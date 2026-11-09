/**
 * The words the reader said were no mistake: "Not a mistake" on an
 * underline keeps that word with what was heard in it, and the pair is
 * never underlined again. Kept in `api.state` as `not-mistakes`
 * (`coach.ts`), read tolerantly.
 */

import { z } from "zod";
import { wordKey } from "./dictionary";

/** A word, and the phones heard in it that the reader accepted. */
export type NotMistake = { word: string; heard: string };

/** The pairs as stored: one that cannot be read is dropped, and the rest kept. */
export const StoredNotMistakes = z
  .array(z.object({ word: z.string(), heard: z.string() }).nullable().catch(null))
  .catch([])
  .transform((pairs) => pairs.filter((pair) => pair !== null));

/** The most pairs kept; the oldest go first. */
export const MAX_NOT_MISTAKES = 500;

const same = (pair: NotMistake, word: string, heard: string): boolean =>
  wordKey(pair.word) === wordKey(word) && pair.heard === heard;

/** `pairs` with `word` heard as `heard` among them, newest last. */
export function withNotMistake(
  pairs: readonly NotMistake[],
  word: string,
  heard: string,
): NotMistake[] {
  const rest = pairs.filter((pair) => !same(pair, word, heard));
  return [...rest, { word, heard }].slice(-MAX_NOT_MISTAKES);
}

/** Whether the reader said `word` heard as `heard` is no mistake. */
export function isNotMistake(pairs: readonly NotMistake[], word: string, heard: string): boolean {
  return pairs.some((pair) => same(pair, word, heard));
}
