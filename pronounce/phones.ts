/**
 * Phones as the two sides write them. The dictionary (Britfone, British) and
 * the phoneme model (espeak's IPA, trained on Common Voice, much of it
 * American) spell the same sound differently: "əʊ" and "oʊ", "ɒ" and "ɑː",
 * a final "ə" and "ɚ", "t" and the flap "ɾ". Those count as the same here
 * (`samePhone`), so an accent is never underlined — only a sound that is
 * another sound in every accent.
 *
 * The model also writes some sequences as one token ("əl", "ɑːɹ"); they are
 * split into their phones first (`splitHeard`).
 */

/** The model's tokens that are two phones: split, so they line up with the dictionary's. */
const SPLIT: Record<string, readonly string[]> = {
  əl: ["ə", "l"],
  ɑːɹ: ["ɑː", "ɹ"],
  ɔːɹ: ["ɔː", "ɹ"],
  oːɹ: ["ɔː", "ɹ"],
  ɛɹ: ["ɛ", "ɹ"],
  ɪɹ: ["ɪ", "ɹ"],
  ʊɹ: ["ʊ", "ɹ"],
  aɪɚ: ["aɪ", "ɚ"],
  aɪə: ["aɪ", "ə"],
};

/** A heard token as its phones. */
export function splitHeard(token: string): readonly string[] {
  return SPLIT[token] ?? [token];
}

/**
 * Groups of phones that are one sound for this purpose: accent variants, and
 * the flap and the glottal stop that stand for a t or d between vowels.
 * Every phone of a group is the same as every other of it, and nothing
 * carries across groups: "ɔ" is like "ɒ" and like "ɔː", and "ɒ" and "ɔː"
 * stay apart, no group holding both.
 */
const SAME_GROUPS: readonly (readonly string[])[] = [
  ["əʊ", "oʊ", "o", "oː"],
  ["ə", "ɚ", "ɐ", "ʌ", "ᵻ", "ɜ"],
  ["ɪ", "ᵻ", "i"],
  ["iː", "i"],
  ["uː", "u"],
  ["ɒ", "ɑː", "ɑ", "ɔ"],
  ["ɔː", "ɔ", "oː"],
  ["ɜː", "ɚ", "ɜ"],
  ["ɛ", "e"],
  ["eə", "ɛə", "ɛ", "e", "eː"],
  ["ɪə", "iə", "ɪ"],
  ["ʊə", "ʊ"],
  ["ʊə", "ɔː"],
  ["æ", "a"],
  ["aɪ", "äɪ"],
  ["t", "ɾ", "ʔ"],
  ["d", "ɾ"],
  ["ɹ", "r", "ʁ", "ɻ"],
  ["l", "ɫ"],
];

/** Each phone to the groups it is in. */
const GROUPS_OF = new Map<string, Set<number>>();
SAME_GROUPS.forEach((group, at) => {
  for (const phone of group) {
    const known = GROUPS_OF.get(phone) ?? new Set<number>();
    known.add(at);
    GROUPS_OF.set(phone, known);
  }
});

/** Whether `a` and `b` are the same sound here: the same phone, or in one group. */
export function samePhone(a: string, b: string): boolean {
  if (a === b) return true;
  const left = GROUPS_OF.get(a);
  const right = GROUPS_OF.get(b);
  if (left === undefined || right === undefined) return false;
  for (const group of left) if (right.has(group)) return true;
  return false;
}

const VOWEL = /[aeiouyæɑɒɔəɛɜɪʊʌɐɚᵻøœɨʉɵɤɯ]/u;

export function isVowel(phone: string): boolean {
  return VOWEL.test(phone);
}

/** A phone as the dictionary writes it, in the model's spelling: no stress marks, the IPA "ɡ", "ɹ" for r. */
export function dictionaryPhone(phone: string): string {
  const bare = phone.replace(/[ˈˌ]/gu, "");
  if (bare === "g") return "ɡ";
  if (bare === "r") return "ɹ";
  return bare;
}
