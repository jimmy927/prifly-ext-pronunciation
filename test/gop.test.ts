import { expect, test } from "bun:test";
import type { Posteriors } from "../pronounce/ctc";
import { PhoneSet } from "../pronounce/force-align";
import { phoneScore, stressCues } from "../pronounce/gop";

const TOKENS = ["<pad>", "<s>", "</s>", "<unk>", "t", "d", "æ", "ɾ"];
const set = new PhoneSet(TOKENS);

function framesOf(rows: readonly Record<string, number>[]): Posteriors {
  const size = TOKENS.length;
  const probs = new Float32Array(rows.length * size);
  rows.forEach((row, t) => {
    let left = 1;
    for (const [token, p] of Object.entries(row)) {
      probs[t * size + TOKENS.indexOf(token)] = p;
      left -= p;
    }
    probs[t * size] = Math.max(0, left);
  });
  return { frames: rows.length, size, probs };
}

test("a phone said as written scores above its best competitor", () => {
  const post = framesOf([
    { d: 0.9, t: 0.05 },
    { d: 0.9, t: 0.05 },
  ]);
  const score = phoneScore(post, set, { phone: "d", from: 0, to: 2 });
  // The flap is the same sound as d here, so it is no competitor; t is.
  expect(score.competitor).toBe("t");
  expect(score.lp).toBeCloseTo(Math.log(0.9), 5);
  expect(score.lpCompetitor).toBeCloseTo(Math.log(0.05), 5);
  expect(score.lpr).toBeCloseTo(Math.log(0.9 / 0.05), 5);
  expect(score.top[0]?.[0]).toBe("d");
});

test("a phone heard as another scores far below it, and names it", () => {
  const post = framesOf([
    { t: 0.9, d: 0.01 },
    { t: 0.8, d: 0.01 },
  ]);
  const score = phoneScore(post, set, { phone: "d", from: 0, to: 2 });
  expect(score.competitor).toBe("t");
  expect(score.lpr).toBeLessThan(-3);
});

test("the same sound written another way counts for the phone itself", () => {
  // A flap for a t: t's own posterior is the flap's plus its own.
  const post = framesOf([{ ɾ: 0.6, t: 0.3 }]);
  expect(phoneScore(post, set, { phone: "t", from: 0, to: 1 }).lp).toBeCloseTo(Math.log(0.9), 5);
});

test("a vowel's cues: its length, its loudness in dB, and its pitch", () => {
  const audio = new Float32Array(16_000);
  // Frames 10 to 20 (200 ms) hold a 200 Hz tone of amplitude 0.5: RMS 0.354, -9 dB.
  for (let i = 3200; i < 6400; i++) audio[i] = 0.5 * Math.sin((2 * Math.PI * 200 * i) / 16_000);
  const cues = stressCues(audio, { phone: "æ", from: 10, to: 20 });
  expect(cues.durationMs).toBe(200);
  expect(cues.rmsDb).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 1);
  expect(Math.abs((cues.f0Hz ?? 0) - 200)).toBeLessThan(4);
  expect(stressCues(new Float32Array(16_000), { phone: "æ", from: 10, to: 20 }).f0Hz).toBeNull();
});
