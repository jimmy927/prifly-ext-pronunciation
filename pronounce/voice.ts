/**
 * The two buttons of a mark's card: "Yours", the reader's own word cut from
 * the piece audio the coach keeps, and "Say it right", the same text said
 * correctly in the reader's own voice at the reader's own speed.
 *
 * "Say it right" is the research run's variant B: a British reading (Edge
 * TTS en-GB-RyanNeural, kept at its native 24 kHz), converted into the
 * reader's voice by Seed-VC's 44.1 kHz f0-conditioned model, with the
 * conversion's `--length-adjust` set to the reader's clip length over the
 * reading's, so the clip comes out as long as the reader's own. Everything
 * handed back is 44.1 kHz or more: a reading or a conversion that is not is
 * refused, and the reader's own 16 kHz cut is resampled up (its content stays
 * band-limited to 8 kHz; prifly gives an extension no fuller audio).
 *
 * The models run on a GPU box (`SeedVcBox` in `box.ts`); what the box does is
 * a `Pipeline`, so tests run it over fakes. Clips are cached per piece in
 * `dir`, made on first click, one at a time per clip.
 */

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeWav, encodeWav, resampleUp, secondsOf, type Wav } from "./wav";

/** The piece audio's rate. */
export const PIECE_RATE = 16_000;
/** Nothing is handed to the reader below this. */
export const MIN_RATE = 44_100;
/** The reading is kept at Edge's native rate: no downsampling. */
export const READING_RATE = 24_000;
export const READING_VOICE = "en-GB-RyanNeural";
/** Seed-VC's `--length-adjust` stays inside these, so a clip of one odd word cannot ask for the impossible. */
export const MIN_ADJUST = 0.4;
export const MAX_ADJUST = 2.5;
/** About how much of the reader's voice the reference holds, in seconds. */
const REFERENCE_SECONDS = 20;
const REFERENCE_PIECES = 3;

/** Seed-VC's flags for the 44.1 kHz f0-conditioned model; the rest are the box's paths. */
export const SEED_FLAGS = [
  "--f0-condition",
  "True",
  "--auto-f0-adjust",
  "True",
  "--diffusion-steps",
  "100",
  "--inference-cfg-rate",
  "0.7",
] as const;

/** What the GPU box does. */
export type Pipeline = {
  /** `text` read in `READING_VOICE`, at its native 24 kHz. */
  read(text: string): Promise<Wav>;
  /** `reading` in the voice of `reference` (a wav), stretched by `lengthAdjust`, with `flags`. */
  convert(job: {
    reading: Wav;
    reference: Wav;
    referenceKey: string;
    lengthAdjust: number;
    flags: readonly string[];
  }): Promise<Wav>;
};

export type VoiceDeps = {
  /** The folder clips are kept in. */
  dir: string;
  /** The pipeline now, or why there is none (the box is not set up). */
  pipeline: () => Pipeline | string;
  /** The reader's own reference wav from the settings, when they gave one. */
  referenceFile?: () => Promise<Wav | null>;
  log?: (event: string, fields: Record<string, string | number | boolean | null>) => void;
};

export type SayRightJob = {
  /** What the clip is cached under: the piece (or the corrected word). */
  key: string;
  text: string;
  /** The reader's own audio of `text`, 16 kHz. */
  clip: Float32Array;
  /** Other audio of the reader, 16 kHz, for a voice reference when none is set. */
  pool: readonly Float32Array[];
};

const hashOf = (...parts: (string | Uint8Array)[]): string => {
  const hash = createHash("sha1");
  for (const part of parts) hash.update(part).update("\0");
  return hash.digest("hex").slice(0, 20);
};

const bytesOf = (samples: Float32Array) =>
  new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);

/** How loud the speech is over how loud the floor is, dB: the cleanest piece has most. */
function cleanliness(samples: Float32Array): number {
  const frame = PIECE_RATE / 50;
  const levels: number[] = [];
  for (let at = 0; at + frame <= samples.length; at += frame) {
    let sum = 0;
    for (let i = at; i < at + frame; i += 1) sum += (samples[i] ?? 0) ** 2;
    levels.push(Math.sqrt(sum / frame) + 1e-9);
  }
  if (levels.length < 10) return Number.NEGATIVE_INFINITY;
  levels.sort((a, b) => a - b);
  const floor = levels[Math.floor(levels.length * 0.1)] ?? 1;
  const speech = levels[Math.floor(levels.length * 0.9)] ?? 1;
  return 20 * Math.log10(speech / floor);
}

/** The reader's cleanest pieces, up to about 20 s and three of them, joined with half a second between. */
export function referenceFrom(pool: readonly Float32Array[]): Wav | null {
  const ranked = pool
    .map((samples) => ({ samples, score: cleanliness(samples) }))
    .filter((one) => Number.isFinite(one.score))
    .sort((a, b) => b.score - a.score);
  const chosen: Float32Array[] = [];
  let seconds = 0;
  for (const { samples } of ranked) {
    if (seconds >= REFERENCE_SECONDS || chosen.length >= REFERENCE_PIECES) break;
    chosen.push(samples, new Float32Array(PIECE_RATE / 2));
    seconds += samples.length / PIECE_RATE + 0.5;
  }
  if (chosen.length === 0) return null;
  const joined = new Float32Array(chosen.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of chosen) {
    joined.set(part, at);
    at += part.length;
  }
  return { rate: MIN_RATE, samples: resampleUp(joined, PIECE_RATE, MIN_RATE) };
}

export class Voice {
  private readonly deps: VoiceDeps;
  private readonly making = new Map<string, Promise<string>>();

  constructor(deps: VoiceDeps) {
    this.deps = deps;
  }

  /** The reader's own audio as a wav at 44.1 kHz; its path. */
  yours(clip: Float32Array): Promise<string> {
    const file = join(this.deps.dir, `yours-${hashOf(bytesOf(clip))}.wav`);
    return this.once(file, async () => {
      await writeWav(file, resampleUp(clip, PIECE_RATE, MIN_RATE), MIN_RATE);
    });
  }

  /** `job.text` said correctly in the reader's voice and speed; the path of a wav at 44.1 kHz or more. */
  sayRight(job: SayRightJob): Promise<string> {
    // The clip is in the key: a correction of the same piece with other words is another clip.
    const file = join(this.deps.dir, `say-${hashOf(job.key, job.text, bytesOf(job.clip))}.wav`);
    return this.once(file, async () => {
      const pipeline = this.deps.pipeline();
      if (typeof pipeline === "string") throw new Error(pipeline);
      const reference =
        (await this.deps.referenceFile?.()) ?? referenceFrom(job.pool) ?? failNoReference();
      const reading = await pipeline.read(job.text);
      if (reading.rate !== READING_RATE) {
        throw new Error(`The reading came at ${reading.rate} Hz, not its native ${READING_RATE}`);
      }
      const asked = job.clip.length / PIECE_RATE / secondsOf(reading);
      const lengthAdjust = Math.min(MAX_ADJUST, Math.max(MIN_ADJUST, asked));
      this.deps.log?.("sayRight", { asked, lengthAdjust, reading: secondsOf(reading) });
      const made = await pipeline.convert({
        reading,
        reference,
        referenceKey: hashOf(bytesOf(reference.samples), String(reference.rate)),
        lengthAdjust,
        flags: SEED_FLAGS,
      });
      if (made.rate < MIN_RATE) {
        throw new Error(`The conversion came at ${made.rate} Hz, below ${MIN_RATE}: not kept`);
      }
      await writeWav(file, made.samples, made.rate);
    });
  }

  /** `file` when it is already made, else made by `make` once however many ask meanwhile. */
  private once(file: string, make: () => Promise<void>): Promise<string> {
    const running = this.making.get(file);
    if (running !== undefined) return running;
    const task = (async () => {
      if (await exists(file)) return file;
      await mkdir(this.deps.dir, { recursive: true });
      await make();
      return file;
    })();
    this.making.set(file, task);
    const forget = () => this.making.delete(file);
    task.then(forget, forget);
    return task;
  }
}

function failNoReference(): never {
  throw new Error("No voice reference yet: dictate a few pieces first, or set a reference file");
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

/** Written whole under a temporary name, so a half-made clip is never played. */
async function writeWav(file: string, samples: Float32Array, rate: number): Promise<void> {
  const temp = `${file}.part`;
  await writeFile(temp, encodeWav(samples, rate));
  await rename(temp, file);
}

/** A wav file read, for the reference setting. */
export async function readReference(path: string): Promise<Wav> {
  return decodeWav(await readFile(path));
}
