import { expect, test } from "bun:test";
import type { Posteriors } from "../pronounce/ctc";
import { forceAlign, PhoneSet } from "../pronounce/force-align";
import { EDGE_FRAMES, ownedSpans, phoneScore, stressCues } from "../pronounce/gop";

const TOKENS = ["<pad>", "<s>", "</s>", "<unk>", "t", "d", "æ", "ɾ", "k", "s", "ɪ"];
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
  const cues = stressCues(audio, { from: 10, to: 20 });
  expect(cues.durationMs).toBe(200);
  expect(cues.rmsDb).toBeCloseTo(20 * Math.log10(0.5 / Math.SQRT2), 1);
  expect(Math.abs((cues.f0Hz ?? 0) - 200)).toBeLessThan(4);
  expect(stressCues(new Float32Array(16_000), { from: 10, to: 20 }).f0Hz).toBeNull();
});

/** Peaky CTC output: each `[token, frames]` a run, "" the blank; a phone is one frame at 0.95, the rest the blank's. */
function peaky(...runs: [string, number][]): Posteriors {
  return framesOf(
    runs.flatMap(([token, count]) =>
      Array.from({ length: count }, () => (token === "" ? {} : { [token]: 0.95 })),
    ),
  );
}

test("a peaky phone owns its spike and half the blanks to each neighbour in its word", () => {
  // "cat": k, æ and t one frame each; the 7 frames of blank after the æ are mostly the vowel.
  const post = peaky(["", 2], ["k", 1], ["", 1], ["æ", 1], ["", 7], ["t", 1], ["", 3]);
  const aligned = forceAlign(post, set, [{ variants: [["k", "æ", "t"]] }]);
  const [cat] = aligned?.words ?? [];
  // The alignment is as peaky as the posteriors: one frame a phone.
  expect(cat?.phones.map((one) => one.to - one.from)).toEqual([1, 1, 1]);
  const [spans] = ownedSpans(aligned?.words ?? [], post.frames);
  expect(spans).toEqual([
    // The piece's start: all of the blanks before, none to share them with.
    { from: 0, to: 3.5 },
    { from: 3.5, to: 8.5 },
    { from: 8.5, to: 16 },
  ]);
  const audio = new Float32Array(post.frames * 320);
  const ms = (spans ?? []).map((span) => stressCues(audio, span).durationMs);
  expect(ms).toEqual([70, 100, 150]);
});

test("between words a phone takes half the blanks, at most EDGE_FRAMES of a pause", () => {
  // "cat sit" with a 1 s pause, then "it" 4 frames after "sit".
  const post = peaky(
    ["k", 1],
    ["", 1],
    ["æ", 1],
    ["", 1],
    ["t", 1],
    ["", 50],
    ["s", 1],
    ["", 1],
    ["ɪ", 1],
    ["", 1],
    ["t", 1],
    ["", 4],
    ["ɪ", 1],
    ["", 1],
    ["t", 1],
  );
  const aligned = forceAlign(post, set, [
    { variants: [["k", "æ", "t"]] },
    { variants: [["s", "ɪ", "t"]] },
    { variants: [["ɪ", "t"]] },
  ]);
  const [cat, sit, it] = ownedSpans(aligned?.words ?? [], post.frames);
  expect(cat?.[2]).toEqual({ from: 3.5, to: 5 + EDGE_FRAMES });
  expect(sit?.[0]).toEqual({ from: 55 - EDGE_FRAMES, to: 56.5 });
  // 4 frames between "sit" and "it": 2 each, under the cap.
  expect(sit?.[2]?.to).toBe(62);
  expect(it?.[0]?.from).toBe(62);
  // The piece's end: the last t has no blanks after it.
  expect(it?.[1]).toEqual({ from: 65.5, to: 67 });
});

test("a word not aligned owns nothing, and its neighbours share the blanks across it", () => {
  const word = { variant: 0, from: 2, to: 3, phones: [{ phone: "t", from: 2, to: 3 }], score: 0 };
  const next = { ...word, from: 9, to: 10, phones: [{ phone: "t", from: 9, to: 10 }] };
  expect(ownedSpans([word, null, next], 12)).toEqual([
    [{ from: 0, to: 6 }],
    [],
    [{ from: 6, to: 12 }],
  ]);
});

test("a vowel's cues over a stretch that ends on a half frame", () => {
  const audio = new Float32Array(16_000);
  for (let i = 1120; i < 2720; i++) audio[i] = 0.5;
  const cues = stressCues(audio, { from: 3.5, to: 8.5 });
  expect(cues.durationMs).toBe(100);
  expect(cues.rmsDb).toBeCloseTo(20 * Math.log10(0.5), 3);
});
