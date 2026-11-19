/**
 * The body of the pronunciation worker (`worker.ts`): the phoneme model, its
 * vocabulary and the dictionary loaded once, at a low priority (`workerPriority`),
 * then requests answered one at a time in the order they come
 * until stdin ends. The model itself is handed in (`phone-model.ts`), so
 * tests run all of this over a fake one.
 */

import { constants, setPriority } from "node:os";
import { posteriors } from "./ctc";
import { type Dictionary, mergeDictionaries, parseCmudict, parseDictionary } from "./dictionary";
import { judgeWords, type Vocab, vocabFrom } from "./judge";
import { exitWhenOrphaned } from "./lifetime";
import { decodeFloats } from "./pcm";
import { JudgeRequest, type PronounceArgs, type PronounceLine } from "./protocol";
import { loadStressCheck, type StressCheck, stressMarks } from "./stress";
import { loadThresholds, type Thresholds } from "./thresholds";

/** What the worker needs of the model: logits per frame for normalised 16 kHz audio. */
export type PhoneModel = {
  logits: (audio: Float32Array) => Promise<{ data: Float32Array; frames: number; size: number }>;
};

export type OpenModel = (path: string, threads: number) => Promise<PhoneModel>;

export type Loaded = {
  model: PhoneModel;
  vocab: Vocab;
  dictionary: Dictionary;
  thresholds: Thresholds;
  /** Word stress (`stress.ts`); null while the calibration files do not turn it on. */
  stress: StressCheck | null;
};

/** `audio` scaled to zero mean and unit variance, as the model was trained on (`do_normalize`). */
export function normalised(audio: Float32Array): Float32Array {
  let mean = 0;
  for (const sample of audio) mean += sample;
  mean /= Math.max(1, audio.length);
  let variance = 0;
  for (const sample of audio) variance += (sample - mean) ** 2;
  const scale = 1 / Math.sqrt(variance / Math.max(1, audio.length) + 1e-7);
  return audio.map((sample) => (sample - mean) * scale);
}

/** The model, `vocab.json`, Britfone and CMUdict as `args` names them, the checks' cut-offs (`thresholds.ts`) and word stress's (`stress.ts`, with `native-stats.json` beside `thresholds.json`). */
export async function loadAll(
  args: PronounceArgs,
  open: OpenModel,
  thresholdsPath?: string,
): Promise<Loaded> {
  const json = (await Bun.file(args.vocab).json()) as Record<string, number>;
  const dictionary = mergeDictionaries(
    parseDictionary(await Bun.file(args.dictionary).text()),
    parseCmudict(await Bun.file(args.cmudict).text()),
  );
  const thresholds = await loadThresholds(thresholdsPath);
  const stress = await loadStressCheck(thresholdsPath);
  const model = await open(args.model, args.threads);
  return { model, vocab: vocabFrom(json), dictionary, thresholds, stress };
}

/** One request's marks, or its failure as an `error` line for its id. */
export async function answerJudge(request: JudgeRequest, loaded: Loaded): Promise<PronounceLine> {
  const started = performance.now();
  try {
    const audio = decodeFloats(request.pcm);
    const out = await loaded.model.logits(normalised(audio));
    const post = posteriors(out.data, out.frames, out.size);
    const { stress } = loaded;
    const marks = judgeWords(
      post,
      loaded.vocab,
      loaded.dictionary,
      request.words,
      loaded.thresholds,
      stress === null ? undefined : (read) => stressMarks(read, request.words, audio, stress),
    );
    return { type: "marks", id: request.id, marks, ms: performance.now() - started };
  } catch (caught) {
    return { type: "error", id: request.id, message: String(caught) };
  }
}

/**
 * The priority the worker runs at: nice 19 (`PRIORITY_LOW`) where there is a
 * nice value. On Windows `PRIORITY_LOW` is the idle class, which runs only
 * when no other thread wants a core: the model would stall whenever the
 * reader builds, plays or compiles, and a piece's marks would come minutes
 * late. `PRIORITY_BELOW_NORMAL` still yields to the reader's own programs.
 */
export function workerPriority(platform: NodeJS.Platform = process.platform): number {
  const { PRIORITY_LOW, PRIORITY_BELOW_NORMAL } = constants.priority;
  return platform === "win32" ? PRIORITY_BELOW_NORMAL : PRIORITY_LOW;
}

/**
 * Lowers this process's priority, so the reader's work, dictation and its
 * final words always go first. A system that refuses (a container without
 * the right, a Windows account without the access) leaves it as it is, and
 * says so on stderr, which the extension logs; whatever the failure, the
 * worker goes on.
 */
export function lowPriority(
  set: (priority: number) => void = (p) => setPriority(p),
  platform: NodeJS.Platform = process.platform,
): void {
  try {
    set(workerPriority(platform));
  } catch (caught) {
    const why = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`pronounce: priority not lowered: ${why}\n`);
  }
}

function say(line: PronounceLine): void {
  process.stdout.write(`${JSON.stringify(line)}\n`);
}

/** Load everything and answer requests until stdin ends. */
export async function servePronounce(args: PronounceArgs, open: OpenModel): Promise<void> {
  exitWhenOrphaned();
  lowPriority();
  const loaded = await loadAll(args, open);
  // The first run is slower than the rest: a second of silence before `ready`.
  await loaded.model.logits(new Float32Array(16_000));
  say({ type: "ready" });
  for await (const line of console) {
    if (line.trim() === "") continue;
    say(await answerJudge(JudgeRequest.parse(JSON.parse(line)), loaded));
  }
}
