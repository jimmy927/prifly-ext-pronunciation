/**
 * The underlines, on prifly's dictation api: each English piece of a
 * dictation, once its words are in the box, judged by the phoneme model and
 * its words said with an accent feature marked (`markDictation`); a word
 * the reader corrected by hand judged again against the corrected word and
 * marked from where it stands in the box (`at`); and "Not a mistake" kept
 * in `api.state`, that word with what was heard in it never marked again.
 *
 * Dictation never waits on any of it: a handler keeps what it needs and
 * returns, and the judging runs after, one request at a time. While one
 * runs, the newest that came meanwhile waits and any older one is dropped.
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
import { type Judged, type JudgeWord, levelOf } from "./judge";
import { isNotMistake, type NotMistake, StoredNotMistakes, withNotMistake } from "./not-mistakes";
import { MARK_AUDIO, type PlayAction, type PlayResult } from "./play-shim";
import type { Voice } from "./voice";

/** The id of the mark's own action; the window adds Listen itself. */
export const NOT_A_MISTAKE = "not-a-mistake";
/** The `api.state` document the accepted pairs are kept in. */
export const NOT_MISTAKES = "not-mistakes";
/** The ids of the two play actions, with "dictation-mark-audio": the reader's own word, and it said right in their voice. */
export const PLAY_YOURS = "play-yours";
export const PLAY_RIGHT = "play-right";

/** The `underline` setting's options, as `prifly-extension.json` declares them: which marks are drawn. */
export const UNDERLINE_SURE = "Sure mistakes only";
export const UNDERLINE_ALL = "Sure and not sure";
export const UNDERLINE_OFF = "Off";
/** The setting's id in `api.settings`. */
export const UNDERLINE = "underline";

type Level = "sure" | "maybe";

/** The levels each option of the `underline` setting draws; an unknown value is the default, sure only. */
function allowedLevels(value: unknown): readonly Level[] {
  if (value === UNDERLINE_OFF) return [];
  return value === UNDERLINE_ALL ? ["sure", "maybe"] : ["sure"];
}

/** `markDictation`'s limits. */
const MAX_LABEL = 64;
const MAX_DETAIL = 300;
/** `DictationMark`'s limit for `said` and `say`. */
const MAX_SPELLING = 40;
const MAX_MARKS = 200;
/** Pieces of a session's last dictation kept for corrections: about 64 KB of audio a second each. */
const KEPT_PIECES = 40;
/** Sessions whose last dictation is kept: the audio lives in prifly's long-running host. */
export const KEPT_SESSIONS = 8;
/** Marked pieces remembered for their marks' actions. */
const SHOWN_GROUPS = 200;
/** Audio samples per millisecond: the piece's audio is 16 kHz. */
const SAMPLES_PER_MS = 16;

export type JudgeFn = (
  audio: Float32Array,
  words: readonly JudgeWord[],
) => Promise<Judged[] | null>;

type CoachApi = Pick<
  ExtensionApi,
  "markDictation" | "state" | "log" | "features" | "settings" | "onSettings"
>;

/** A word as it stands where its mark goes: its text and its offsets. */
type Spot = { text: string; start: number; end: number; from: number; to: number };

type KeptPiece = { text: string; words: DictationPiece["words"]; audio: Float32Array };

/** A mark as given, with the word and what was heard in it, for "Not a mistake", and how sure it is: whether it is drawn is the setting's. `from` and `to` are the word's samples in the piece's audio. */
type Shown = {
  mark: DictationMark;
  word: string;
  heard: string;
  level: Level;
  from: number;
  to: number;
};

/** The marks given to one piece of a dictation, from `at` when a correction's. */
type Group = { sessionId: string; dict: string; piece: number; at?: number; shown: Shown[] };

type Task = () => Promise<void>;

/** English as prifly writes it: "en", or a regional "en-GB". */
export function isEnglish(language: string): boolean {
  const lower = language.toLowerCase();
  return lower === "en" || lower.startsWith("en-");
}

/** The hint line after the bold word: one plain line on the fix, no phonetic letters. */
export function detailOf(judged: Pick<Judged, "fix">): string {
  return judged.fix.slice(0, MAX_DETAIL);
}

const groupKey = (where: { sessionId: string; dict: string; piece: number; at?: number }) =>
  `${where.sessionId}\n${where.dict}\n${where.piece}\n${where.at ?? ""}`;

/** A word's place in the piece's audio, in samples. */
function samplesOf(word: { startMs: number; endMs: number }): { from: number; to: number } {
  const from = Math.max(0, Math.round(word.startMs * SAMPLES_PER_MS));
  return { from, to: Math.max(from, Math.round(word.endMs * SAMPLES_PER_MS)) };
}

export class Coach {
  private readonly api: CoachApi;
  private readonly judge: JudgeFn;
  private readonly voice: Pick<Voice, "yours" | "sayRight"> | null;
  private notMistakes: NotMistake[] = [];
  /** Each session's last dictation: its id, and its pieces by number. */
  private readonly kept = new Map<string, { dict: string; pieces: Map<number, KeptPiece> }>();
  private readonly groups = new Map<string, Group>();
  private waiting: Task | null = null;
  private draining: Promise<void> | null = null;
  private stopped = false;
  /** The levels drawn, from the `underline` setting as it is now. */
  private allowed: readonly Level[];

  constructor(
    api: CoachApi,
    judge: JudgeFn,
    voice: Pick<Voice, "yours" | "sayRight"> | null = null,
  ) {
    this.api = api;
    this.judge = judge;
    this.voice = voice;
    this.allowed = allowedLevels(api.settings?.[UNDERLINE]);
    api.onSettings?.((values) => this.settingsChanged(values));
  }

  /** The `underline` setting changed: the marks already given are drawn or taken away to match. */
  private settingsChanged(values: SettingValues): void {
    if (this.stopped) return;
    const before = this.allowed;
    this.allowed = allowedLevels(values[UNDERLINE]);
    for (const group of [...this.groups.values()]) {
      const drawn = (levels: readonly Level[]) =>
        group.shown.filter((one) => levels.includes(one.level)).length;
      if (drawn(before) !== drawn(this.allowed)) this.show(group, true);
    }
  }

  /** The pairs the reader accepted before, from `api.state`. */
  async load(): Promise<void> {
    this.notMistakes = StoredNotMistakes.parse((await this.api.state?.get(NOT_MISTAKES)) ?? []);
  }

  /** A finished piece: kept, and its words judged once the work before it is done. */
  piece(piece: DictationPiece): void {
    const { audio } = piece;
    if (this.stopped || !isEnglish(piece.language) || audio === undefined) return;
    if (piece.words.length === 0) return;
    this.keep(piece, audio);
    if (this.allowed.length === 0) return;
    const spots = piece.words.map((word) => ({
      text: word.text,
      start: word.start,
      end: word.end,
      ...samplesOf(word),
    }));
    const asked = piece.words.map((word) => ({ word: word.text, ...samplesOf(word) }));
    const where = { sessionId: piece.sessionId, dict: piece.dict, piece: piece.piece };
    this.run(async () => {
      const judged = await this.judge(audio, asked);
      if (judged !== null) this.show({ ...where, shown: this.shownOf(judged, spots) }, false);
    });
  }

  /** A dictated word the reader replaced: judged again as the word now in the box, marked from its place there. */
  correction(correction: DictationCorrection): void {
    if (this.stopped || wordKey(correction.word) === "") return;
    const kept = this.kept.get(correction.sessionId);
    const piece = kept?.dict === correction.dict ? kept.pieces.get(correction.piece) : undefined;
    const said = piece?.words.find((word) => wordKey(word.text) === wordKey(correction.heard));
    if (piece === undefined || said === undefined || this.allowed.length === 0) return;
    const { sessionId, dict, word, start: at } = correction;
    const asked = [{ word, ...samplesOf(said) }];
    const spots = [{ text: word, start: 0, end: word.length, ...samplesOf(said) }];
    this.run(async () => {
      const judged = await this.judge(piece.audio, asked);
      this.api.log("recheck", { heard: correction.heard, word, marks: judged?.length ?? -1 });
      if (judged === null) return;
      const group = {
        sessionId,
        dict,
        piece: correction.piece,
        at,
        shown: this.shownOf(judged, spots),
      };
      this.show(group, true);
    });
  }

  /**
   * A click on a mark's action: "Not a mistake" keeps the pair and takes its marks away wherever
   * they are; "Yours" and "Say it right" answer with the audio to play.
   */
  async action(click: DictationMarkClick): Promise<undefined | PlayResult> {
    const play = click.action === PLAY_YOURS || click.action === PLAY_RIGHT;
    if (this.stopped || (click.action !== NOT_A_MISTAKE && !play)) return undefined;
    const group = this.groups.get(groupKey(click));
    const hit = group?.shown.find(
      (one) => one.mark.start === click.markStart && one.mark.end === click.markEnd,
    );
    if (group === undefined || hit === undefined) {
      this.api.log("unknownMark", { markStart: click.markStart, markEnd: click.markEnd });
      return undefined;
    }
    if (play) return this.play(click.action, group, hit);
    const { word, heard } = hit;
    this.api.log("notMistake", { word, heard });
    this.notMistakes = withNotMistake(this.notMistakes, word, heard);
    await this.api.state?.update(NOT_MISTAKES, (current) =>
      withNotMistake(StoredNotMistakes.parse(current ?? []), word, heard),
    );
    for (const group of [...this.groups.values()]) {
      const shown = group.shown.filter((one) => !isNotMistake([hit], one.word, one.heard));
      if (shown.length !== group.shown.length) this.show({ ...group, shown }, true);
    }
    return undefined;
  }

  /** The audio of a play action: the reader's own word, or the sentence (the word, for a correction) said right in their voice. */
  private async play(action: string, group: Group, hit: Shown): Promise<PlayResult> {
    const kept = this.kept.get(group.sessionId);
    const piece = kept?.dict === group.dict ? kept.pieces.get(group.piece) : undefined;
    if (this.voice === null || piece === undefined || hit.to <= hit.from) {
      throw new Error("That audio is no longer kept: only the last dictation of a session is");
    }
    try {
      if (action === PLAY_YOURS) {
        return { audio: await this.voice.yours(piece.audio.slice(hit.from, hit.to)) };
      }
      const first = piece.words[0];
      const last = piece.words[piece.words.length - 1];
      const whole = group.at === undefined && first !== undefined && last !== undefined;
      const span = whole ? { from: samplesOf(first).from, to: samplesOf(last).to } : hit;
      const audio = await this.voice.sayRight({
        key: whole ? groupKey(group) : `${groupKey(group)}\n${hit.word}`,
        text: whole ? piece.text : hit.word,
        clip: piece.audio.slice(span.from, span.to),
        pool: [...(kept?.pieces.values() ?? [])].map((one) => one.audio),
      });
      return { audio };
    } catch (caught) {
      if (caught instanceof Error) this.api.log("playFailed", { action, error: caught.message });
      throw caught;
    }
  }

  /** Nothing more is judged or marked; what is kept goes. */
  stop(): void {
    this.stopped = true;
    this.waiting = null;
    this.kept.clear();
    this.groups.clear();
  }

  /** Resolves once every request handed over so far is done: for tests. */
  async settled(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  private keep(piece: DictationPiece, audio: Float32Array): void {
    let kept = this.kept.get(piece.sessionId);
    if (kept?.dict !== piece.dict) kept = { dict: piece.dict, pieces: new Map() };
    // Set anew so the session is the newest; the longest silent ones go first.
    this.kept.delete(piece.sessionId);
    this.kept.set(piece.sessionId, kept);
    for (const old of this.kept.keys()) {
      if (this.kept.size <= KEPT_SESSIONS) break;
      this.kept.delete(old);
    }
    kept.pieces.set(piece.piece, { text: piece.text, words: piece.words, audio });
    for (const old of kept.pieces.keys()) {
      if (kept.pieces.size <= KEPT_PIECES) break;
      kept.pieces.delete(old);
    }
  }

  /** `judged` as marks on `spots`, without the pairs the reader accepted and words too long to label. */
  private shownOf(judged: readonly Judged[], spots: readonly Spot[]): Shown[] {
    const shown = judged.flatMap((one): Shown[] => {
      const spot = spots[one.index];
      if (spot === undefined || spot.text.length > MAX_LABEL) return [];
      if (isNotMistake(this.notMistakes, one.word, one.heard)) return [];
      const level = levelOf(one.posterior);
      const mark: DictationMark = {
        start: spot.start,
        end: spot.end,
        label: spot.text,
        detail: detailOf(one),
        actions: [
          { id: NOT_A_MISTAKE, label: "Not a mistake", icon: "check" },
          ...this.playActions(),
        ],
        // An older prifly refuses the fields, and draws every mark as sure.
        ...(this.api.features?.includes("dictation-mark-levels") === true
          ? {
              level,
              confidence: one.posterior,
              said: one.said.slice(0, MAX_SPELLING),
              say: one.say.slice(0, MAX_SPELLING),
            }
          : {}),
      };
      return [{ mark, word: one.word, heard: one.heard, level, from: spot.from, to: spot.to }];
    });
    return shown.slice(0, MAX_MARKS);
  }

  /** "Yours" and "Say it right", only where prifly plays what a click answers with; an older prifly gets none. */
  private playActions(): PlayAction[] {
    if (this.voice === null || this.api.features?.includes(MARK_AUDIO) !== true) return [];
    return [
      { id: PLAY_YOURS, label: "Yours", kind: "play" },
      { id: PLAY_RIGHT, label: "Say it right", kind: "play" },
    ];
  }

  /** `group`'s marks of the levels allowed given to the window; with none, only when `always` (a correction's, or marks taken away). */
  private show(group: Group, always: boolean): void {
    const drawn = group.shown.filter((one) => this.allowed.includes(one.level));
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
        marks: drawn.map((one) => one.mark),
      });
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught;
      this.api.log("markRefused", { error: caught.message });
    }
  }

  /** `task` now, or after the one running: the newest waits, an older waiting one is dropped. */
  private run(task: Task): void {
    if (this.draining !== null) {
      if (this.waiting !== null) this.api.log("skipped", { reason: "busy" });
      this.waiting = task;
      return;
    }
    this.draining = this.drain(task);
  }

  private async drain(first: Task): Promise<void> {
    let task: Task | null = first;
    while (task !== null && !this.stopped) {
      try {
        await task();
      } catch (caught) {
        if (!(caught instanceof Error)) throw caught;
        this.api.log("judgeFailed", { error: caught.message });
      }
      task = this.waiting;
      this.waiting = null;
    }
    this.draining = null;
  }
}
