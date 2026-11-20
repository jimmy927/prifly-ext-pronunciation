import { expect, test } from "bun:test";
import { anySoundCandidates, anySoundFix, anySoundMarks } from "../pronounce/any-sound";
import type { Posteriors } from "../pronounce/ctc";
import { parseDictionary } from "../pronounce/dictionary";
import { readPiece, SAMPLES_PER_FRAME, Vocab } from "../pronounce/judge";
import { parseNativeStats } from "../pronounce/native";
import { DEFAULT_DEVIATE_CUT } from "../pronounce/thresholds";
import { CURVE } from "./accent-fixtures";

const TOKENS = [
  "<pad>",
  "<s>",
  "</s>",
  "<unk>",
  "dʒ",
  "j",
  "ʌ",
  "s",
  "t",
  "z",
  "ɹ",
  "l",
  "iː",
  "θ",
];
const vocab = new Vocab(TOKENS);
const dictionary = parseDictionary(
  "JUST, dʒ ˈʌ s t\nRUST, ɹ ˈʌ s t\nBUZZ, b ˈʌ z\nTHREE, θ ɹ ˈiː\nIS, ˈɪ z\nZEST, z ˈɛ s t\n",
);
/** Natives whose consonants all sit on `CURVE`: p1 -3, so a consonant at -8 is far past their 0.5th percentile. */
const natives = parseNativeStats({
  phones: Object.fromEntries(["dʒ", "ɹ", "s", "t", "z", "θ"].map((one) => [one, { lpr: CURVE }])),
});

/** Frames of logits: each row's tokens at their logit, the rest at 0, softmaxed. */
function framesOf(rows: readonly Record<string, number>[]): Posteriors {
  const size = TOKENS.length;
  const probs = new Float32Array(rows.length * size);
  rows.forEach((row, t) => {
    const logits = TOKENS.map((token) => row[token] ?? 0);
    const sum = logits.reduce((a, b) => a + Math.exp(b), 0);
    logits.forEach((logit, k) => {
      probs[t * size + k] = Math.exp(logit) / sum;
    });
  });
  return { frames: rows.length, size, probs };
}

const one = (word: string, frames: number) => [{ word, from: 0, to: frames * SAMPLES_PER_FRAME }];

/** The candidates of a word's consonants that lost: every consonant is one, the ones said right far inside the natives. */
const lost = (read: ReturnType<typeof readPiece>) =>
  read === null ? [] : anySoundCandidates(read, 0).filter((candidate) => candidate.lpr < 0);

/** "just" with its j heard as `heard` (sure of it), the j itself at logit 4. */
const just = (heard: string) =>
  framesOf([{ [heard]: 12, dʒ: 4 }, { ʌ: 12 }, { s: 12 }, { t: 12 }, { "<pad>": 12 }]);

test("a consonant heard as another, past the natives' 0.5th percentile, is a mark with a card saying what and how", () => {
  const read = readPiece(just("j"), vocab, dictionary, one("Just,", 5));
  if (read === null) throw new Error("not aligned");
  expect(lost(read)).toMatchObject([{ at: 0, expected: "dʒ", rival: "j" }]);
  const [mark] = anySoundMarks(read, one("Just,", 5), natives, DEFAULT_DEVIATE_CUT);
  expect(mark).toMatchObject({
    index: 0,
    check: "any-sound",
    level: "sure",
    sound: "J → Y",
    said: "YUST",
    say: "JUST",
    fix: anySoundFix("Just,", "dʒ", "j"),
  });
  expect(mark?.fix).toBe(
    "Swapped sound. The J in 'just' came out as a Y. Start with the tongue touching, as for D, then let it go with your voice on.",
  );
});

test("an R heard as an L is one too; without natives nothing is marked", () => {
  const post = framesOf([{ l: 12, ɹ: 4 }, { ʌ: 12 }, { s: 12 }, { t: 12 }, { "<pad>": 12 }]);
  const read = readPiece(post, vocab, dictionary, one("rust", 5));
  if (read === null) throw new Error("not aligned");
  expect(anySoundMarks(read, one("rust", 5), natives, DEFAULT_DEVIATE_CUT)).toMatchObject([
    { sound: "R → L", said: "LUST", say: "RUST" },
  ]);
  expect(anySoundMarks(read, one("rust", 5), null, DEFAULT_DEVIATE_CUT)).toEqual([]);
});

test("the five named swaps are never this check's: their own checks have them", () => {
  // z heard as s (Z said as S), th heard as t (TH said as T).
  const zest = framesOf([{ s: 12, z: 4 }, { ʌ: 12 }, { s: 12 }, { t: 12 }, { "<pad>": 12 }]);
  const three = framesOf([{ t: 12, θ: 4 }, { ɹ: 12 }, { iː: 12 }, { "<pad>": 12 }]);
  for (const [post, word] of [
    [zest, "zest"],
    [three, "three"],
  ] as const) {
    const read = readPiece(post, vocab, dictionary, one(word, post.frames));
    if (read === null) throw new Error("not aligned");
    expect(lost(read)).toEqual([]);
    expect(anySoundMarks(read, one(word, post.frames), natives, DEFAULT_DEVIATE_CUT)).toEqual([]);
  }
});

test("short of the natives' cut-off, or lost to the sound beside it, is no mark", () => {
  // The j only a little less likely than a y: well inside the natives.
  const close = framesOf([{ j: 5, dʒ: 4.5 }, { ʌ: 12 }, { s: 12 }, { t: 12 }, { "<pad>": 12 }]);
  const read = readPiece(close, vocab, dictionary, one("just", 5));
  if (read === null) throw new Error("not aligned");
  expect(anySoundMarks(read, one("just", 5), natives, DEFAULT_DEVIATE_CUT)).toEqual([]);
  // The s of "just" heard as the t after it: the alignment's edge, not a swap.
  const blurred = framesOf([{ dʒ: 12 }, { ʌ: 12 }, { t: 12, s: 4 }, { t: 12 }, { "<pad>": 12 }]);
  const edge = readPiece(blurred, vocab, dictionary, one("just", 5));
  if (edge === null) throw new Error("not aligned");
  expect(lost(edge)).toEqual([]);
  expect(anySoundMarks(edge, one("just", 5), natives, DEFAULT_DEVIATE_CUT)).toEqual([]);
});
