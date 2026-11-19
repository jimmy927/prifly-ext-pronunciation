/**
 * wav2vec2-lv-60-espeak through onnxruntime-node, on the CPU only — never
 * the GPU, which prifly's dictation models fill — with the threads the
 * extension gives it (`PRONOUNCE_THREADS`), one inter-op thread, and pools
 * that do not spin while idle. Its input is the piece's audio, already
 * normalised (`serve.ts`), its output a row of logits per 20 ms frame. Only
 * the worker imports this (`worker.ts`), once onnxruntime is known to load.
 */

import * as ort from "onnxruntime-node";
import { cpuSessionOptions } from "./engine";
import type { PhoneModel } from "./serve";

/** The model at `path`; `options` other than the CPU's only for `tools/calibrate/dump.ts`, never in the worker. */
export async function openPhoneModel(
  path: string,
  threads: number,
  options: ort.InferenceSession.SessionOptions = cpuSessionOptions(threads),
): Promise<PhoneModel> {
  const session = await ort.InferenceSession.create(path, options);
  const masked = session.inputNames.includes("attention_mask");
  return {
    logits: async (audio) => {
      const input = new ort.Tensor("float32", audio, [1, audio.length]);
      const feeds: Record<string, ort.Tensor> = { input_values: input };
      if (masked) {
        const ones = new BigInt64Array(audio.length).fill(1n);
        feeds["attention_mask"] = new ort.Tensor("int64", ones, [1, audio.length]);
      }
      const out = (await session.run(feeds))["logits"];
      if (out === undefined) throw new Error("the phoneme model gave no logits");
      const [, frames = 0, size = 0] = out.dims;
      return { data: out.data as Float32Array, frames, size };
    },
  };
}
