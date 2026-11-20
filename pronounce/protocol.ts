/**
 * What the extension and its pronunciation worker (`worker.ts`) say to each
 * other, one JSON object per line: the extension sends a piece's audio with the
 * words to check and where each was said, and the worker answers with the
 * words said otherwise (`judge.ts`) and the content words' scores for the
 * accent profile (`scores.ts`). The worker says `ready` once the model and
 * the dictionary are loaded. A `scan` (for "Check your flags", `scan-worker.ts`)
 * is answered with every candidate flag of the piece instead (`flags.ts`).
 */

import { z } from "zod";
import { CHECK_IDS } from "./checks";
import { CONTRAST_IDS } from "./contrasts";

const Words = z.array(
  z.strictObject({
    word: z.string().min(1),
    from: z.number().int().min(0),
    to: z.number().int().min(0),
  }),
);

/** `pcm`: the piece's 16 kHz mono float32 samples, little-endian, base64; each word's samples in it. */
export const JudgeRequest = z.strictObject({
  op: z.literal("judge"),
  id: z.string(),
  pcm: z.string(),
  words: Words,
});
export type JudgeRequest = z.infer<typeof JudgeRequest>;

/** Every candidate flag of a piece, from every check, at loose cut-offs (`flags.ts`), for "Check your flags". */
export const ScanRequest = z.strictObject({
  op: z.literal("scan"),
  id: z.string(),
  pcm: z.string(),
  words: Words,
});
export type ScanRequest = z.infer<typeof ScanRequest>;

export const WorkerRequest = z.discriminatedUnion("op", [JudgeRequest, ScanRequest]);

export const Flag = z.strictObject({
  index: z.number().int().min(0),
  check: z.enum(CHECK_IDS),
  score: z.number(),
  sound: z.string(),
  fix: z.string(),
});

export const Judged = z.strictObject({
  index: z.number().int().min(0),
  /** The check that heard it (`checks.ts`): its switch decides whether it is drawn. */
  check: z.enum(CHECK_IDS),
  word: z.string(),
  heard: z.string(),
  expected: z.string(),
  sound: z.string(),
  how: z.string(),
  posterior: z.number().min(0).max(1),
  /** The mark's level under its check's cut-offs (`thresholds.ts`). */
  level: z.enum(["sure", "maybe"]).optional(),
  /** From which Sensitivity step it is drawn, and drawn sure (`sensitivity.ts`; 3: never sure). */
  steps: z
    .strictObject({
      drawn: z.union([z.literal(0), z.literal(1), z.literal(2)]),
      sure: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    })
    .optional(),
  said: z.string(),
  say: z.string(),
  fix: z.string(),
});

/** A content word's scores for the accent profile (`scores.ts`). */
export const WordScores = z.strictObject({
  index: z.number().int().min(0),
  phones: z.array(z.string()),
  stress: z.number().int(),
  vowels: z.array(
    z.strictObject({ at: z.number().int(), phone: z.string(), lpr: z.number(), rival: z.string() }),
  ),
  contrasts: z.array(
    z.strictObject({
      id: z.enum(CONTRAST_IDS),
      at: z.number().int(),
      phone: z.string(),
      lpr: z.number(),
    }),
  ),
});

export const PronounceLine = z.discriminatedUnion("type", [
  /** The model and the dictionary are loaded, and the model has run once. */
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({
    type: z.literal("marks"),
    id: z.string(),
    marks: z.array(Judged),
    /** The piece's content words scored for the accent profile. */
    scores: z.array(WordScores).default([]),
    ms: z.number(),
  }),
  /** A scan's answer: the piece's candidate flags, and its content words' scores for the vowels'. */
  z.strictObject({
    type: z.literal("flags"),
    id: z.string(),
    flags: z.array(Flag),
    scores: z.array(WordScores).default([]),
    ms: z.number(),
  }),
  z.strictObject({ type: z.literal("error"), id: z.string(), message: z.string() }),
  /** onnxruntime would not load at all: the worker ends, and is not started again (`engine.ts`). */
  z.strictObject({ type: z.literal("unavailable"), message: z.string() }),
]);
export type PronounceLine = z.infer<typeof PronounceLine>;

/** How the extension starts the worker: argv after the script, as base64 of JSON (`encodeArgs`). */
export const PronounceArgs = z.strictObject({
  model: z.string(),
  vocab: z.string(),
  dictionary: z.string(),
  /** CMUdict, the American pronunciations (`dictionary.ts`). */
  cmudict: z.string(),
  /** Intra-op threads: `PRONOUNCE_THREADS` (4), so dictation and the reader's work keep the rest. */
  threads: z.number().int().positive(),
});
export type PronounceArgs = z.infer<typeof PronounceArgs>;

/**
 * `args` as the one argv word the worker takes: base64 of the JSON. Paths on
 * Windows hold backslashes, spaces and sometimes quotes, and a command line is
 * one string there that each program splits by its own rules, so the word is
 * made of characters no rule treats specially.
 */
export function encodeArgs(args: PronounceArgs): string {
  return Buffer.from(JSON.stringify(args), "utf8").toString("base64");
}

/** The arguments `encodeArgs` made; throws on a word that is not them. */
export function decodeArgs(word: string): PronounceArgs {
  return PronounceArgs.parse(JSON.parse(Buffer.from(word, "base64").toString("utf8")));
}
