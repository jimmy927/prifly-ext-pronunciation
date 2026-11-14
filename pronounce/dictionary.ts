/**
 * The pronouncing dictionary: Britfone 3.0.1 (Jose Llarena, MIT), about
 * 16,000 common English words in British pronunciation, one line each —
 * `THREE, θ ɹ ˈiː`, and `WORD(1)`, `WORD(2)` for a word said two ways. Its
 * phones come space-separated, so they need no splitting; the stress marks
 * go (`stressOf` keeps where the stress fell) and a few letters take the model's spelling (`dictionaryPhone`). A word
 * not in it is not checked.
 */

import { dictionaryPhone } from "./phones";

/** Each word, as `wordKey` makes it, to its pronunciations. */
export type Dictionary = ReadonlyMap<string, readonly (readonly string[])[]>;

/** Where each pronunciation's primary stress falls, by the array `parseDictionary` made for it. Kept beside the arrays so they stay plain lists of phones. */
const STRESS = new WeakMap<readonly string[], number>();

/** The index of the phone a pronunciation stresses (its primary stress, else its secondary one); -1 when it has none or is not from `parseDictionary`. */
export function stressOf(pronunciation: readonly string[]): number {
  return STRESS.get(pronunciation) ?? -1;
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

const LINE = /^(.+?)(?:\(\d+\))?,\s*(.+)$/u;

/** Britfone's lines as a dictionary; a line that is no entry is skipped. */
export function parseDictionary(text: string): Dictionary {
  const words = new Map<string, string[][]>();
  for (const line of text.split(/\r?\n/u)) {
    const found = LINE.exec(line.trim());
    if (found === null) continue;
    const [, word = "", phones = ""] = found;
    const raw = phones.split(/\s+/u).filter((phone) => dictionaryPhone(phone) !== "");
    const said = raw.map(dictionaryPhone);
    const key = wordKey(word);
    if (said.length === 0 || key === "") continue;
    const known = words.get(key) ?? [];
    STRESS.set(said, stressIndex(raw));
    known.push(said);
    words.set(key, known);
  }
  return words;
}
