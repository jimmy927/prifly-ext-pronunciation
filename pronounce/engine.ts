/**
 * Whether onnxruntime's native library loads on this machine, asked by the
 * worker before it imports anything that needs it. A worker that imports it
 * statically and fails dies before it can say why; this one says
 * `unavailable` with the loader's own words and exits, and the runner shows
 * that reason and does not start it again — the same library will not load
 * on a retry. The extension itself (inside prifly's host) never imports
 * onnxruntime.
 */

import type { InferenceSession } from "onnxruntime-node";

/** The worker's exit code after saying `unavailable`. */
export const EXIT_UNAVAILABLE = 3;

/**
 * "" when onnxruntime loads, or the loader's error. Every error is caught: a
 * native module fails to load in many ways (no file, a missing DLL, a wrong
 * architecture), and each means the same here.
 */
export async function engineLoadError(
  load: () => Promise<unknown> = () => import("onnxruntime-node"),
): Promise<string> {
  try {
    await load();
    return "";
  } catch (caught) {
    return caught instanceof Error ? caught.message : String(caught);
  }
}

/** First thing in the worker: when onnxruntime will not load, say so on stdout and exit. */
export async function requireEngine(load?: () => Promise<unknown>): Promise<void> {
  const failed = await engineLoadError(load);
  if (failed === "") return;
  // Written out in full before the exit, which would otherwise cut a piped stdout short.
  await Bun.write(Bun.stdout, `${JSON.stringify({ type: "unavailable", message: failed })}\n`);
  process.exit(EXIT_UNAVAILABLE);
}

/**
 * The session options for the phoneme model: the CPU execution provider
 * only. onnxruntime-node's Windows package ships DirectML (the GPU) beside
 * the CPU library, and a session with no provider named may pick it; prifly's
 * dictation models fill the GPU, and the model here is sized for 4 CPU
 * threads. Only `phone-model.ts`, in the worker, reads this.
 */
export function cpuSessionOptions(threads: number): InferenceSession.SessionOptions {
  return {
    executionProviders: ["cpu"],
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    logSeverityLevel: 3,
    extra: { session: { intra_op: { allow_spinning: "0" } } },
  };
}
