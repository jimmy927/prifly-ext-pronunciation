/**
 * A word's phones (Britfone's, `dictionary.ts`) as plain English letters for a
 * reader who knows no phonetics: "BROW-zzer". Each word is shown twice, as it
 * was heard (`said`) and as it should be said (`say`), the same way, so that
 * only the swapped sound differs between them.
 *
 * The rules, which every respelling follows:
 * - Syllables are joined by "-", one for each vowel. A consonant between two
 *   vowels goes to the second syllable, as far as English can start a word
 *   with it ("pl", "str"); of "kʃ" only the "ʃ" does, so it is AK-shuns.
 * - The stressed syllable is in CAPITALS, the others in lower case. A word of
 *   one syllable is in capitals, being stressed. A word with no stress mark
 *   takes its first syllable as the stressed one.
 * - The swapped sound is doubled ("zz", "ss") when it stands alone between a
 *   vowel before it and a vowel or the word's end after it, so the eye lands
 *   on it: BROW-zzer, THEEZZ, bee-KOZZ. It is not doubled at the start of a
 *   word, in a cluster, or where it is spelled with two letters (sh, ch, th):
 *   AK-shuns, not AK-shhuns.
 * - Final devoicing takes the whole voiced cluster at the word's end with it
 *   (German and Swedish speakers say "threads" as THRETS, not THREDS): the
 *   heard version turns each voiced stop or fricative before the last into
 *   its voiceless twin, and a cluster is never doubled: THREDZ, NEEDZ.
 * - A z outside the swapped sound is spelled "s", as English spells it in a
 *   plural ("shuns"), so a "z" in the respelling is always the sound the
 *   reader is asked to buzz.
 * - A schwa ends a word as "er" and is "u" elsewhere; an unstressed short
 *   "ɪ" ending a syllable is "ee" (bee-KOZZ), and "i" otherwise.
 */

import { FINAL_DEVOICING } from "./contrasts";
import { isVowel } from "./phones";

/** Consonants as letters. */
const CONSONANTS: Record<string, string> = {
  p: "p",
  b: "b",
  t: "t",
  d: "d",
  k: "k",
  ɡ: "g",
  tʃ: "ch",
  dʒ: "j",
  f: "f",
  v: "v",
  θ: "th",
  ð: "th",
  s: "s",
  z: "z",
  ʃ: "sh",
  ʒ: "zh",
  h: "h",
  m: "m",
  n: "n",
  ŋ: "ng",
  l: "l",
  ɹ: "r",
  j: "y",
  w: "w",
};

/** Vowels as letters, where one spelling does for every place in a word. */
const VOWELS: Record<string, string> = {
  iː: "ee",
  i: "ee",
  ɪ: "i",
  ɛ: "e",
  e: "e",
  æ: "a",
  a: "a",
  ɑː: "ah",
  ɑ: "ah",
  ɒ: "o",
  ɔː: "aw",
  ɔ: "aw",
  ʊ: "oo",
  uː: "oo",
  u: "oo",
  ʌ: "u",
  ɐ: "u",
  ɜː: "er",
  ɜ: "er",
  ɚ: "er",
  eɪ: "ay",
  aɪ: "eye",
  ɔɪ: "oy",
  əʊ: "oh",
  oʊ: "oh",
  aʊ: "ow",
  ɪə: "eer",
  ɛə: "air",
  eə: "air",
  ʊə: "oor",
};

/** Two phones that may start a syllable, after an s or alone, as English starts words. */
const ONSET_PAIRS: ReadonlySet<string> = new Set(
  (
    "p.l p.ɹ b.l b.ɹ t.ɹ d.ɹ k.l k.ɹ k.w ɡ.l ɡ.ɹ f.l f.ɹ θ.ɹ ʃ.ɹ t.w d.w θ.w s.w s.l s.m s.n " +
    "s.p s.t s.k h.j k.j p.j b.j f.j v.j m.j n.j t.j d.j l.j s.j θ.j z.j"
  ).split(" "),
);
/** Three phones that may start a syllable. */
const ONSET_TRIPLES: ReadonlySet<string> = new Set(
  "s.p.l s.p.ɹ s.t.ɹ s.k.ɹ s.k.w s.k.l s.p.j s.t.j s.k.j".split(" "),
);

/** Whether the consonants `phones` can start a syllable. */
function isOnset(phones: readonly string[]): boolean {
  if (phones.length <= 1) return true;
  const key = phones.join(".");
  return phones.length === 2 ? ONSET_PAIRS.has(key) : ONSET_TRIPLES.has(key);
}

/** Syllables as lists of phone indexes: one for each vowel, the consonants between two going to the second as far as `isOnset` allows. */
function syllables(phones: readonly string[]): number[][] {
  const nuclei = phones.flatMap((phone, at) => (isVowel(phone) ? [at] : []));
  if (nuclei.length === 0) return [phones.map((_, at) => at)];
  const cuts = [0];
  for (let n = 1; n < nuclei.length; n++) {
    const prev = nuclei[n - 1] ?? 0;
    const next = nuclei[n] ?? 0;
    let start = next;
    while (start - 1 > prev && isOnset(phones.slice(start - 1, next))) start--;
    cuts.push(start);
  }
  return cuts.map((from, n) => {
    const to = cuts[n + 1] ?? phones.length;
    return Array.from({ length: to - from }, (_, k) => from + k);
  });
}

/** The swapped stretch of a word's phones: indexes `from` to `to`, `to` not included. */
export type Swap = { from: number; to: number };

/** Everything one word's spelling needs besides its phones. */
type Spelling = { phones: readonly string[]; swap: Swap; doubled: boolean };

function consonantLetters(phone: string): string {
  return CONSONANTS[phone] ?? "";
}

/** Whether `phone` is an English consonant these respellings have letters for. */
export function spellsConsonant(phone: string): boolean {
  return consonantLetters(phone) !== "";
}

/** Whether `phone` is a vowel these respellings have letters for. */
export function spellsVowel(phone: string): boolean {
  return phone === "ə" || (VOWELS[phone] ?? "") !== "";
}

/** One consonant as letters: a z outside the swap is "s", the swapped single letter doubled when `doubled`. */
function spellConsonant(spelling: Spelling, at: number): string {
  const phone = spelling.phones[at] ?? "";
  const inSwap = at >= spelling.swap.from && at < spelling.swap.to;
  const letters = phone === "z" && !inSwap ? "s" : consonantLetters(phone);
  return inSwap && spelling.doubled ? letters.repeat(2) : letters;
}

/** One vowel as letters, by where it stands in the word and its syllable. */
function spellVowel(
  phones: readonly string[],
  at: number,
  stressed: boolean,
  open: boolean,
): string {
  const phone = phones[at] ?? "";
  if (phone === "ə") return at === phones.length - 1 ? "er" : "u";
  if (phone === "ɪ" && !stressed && open) return "ee";
  return VOWELS[phone] ?? "";
}

/** The respelling of `phones`: `stress` is the index of the stressed phone (-1: none), `swap` the swapped stretch, `doubled` whether it is written doubled. */
export function respell(
  phones: readonly string[],
  stress: number,
  swap: Swap,
  doubled: boolean,
): string {
  const parts = syllables(phones);
  const found = parts.findIndex((part) => part.includes(stress));
  const stressedAt = Math.max(found, 0);
  const spelling: Spelling = { phones, swap, doubled };
  return parts
    .map((part, n) => {
      const last = part[part.length - 1] ?? 0;
      const text = part
        .map((at) =>
          isVowel(phones[at] ?? "")
            ? spellVowel(phones, at, n === stressedAt, at === last)
            : spellConsonant(spelling, at),
        )
        .join("");
      return n === stressedAt ? text.toUpperCase() : text;
    })
    .join("-");
}

/** Whether the swapped stretch is written doubled: one single-letter consonant, after a vowel, before a vowel or the word's end. */
function isDoubled(phones: readonly string[], heard: readonly string[], swap: Swap): boolean {
  if (swap.to - swap.from !== 1) return false;
  const { from } = swap;
  const single = (phone: string | undefined) => consonantLetters(phone ?? "").length === 1;
  if (!single(phones[from]) || !single(heard[from])) return false;
  const before = phones[from - 1];
  const after = phones[from + 1];
  return before !== undefined && isVowel(before) && (after === undefined || isVowel(after));
}

/**
 * The word as heard and as it should be said, respelt. `phones` are the
 * dictionary's, `stress` where they are stressed (`stressOf`), `at` the
 * swapped phone, `heard` what was heard in its place, `last` whether it is
 * the word's last: a final devoicing takes the voiced consonants before it
 * with it.
 */
export function respellPair(
  phones: readonly string[],
  stress: number,
  at: number,
  heard: string,
  last: boolean,
): { said: string; say: string } {
  const swapped = [...phones];
  swapped[at] = heard;
  let from = at;
  const devoicing = last && FINAL_DEVOICING[phones[at] ?? ""] === heard;
  while (devoicing && from > 0) {
    const twin = FINAL_DEVOICING[phones[from - 1] ?? ""];
    if (twin === undefined) break;
    swapped[from - 1] = twin;
    from--;
  }
  const swap = { from, to: at + 1 };
  const doubled = isDoubled(phones, swapped, swap);
  return {
    said: respell(swapped, stress, swap, doubled),
    say: respell(phones, stress, swap, doubled),
  };
}
