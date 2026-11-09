/**
 * The pronouncing dictionary: Britfone 3.0.1 (Jose Llarena, MIT), about
 * 16,000 common English words in British pronunciation, one line each —
 * `THREE, θ ɹ ˈiː`, and `WORD(1)`, `WORD(2)` for a word said two ways. Its
 * phones come space-separated, so they need no splitting; the stress marks
 * go and a few letters take the model's spelling (`dictionaryPhone`). A word
 * not in it is not checked.
 */

import { dictionaryPhone } from "./phones";

/** Each word, as `wordKey` makes it, to its pronunciations. */
export type Dictionary = ReadonlyMap<string, readonly (readonly string[])[]>;

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
    const said = phones
      .split(/\s+/u)
      .map(dictionaryPhone)
      .filter((phone) => phone !== "");
    const key = wordKey(word);
    if (said.length === 0 || key === "") continue;
    const known = words.get(key) ?? [];
    known.push(said);
    words.set(key, known);
  }
  return words;
}
