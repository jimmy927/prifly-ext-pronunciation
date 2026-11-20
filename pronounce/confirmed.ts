/**
 * Vowel underlines from a confirmed pattern. A vowel is not underlined word by
 * word on its own: one word's vowel score flags natives far too often. Once
 * the accent profile has confirmed a vowel feature (`profile.ts`: over 40 and
 * more examples the reader's median sits past the natives' 10th percentile), a
 * later word with that vowel is underlined when, in that word,
 *
 * - the vowel sits past the natives' 0.5th percentile (`Z_P05`): at most 1
 *   native word in 200 would be underlined, were the pattern a native's (or
 *   past the reader's own cut-off, once their marks in "Check your flags"
 *   set one, `personal.ts`);
 * - the sound the model liked best instead is the pattern's own (the A in
 *   "cap" for an open U in "cup"), so the card's words hold for this word too;
 * - no other check marked the word already.
 *
 * It is "maybe" unless it is far past, beyond 1 native word in 2000
 * (`Z_P005`), "sure". The Underline setting and "Not a mistake" apply as to
 * every mark: these go through the coach like the others.
 */

import { patternCard, soundOf, vowelKey } from "./accent-words";
import type { Judged } from "./judge";
import { deviateOf, type NativeStats, normalShare, valueAt, Z_P05, Z_P005 } from "./native";
import { samePhone } from "./phones";
import { type Assessed, curveOfKey } from "./profile";
import { respellPair } from "./respell";
import type { VowelScore, WordScores } from "./scores";

/** `markDictation`'s limits for a card's line and a respelling. */
const MAX_DETAIL = 300;
const MAX_SPELLING = 40;

type Found = { vowel: VowelScore; rival: string; deviate: number };

/** The vowel of `word` furthest past its confirmed pattern's cut-off; null when none is. */
function worstVowel(
  word: WordScores,
  patterns: ReadonlyMap<string, Assessed>,
  stats: NativeStats,
  cut: number,
): Found | null {
  let worst: Found | null = null;
  for (const vowel of word.vowels) {
    const key = vowelKey(vowel.phone);
    const pattern = patterns.get(key);
    const curve = curveOfKey(stats, key);
    if (pattern === undefined || curve === null || pattern.rival === "") continue;
    if (!samePhone(vowel.rival, pattern.rival)) continue;
    if (vowel.lpr > valueAt(curve, cut)) continue;
    const deviate = deviateOf(curve, vowel.lpr);
    if (worst === null || deviate < worst.deviate) worst = { vowel, rival: pattern.rival, deviate };
  }
  return worst;
}

/** The mark of `found` in word `scores` said as `text`; null when it cannot be put in plain words. */
function markOf(scores: WordScores, text: string, found: Found): Judged | null {
  const { vowel, rival, deviate } = found;
  const card = patternCard(vowel.phone, rival);
  const last = vowel.at === scores.phones.length - 1;
  const { said, say } = respellPair(scores.phones, scores.stress, vowel.at, rival, last);
  if (card === null || said === "" || said === say) return null;
  const heard = scores.phones.map((phone, at) => (at === vowel.at ? rival : phone));
  return {
    index: scores.index,
    word: text,
    heard: heard.join(""),
    expected: scores.phones.join(""),
    sound: soundOf(vowel.phone, rival),
    how: card,
    posterior: 1 - normalShare(deviate),
    level: deviate <= Z_P005 ? "sure" : "maybe",
    said: said.slice(0, MAX_SPELLING),
    say: say.slice(0, MAX_SPELLING),
    fix: card.slice(0, MAX_DETAIL),
  };
}

/**
 * The confirmed-pattern marks of a piece: `scores` are its content words',
 * `texts` every word's text by index, `assessed` the profile now, `taken` the
 * words another check marked. None without native statistics. `cut` is the
 * native deviate a vowel must sit below: `Z_P05`, or the reader's own from
 * their marks (`personal.ts`).
 */
export function confirmedMarks(
  scores: readonly WordScores[],
  texts: readonly string[],
  assessed: readonly Assessed[],
  stats: NativeStats | null,
  taken: ReadonlySet<number>,
  cut: number = Z_P05,
): Judged[] {
  if (stats === null) return [];
  const patterns = new Map(
    assessed
      .filter((one) => one.confirmed && one.key.startsWith("vowel/"))
      .map((one) => [one.key, one]),
  );
  if (patterns.size === 0) return [];
  return scores.flatMap((word): Judged[] => {
    const text = texts[word.index];
    if (text === undefined || taken.has(word.index)) return [];
    const found = worstVowel(word, patterns, stats, cut);
    const mark = found === null ? null : markOf(word, text, found);
    return mark === null ? [] : [mark];
  });
}
