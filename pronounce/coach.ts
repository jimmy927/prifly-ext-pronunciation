/**
 * The underlines, on prifly's dictation api: each English piece of a
 * dictation, once its words are in the box, judged by the phoneme model and
 * its words said with an accent feature marked (`markDictation`); a word
 * the reader corrected by hand judged again against the corrected word and
 * marked from where it stands in the box (`at`); and "Not a mistake" kept
 * in `api.state`, that word with what was heard in it never marked again,
 * and counted as a Wrong verdict on its check (`personal.ts`). A judged
 * piece's content words also go into the accent profile (`profile.ts`), and
 * its stressed vowels are checked against the natives' here (`vowels.ts`).
 *
 * Every check's marks are kept, judged at every Sensitivity step
 * (`sensitivity.ts`); which are drawn, and at which level, is the reader's
 * settings' (`drawn.ts`): Sensitivity, Underline and each check's switch. A
 * setting changed redraws the marks already given.
 *
 * With the native check on (`native-control.ts`), a piece whose settings draw a
 * mark is not marked until a native reading of its sentence has been judged
 * too: the marks it shares are kept but not drawn, so none is drawn and then
 * taken away. A piece that drew nothing is compared once a setting draws one.
 *
 * Dictation never waits on any of it: a handler keeps what it needs and
 * returns, and the judging runs after, one request at a time. While one
 * runs, the newest that came meanwhile waits and any older one is dropped
 * (`latest-queue.ts`); the judge, native readings included, one at a time.
 *
 * The last dictation of each session is kept with its pieces' audio (prifly
 * keeps none for an extension) until the next one starts or the session is
 * among the longest silent past `KEPT_SESSIONS`, so a correction made after
 * it ended can still be judged.
 */

import type {
  DictationCorrection,
  DictationMark,
  DictationMarkClick,
  DictationPiece,
  ExtensionApi,
  SettingValues,
} from "@prifly/extension-api";
import { wordKey } from "./dictionary";
import {
  type Drawn,
  drawnBy,
  drawnMark,
  drawsNothing,
  pickDrawn,
  type Shown,
  shownMark,
  UNDERLINE,
  UnderlineSwitch,
} from "./drawn";
import { inWordOrder, type Judged, type JudgeWord } from "./judge";
import { LatestQueue, oneAtATime } from "./latest-queue";
import { type NativeControl, withNatives } from "./native-control";
import { isNotMistake, type NotMistake, StoredNotMistakes, withNotMistake } from "./not-mistakes";
import type { Personal } from "./personal";
import { fullRateOf, samplesOf } from "./piece-audio";
import { type AudioFull, MARK_AUDIO, type PlayAction, type PlayResult } from "./play-shim";
import type { AccentProfile, PieceAt } from "./profile";
import type { Judgement } from "./scores";
import { PIECE_RATE, type Voice } from "./voice";
import { steppedVowelMarks } from "./vowels";

/** The id of the mark's own action; the window adds Listen itself. */
export const NOT_A_MISTAKE = "not-a-mistake";
/** The `api.state` document the accepted pairs are kept in. */
export const NOT_MISTAKES = "not-mistakes";
/** The ids of the two play actions, with "dictation-mark-audio": the reader's own word, and it said right in their voice. */
export const PLAY_YOURS = "play-yours";
export const PLAY_RIGHT = "play-right";

/** `markDictation`'s limits. */
const MAX_LABEL = 64;
const MAX_MARKS = 200;
/** Pieces of a session's last dictation kept for corrections: about 64 KB of audio a second each. */
const KEPT_PIECES = 40;
/** Sessions whose last dictation is kept: the audio lives in prifly's long-running host. */
export const KEPT_SESSIONS = 8;
/** Marked pieces remembered for their marks' actions. */
const SHOWN_GROUPS = 200;

export type JudgeFn = (
  audio: Float32Array,
  words: readonly JudgeWord[],
) => Promise<Judgement | null>;

/** What the reader hears for an example of the accent profile: their own word, or it said right. */
export type ExampleAudio = PieceAt & { word: string; from: number; to: number };

/** Why "Yours" cannot play: the piece's audio went with its dictation, or came without its full rate. */
export const AUDIO_GONE = "That audio is no longer kept: only the last dictation of a session is";
export const NO_FULL_RATE = "Prifly gave no full-rate audio of that piece";

type CoachApi = Pick<
  ExtensionApi,
  "markDictation" | "state" | "log" | "features" | "settings" | "onSettings"
>;

/** A word as it stands where its mark goes: its text and its offsets. */
type Spot = { text: string; start: number; end: number; from: number; to: number };

/** `full` is the piece at the device's own rate, kept only when it is 44.1 kHz or more. */
type KeptPiece = {
  text: string;
  words: DictationPiece["words"];
  audio: Float32Array;
  full?: AudioFull;
};

/** Optional parts of a coach: where "Not a mistake" counts as a Wrong verdict, and the native check (`native-control.ts`). */
export type CoachOptions = { personal?: Pick<Personal, "mark"> | null; control?: Control | null };
type Control = Pick<NativeControl, "natives">;

/** The marks given to one piece of a dictation, from `at` when a correction's; `pending`: its sentence and words, until the native check has seen them. */
type Group = { sessionId: string; dict: string; piece: number; at?: number; shown: Shown[] } & {
  pending?: { text: string; words: string[] };
};

/** English as prifly writes it: "en", or a regional "en-GB". */
export function isEnglish(language: string): boolean {
  const lower = language.toLowerCase();
  return lower === "en" || lower.startsWith("en-");
}

const groupKey = (where: { sessionId: string; dict: string; piece: number; at?: number }) =>
  `${where.sessionId}\n${where.dict}\n${where.piece}\n${where.at ?? ""}`;

export class Coach {
  private readonly api: CoachApi;
  private readonly judge: JudgeFn;
  private readonly voice: Pick<Voice, "yours" | "sayRight"> | null;
  private readonly profile: AccentProfile | null;
  private readonly personal: Pick<Personal, "mark"> | null;
  private readonly control: Control | null;
  private readonly controlling = new Set<Group>(); // groups in `controlLater`
  private notMistakes: NotMistake[] = [];
  /** Each session's last dictation: its id, and its pieces by number. */
  private readonly kept = new Map<string, { dict: string; pieces: Map<number, KeptPiece> }>();
  private readonly groups = new Map<string, Group>();
  private readonly queue: LatestQueue;
  private stopped = false;
  /** Whether a kept "Sure mistakes only" counts as "Sure and not sure". */
  private readonly switched: UnderlineSwitch;
  /** What is drawn, from the settings as they are now. */
  private drawn: Drawn;

  constructor(
    api: CoachApi,
    judge: JudgeFn,
    voice: Pick<Voice, "yours" | "sayRight"> | null = null,
    profile: AccentProfile | null = null,
    options: CoachOptions = {},
  ) {
    this.api = api;
    this.judge = oneAtATime(judge);
    this.queue = new LatestQueue((event, fields) => api.log(event, fields));
    this.voice = voice;
    this.profile = profile;
    this.personal = options.personal ?? null;
    this.control = options.control ?? null;
    this.switched = new UnderlineSwitch(api.state, (event, fields) => api.log(event, fields));
    this.drawn = drawnBy(api.settings, false);
    api.onSettings?.((values) => this.settingsChanged(values));
  }

  /** A setting changed: an Underline the reader picked ends the switch, and the marks already given are drawn or taken away to match. */
  private settingsChanged(values: SettingValues): void {
    if (this.stopped) return;
    this.switched.changed(values[UNDERLINE]);
    this.redraw(values);
  }

  /** The settings now are `values`: every group whose drawn marks change is given again. */
  private redraw(values: SettingValues | undefined): void {
    const before = this.drawn;
    this.drawn = drawnBy(values, this.switched.active);
    for (const group of [...this.groups.values()]) {
      if (this.needsControl(group)) {
        this.controlLater(group);
        continue;
      }
      const was = pickDrawn(group.shown, before, MAX_MARKS);
      const now = pickDrawn(group.shown, this.drawn, MAX_MARKS);
      const level = (one: Shown, drawn: Drawn) => drawnMark(one, drawn).level;
      const changed = (one: Shown, at: number) => {
        const other = now[at];
        return one !== other || level(one, before) !== level(other, this.drawn);
      };
      if (was.length !== now.length || was.some(changed)) this.show(group, true);
    }
  }

  /** The pairs the reader accepted before, from `api.state`, and the Underline switch (`drawn.ts`). */
  async load(): Promise<void> {
    this.notMistakes = StoredNotMistakes.parse((await this.api.state?.get(NOT_MISTAKES)) ?? []);
    await this.switched.load(this.api.settings?.[UNDERLINE]);
    if (!this.stopped) this.redraw(this.api.settings);
  }

  /** A finished piece: kept, and its words judged once the work before it is done. */
  piece(piece: DictationPiece): void {
    const { audio } = piece;
    if (this.stopped || !isEnglish(piece.language) || audio === undefined) return;
    if (piece.words.length === 0) return;
    const full = fullRateOf(piece);
    this.keep(piece, audio, full);
    if (drawsNothing(this.drawn)) return;
    const spots = piece.words.map((word) => ({
      text: word.text,
      start: word.start,
      end: word.end,
      ...samplesOf(word),
    }));
    const asked = piece.words.map((word) => ({ word: word.text, ...samplesOf(word) }));
    const where = { sessionId: piece.sessionId, dict: piece.dict, piece: piece.piece };
    this.queue.run(async () => {
      const judged = await this.judge(audio, asked);
      if (judged === null) return;
      const marks = inWordOrder([...judged.marks, ...this.vowelMarksOf(judged, spots)]);
      const shown = this.shownOf(marks, spots, full !== undefined);
      const pending = { text: piece.text, words: spots.map((spot) => spot.text) };
      const group: Group = { ...where, shown, ...(this.control === null ? {} : { pending }) };
      this.show(this.needsControl(group) ? await this.controlled(group) : group, false);
      await this.learn(judged, spots, where);
    });
  }

  /** Whether `group`'s marks wait for the native check, so none it drops is drawn first: it is on, has not seen them, and the settings draw one. */
  private needsControl(group: Group): boolean {
    if (this.control === null || group.pending === undefined || !this.drawn.native) return false;
    return pickDrawn(group.shown, this.drawn, MAX_MARKS).length > 0;
  }

  /** `group` compared with native readings of its sentence (`withNatives`), one line logged. */
  private async controlled(group: Group): Promise<Group> {
    const { pending, ...rest } = group;
    if (this.control === null || pending === undefined) return group;
    const answer = await this.control.natives(pending.text, pending.words, async (audio, words) => {
      const judged = await this.judge(audio, words);
      const texts = words.map((word) => ({ text: word.word }));
      return judged && [...judged.marks, ...this.vowelMarksOf(judged, texts)];
    });
    const { marks, fields } = withNatives(group.shown, answer);
    this.api.log("control", fields);
    return { ...rest, shown: marks };
  }

  /** `group`'s native check after a setting drew it, outside the queue; drawn when done, or run again on the group that replaced it meanwhile (its readings are kept). */
  private controlLater(group: Group): void {
    if (this.controlling.has(group)) return;
    this.controlling.add(group);
    const key = groupKey(group);
    const draw = (done: Group) => {
      const now = this.groups.get(key);
      if (now === group) this.show(done, true);
      else if (now !== undefined && this.needsControl(now)) this.controlLater(now);
    };
    const failed = (caught: unknown) => this.api.log("controlFailed", { error: String(caught) });
    void this.controlled(group)
      .then(draw, failed)
      .finally(() => this.controlling.delete(group));
  }

  /** The piece's content words' scores added to the accent profile; a refused write is logged. */
  private async learn(judged: Judgement, spots: readonly Spot[], where: PieceAt): Promise<void> {
    const words = judged.scores.flatMap((scores) => {
      const spot = spots[scores.index];
      return spot === undefined ? [] : [{ scores, word: spot.text, from: spot.from, to: spot.to }];
    });
    try {
      await this.profile?.add(words, where);
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught;
      this.api.log("profileFailed", { error: caught.message });
    }
  }

  /** The Vowels check's marks of a judged piece (`vowels.ts`), from its scores, the natives' and the accent profile. */
  private vowelMarksOf(judged: Judgement, spots: readonly Pick<Spot, "text">[]): Judged[] {
    if (this.profile === null) return [];
    return steppedVowelMarks(
      judged.scores,
      spots.map((spot) => spot.text),
      this.profile.assessed(),
      this.profile.nativeStats(),
    );
  }

  /** A dictated word the reader replaced: judged again as the word now in the box, marked from its place there. */
  correction(correction: DictationCorrection): void {
    if (this.stopped || wordKey(correction.word) === "") return;
    const kept = this.kept.get(correction.sessionId);
    const piece = kept?.dict === correction.dict ? kept.pieces.get(correction.piece) : undefined;
    const said = piece?.words.find((word) => wordKey(word.text) === wordKey(correction.heard));
    if (piece === undefined || said === undefined || drawsNothing(this.drawn)) return;
    const { sessionId, dict, word, start: at } = correction;
    const asked = [{ word, ...samplesOf(said) }];
    const spots = [{ text: word, start: 0, end: word.length, ...samplesOf(said) }];
    this.queue.run(async () => {
      const judged = await this.judge(piece.audio, asked);
      this.api.log("recheck", { heard: correction.heard, word, marks: judged?.marks.length ?? -1 });
      if (judged === null) return;
      const group = {
        sessionId,
        dict,
        piece: correction.piece,
        at,
        shown: this.shownOf(judged.marks, spots, piece.full !== undefined),
      };
      this.show(group, true);
    });
  }

  /**
   * A click on a mark's action: "Not a mistake" keeps the pair, takes its marks away wherever
   * they are and counts as a Wrong verdict on the mark's check (`personal.ts`), which switches
   * nothing; "Yours" and "Say it right" answer with the audio to play.
   */
  async action(click: DictationMarkClick): Promise<undefined | PlayResult> {
    const play = click.action === PLAY_YOURS || click.action === PLAY_RIGHT;
    if (this.stopped || (click.action !== NOT_A_MISTAKE && !play)) return undefined;
    const group = this.groups.get(groupKey(click));
    const hit = pickDrawn(group?.shown ?? [], this.drawn, MAX_MARKS).find(
      (one) => one.mark.start === click.markStart && one.mark.end === click.markEnd,
    );
    if (group === undefined || hit === undefined) {
      this.api.log("unknownMark", { markStart: click.markStart, markEnd: click.markEnd });
      return undefined;
    }
    if (play) return this.play(click.action, group, hit);
    const { word, heard } = hit;
    this.api.log("notMistake", { word, heard, check: hit.check });
    this.notMistakes = withNotMistake(this.notMistakes, word, heard);
    await this.api.state?.update(NOT_MISTAKES, (current) =>
      withNotMistake(StoredNotMistakes.parse(current ?? []), word, heard),
    );
    await this.countWrong(group, hit);
    for (const group of [...this.groups.values()]) {
      const shown = group.shown.filter((one) => !isNotMistake([hit], one.word, one.heard));
      if (shown.length !== group.shown.length) this.show({ ...group, shown }, true);
    }
    return undefined;
  }

  /** "Not a mistake" on `hit` kept as a Wrong verdict on its check; a refused write is logged. */
  private async countWrong(group: Group, hit: Shown): Promise<void> {
    const id = `session#${groupKey(group).replaceAll("\n", "#")}#${hit.mark.start}#${hit.check}`;
    try {
      await this.personal?.mark(id, "wrong", hit.check, hit.score);
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught;
      this.api.log("verdictFailed", { error: caught.message });
    }
  }

  /** The audio of a play action: the reader's own word, or the sentence (the word, for a correction) said right in their voice. */
  private async play(action: string, group: Group, hit: Shown): Promise<PlayResult> {
    const kept = this.kept.get(group.sessionId);
    const piece = this.keptPiece(group);
    if (this.voice === null || piece === undefined || hit.to <= hit.from) {
      throw new Error(AUDIO_GONE);
    }
    try {
      if (action === PLAY_YOURS) return { audio: await this.yoursOf(this.voice, piece, hit) };
      const first = piece.words[0];
      const last = piece.words[piece.words.length - 1];
      const whole = group.at === undefined && first !== undefined && last !== undefined;
      const span = whole ? { from: samplesOf(first).from, to: samplesOf(last).to } : hit;
      const audio = await this.voice.sayRight({
        key: whole ? groupKey(group) : `${groupKey(group)}\n${hit.word}`,
        text: whole ? piece.text : hit.word,
        clip: piece.audio.slice(span.from, span.to),
        pool: [...(kept?.pieces.values() ?? [])].flatMap((one) => (one.full ? [one.full] : [])),
      });
      return { audio };
    } catch (caught) {
      if (caught instanceof Error) this.api.log("playFailed", { action, error: caught.message });
      throw caught;
    }
  }

  /** The piece at `where` while its dictation is still the session's kept one. */
  private keptPiece(where: PieceAt): KeptPiece | undefined {
    const kept = this.kept.get(where.sessionId);
    return kept?.dict === where.dict ? kept.pieces.get(where.piece) : undefined;
  }

  /** The reader's own samples `from` to `to` of `piece`, cut from its full-rate audio. */
  private yoursOf(
    voice: Pick<Voice, "yours">,
    piece: KeptPiece,
    span: { from: number; to: number },
  ): Promise<string> {
    const { full } = piece;
    if (full === undefined) return Promise.reject(new Error(NO_FULL_RATE));
    const scale = full.rate / PIECE_RATE;
    const samples = full.samples.slice(Math.round(span.from * scale), Math.round(span.to * scale));
    return voice.yours({ rate: full.rate, samples });
  }

  /** Why an example of the profile cannot play "Yours" now; null when it can. */
  yoursMissing(example: ExampleAudio): string | null {
    const piece = this.keptPiece(example);
    if (this.voice === null || piece === undefined || example.to <= example.from) return AUDIO_GONE;
    return piece.full === undefined ? NO_FULL_RATE : null;
  }

  /** The file of an example's own word, as "Yours" on a card plays it. */
  exampleYours(example: ExampleAudio): Promise<string> {
    const piece = this.keptPiece(example);
    const why = this.yoursMissing(example);
    if (why !== null || piece === undefined || this.voice === null) {
      return Promise.reject(new Error(why ?? AUDIO_GONE));
    }
    return this.yoursOf(this.voice, piece, example);
  }

  /**
   * An example's word said right in the reader's voice, as a correction's "Say it right" says
   * one word. Seed-VC only takes the length of the reader's clip, so an example whose audio has
   * gone still plays, from silence of the same length; the voice comes from the reference or
   * any session's kept full-rate pieces.
   */
  exampleRight(example: ExampleAudio): Promise<string> {
    if (this.voice === null) return Promise.reject(new Error(AUDIO_GONE));
    const piece = this.keptPiece(example);
    const length = Math.max(0, example.to - example.from);
    return this.voice.sayRight({
      key: `example\n${groupKey(example)}\n${example.from}`,
      text: example.word,
      clip: piece?.audio.slice(example.from, example.to) ?? new Float32Array(length),
      pool: [...this.kept.values()].flatMap((one) =>
        [...one.pieces.values()].flatMap((kept) => (kept.full ? [kept.full] : [])),
      ),
    });
  }

  /** Nothing more is judged or marked; what is kept goes. */
  stop(): void {
    this.stopped = true;
    this.queue.stop();
    this.kept.clear();
    this.groups.clear();
  }

  /** Resolves once every request handed over so far is done: for tests. */
  settled(): Promise<void> {
    return this.queue.settled();
  }

  private keep(piece: DictationPiece, audio: Float32Array, full: AudioFull | undefined): void {
    let kept = this.kept.get(piece.sessionId);
    if (kept?.dict !== piece.dict) kept = { dict: piece.dict, pieces: new Map() };
    // Set anew so the session is the newest; the longest silent ones go first.
    this.kept.delete(piece.sessionId);
    this.kept.set(piece.sessionId, kept);
    for (const old of this.kept.keys()) {
      if (this.kept.size <= KEPT_SESSIONS) break;
      this.kept.delete(old);
    }
    kept.pieces.set(piece.piece, {
      text: piece.text,
      words: piece.words,
      audio,
      ...(full === undefined ? {} : { full }),
    });
    for (const old of kept.pieces.keys()) {
      if (kept.pieces.size <= KEPT_PIECES) break;
      kept.pieces.delete(old);
    }
  }

  /** `judged` as marks on `spots`, without the pairs the reader accepted and words too long to label. */
  private shownOf(judged: readonly Judged[], spots: readonly Spot[], full: boolean): Shown[] {
    const actions: NonNullable<DictationMark["actions"]> = [
      { id: NOT_A_MISTAKE, label: "Not a mistake", icon: "check" },
      ...this.playActions(full),
    ];
    const levels = this.api.features?.includes("dictation-mark-levels") === true;
    return judged.flatMap((one): Shown[] => {
      const spot = spots[one.index];
      if (spot === undefined || spot.text.length > MAX_LABEL) return [];
      if (isNotMistake(this.notMistakes, one.word, one.heard)) return [];
      return [shownMark(one, spot, actions, levels)];
    });
  }

  /**
   * "Yours" and "Say it right", only where prifly plays what a click answers with; an older prifly
   * gets none. "Yours" only when the piece came with its full-rate audio: the 16 kHz copy is never offered.
   */
  private playActions(full: boolean): PlayAction[] {
    if (this.voice === null || this.api.features?.includes(MARK_AUDIO) !== true) return [];
    return [
      ...(full ? [{ id: PLAY_YOURS, label: "Yours", kind: "play" as const }] : []),
      { id: PLAY_RIGHT, label: "Say it right", kind: "play" },
    ];
  }

  /** `group`'s marks the settings draw (`pickDrawn`) given to the window; with none, only when `always` (a correction's, or marks taken away). */
  private show(group: Group, always: boolean): void {
    const drawn = pickDrawn(group.shown, this.drawn, MAX_MARKS);
    if (this.stopped || (group.shown.length === 0 && !always)) return;
    const key = groupKey(group);
    this.groups.delete(key);
    this.groups.set(key, group);
    for (const old of this.groups.keys()) {
      if (this.groups.size <= SHOWN_GROUPS) break;
      this.groups.delete(old);
    }
    // Kept above even when nothing is drawn, so a later setting change can draw it.
    if (drawn.length === 0 && !always) return;
    const { sessionId, dict, piece, at } = group;
    try {
      this.api.markDictation?.({
        sessionId,
        dict,
        piece,
        ...(at === undefined ? {} : { at }),
        marks: drawn.map((one) => drawnMark(one, this.drawn)),
      });
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught;
      this.api.log("markRefused", { error: caught.message });
    }
  }
}
