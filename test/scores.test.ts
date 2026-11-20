import { expect, test } from "bun:test";
import type { Posteriors } from "../pronounce/ctc";
import { mergeDictionaries, parseCmudict, parseDictionary } from "../pronounce/dictionary";
import { SAMPLES_PER_FRAME, Vocab } from "../pronounce/judge";
import { scorePiece } from "../pronounce/scores";

const vocab = new Vocab([
  ...["<pad>", "<s>", "</s>", "<unk>", "m", "ʌ", "æ", "tʃ", "ð", "z", "s", "ɪ"],
  ...["w", "ɜː", "ɹ", "iː"],
]);
const dictionary = parseDictionary("MUCH, m ˈʌ tʃ\nTHE, ð ˈə\nMIZ, m ˈɪ z\n");

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

const span = (text: string, from: number, to: number) => ({
  word: text,
  from: from * SAMPLES_PER_FRAME,
  to: to * SAMPLES_PER_FRAME,
});

test("a content word's vowel is scored with the sound that won over it; function words are not scored", () => {
  const post = framesOf([
    { ð: 0.9 },
    { ʌ: 0.9 },
    { m: 0.9 },
    { æ: 0.8, ʌ: 0.1 },
    { tʃ: 0.9 },
    { m: 0.9 },
    { ɪ: 0.9 },
    { s: 0.7, z: 0.2 },
  ]);
  const scores = scorePiece(post, vocab, dictionary, [
    span("the", 0, 2),
    span("much", 2, 5),
    span("miz", 5, 8),
  ]);
  expect(scores.map((one) => one.index)).toEqual([1, 2]);
  // The final z, heard more as s: final devoicing's check scores it.
  expect(scores[1]?.contrasts).toEqual([
    { id: "final-devoicing", at: 2, phone: "z", lpr: expect.any(Number) },
  ]);
  expect(scores[1]?.contrasts[0]?.lpr ?? 0).toBeCloseTo(Math.log(0.2) - Math.log(0.7), 2);
  const [much] = scores;
  expect(much).toMatchObject({ index: 1, phones: ["m", "ʌ", "tʃ"], stress: 1, contrasts: [] });
  expect(much?.vowels).toEqual([{ at: 1, phone: "ʌ", lpr: expect.any(Number), rival: "æ" }]);
  expect(much?.vowels[0]?.lpr ?? 0).toBeCloseTo(Math.log(0.1) - Math.log(0.8), 2);
});

test("a word only CMUdict knows is not scored, so the Vowels check never sees it: the reader's \"we're\"", () => {
  // Britfone has no "we're"; CMUdict has three ways, the shortest the "were" one, w ɜː.
  const words = mergeDictionaries(
    dictionary,
    parseCmudict("we're W IY1 R\nwe're(2) W IH1 R\nwe're(3) W ER1\n"),
  );
  // Two frames for "we're", w and then the reader's ɪ (British "wɪə"), the ɜː at 0.005.
  const post = framesOf([{ m: 0.9 }, { ʌ: 0.9 }, { tʃ: 0.9 }, { w: 0.9 }, { ɪ: 0.6, ɜː: 0.005 }]);
  const scores = scorePiece(post, vocab, words, [span("much", 0, 3), span("we're", 3, 5)]);
  expect(scores.map((one) => one.index)).toEqual([0]);
});
