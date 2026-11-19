/** Synthetic native statistics and scored words for the accent profile's tests: no model. */

import { type NativeStats, parseNativeStats } from "../pronounce/native";
import type { ScoredWord } from "../pronounce/profile";
import type { WordScores } from "../pronounce/scores";

/** A native LPR distribution: p1 -3, p5 -2, p10 -1.5, p50 0, p99 1.5. */
export const CURVE = {
  n: 1000,
  p1: -3,
  p5: -2,
  p10: -1.5,
  p25: -0.8,
  p50: 0,
  p75: 0.5,
  p90: 1,
  p95: 1.2,
  p99: 1.5,
};

/** Natives with the cup vowel, the KIT vowel and z on `CURVE`. */
export function natives(extra: object = {}): NativeStats {
  return parseNativeStats({
    generated: "2026-11-19",
    phones: { z: { lpr: CURVE, lp: CURVE } },
    vowels: { ʌ: { lpr: CURVE, durationMs: CURVE }, ɪ: { lpr: CURVE, durationMs: CURVE } },
    stress: { rmsDb: CURVE },
    ...extra,
  });
}

/** "much" (m ʌ tʃ) with its vowel at `lpr`, the A of "cap" winning over it. */
export function much(lpr: number, rival = "æ", index = 0): WordScores {
  return {
    index,
    phones: ["m", "ʌ", "tʃ"],
    stress: -1,
    vowels: [{ at: 1, phone: "ʌ", lpr, rival }],
    contrasts: [],
  };
}

/** "is" (ɪ z) with its z checked for z-s. */
export function zed(lpr: number, index = 0): WordScores {
  return {
    index,
    phones: ["ɪ", "z"],
    stress: -1,
    vowels: [{ at: 0, phone: "ɪ", lpr: 0.5, rival: "iː" }],
    contrasts: [{ id: "z-s", at: 1, phone: "z", lpr }],
  };
}

export const word = (scores: WordScores, text = "much", from = 1600, to = 8000): ScoredWord => ({
  scores,
  word: text,
  from,
  to,
});

export const WHERE = { sessionId: "s1", dict: "d1", piece: 0 };
export const DAY = 24 * 3600 * 1000;
export const NOW = Date.UTC(2026, 10, 19);
