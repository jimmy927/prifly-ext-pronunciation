/**
 * "Check your flags" in the "Your accent" window: the reader's newest `SCAN_PIECES` English
 * sentences with full-rate audio (`past-pieces.ts`) scored in the background by a worker of its
 * own (`scan-worker.ts`, two threads, one piece at a time), every candidate flag of every check
 * kept (`flags.ts`), the ones switched off included; the reader marks each Right or Wrong
 * (`personal.ts`). Per check the page shows how often the reader found it wrong, here and with
 * "Not a mistake" in the session, beside the switch in Settings that turns it off
 * (`checks.ts`): the marks themselves switch nothing.
 *
 * The flags are kept in `api.state` (`FLAGS`) with what is needed to play the word: the
 * recording's file, its rate and the word's times. A job can be cancelled; what it found so far
 * stays. A flag's id names its piece, word and check, so scoring again keeps the marks.
 */

import { z } from "zod";
import { CHECK_IDS, CHECK_LABELS, type CheckId } from "./checks";
import { type Flag, vowelFlags } from "./flags";
import type { NativeStats } from "./native";
import { type NativeControl, withNatives } from "./native-control";
import type { PastPiece } from "./past-pieces";
import type { Personal, Tally, Verdict } from "./personal";
import { resample } from "./resample";
import type { ScanAnswer, ScanWorker } from "./scan-worker";
import { type Sensitivity, sensitivityLabel } from "./sensitivity";
import { PIECE_RATE, type Voice } from "./voice";
import type { Wav } from "./wav";

/** The `api.state` document the flags are kept in. */
export const FLAGS = "flag-check";
/** Sentences a job scores: the newest. */
export const SCAN_PIECES = 200;
/** Pieces between saves of a running job. */
const SAVE_EVERY = 10;
/** Pieces in a row the worker fails on before the job stops. */
const MAX_FAILED = 3;
/** Samples a millisecond at 16 kHz. */
const SAMPLES_PER_MS = PIECE_RATE / 1000;

/** Where the reader finds the checks' switches. */
export const WHERE_SWITCHES = "Settings → Extensions → Pronunciation";

/**
 * The line under a check's title: its tally (a Wrong here and a "Not a mistake" in the session
 * count alike), and the hint naming the switch that turns it off, or on again: "9 of 14 not a
 * mistake. Too many? Switch off “Final D said as T” in Settings → Extensions → Pronunciation."
 */
export function tallyLine(check: CheckId, tally: Tally, on: boolean): string {
  const label = `“${CHECK_LABELS[check]}”`;
  const marked =
    tally.marked === 0 ? "Not marked yet." : `${tally.wrong} of ${tally.marked} not a mistake.`;
  const hint = on
    ? `Too many? Switch off ${label} in ${WHERE_SWITCHES}.`
    : `Off: switch on ${label} in ${WHERE_SWITCHES} to underline it again.`;
  return `${marked} ${hint}`;
}

/**
 * The line naming the Sensitivity dictation is underlined at now: "Dictation is underlined at
 * “Like 1 in 50 natives”: Sensitivity in Settings → Extensions → Pronunciation."
 */
export function sensitivityLine(step: Sensitivity): string {
  return `Dictation is underlined at “${sensitivityLabel(step)}”: Sensitivity in ${WHERE_SWITCHES}.`;
}

const StoredFlag = z.object({
  id: z.string(),
  check: z.enum(CHECK_IDS),
  score: z.number(),
  word: z.string(),
  sentence: z.string(),
  start: z.number(),
  end: z.number(),
  sound: z.string(),
  fix: z.string(),
  wav: z.string(),
  fromMs: z.number(),
  toMs: z.number(),
});
export type StoredFlag = z.infer<typeof StoredFlag>;

const Stored = z.object({
  v: z.literal(1),
  scanned: z.number(),
  total: z.number(),
  complete: z.boolean(),
  flags: z.array(StoredFlag),
  /** Per check, the flags the native check dropped (`native-control.ts`); sentences it could not check. */
  dropped: z.partialRecord(z.enum(CHECK_IDS), z.number()).optional(),
  unchecked: z.number().optional(),
});
type Stored = z.infer<typeof Stored>;

export type JobState = "idle" | "listing" | "running" | "done" | "cancelled" | "failed" | "empty";

type Job = {
  state: JobState;
  done: number;
  total: number;
  error: string;
  /** When the first piece was handed to the worker; null before (while it starts). */
  since: number | null;
};

export type FlagView = {
  id: string;
  word: string;
  /** The sentence around the word: before it, the word itself, after it. */
  before: string;
  after: string;
  score: string;
  sound: string;
  fix: string;
  verdict: Verdict | null;
};

export type CheckView = {
  id: CheckId;
  /** Its name, the label of its switch in Settings. */
  title: string;
  /** Whether its switch is on now. */
  on: boolean;
  /** The tally and the hint naming its switch (`tallyLine`). */
  line: string;
  /** The reader's verdicts on it, here and with "Not a mistake" in the session. */
  marked: number;
  right: number;
  wrong: number;
  /** Its flags the native check dropped in the last job: a native reading of the sentence got them too. */
  dropped: number;
  flags: FlagView[];
};

export type FlagsView = {
  job: { state: JobState; done: number; total: number; line: string };
  canStart: boolean;
  canCancel: boolean;
  canReset: boolean;
  /** Why "Yours" cannot play (no audio kept for the extension); null when it can. */
  yours: string | null;
  /** Why "Say it right" cannot play (no voice box set); null when it can. */
  sayRight: string | null;
  /** The Sensitivity the session underlines at now (`sensitivityLine`). */
  sensitivity: string;
  checks: CheckView[];
};

type State = {
  get(name: string): Promise<unknown>;
  set(name: string, value: unknown): Promise<void>;
};

export type FlagCheckDeps = {
  state: State | undefined;
  personal: Personal;
  /** The newest English pieces with full-rate audio, up to `limit`. */
  list: (limit: number) => Promise<PastPiece[]>;
  /** A piece's audio, at its full rate and at 16 kHz. */
  read: (wav: string) => Promise<{ full: Wav; audio: Float32Array }>;
  /** The scoring worker, started; rejects when `signal` aborts first. */
  worker: (signal: AbortSignal) => Promise<ScanWorker>;
  natives: () => NativeStats | null;
  /** The checks whose switch is on now (`checks.ts`'s `switchedOn`). */
  switchedOn: () => ReadonlySet<CheckId>;
  /** The Sensitivity step now (`sensitivity.ts`'s `sensitivityOf`); left out, the default. */
  sensitivity?: () => Sensitivity;
  /** The native check (`native-control.ts`) while its setting is on; null, or left out, when off. */
  control?: () => Pick<NativeControl, "natives"> | null;
  voice: Pick<Voice, "yours" | "sayRight"> | null;
  /** Why "Say it right" cannot be made now; null when a voice box is set. */
  sayRight: () => string | null;
  now?: () => number;
  log: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

export const NO_VOICE = "Your audio cannot be played: the extension has no folder for clips";
export const GONE = "That recording is no longer kept: prifly deleted it to stay under its cap";

const EMPTY: Stored = { v: 1, scanned: 0, total: 0, complete: false, flags: [] };

const errorText = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

/** "about 4 minutes left", "under a minute left". */
function leftWords(seconds: number): string {
  if (seconds < 60) return "under a minute left";
  const minutes = Math.round(seconds / 60);
  return `about ${minutes} minute${minutes === 1 ? "" : "s"} left`;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

type Stats = NativeStats | null;

/** Every flag of a scanned piece: the worker's and the vowels'. */
export function flagsOfScan(answer: ScanAnswer, stats: Stats): Flag[] {
  return [...answer.flags, ...vowelFlags(answer.scores, stats)];
}

/** The piece's flags as kept: each with its word, its sentence and where its audio is. */
export function storedFlags(piece: PastPiece, flags: readonly Flag[]): StoredFlag[] {
  return flags.flatMap((flag): StoredFlag[] => {
    const word = piece.words[flag.index];
    if (word === undefined) return [];
    return [
      {
        id: `${piece.id}#${flag.index}#${flag.check}`,
        check: flag.check,
        score: flag.score,
        word: word.text,
        sentence: piece.text,
        start: word.start,
        end: word.end,
        sound: flag.sound,
        fix: flag.fix,
        wav: piece.wav,
        fromMs: word.startMs,
        toMs: word.endMs,
      },
    ];
  });
}

export class FlagCheck {
  private readonly deps: FlagCheckDeps;
  private readonly now: () => number;
  private stored: Stored = EMPTY;
  private job: Job = { state: "idle", done: 0, total: 0, error: "", since: null };
  private abort: AbortController | null = null;
  private worker: ScanWorker | null = null;
  private run = 0;
  private task: Promise<void> = Promise.resolve();
  private loaded: Promise<void> = Promise.resolve();

  constructor(deps: FlagCheckDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  /** The kept flags read: a job that finished is done, one that stopped early (cancelled, or prifly closed) stopped. */
  load(): Promise<void> {
    this.loaded = (async () => {
      const parsed = Stored.safeParse(await this.deps.state?.get(FLAGS));
      if (!parsed.success || this.busy()) return;
      this.stored = parsed.data;
      const { scanned, total, complete } = parsed.data;
      this.job = {
        state: complete ? "done" : "cancelled",
        done: scanned,
        total,
        error: "",
        since: null,
      };
    })();
    return this.loaded;
  }

  private busy(): boolean {
    return this.job.state === "listing" || this.job.state === "running";
  }

  /** A job started, unless one runs; its work goes on in the background. */
  async start(): Promise<void> {
    await this.loaded.catch(() => undefined);
    if (this.busy()) return;
    const run = ++this.run;
    const abort = new AbortController();
    this.abort = abort;
    this.job = { state: "listing", done: 0, total: 0, error: "", since: null };
    this.task = this.score(run, abort.signal).catch((caught: unknown) => {
      if (run !== this.run) return;
      this.deps.log("flagCheckFailed", { error: errorText(caught) });
      this.job = { ...this.job, state: "failed", error: errorText(caught) };
      return this.save(run, false);
    });
  }

  /** The running job stopped; what it found so far stays. */
  cancel(): void {
    if (!this.busy()) return;
    this.abort?.abort(new Error("Cancelled"));
    this.worker?.stop();
    this.job = { ...this.job, state: "cancelled" };
  }

  /** Resolves once the job started last has ended: for tests. */
  settled(): Promise<void> {
    return this.task;
  }

  private async score(run: number, signal: AbortSignal): Promise<void> {
    const pieces = await this.deps.list(SCAN_PIECES);
    if (signal.aborted || run !== this.run) return;
    if (pieces.length === 0) {
      this.job = { ...this.job, state: "empty" };
      return;
    }
    this.job = { ...this.job, state: "running", total: pieces.length };
    let worker: ScanWorker;
    try {
      worker = await this.deps.worker(signal);
    } catch (caught) {
      // Cancelled while the model started: the flags of the last job stay as they were.
      if (signal.aborted) return;
      throw caught;
    }
    this.worker = worker;
    if (signal.aborted || run !== this.run) {
      worker.stop();
      return;
    }
    this.stored = { v: 1, scanned: 0, total: pieces.length, complete: false, flags: [] };
    try {
      this.job.since = this.now();
      await this.each(run, signal, worker, pieces);
    } finally {
      worker.stop();
      if (this.worker === worker) this.worker = null;
    }
  }

  /** One piece's flags; none when its recording can no longer be read (prifly pruned it). Throws when the worker fails it. */
  private async scanOne(worker: ScanWorker, piece: PastPiece): Promise<StoredFlag[]> {
    let audio: Float32Array;
    try {
      ({ audio } = await this.deps.read(piece.wav));
    } catch (caught) {
      this.deps.log("flagPieceUnread", { piece: piece.id, error: errorText(caught) });
      return [];
    }
    const words = piece.words.map((word) => ({
      word: word.text,
      from: Math.max(0, Math.round(word.startMs * SAMPLES_PER_MS)),
      to: Math.max(0, Math.round(word.endMs * SAMPLES_PER_MS)),
    }));
    const stats = this.deps.natives();
    const flags = flagsOfScan(await worker.scan(audio, words), stats);
    return storedFlags(piece, await this.nativeKept(worker, piece, flags, stats));
  }

  /**
   * `flags` without those a native reading of the sentence gets too, scanned the same way
   * (`native-control.ts`), each check's count of them added to `dropped`; all of them when the
   * native check is off, and when no reading could be judged (counted in `unchecked`).
   */
  private async nativeKept(worker: ScanWorker, piece: PastPiece, flags: Flag[], stats: Stats) {
    const control = this.deps.control?.() ?? null;
    if (control === null || flags.length === 0) return flags;
    const words = piece.words.map((word) => word.text);
    const answer = await control.natives(piece.text, words, async (audio, asked) =>
      flagsOfScan(await worker.scan(audio, asked), stats),
    );
    const { marks, fields } = withNatives(flags, answer);
    const dropped = { ...this.stored.dropped };
    for (const { check } of marks.filter((one) => one.native))
      dropped[check] = (dropped[check] ?? 0) + 1;
    const unchecked = (this.stored.unchecked ?? 0) + (answer.error === null ? 0 : 1);
    this.stored = { ...this.stored, dropped, unchecked };
    this.deps.log("control", { piece: piece.id, ...fields });
    return marks.filter((one) => !one.native);
  }

  private async each(
    run: number,
    signal: AbortSignal,
    worker: ScanWorker,
    pieces: readonly PastPiece[],
  ): Promise<void> {
    const live = () => !signal.aborted && run === this.run;
    let failed = 0;
    for (const piece of pieces) {
      if (!live()) break;
      const before = failed;
      const found = await this.scanOne(worker, piece).catch((caught: unknown) => {
        if (!live()) return null;
        failed++;
        this.deps.log("flagPieceFailed", { piece: piece.id, error: errorText(caught) });
        if (failed >= MAX_FAILED) throw caught;
        return [];
      });
      // Cancelled while the piece, or a native reading of it, was scored: it is not counted.
      if (found === null || !live()) break;
      // Only failures in a row stop the job.
      if (failed === before) failed = 0;
      this.stored = { ...this.stored, flags: [...this.stored.flags, ...found] };
      this.job.done++;
      this.stored = { ...this.stored, scanned: this.job.done };
      if (this.job.done % SAVE_EVERY === 0) await this.save(run, false);
    }
    if (run !== this.run) return;
    const complete = !signal.aborted;
    if (complete) this.job = { ...this.job, state: "done" };
    await this.save(run, complete);
  }

  private async save(run: number, complete: boolean): Promise<void> {
    if (run !== this.run) return;
    this.stored = { ...this.stored, complete };
    try {
      await this.deps.state?.set(FLAGS, this.stored);
    } catch (caught) {
      this.deps.log("flagSaveFailed", { error: errorText(caught) });
    }
  }

  /** The reader's verdict on a flag; null takes it back. */
  async mark(id: string, verdict: Verdict | null): Promise<void> {
    const flag = this.stored.flags.find((one) => one.id === id);
    if (flag === undefined) throw new Error("That flag is no longer in the list: score again");
    await this.deps.personal.mark(id, verdict, flag.check, flag.score);
  }

  /** Every mark cleared, the "Not a mistake" ones of the session included. */
  reset(): Promise<void> {
    return this.deps.personal.reset();
  }

  /** The file of the flag's word, the reader's own ("yours") or said right ("right"). */
  async play(id: string, which: "yours" | "right"): Promise<string> {
    const flag = this.stored.flags.find((one) => one.id === id);
    if (flag === undefined) throw new Error("That flag is no longer in the list: score again");
    const { voice } = this.deps;
    if (voice === null) throw new Error(NO_VOICE);
    const why = which === "right" ? this.deps.sayRight() : null;
    if (why !== null) throw new Error(why);
    let full: Wav;
    try {
      ({ full } = await this.deps.read(flag.wav));
    } catch (caught) {
      this.deps.log("flagPlayFailed", { error: errorText(caught) });
      throw new Error(GONE);
    }
    const from = Math.round((flag.fromMs / 1000) * full.rate);
    const to = Math.max(from, Math.round((flag.toMs / 1000) * full.rate));
    const samples = full.samples.slice(from, to);
    if (which === "yours") return voice.yours({ rate: full.rate, samples });
    return voice.sayRight({
      key: `flag\n${id}`,
      text: flag.word,
      clip: resample(samples, full.rate, PIECE_RATE),
      pool: [full],
    });
  }

  /** The job and the flags as the page shows them. */
  view(): FlagsView {
    const { personal } = this.deps;
    const on = this.deps.switchedOn();
    const checks = CHECK_IDS.map((id): CheckView => {
      const flags = this.stored.flags
        .filter((one) => one.check === id)
        .sort((a, b) => b.score - a.score);
      const verdicts = flags.map((one) => personal.verdictOf(one.id));
      const tally = personal.tally(id);
      return {
        id,
        title: CHECK_LABELS[id],
        on: on.has(id),
        line: tallyLine(id, tally, on.has(id)),
        ...tally,
        dropped: this.stored.dropped?.[id] ?? 0,
        flags: flags.map((one, at) => ({
          id: one.id,
          word: one.word,
          before: one.sentence.slice(0, one.start),
          after: one.sentence.slice(one.end),
          score: one.score.toFixed(2),
          sound: one.sound,
          fix: one.fix,
          verdict: verdicts[at] ?? null,
        })),
      };
    });
    return {
      job: { state: this.job.state, done: this.job.done, total: this.job.total, line: this.line() },
      canStart: !this.busy(),
      canCancel: this.busy(),
      canReset: personal.count() > 0,
      yours: this.deps.voice === null ? NO_VOICE : null,
      sayRight: this.deps.sayRight(),
      sensitivity: sensitivityLine(this.deps.sensitivity?.() ?? 0),
      checks,
    };
  }

  /** The line beside the buttons. */
  private line(): string {
    const { state, done, total, error } = this.job;
    const flags = plural(this.stored.flags.length, "flag");
    const lines: Record<JobState, () => string> = {
      idle: () =>
        `Scores your last ${SCAN_PIECES} English sentences with every check, the ones switched off too. Mark each flag Right or Wrong: each check's tally shows how often it was wrong for you, and which switch in ${WHERE_SWITCHES} turns it off.`,
      listing: () => "Finding your English recordings…",
      running: () => this.runningLine(),
      done: () => `Scored ${plural(done, "sentence")}: ${flags}${this.uncheckedWords()}`,
      cancelled: () =>
        done === 0
          ? "Cancelled before any sentence was scored"
          : `Stopped after ${done} of ${total} sentences: ${flags} so far`,
      failed: () => `Scoring stopped: ${error}`,
      empty: () =>
        "No English recordings with full audio to score. Turn on Settings, Dictation, Keep recordings of my dictation, dictate in English for a while, then score again.",
    };
    return lines[state]();
  }

  /** ", 3 sentences not checked against a native reading": those the native check could not judge a reading of. */
  private uncheckedWords(): string {
    const unchecked = this.stored.unchecked ?? 0;
    if (unchecked === 0) return "";
    return `, ${plural(unchecked, "sentence")} not checked against a native reading`;
  }

  /** "Scoring 37 of 200, about 4 minutes left". */
  private runningLine(): string {
    const { done, total, since } = this.job;
    if (since === null) return `Starting the model to score ${plural(total, "sentence")}…`;
    const left =
      done === 0
        ? "working out how long"
        : leftWords((((this.now() - since) / done) * (total - done)) / 1000);
    return `Scoring ${Math.min(total, done + 1)} of ${total}, ${left}`;
  }
}
