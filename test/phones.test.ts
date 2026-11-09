import { expect, test } from "bun:test";
import { alignPhones } from "../pronounce/align";
import { accentContrast } from "../pronounce/contrasts";
import { greedyTokens, posteriors } from "../pronounce/ctc";
import { parseDictionary, wordKey } from "../pronounce/dictionary";
import { dictionaryPhone, samePhone, splitHeard } from "../pronounce/phones";

test("accent variants are the same sound; a sound for another is not", () => {
  expect(samePhone("əʊ", "oʊ")).toBe(true);
  expect(samePhone("ɒ", "ɑː")).toBe(true);
  expect(samePhone("t", "ɾ")).toBe(true);
  expect(samePhone("ə", "ɚ")).toBe(true);
  expect(samePhone("θ", "t")).toBe(false);
  expect(samePhone("iː", "ɪ")).toBe(false);
  expect(samePhone("t", "d")).toBe(false);
  // Groups do not carry over: ɒ is like ɔ, ɔ like ɔː, but ɒ is not ɔː.
  expect(samePhone("ɒ", "ɔː")).toBe(false);
  expect(samePhone("ʊ", "ɔː")).toBe(false);
});

test("the model's two-phone tokens split; the dictionary's phones take the model's spelling", () => {
  expect(splitHeard("əl")).toEqual(["ə", "l"]);
  expect(splitHeard("θ")).toEqual(["θ"]);
  expect(dictionaryPhone("ˈiː")).toBe("iː");
  expect(dictionaryPhone("g")).toBe("ɡ");
  expect(dictionaryPhone("r")).toBe("ɹ");
});

test("alignment lines up a substitution, a deletion and an insertion", () => {
  expect(alignPhones(["θ", "ɹ", "iː"], ["t", "ɹ", "iː"])).toEqual([
    { kind: "sub", expected: 0, heard: 0 },
    { kind: "same", expected: 1, heard: 1 },
    { kind: "same", expected: 2, heard: 2 },
  ]);
  expect(alignPhones(["h", "æ", "t"], ["æ", "t", "s"])).toEqual([
    { kind: "del", expected: 0 },
    { kind: "same", expected: 1, heard: 0 },
    { kind: "same", expected: 2, heard: 1 },
    { kind: "ins", heard: 2 },
  ]);
});

test("alignment keeps vowels with vowels", () => {
  const steps = alignPhones(["b", "æ", "d"], ["b", "ɛ", "d"]);
  expect(steps[1]).toEqual({ kind: "sub", expected: 1, heard: 1 });
});

test("each accent feature has its label and how-to", () => {
  expect(accentContrast("θ", "t", false)).toEqual({
    sound: "th → t",
    how: "tongue tip between the teeth, let the air through",
  });
  expect(accentContrast("ð", "d", false)?.sound).toBe("th → d");
  expect(accentContrast("ð", "z", false)?.sound).toBe("th → z");
  expect(accentContrast("ð", "t", false)?.sound).toBe("th → t");
  expect(accentContrast("w", "v", false)?.sound).toBe("w → v");
  expect(accentContrast("v", "w", false)?.sound).toBe("v → w");
  expect(accentContrast("z", "s", false)).toEqual({
    sound: "z → s",
    how: "buzz it: keep the voice on, not a hiss",
  });
  expect(accentContrast("ʒ", "ʃ", false)?.sound).toBe("zh → sh");
  expect(accentContrast("tʃ", "ʃ", false)?.sound).toBe("ch → sh");
  expect(accentContrast("dʒ", "ʒ", false)?.sound).toBe("j → zh");
  expect(accentContrast("ʃ", "dʒ", false)?.sound).toBe("sh → j");
});

test("final devoicing: the voiced consonant gone voiceless at the last phone only", () => {
  const voice = "keep the voice on to the end of the word";
  expect(accentContrast("b", "p", true)).toEqual({ sound: "final b → p", how: voice });
  expect(accentContrast("d", "t", true)?.sound).toBe("final d → t");
  expect(accentContrast("ɡ", "k", true)?.sound).toBe("final ɡ → k");
  expect(accentContrast("v", "f", true)?.sound).toBe("final v → f");
  expect(accentContrast("z", "s", true)?.sound).toBe("final z → s");
  expect(accentContrast("ð", "θ", true)?.sound).toBe("final voiced th → th");
  expect(accentContrast("b", "p", false)).toBeNull();
  expect(accentContrast("d", "t", false)).toBeNull();
});

test("vowels, other consonant swaps and unlisted sounds are no accent feature", () => {
  expect(accentContrast("iː", "ɪ", false)).toBeNull();
  expect(accentContrast("æ", "ɛ", false)).toBeNull();
  expect(accentContrast("ɜː", "ɔː", false)).toBeNull();
  expect(accentContrast("t", "ə", false)).toBeNull();
  expect(accentContrast("k", "ɡ", false)).toBeNull();
  expect(accentContrast("s", "ʃ", false)).toBeNull();
  expect(accentContrast("v", "b", false)).toBeNull();
});

test("Britfone's lines: variants under one word, stress gone, lines that are no entry skipped", () => {
  const dictionary = parseDictionary(
    "THREE, θ ɹ ˈiː\nREAD(1), ɹ ˈiː d\nREAD(2), ɹ ˈɛ d\n'COS, k ˈə z\nnot a line\n",
  );
  expect(dictionary.get("three")).toEqual([["θ", "ɹ", "iː"]]);
  expect(dictionary.get("read")).toEqual([
    ["ɹ", "iː", "d"],
    ["ɹ", "ɛ", "d"],
  ]);
  expect(dictionary.get("'cos")).toEqual([["k", "ə", "z"]]);
  expect(dictionary.size).toBe(3);
  expect(wordKey("Three,")).toBe("three");
  expect(wordKey("don’t")).toBe("don't");
});

test("greedy CTC merges repeats, drops the blank, and keeps each phone's frames", () => {
  const vocab = ["<pad>", "a", "b"];
  // Logits per frame: a, a, blank, a, b.
  const logits = Float32Array.from([0, 9, 0, 0, 9, 0, 9, 0, 0, 0, 9, 0, 0, 0, 9]);
  const post = posteriors(logits, 5, 3);
  expect(post.probs[1]).toBeGreaterThan(0.99);
  expect(greedyTokens(post, vocab)).toEqual([
    { id: 1, token: "a", from: 0, to: 2 },
    { id: 1, token: "a", from: 3, to: 4 },
    { id: 2, token: "b", from: 4, to: 5 },
  ]);
});
