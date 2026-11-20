/** Where a dictation piece's words sit in its 16 kHz audio, and its full-rate audio when prifly gave it (`coach.ts`). */

import type { DictationPiece } from "@prifly/extension-api";
import type { AudioFull, FullPiece } from "./play-shim";
import { MIN_RATE } from "./voice";

/** Audio samples per millisecond: the piece's audio is 16 kHz. */
const SAMPLES_PER_MS = 16;

/** A word's place in the piece's audio, in samples. */
export function samplesOf(word: { startMs: number; endMs: number }): { from: number; to: number } {
  const from = Math.max(0, Math.round(word.startMs * SAMPLES_PER_MS));
  return { from, to: Math.max(from, Math.round(word.endMs * SAMPLES_PER_MS)) };
}

/** The piece's audio at the device's own rate, when prifly gave it and it is 44.1 kHz or more. */
export function fullRateOf(piece: DictationPiece): AudioFull | undefined {
  const full = (piece as FullPiece).audioFull;
  return full !== undefined && full.rate >= MIN_RATE && full.samples.length > 0 ? full : undefined;
}
