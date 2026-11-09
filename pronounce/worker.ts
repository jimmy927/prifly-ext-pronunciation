/**
 * The pronunciation worker, a process of its own that the extension starts
 * (`worker-pipe.ts`): the phoneme model on the CPU at low priority, never in
 * prifly's host, where it would hold up the reader's work. Run as
 * `bun pronounce/worker.ts '<PronounceArgs JSON>'`; onnxruntime is imported
 * only once it is known to load (`engine.ts`).
 */

import { requireEngine } from "./engine";
import { PronounceArgs } from "./protocol";

await requireEngine();
const { openPhoneModel } = await import("./phone-model");
const { servePronounce } = await import("./serve");
await servePronounce(PronounceArgs.parse(JSON.parse(Bun.argv[2] ?? "{}")), openPhoneModel);
process.exit(0);
