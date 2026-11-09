import { expect, test } from "bun:test";
import type { Posteriors } from "../pronounce/ctc";
import { parseDictionary } from "../pronounce/dictionary";
import { judgeWords, SAMPLES_PER_FRAME, Vocab } from "../pronounce/judge";

const vocab = new Vocab([
  "<pad>",
  "<s>",
  "</s>",
  "<unk>",
  "θ",
  "t",
  "ɹ",
  "iː",
  "b",
  "æ",
  "d",
  "ɾ",
  "w",
  "v",
  "ɜː",
  "s",
  "p",
  "ɛ",
]);
const dictionary = parseDictionary(
  "THREE, θ ɹ ˈiː\nBAD, b ˈæ d\nWORSE, w ˈɜː s\nWATER(1), w ˈɔː t ə\nTAB, t ˈæ b\nTHAT, ð ˈæ t\n",
);

/** Frames, each the probabilities of a few tokens; the rest of the frame goes to the blank. */
function framesOf(rows: readonly Record<string, number>[]): Posteriors {
  const size = vocab.tokens.length;
  const probs = new Float32Array(rows.length * size);
  rows.forEach((row, t) => {
    let left = 1;
    for (const [token, p] of Object.entries(row)) {
      probs[t * size + vocab.tokens.indexOf(token)] = p;
      left -= p;
    }
    probs[t * size] = Math.max(0, left);
  });
  return { frames: rows.length, size, probs };
}

const blank = {};
const word = (text: string, frames: number) => ({
  word: text,
  from: 0,
  to: frames * SAMPLES_PER_FRAME,
});

test("a th the model was sure was a t marks the word, with the sound and how to say it", () => {
  const post = framesOf([blank, { t: 0.9, θ: 0.05 }, blank, { ɹ: 0.9 }, { iː: 0.9 }, blank]);
  expect(judgeWords(post, vocab, dictionary, [word("three", 6)])).toEqual([
    {
      index: 0,
      word: "three",
      heard: "tɹiː",
      expected: "θɹiː",
      sound: "th → t",
      how: "tongue tip between the teeth, let the air through",
    },
  ]);
});

test("a t the model was not sure of over the th is no mark", () => {
  const post = framesOf([blank, { t: 0.5, θ: 0.4 }, blank, { ɹ: 0.9 }, { iː: 0.9 }, blank]);
  expect(judgeWords(post, vocab, dictionary, [word("three", 6)])).toEqual([]);
});

test("the word said as written is no mark", () => {
  const post = framesOf([blank, { θ: 0.9 }, blank, { ɹ: 0.9 }, { iː: 0.9 }, blank]);
  expect(judgeWords(post, vocab, dictionary, [word("Three,", 6)])).toEqual([]);
});

test("a final d heard as t is named as the voice let go at the end", () => {
  const post = framesOf([{ b: 0.9 }, { æ: 0.9 }, blank, { t: 0.95, d: 0.02 }, blank]);
  const [judged] = judgeWords(post, vocab, dictionary, [word("bad", 5)]);
  expect(judged?.sound).toBe("final d → t");
  expect(judged?.how).toBe("keep the voice on to the end of the word");
});

test("w said as v is marked; a word not in the dictionary is not checked", () => {
  const post = framesOf([{ v: 0.9, w: 0.03 }, { ɜː: 0.9 }, { s: 0.9 }, blank]);
  const judged = judgeWords(post, vocab, dictionary, [word("worse", 4), word("zorse", 4)]);
  expect(judged.map((j) => [j.index, j.sound])).toEqual([[0, "w → v"]]);
});

test("a flap for the t of water is an accent, not a mistake", () => {
  const post = framesOf([{ w: 0.9 }, blank, { ɾ: 0.9, t: 0.01 }, blank]);
  // No ɔː or ə in this vocabulary: those steps are left out, the flap is the same sound as t.
  expect(judgeWords(post, vocab, dictionary, [word("water", 4)])).toEqual([]);
});

test("each word looks only at its own frames, widened a little", () => {
  const rows = [{ θ: 0.9 }, { ɹ: 0.9 }, { iː: 0.9 }, blank, blank, blank, blank];
  const post = framesOf([...rows, { t: 0.9 }, { ɹ: 0.9 }, { iː: 0.9 }]);
  const words = [
    { word: "three", from: 0, to: 3 * SAMPLES_PER_FRAME },
    { word: "three", from: 7 * SAMPLES_PER_FRAME, to: 10 * SAMPLES_PER_FRAME },
  ];
  expect(judgeWords(post, vocab, dictionary, words).map((j) => j.index)).toEqual([1]);
});

test("a final b heard as p is the voice let go at the end", () => {
  const post = framesOf([{ t: 0.9 }, { æ: 0.9 }, blank, { p: 0.9 }, blank]);
  const [judged] = judgeWords(post, vocab, dictionary, [word("tab", 5)]);
  expect(judged?.sound).toBe("final b → p");
});

test("a heard phone with a posterior of 0.65 is no mark; 0.75 is", () => {
  const rows = (p: number) => [blank, { t: p }, blank, { ɹ: 0.9 }, { iː: 0.9 }, blank];
  expect(judgeWords(framesOf(rows(0.65)), vocab, dictionary, [word("three", 6)])).toEqual([]);
  expect(judgeWords(framesOf(rows(0.75)), vocab, dictionary, [word("three", 6)])).toHaveLength(1);
});

test("a vowel said as another vowel is no mark", () => {
  const post = framesOf([{ b: 0.9 }, { ɛ: 0.95 }, blank, { d: 0.9 }, blank]);
  expect(judgeWords(post, vocab, dictionary, [word("bad", 5)])).toEqual([]);
});

test("a sound left out at the start or the end of a word is no mark", () => {
  const noStart = framesOf([{ æ: 0.9 }, blank, { d: 0.9 }, blank]);
  expect(judgeWords(noStart, vocab, dictionary, [word("bad", 4)])).toEqual([]);
  const noEnd = framesOf([{ b: 0.9 }, { æ: 0.9 }, blank, blank]);
  expect(judgeWords(noEnd, vocab, dictionary, [word("bad", 4)])).toEqual([]);
});

test("a function word is never marked, whatever was heard", () => {
  const post = framesOf([{ d: 0.95 }, { æ: 0.9 }, { t: 0.9 }, blank]);
  expect(judgeWords(post, vocab, dictionary, [word("That", 4)])).toEqual([]);
});
