/**
 * The Vowels check: a word whose stressed full vowel natives almost never say that way ("much"
 * said like "match", "go" with a vowel that should glide). Made by the extension, not the
 * worker, from the scores the worker sends with each piece (`scores.ts`), since the natives'
 * statistics and the accent profile are the extension's. A word is underlined when
 *
 * - its stressed vowel (the only one, in a word of one; never a weak "uh", `weak-vowels.ts` has
 *   those), gliding vowels included, sits at or past the natives' 0.5th percentile (`Z_P05`): at
 *   most 1 native word in 200 would be underlined;
 * - the sound the model liked best instead is a vowel of another kind that the card can name
 *   ("came out like the A in 'cap'").
 *
 * It is "maybe", and "sure" where the vowel is an example of a pattern the accent profile has
 * confirmed (`confirmed.ts`), which is underlined in any syllable, stressed or not, and gets the
 * pattern's card. The word's vowel furthest past is the mark's. The Underline setting, the
 * Vowels switch and "Not a mistake" apply as to every mark: these go through the coach.
 */

import { patternCard, soundOf, vowelCard, vowelKey } from "./accent-words";
import { confirmedPatterns, patternOf } from "./confirmed";
import { wordKey } from "./dictionary";
import type { Judged } from "./judge";
import { deviateOf, type NativeStats, normalShare, valueAt, Z_P05 } from "./native";
import { type Assessed, curveOfKey } from "./profile";
import { respellPair } from "./respell";
import type { VowelScore, WordScores } from "./scores";

/** `markDictation`'s limits for a card's line and a respelling. */
const MAX_DETAIL = 300;
const MAX_SPELLING = 40;

/** The weak vowels: never a stressed full vowel. */
const WEAK: ReadonlySet<string> = new Set(["ə", "ᵻ"]);

/** The card's first words: the check's name. */
export const VOWEL_HEAD = "Vowel.";

type Found = { vowel: VowelScore; deviate: number; confirmed: Assessed | null };

/** The index in `word.phones` of its stressed vowel: the dictionary's, or the only vowel of a word of one; -1 for none. */
export function stressedVowelAt(word: Pick<WordScores, "stress" | "vowels">): number {
  if (word.stress >= 0) return word.stress;
  const [only] = word.vowels;
  return word.vowels.length === 1 && only !== undefined ? only.at : -1;
}

/** The vowel of `word` furthest past the cut-off among those the check looks at; null when none is. */
function worstVowel(
  word: WordScores,
  patterns: ReadonlyMap<string, Assessed>,
  stats: NativeStats,
  cut: number,
): Found | null {
  const stressed = stressedVowelAt(word);
  let worst: Found | null = null;
  for (const vowel of word.vowels) {
    const confirmed = patternOf(patterns, vowel);
    const looked = confirmed !== null || (vowel.at === stressed && !WEAK.has(vowel.phone));
    const curve = curveOfKey(stats, vowelKey(vowel.phone));
    if (!looked || curve === null || vowel.rival === "") continue;
    if (vowel.lpr > valueAt(curve, cut)) continue;
    const deviate = deviateOf(curve, vowel.lpr);
    if (worst === null || deviate < worst.deviate) worst = { vowel, deviate, confirmed };
  }
  return worst;
}

/** The mark of `found` in word `scores` said as `text`; null when it cannot be put in plain words. */
function markOf(scores: WordScores, text: string, found: Found): Judged | null {
  const { vowel, deviate, confirmed } = found;
  const rival = confirmed?.rival ?? vowel.rival;
  const card =
    confirmed === null
      ? vowelCard(wordKey(text), vowel.phone, rival)
      : patternCard(vowel.phone, rival);
  const last = vowel.at === scores.phones.length - 1;
  const { said, say } = respellPair(scores.phones, scores.stress, vowel.at, rival, last);
  if (card === null || said === "" || said === say) return null;
  const heard = scores.phones.map((phone, at) => (at === vowel.at ? rival : phone));
  const fix = `${VOWEL_HEAD} ${card}`;
  return {
    index: scores.index,
    check: "vowel-patterns",
    word: text,
    heard: heard.join(""),
    expected: scores.phones.join(""),
    sound: soundOf(vowel.phone, rival),
    how: card,
    posterior: 1 - normalShare(deviate),
    level: confirmed === null ? "maybe" : "sure",
    said: said.slice(0, MAX_SPELLING),
    say: say.slice(0, MAX_SPELLING),
    fix: fix.slice(0, MAX_DETAIL),
  };
}

/**
 * The Vowels check's marks of a piece: `scores` are its content words', `texts` every word's
 * text by index, `assessed` the accent profile now. None without native statistics. `cut` is
 * the native deviate a vowel must sit at or below: `Z_P05`.
 */
export function vowelMarks(
  scores: readonly WordScores[],
  texts: readonly string[],
  assessed: readonly Assessed[],
  stats: NativeStats | null,
  cut: number = Z_P05,
): Judged[] {
  if (stats === null) return [];
  const patterns = confirmedPatterns(assessed);
  return scores.flatMap((word): Judged[] => {
    const text = texts[word.index];
    const found = text === undefined ? null : worstVowel(word, patterns, stats, cut);
    const mark = found === null || text === undefined ? null : markOf(word, text, found);
    return mark === null ? [] : [mark];
  });
}
