import { expect, test } from "bun:test";
import {
  arpabetPhone,
  mergeDictionaries,
  parseCmudict,
  parseDictionary,
  sourceOf,
  stressOf,
} from "../pronounce/dictionary";

const CMU = [
  "developer D IH0 V EH1 L AH0 P ER0",
  "either IY1 DH ER0",
  "either(2) AY1 DH ER0",
  "aalborg AO1 L B AO0 R G # place, danish",
  "abc EY1 B IY2 S IY2",
  "nonword XX1 Y",
  "",
].join("\n");

test("CMUdict's ARPAbet comes in the model's IPA, its variants and comments handled", () => {
  const cmu = parseCmudict(CMU);
  expect(cmu.get("developer")).toEqual([["d", "ɪ", "v", "ɛ", "l", "ə", "p", "ɚ"]]);
  expect(cmu.get("either")).toEqual([
    ["iː", "ð", "ɚ"],
    ["aɪ", "ð", "ɚ"],
  ]);
  expect(cmu.get("aalborg")).toEqual([["ɔː", "l", "b", "ɔː", "ɹ", "ɡ"]]);
  // A symbol that is no ARPAbet skips the line.
  expect(cmu.has("nonword")).toBe(false);
});

test("stress is the phone carrying it, from Britfone's marks and CMUdict's digits alike", () => {
  const cmu = parseCmudict(CMU);
  const brit = parseDictionary("DEVELOPER, d ɪ v ˈɛ l ə p ə\nTOMATO, t ə m ˈɑː t ˌəʊ\nUH, ə\n");
  expect(stressOf(cmu.get("developer")?.[0] ?? [])).toBe(3);
  expect(stressOf(brit.get("developer")?.[0] ?? [])).toBe(3);
  expect(stressOf(brit.get("tomato")?.[0] ?? [])).toBe(3);
  // Only a secondary stress: that one.
  expect(stressOf(parseCmudict("ab AE2 B\n").get("ab")?.[0] ?? [])).toBe(0);
  expect(stressOf(brit.get("uh")?.[0] ?? [])).toBe(-1);
  expect(stressOf(["d"])).toBe(-1);
});

test("AH and ER are weak without stress, full with it", () => {
  expect(arpabetPhone("AH0")).toEqual({ phone: "ə", stress: 0 });
  expect(arpabetPhone("AH1")).toEqual({ phone: "ʌ", stress: 1 });
  expect(arpabetPhone("ER0")).toEqual({ phone: "ɚ", stress: 0 });
  expect(arpabetPhone("ER1")).toEqual({ phone: "ɜː", stress: 1 });
  expect(arpabetPhone("JH")).toEqual({ phone: "dʒ", stress: -1 });
  expect(arpabetPhone("Q")).toBeNull();
});

test("merged, a word keeps Britfone's pronunciations first and adds CMUdict's that differ", () => {
  const brit = parseDictionary(
    "EITHER(1), ˈaɪ ð ə\nEITHER(2), ˈiː ð ə\nDEVELOPER, d ɪ v ˈɛ l ə p ə\n",
  );
  const cmu = parseCmudict(`${CMU}\nsame AY1 DH\n`);
  const both = mergeDictionaries(
    brit,
    parseCmudict("developer D IH0 V EH1 L AH0 P ER0\nnew N UW1\n"),
  );
  expect(both.get("developer")?.map((said) => said.join(" "))).toEqual([
    "d ɪ v ɛ l ə p ə",
    "d ɪ v ɛ l ə p ɚ",
  ]);
  expect(both.get("developer")?.map((said) => sourceOf(said))).toEqual(["britfone", "cmudict"]);
  expect(both.get("new")?.map((said) => sourceOf(said))).toEqual(["cmudict"]);
  expect(mergeDictionaries(brit, cmu).get("either")).toHaveLength(4);
  // The same phones twice are one pronunciation.
  const twice = mergeDictionaries(
    parseDictionary("NEW, n j ˈuː\n"),
    parseDictionary("NEW, n j ˈuː\n"),
  );
  expect(twice.get("new")).toHaveLength(1);
});
