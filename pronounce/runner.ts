/**
 * The pronunciation worker (`worker.ts`) as the extension runs it: its
 * files fetched the first time (`downloading`, with each file's progress),
 * then started (`loading` until it says `ready`), started again after 1, 2,
 * 4 … 30 s when it dies, and `failed` after five deaths in a row, a fetch
 * that failed or a file whose sha256 was not the pinned one — until it is
 * stopped and started again (the extension disabled and enabled). Dictation
 * never waits on it: a piece is judged only while it is `ready`, else not at
 * all.
 */

import { MAX_FAILURES, PendingCalls, readLine, restartWait } from "./calls";
import { ShaMismatch } from "./download";
import type { JudgeWord } from "./judge";
import type { Fetching, PronounceFiles } from "./models";
import { encodeFloats } from "./pcm";
import { type PronounceArgs, PronounceLine } from "./protocol";
import type { Judgement } from "./scores";
import type { WorkerPipe } from "./worker-pipe";

/**
 * Intra-op threads the model gets: the reader's work and dictation keep the
 * rest of the cores. The uint8 model took 75 / 55 / 55 ms per audio second at
 * 2 / 4 / 8 threads (13-speaker Speech Accent Archive benchmark): 4 is where
 * it stops getting faster.
 */
export const PRONOUNCE_THREADS = 4;

export type PronounceState = "off" | "downloading" | "loading" | "ready" | "failed";

export type Log = (
  event: string,
  fields?: Record<string, string | number | boolean | null>,
) => void;

export type RunnerDeps = {
  /** Fetch what is missing, stopping when `signal` aborts; the files' paths. */
  ensure: (progress: (at: Fetching) => void, signal: AbortSignal) => Promise<PronounceFiles>;
  spawn: (args: PronounceArgs) => WorkerPipe;
  /** The state, the download's progress or the error changed. */
  onChange: () => void;
  log: Log;
  /** Tests make the wait short. */
  backoffMs?: (failures: number) => number;
};

/** Why a fetch failed, as the status line says it. */
function fetchError(caught: unknown): string {
  const message = caught instanceof Error ? caught.message : String(caught);
  if (caught instanceof ShaMismatch) return `sha256 mismatch, nothing kept: ${message}`;
  return `download failed: ${message}`;
}

export class PronounceRunner {
  state: PronounceState = "off";
  /** The file on its way while `downloading`; null before its first byte. */
  fetching: Fetching | null = null;
  /** Why it is `failed`; "" otherwise. */
  error = "";
  private pipe: WorkerPipe | null = null;
  private readonly calls = new PendingCalls<Judgement>();
  private generation = 0;
  private failures = 0;
  private unavailable: string | null = null;
  private abort: AbortController | null = null;
  private restart: ReturnType<typeof setTimeout> | null = null;
  private readonly deps: RunnerDeps;

  constructor(deps: RunnerDeps) {
    this.deps = deps;
  }

  private set(state: PronounceState, error = ""): void {
    if (state === this.state && error === this.error) return;
    this.state = state;
    this.error = error;
    if (state !== "downloading") this.fetching = null;
    this.deps.onChange();
  }

  /** A file's progress, told once per whole percent (or per MB when its size is unknown). */
  private progress(generation: number, at: Fetching): void {
    if (generation !== this.generation) return;
    const step = (one: Fetching) =>
      one.total > 0 ? Math.floor((one.done / one.total) * 100) : Math.floor(one.done / 1e6);
    const was = this.fetching;
    if (was !== null && was.file === at.file && step(was) === step(at)) return;
    this.fetching = { ...at };
    this.deps.onChange();
  }

  /** Fetch and start it from `off`; nothing in any other state. A `failed` one stays so until it is stopped. */
  async start(): Promise<void> {
    if (this.state !== "off") return;
    const generation = ++this.generation;
    this.failures = 0;
    this.unavailable = null;
    const abort = new AbortController();
    this.abort = abort;
    this.set("downloading");
    try {
      const files = await this.deps.ensure((at) => this.progress(generation, at), abort.signal);
      if (generation !== this.generation) return;
      this.launch(generation, { ...files, threads: PRONOUNCE_THREADS });
    } catch (caught) {
      if (generation !== this.generation) return;
      this.deps.log("fetchFailed", { error: String(caught) });
      this.set("failed", fetchError(caught));
    } finally {
      if (this.abort === abort) this.abort = null;
    }
  }

  private launch(generation: number, args: PronounceArgs): void {
    this.set("loading");
    const pipe = this.deps.spawn(args);
    this.pipe = pipe;
    pipe.onLine((line) => this.onLine(generation, line));
    void pipe.exited.then((code) => this.onExit(generation, args, pipe, code));
  }

  private onLine(generation: number, line: string): void {
    if (generation !== this.generation) return;
    const msg = readLine(PronounceLine, line);
    if (msg === null) {
      this.deps.log("badLine", { line: line.slice(0, 200) });
      return;
    }
    if (msg.type === "ready") {
      this.failures = 0;
      this.deps.log("ready", {});
      this.set("ready");
    } else if (msg.type === "marks") {
      this.deps.log("judged", { ms: Math.round(msg.ms), marks: msg.marks.length });
      this.calls.answer(msg.id, { marks: msg.marks, scores: msg.scores });
    } else if (msg.type === "unavailable") {
      this.unavailable = msg.message;
    } else if (msg.type === "flags") {
      // Only a scan is answered with flags, and this worker is asked for none (`scan-worker.ts` is).
      this.deps.log("badLine", { line: line.slice(0, 200) });
    } else {
      this.deps.log("judgeError", { message: msg.message });
      this.calls.answer(msg.id, null);
    }
  }

  private onExit(generation: number, args: PronounceArgs, pipe: WorkerPipe, code: number): void {
    if (generation !== this.generation) return;
    this.calls.dropAll();
    this.pipe = null;
    if (this.unavailable !== null) {
      this.set("failed", `onnxruntime could not load on this machine: ${this.unavailable}`);
      return;
    }
    this.failures++;
    const said = pipe.stderrTail?.() ?? "";
    this.deps.log("workerExit", { code, failures: this.failures, stderr: said });
    if (this.failures >= MAX_FAILURES) {
      const why = said === "" ? "" : `: ${said}`;
      this.set("failed", `the worker crashed ${this.failures} times (exit ${code})${why}`);
      return;
    }
    this.set("loading");
    const wait = this.deps.backoffMs?.(this.failures) ?? restartWait(this.failures);
    this.restart = setTimeout(() => {
      this.restart = null;
      if (generation === this.generation) this.launch(generation, args);
    }, wait);
  }

  /** Stop the worker, or the fetch on its way; its exit is not counted as a failure. */
  stop(): void {
    this.generation++;
    this.abort?.abort();
    this.abort = null;
    if (this.restart !== null) clearTimeout(this.restart);
    this.restart = null;
    this.pipe?.signal("SIGTERM");
    this.pipe = null;
    this.calls.dropAll();
    this.set("off");
  }

  /**
   * The words of `audio` said otherwise, by every check, and its content words' scores; null
   * while the worker is not ready, or when it could not say.
   */
  judge(audio: Float32Array, words: readonly JudgeWord[]): Promise<Judgement | null> {
    const { pipe } = this;
    if (this.state !== "ready" || pipe === null || words.length === 0) return Promise.resolve(null);
    // Only what the worker's strict request takes.
    const asked = words.map(({ word, from, to }) => ({ word, from, to }));
    return this.calls.ask(pipe, (id) => ({
      op: "judge",
      id,
      pcm: encodeFloats(audio),
      words: asked,
    }));
  }
}
