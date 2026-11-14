import { expect, test } from "bun:test";
import { accentContrast } from "../pronounce/contrasts";
import { parseDictionary, stressOf } from "../pronounce/dictionary";
import { respellPair } from "../pronounce/respell";

/** Britfone's line for a word, the swap at phone `at` heard as `heard`: the word respelt as heard and as it should be said. */
function pair(line: string, at: number, heard: string) {
  const [pronunciation] = parseDictionary(line).values().next().value ?? [];
  if (pronunciation === undefined) throw new Error(`no entry in ${line}`);
  const last = at === pronunciation.length - 1;
  const expected = pronunciation[at] ?? "";
  // Every case here is one the judge would find: a contrast the accent features name.
  expect(accentContrast(expected, heard, last)).not.toBeNull();
  const { said, say } = respellPair(pronunciation, stressOf(pronunciation), at, heard, last);
  return `${said} → ${say}`;
}

test("a z in the middle of a word is doubled, syllables joined by hyphens, the stressed one in capitals", () => {
  expect(pair("BROWSER, b ɹ ˈaʊ z ə", 3, "s")).toBe("BROW-sser → BROW-zzer");
});

test("a final z heard as s is doubled after a vowel, in one syllable and after an unstressed one", () => {
  expect(pair("THESE, ð ˈiː z", 2, "s")).toBe("THEESS → THEEZZ");
  expect(pair("PLEASE, p l ˈiː z", 3, "s")).toBe("PLEESS → PLEEZZ");
  expect(pair("BECAUSE, b ɪ k ˈɒ z", 4, "s")).toBe("bee-KOSS → bee-KOZZ");
});

test("a final devoicing takes the voiced cluster with it, and a cluster is not doubled", () => {
  expect(pair("THREADS, θ ɹ ˈɛ d z", 4, "s")).toBe("THRETS → THREDZ");
  expect(pair("NEEDS, n ˈiː d z", 3, "s")).toBe("NEETS → NEEDZ");
});

test("a two-letter sound is not doubled, and a z outside the swap is spelled s", () => {
  expect(pair("ACTIONS, ˈæ k ʃ ə n z", 2, "tʃ")).toBe("AK-chuns → AK-shuns");
});

test("a sound at the start of a word is not doubled", () => {
  expect(pair("ZOO, z ˈuː", 0, "s")).toBe("SOO → ZOO");
});

test("a word with no stress mark takes its first syllable as the stressed one", () => {
  expect(pair("BUZZER, b ʌ z ə", 2, "s")).toBe("BU-sser → BU-zzer");
});

test("an ɪ is i unless it is unstressed and ends its syllable, and a z outside the swap is spelled s", () => {
  expect(pair("VISIT, v ˈɪ z ɪ t", 0, "w")).toBe("WI-sit → VI-sit");
});
