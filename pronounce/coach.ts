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
} from "@prifly/extension-api";
import { wordKey } from "./dictionary";
import type { Judged, JudgeWord } from "./judge";
import { isNotMistake, type NotMistake, StoredNotMistakes, withNotMistake } from "./not-mistakes";

/** The id of the mark's own action; the window adds Listen itself. */
export const NOT_A_MISTAKE = "not-a-mistake";
/** The `api.state` document the accepted pairs are kept in. */
export const NOT_MISTAKES = "not-mistakes";

/** `markDictation`'s limits. */
const MAX_LABEL = 64;
const MAX_DETAIL = 300;
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

type CoachApi = Pick<ExtensionApi, "markDictation" | "state" | "log">;

/** A word as it stands where its mark goes: its text and its offsets. */
type Spot = { text: string; start: number; end: number };

type KeptPiece = { words: DictationPiece["words"]; audio: Float32Array };

/** A mark as given, with the word and what was heard in it, for "Not a mistake". */
type Shown = { mark: DictationMark; word: string; heard: string };

/** The marks given to one piece of a dictation, from `at` when a correction's. */
type Group = { sessionId: string; dict: string; piece: number; at?: number; shown: Shown[] };

type Task = () => Promise<void>;

/** English as prifly writes it: "en", or a regional "en-GB". */
export function isEnglish(language: string): boolean {
  const lower = language.toLowerCase();
  return lower === "en" || lower.startsWith("en-");
}

/** The hint line after the bold word: what was heard, what the word is, the sound and how to say it. */
export function detailOf(judged: Pick<Judged, "heard" | "expected" | "sound" | "how">): string {
  const { heard, expected, sound, how } = judged;
  return `heard /${heard}/, the word is /${expected}/ · ${sound}: ${how}`.slice(0, MAX_DETAIL);
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
  private notMistakes: NotMistake[] = [];
  /** Each session's last dictation: its id, and its pieces by number. */
  private readonly kept = new Map<string, { dict: string; pieces: Map<number, KeptPiece> }>();
  private readonly groups = new Map<string, Group>();
  private waiting: Task | null = null;
  private draining: Promise<void> | null = null;
  private stopped = false;

  constructor(api: CoachApi, judge: JudgeFn) {
    this.api = api;
    this.judge = judge;
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
    const spots = piece.words.map(({ text, start, end }) => ({ text, start, end }));
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
    if (piece === undefined || said === undefined) return;
    const { sessionId, dict, word, start: at } = correction;
    const asked = [{ word, ...samplesOf(said) }];
    const spots = [{ text: word, start: 0, end: word.length }];
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

  /** "Not a mistake" on a mark: the pair kept, and its marks taken away wherever they are. */
  async action(click: DictationMarkClick): Promise<void> {
    if (this.stopped || click.action !== NOT_A_MISTAKE) return;
    const hit = this.groups
      .get(groupKey(click))
      ?.shown.find((one) => one.mark.start === click.markStart && one.mark.end === click.markEnd);
    if (hit === undefined) {
      this.api.log("unknownMark", { markStart: click.markStart, markEnd: click.markEnd });
      return;
    }
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
    kept.pieces.set(piece.piece, { words: piece.words, audio });
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
      const mark: DictationMark = {
        start: spot.start,
        end: spot.end,
        label: spot.text,
        detail: detailOf(one),
        actions: [{ id: NOT_A_MISTAKE, label: "Not a mistake", icon: "check" }],
      };
      return [{ mark, word: one.word, heard: one.heard }];
    });
    return shown.slice(0, MAX_MARKS);
  }

  /** `group`'s marks given to the window; with none, only when `always` (a correction's, or marks taken away). */
  private show(group: Group, always: boolean): void {
    if (this.stopped || (group.shown.length === 0 && !always)) return;
    const key = groupKey(group);
    this.groups.delete(key);
    this.groups.set(key, group);
    for (const old of this.groups.keys()) {
      if (this.groups.size <= SHOWN_GROUPS) break;
      this.groups.delete(old);
    }
    const { sessionId, dict, piece, at } = group;
    try {
      this.api.markDictation?.({
        sessionId,
        dict,
        piece,
        ...(at === undefined ? {} : { at }),
        marks: group.shown.map((one) => one.mark),
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
