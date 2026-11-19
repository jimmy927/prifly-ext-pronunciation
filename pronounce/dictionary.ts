/**
 * The pronouncing dictionaries, merged into one where a word may have
 * several accepted pronunciations:
 *
 * - Britfone 3.0.1 (Jose Llarena, MIT), about 16,000 common English words in
 *   British pronunciation, one line each — `THREE, θ ɹ ˈiː`, and `WORD(1)`,
 *   `WORD(2)` for a word said two ways. Its phones come space-separated; the
 *   stress marks go (`stressOf` keeps where the stress fell) and a few
 *   letters take the model's spelling (`dictionaryPhone`).
 * - CMUdict (Carnegie Mellon, BSD-2-Clause), about 135,000 words in American
 *   pronunciation, in ARPAbet — `need N IY1 D`, `either(2) AY1 DH ER0`, a
 *   `#` comment after some. Each ARPAbet phone is mapped to the model's
 *   espeak IPA (`ARPABET`); the digit on a vowel is its stress (1 primary, 2
 *   secondary).
 *
 * A word is judged only when Britfone has it (`sourceOf`), as before CMUdict
 * came in; CMUdict's pronunciations are further accepted ways to say it, so a
 * speaker who says it the American way is not marked, and they place the
 * words Britfone does not know in the sentence's alignment.
 */

import { dictionaryPhone } from "./phones";

/** Each word, as `wordKey` makes it, to its pronunciations. */
export type Dictionary = ReadonlyMap<string, readonly (readonly string[])[]>;

export type Source = "britfone" | "cmudict";

/** Where each pronunciation's primary stress falls, by the array the parser made for it. Kept beside the arrays so they stay plain lists of phones. */
const STRESS = new WeakMap<readonly string[], number>();
/** Which dictionary each pronunciation came from. */
const SOURCE = new WeakMap<readonly string[], Source>();

/** The index of the phone a pronunciation stresses (its primary stress, else its secondary one); -1 when it has none or is not from a parser here. */
export function stressOf(pronunciation: readonly string[]): number {
  return STRESS.get(pronunciation) ?? -1;
}

/** The dictionary a pronunciation came from; undefined for one not made by a parser here. */
export function sourceOf(pronunciation: readonly string[]): Source | undefined {
  return SOURCE.get(pronunciation);
}

/** The index of the stressed phone of Britfone's `phones` (a primary mark wins over a secondary one); -1 for none. */
function stressIndex(phones: readonly string[]): number {
  const primary = phones.findIndex((phone) => phone.includes("ˈ"));
  return primary >= 0 ? primary : phones.findIndex((phone) => phone.includes("ˌ"));
}

/** A word as it is looked up: lower case, its curly apostrophes straight, no punctuation around it. */
export function wordKey(word: string): string {
  return word
    .toLowerCase()
    .replaceAll("’", "'")
    .replace(/^[^\p{L}\p{N}']+|[^\p{L}\p{N}]+$/gu, "");
}

/** Adds `said` under `key`, unless the word has those phones already. */
function addTo(
  words: Map<string, (readonly string[])[]>,
  key: string,
  said: string[],
  stress: number,
  source: Source,
): void {
  const known = words.get(key) ?? [];
  const spelt = said.join(" ");
  if (known.some((other) => other.join(" ") === spelt)) return;
  STRESS.set(said, stress);
  SOURCE.set(said, source);
  known.push(said);
  words.set(key, known);
}

const LINE = /^(.+?)(?:\(\d+\))?,\s*(.+)$/u;

/** Britfone's lines as a dictionary; a line that is no entry is skipped. */
export function parseDictionary(text: string): Dictionary {
  const words = new Map<string, (readonly string[])[]>();
  for (const line of text.split(/\r?\n/u)) {
    const found = LINE.exec(line.trim());
    if (found === null) continue;
    const [, word = "", phones = ""] = found;
    const raw = phones.split(/\s+/u).filter((phone) => dictionaryPhone(phone) !== "");
    const said = raw.map(dictionaryPhone);
    const key = wordKey(word);
    if (said.length === 0 || key === "") continue;
    addTo(words, key, said, stressIndex(raw), "britfone");
  }
  return words;
}

/**
 * ARPAbet in the model's espeak IPA, as espeak writes General American:
 * `AH` is "ʌ" stressed and "ə" not, `ER` "ɜː" stressed and "ɚ" not (the
 * digit decides, `arpabetPhone`).
 */
export const ARPABET: Readonly<Record<string, string>> = {
  AA: "ɑː",
  AE: "æ",
  AH: "ʌ",
  AO: "ɔː",
  AW: "aʊ",
  AY: "aɪ",
  EH: "ɛ",
  ER: "ɜː",
  EY: "eɪ",
  IH: "ɪ",
  IY: "iː",
  OW: "oʊ",
  OY: "ɔɪ",
  UH: "ʊ",
  UW: "uː",
  B: "b",
  CH: "tʃ",
  D: "d",
  DH: "ð",
  F: "f",
  G: "ɡ",
  HH: "h",
  JH: "dʒ",
  K: "k",
  L: "l",
  M: "m",
  N: "n",
  NG: "ŋ",
  P: "p",
  R: "ɹ",
  S: "s",
  SH: "ʃ",
  T: "t",
  TH: "θ",
  V: "v",
  W: "w",
  Y: "j",
  Z: "z",
  ZH: "ʒ",
};

/** One ARPAbet phone (`AH0`, `T`) in IPA, with its stress digit (-1 for a consonant); null for a symbol not in ARPAbet. */
export function arpabetPhone(symbol: string): { phone: string; stress: number } | null {
  const found = /^([A-Z]+)([012])?$/u.exec(symbol);
  if (found === null) return null;
  const [, base = "", digit] = found;
  const ipa = ARPABET[base];
  if (ipa === undefined) return null;
  const stress = digit === undefined ? -1 : Number(digit);
  if (stress === 0 && base === "AH") return { phone: "ə", stress };
  if (stress === 0 && base === "ER") return { phone: "ɚ", stress };
  return { phone: ipa, stress };
}

/** CMUdict's lines as a dictionary; a line with a symbol not in ARPAbet is skipped. */
export function parseCmudict(text: string): Dictionary {
  const words = new Map<string, (readonly string[])[]>();
  for (const line of text.split(/\r?\n/u)) {
    const [entry = ""] = line.split("#");
    const [word = "", ...symbols] = entry.trim().split(/\s+/u);
    const key = wordKey(word.replace(/\(\d+\)$/u, ""));
    if (key === "" || symbols.length === 0) continue;
    const phones = symbols.map(arpabetPhone);
    if (phones.some((phone) => phone === null)) continue;
    const said = phones.map((phone) => phone?.phone ?? "");
    const primary = phones.findIndex((phone) => phone?.stress === 1);
    const stress = primary >= 0 ? primary : phones.findIndex((phone) => phone?.stress === 2);
    addTo(words, key, said, stress, "cmudict");
  }
  return words;
}

/** `first`'s pronunciations of each word, then `second`'s that differ from them; words of either. */
export function mergeDictionaries(first: Dictionary, second: Dictionary): Dictionary {
  const words = new Map<string, (readonly string[])[]>();
  for (const [key, said] of first) words.set(key, [...said]);
  for (const [key, said] of second) {
    const known = words.get(key) ?? [];
    const spelt = new Set(known.map((one) => one.join(" ")));
    words.set(key, [...known, ...said.filter((one) => !spelt.has(one.join(" ")))]);
  }
  return words;
}
