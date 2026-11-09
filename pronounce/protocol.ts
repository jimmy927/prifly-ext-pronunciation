/**
 * What the extension and its pronunciation worker (`worker.ts`) say to each
 * other, one JSON object per line: the extension sends a piece's audio with the
 * words to check and where each was said, and the worker answers with the
 * words said otherwise (`judge.ts`). The worker says `ready` once the model
 * and the dictionary are loaded.
 */

import { z } from "zod";

/** `pcm`: the piece's 16 kHz mono float32 samples, little-endian, base64; each word's samples in it. */
export const JudgeRequest = z.strictObject({
  op: z.literal("judge"),
  id: z.string(),
  pcm: z.string(),
  words: z.array(
    z.strictObject({
      word: z.string().min(1),
      from: z.number().int().min(0),
      to: z.number().int().min(0),
    }),
  ),
});
export type JudgeRequest = z.infer<typeof JudgeRequest>;

export const Judged = z.strictObject({
  index: z.number().int().min(0),
  word: z.string(),
  heard: z.string(),
  expected: z.string(),
  sound: z.string(),
  how: z.string(),
});

export const PronounceLine = z.discriminatedUnion("type", [
  /** The model and the dictionary are loaded, and the model has run once. */
  z.strictObject({ type: z.literal("ready") }),
  z.strictObject({
    type: z.literal("marks"),
    id: z.string(),
    marks: z.array(Judged),
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
