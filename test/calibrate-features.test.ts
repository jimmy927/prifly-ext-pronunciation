import { expect, test } from "bun:test";
import { mergeDictionaries, parseCmudict, parseDictionary } from "../pronounce/dictionary";
import { SAMPLES_PER_FRAME, Vocab } from "../pronounce/judge";
import { utteranceRecords, type WordRecord, wordsOf } from "../tools/calibrate/features";

const TOKENS = ["<pad>", "<s>", "</s>", "<unk>", "n", "iː", "d", "t", "ɪ", "æ", "k"];
const vocab = new Vocab(TOKENS);
const dictionary = mergeDictionaries(
  parseDictionary("NEED, n ˈiː d\nIT, ˈɪ t\n"),
  parseCmudict("need N IY1 D\nkat K AE1 T\n"),
);

/** `[row, n]`: a row of a few tokens' probabilities held for n frames, the rest the blank's. */
function framesOf(...runs: [Record<string, number>, number][]) {
  const rows = runs.flatMap(([row, count]) => Array.from({ length: count }, () => row));
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

/** A 200 Hz tone over frames `from` to `to`, silence elsewhere. */
function toneOver(frames: number, from: number, to: number): Float32Array {
  const audio = new Float32Array(frames * SAMPLES_PER_FRAME);
  for (let i = from * SAMPLES_PER_FRAME; i < to * SAMPLES_PER_FRAME; i++) {
    audio[i] = 0.3 * Math.sin((2 * Math.PI * 200 * i) / 16_000);
  }
  return audio;
}

test("the words of a transcript line, punctuation alone left out, each with the whole utterance as its time", () => {
  expect(wordsOf("NEED IT , kat", 640)).toEqual([
    { word: "NEED", from: 0, to: 640 },
    { word: "IT", from: 0, to: 640 },
    { word: "kat", from: 0, to: 640 },
  ]);
});

test("each word gets its pronunciation, phones' goodness, vowels' cues and the checks' candidates", () => {
  // "need it kat", the d of need said as t.
  const post = framesOf(
    [{ n: 0.9 }, 3],
    [{ iː: 0.9 }, 6],
    [{ t: 0.9, d: 0.05 }, 2],
    [{}, 3],
    [{ ɪ: 0.9 }, 3],
    [{ t: 0.9 }, 2],
    [{}, 2],
    [{ k: 0.9 }, 2],
    [{ æ: 0.9 }, 4],
    [{ t: 0.9 }, 2],
  );
  const audio = toneOver(post.frames, 3, 9);
  const records = utteranceRecords("u1", "NEED IT kat", audio, post, vocab, dictionary);
  if (!Array.isArray(records)) throw new Error(records.error);
  const [need, it, kat] = records as [WordRecord, WordRecord, WordRecord];
  expect(need).toMatchObject({
    utt: "u1",
    i: 0,
    key: "need",
    known: true,
    judged: true,
    functionWord: false,
    variants: 1,
    variant: "n iː d",
    variantSource: "britfone",
    stress: 1,
    stressVowel: 0,
    // Britfone's and CMUdict's "need" are one pronunciation, stressed on its only vowel.
    stressAccepts: [0],
  });
  expect(need.phones.map((phone) => phone.phone)).toEqual(["n", "iː", "d"]);
  expect(need.phones[2]?.competitor).toBe("t");
  expect(need.phones[2]?.lpr).toBeLessThan(0);
  expect(need.phones[0]?.lpr).toBeGreaterThan(0);
  expect(need.vowels).toEqual([
    expect.objectContaining({ at: 1, phone: "iː", stressed: true, durationMs: 120 }),
  ]);
  expect(Math.abs((need.vowels[0]?.f0Hz ?? 0) - 200)).toBeLessThan(5);
  expect(need.candidates).toContainEqual(
    expect.objectContaining({ expected: "d", heard: "t", id: "final-devoicing", wasHeard: true }),
  );
  expect(it).toMatchObject({ judged: false, functionWord: true });
  // Only CMUdict knows kat: aligned, not judged.
  expect(kat).toMatchObject({ known: true, judged: false, variantSource: "cmudict" });
  expect(JSON.parse(JSON.stringify(need))).toEqual(need);
});

test("an utterance too short for its words is one error line", () => {
  const post = framesOf([{ n: 0.9 }, 2]);
  expect(
    utteranceRecords("u2", "need need", new Float32Array(640), post, vocab, dictionary),
  ).toEqual({ utt: "u2", error: "no alignment (2 frames)" });
});
