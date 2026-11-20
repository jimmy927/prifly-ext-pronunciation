import { expect, test } from "bun:test";
import type { Posteriors } from "../pronounce/ctc";
import { mergeDictionaries, parseCmudict, parseDictionary } from "../pronounce/dictionary";
import { readPiece, SAMPLES_PER_FRAME, Vocab } from "../pronounce/judge";
import { parseNativeStats } from "../pronounce/native";
import { DEFAULT_DEVIATE_CUT } from "../pronounce/thresholds";
import { weakVowelCandidates, weakVowelMarks } from "../pronounce/weak-vowels";
import { CURVE } from "./accent-fixtures";

const TOKENS = ["<pad>", "<s>", "</s>", "<unk>", "ə", "æ", "ɪ", "b", "aʊ", "t", "d", "eɪ", "s"];
const vocab = new Vocab(TOKENS);
const dictionary = parseDictionary("ABOUT, ə b ˈaʊ t\nTODAY, t ə d ˈeɪ\nBATS, b ˈæ t s\n");
/** Natives whose schwa sits on `CURVE`: p1 -3, so one at -8 is far past their 0.5th percentile. */
const natives = parseNativeStats({ vowels: { ə: { lpr: CURVE } } });

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

/** "about" with its weak vowel heard as `heard` (sure of it), the schwa itself at logit 4. */
const about = (heard: string) =>
  framesOf([{ [heard]: 12, ə: 4 }, { b: 12 }, { aʊ: 12 }, { t: 12 }, { "<pad>": 12 }]);

test("an unstressed schwa said as a full vowel, past the natives' 0.5th percentile, is a mark: say it weak", () => {
  const read = readPiece(about("æ"), vocab, dictionary, one("About", 5));
  if (read === null) throw new Error("not aligned");
  expect(weakVowelMarks(read, one("About", 5), natives, DEFAULT_DEVIATE_CUT)).toMatchObject([
    {
      index: 0,
      check: "weak-vowels",
      level: "sure",
      said: "a-BOWT",
      say: "u-BOWT",
      fix: "Unreduced vowel. The weak vowel in 'about' came out full, like the A in 'cap'. Say it short and weak: uh.",
    },
  ]);
});

test("a schwa heard as another weak vowel is no mark; nor is one inside the natives, or without them", () => {
  const short = readPiece(about("ɪ"), vocab, dictionary, one("about", 5));
  if (short === null) throw new Error("not aligned");
  expect(weakVowelCandidates(short, 0)).toEqual([]);
  const close = framesOf([{ æ: 5, ə: 4.6 }, { b: 12 }, { aʊ: 12 }, { t: 12 }, { "<pad>": 12 }]);
  const near = readPiece(close, vocab, dictionary, one("about", 5));
  if (near === null) throw new Error("not aligned");
  expect(weakVowelMarks(near, one("about", 5), natives, DEFAULT_DEVIATE_CUT)).toEqual([]);
  const read = readPiece(about("æ"), vocab, dictionary, one("about", 5));
  if (read === null) throw new Error("not aligned");
  expect(weakVowelMarks(read, one("about", 5), null, DEFAULT_DEVIATE_CUT)).toEqual([]);
});

test("only a schwa is looked at: a stressed full vowel heard as another is the Vowels check's, not this one's", () => {
  // "bats" with its stressed A heard as an I.
  const post = framesOf([{ b: 12 }, { ɪ: 12, æ: 4 }, { t: 12 }, { s: 12 }, { "<pad>": 12 }]);
  const read = readPiece(post, vocab, dictionary, one("bats", 5));
  if (read === null) throw new Error("not aligned");
  expect(weakVowelCandidates(read, 0)).toEqual([]);
  expect(weakVowelMarks(read, one("bats", 5), natives, DEFAULT_DEVIATE_CUT)).toEqual([]);
});

test("a full vowel another accepted pronunciation has there is no mark", () => {
  // CMUdict's "today" with a full O-ish vowel stands in: here, the A of "cap".
  const both = mergeDictionaries(dictionary, parseCmudict("today T AE0 D EY1\n"));
  const post = framesOf([{ t: 12 }, { æ: 12, ə: 4 }, { d: 12 }, { eɪ: 12 }, { "<pad>": 12 }]);
  const alone = readPiece(post, vocab, dictionary, one("today", 5));
  if (alone === null) throw new Error("not aligned");
  expect(weakVowelMarks(alone, one("today", 5), natives, DEFAULT_DEVIATE_CUT)).toHaveLength(1);
  const read = readPiece(post, vocab, both, one("today", 5));
  if (read === null) throw new Error("not aligned");
  expect(weakVowelMarks(read, one("today", 5), natives, DEFAULT_DEVIATE_CUT)).toEqual([]);
});
