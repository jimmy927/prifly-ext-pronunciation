/**
 * A worker of its own for "Check your flags" (`flag-check.ts`): the same `worker.ts` the
 * underlines use, started beside it on `SCAN_THREADS` threads, so dictation is still judged
 * while the reader's past sentences are scored and the laptop stays usable. It is asked one
 * piece at a time (`scan` requests, `flags.ts`) and stopped when the job ends or is cancelled.
 */

import { readLine } from "./calls";
import type { JudgeWord } from "./judge";
import type { Fetching, PronounceFiles } from "./models";
import { encodeFloats } from "./pcm";
import { type PronounceArgs, PronounceLine } from "./protocol";
import type { WorkerPipe } from "./worker-pipe";

/** Intra-op threads the scoring gets: two, a quarter of an eight-core laptop at most. */
export const SCAN_THREADS = 2;

type Line = PronounceLine;
type FlagsLine = Extract<Line, { type: "flags" }>;

/** What a scanned piece gives: its flags and its content words' scores. */
export type ScanAnswer = Pick<FlagsLine, "flags" | "scores">;

/** The worker as the job holds it. */
export type ScanWorker = {
  scan(audio: Float32Array, words: readonly JudgeWord[]): Promise<ScanAnswer>;
  stop(): void;
};

export type ScanWorkerDeps = {
  ensure: (progress: (at: Fetching) => void, signal: AbortSignal) => Promise<PronounceFiles>;
  spawn: (args: PronounceArgs) => WorkerPipe;
};

/** Why the worker went, with what it last said on stderr. */
function exitError(code: number, pipe: WorkerPipe): Error {
  const said = pipe.stderrTail?.() ?? "";
  return new Error(`The model stopped (exit ${code})${said === "" ? "" : `: ${said}`}`);
}

/** The worker started and `ready`; rejects when it cannot be fetched or started, or `signal` aborts first. */
export async function startScanWorker(
  deps: ScanWorkerDeps,
  signal: AbortSignal,
): Promise<ScanWorker> {
  const files = await deps.ensure(() => undefined, signal);
  signal.throwIfAborted();
  const pipe = deps.spawn({ ...files, threads: SCAN_THREADS });
  const pending = new Map<
    string,
    { resolve: (a: ScanAnswer) => void; reject: (e: Error) => void }
  >();
  let gone: Error | null = null;
  let next = 0;
  let readyNow: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    readyNow = resolve;
  });
  pipe.onLine((text) => {
    const line = readLine(PronounceLine, text);
    if (line === null) return;
    if (line.type === "ready") readyNow();
    else if (line.type === "flags" || line.type === "error") {
      const waiting = pending.get(line.id);
      pending.delete(line.id);
      if (line.type === "flags") waiting?.resolve({ flags: line.flags, scores: line.scores });
      else waiting?.reject(new Error(line.message));
    } else if (line.type === "unavailable") {
      gone = new Error(`onnxruntime could not load on this machine: ${line.message}`);
    }
  });
  const exited = pipe.exited.then((code) => {
    gone ??= exitError(code, pipe);
    for (const one of pending.values()) one.reject(gone);
    pending.clear();
    throw gone;
  });
  const stop = () => pipe.signal("SIGTERM");
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  // Only the race below waits on these; a later exit reaches the pending scans, a later abort the job.
  exited.catch(() => undefined);
  aborted.catch(() => undefined);
  try {
    await Promise.race([ready, exited, aborted]);
  } catch (caught) {
    stop();
    throw caught;
  }
  return {
    scan: (audio, words) => {
      if (gone !== null) return Promise.reject(gone);
      const id = String(++next);
      return new Promise<ScanAnswer>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        pipe.write(
          JSON.stringify({
            op: "scan",
            id,
            pcm: encodeFloats(audio),
            words: words.map(({ word, from, to }) => ({ word, from, to })),
          }),
        );
      });
    },
    stop,
  };
}
