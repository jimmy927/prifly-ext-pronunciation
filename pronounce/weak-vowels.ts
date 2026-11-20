/**
 * Unreduced vowels: the weak "uh" of an unstressed syllable said as a full vowel, the A of
 * "about" like the A in "cap", the O of "today" like the O in "go". A word is underlined when,
 * at a schwa (ə) of its chosen pronunciation that is not its stressed vowel,
 *
 * - the schwa's goodness (`gop.ts`'s LPR) sits at or past the natives' cut-off for schwa
 *   (`thresholds.ts`'s `weak-vowels`, by default their 0.5th percentile: 1 native schwa in 200);
 * - the sound that won over it is a full vowel: no other weak one (the uh, er and short i
 *   sounds, `samePhone`), and one the card can name;
 * - no other accepted pronunciation of the word has that full vowel there.
 *
 * Function words, said weak or strong by natives alike, are never looked at. The worst such
 * schwa of a word is its mark. The worker makes these (`serve.ts`); `tools/calibrate/stats.py`
 * measures the cut-off on the same candidates (`weakVowelCandidates`, written by `dump.ts`).
 */

import { vowelNamed } from "./accent-words";
import { stressOf, wordKey } from "./dictionary";
import { phoneScore } from "./gop";
import { chosenOf, type Judged, type JudgeWord, otherHas, type ReadPiece } from "./judge";
import { curveFor, deviateOf, type NativeStats, normalShare } from "./native";
import { isVowel, samePhone } from "./phones";
import { respellPair, spellsVowel } from "./respell";
import { type DeviateCut, deviateLevel } from "./thresholds";

/** `markDictation`'s limits for a card's line and a respelling. */
const MAX_DETAIL = 300;
const MAX_SPELLING = 40;

/** The schwa, as the dictionary writes it. */
export const SCHWA = "ə";

/** The card's first words: the check's name. */
export const WEAK_HEAD = "Unreduced vowel.";

/** A schwa that lost to a full vowel: where it is in the chosen pronunciation, the vowel that won, its LPR, and whether it ends the word. */
export type WeakCandidate = { at: number; rival: string; lpr: number; last: boolean };

/** Whether `phone` is a weak vowel: the schwa's sounds or the short i's. */
function isWeak(phone: string): boolean {
  return samePhone(phone, SCHWA) || samePhone(phone, "ɪ");
}

/** Every unstressed schwa of word `index` heard as a full vowel: the conditions but the natives' cut-off. */
export function weakVowelCandidates(read: ReadPiece, index: number): WeakCandidate[] {
  const entry = read.entries[index];
  const chosen = chosenOf(read, index);
  if (entry?.judged !== true || chosen === null) return [];
  const { word, said } = chosen;
  const stress = stressOf(said);
  return said.flatMap((expected, at): WeakCandidate[] => {
    const phone = word.phones[at];
    if (phone === undefined || expected !== SCHWA || at === stress) return [];
    const score = phoneScore(read.post, read.set, phone);
    const rival = score.competitor;
    if (!isVowel(rival) || isWeak(rival) || !spellsVowel(rival) || vowelNamed(rival) === null) {
      return [];
    }
    if (otherHas(entry, said, at, rival)) return [];
    return [{ at, rival, lpr: score.lpr, last: at === said.length - 1 }];
  });
}

/** The card: "Unreduced vowel. The weak vowel in 'about' came out full, like the A in 'cap'. Say it short and weak: uh." */
export function weakVowelFix(word: string, rival: string): string {
  const like = vowelNamed(rival) ?? "a full vowel";
  return (
    `${WEAK_HEAD} The weak vowel in '${wordKey(word)}' came out full, like ${like}. ` +
    "Say it short and weak: uh."
  ).slice(0, MAX_DETAIL);
}

/** The check's marks of a piece already read, at most one a word; none without the natives' schwa. */
export function weakVowelMarks(
  read: ReadPiece,
  words: readonly JudgeWord[],
  natives: NativeStats | null,
  cut: DeviateCut,
): Judged[] {
  return weakVowelFound(read, words, natives, cut).map((one) => one.mark);
}

/** `weakVowelMarks`, each with the native deviate of its schwa. */
export function weakVowelFound(
  read: ReadPiece,
  words: readonly JudgeWord[],
  natives: NativeStats | null,
  cut: DeviateCut,
): { mark: Judged; deviate: number }[] {
  const curve = curveFor(natives, "vowel", SCHWA);
  if (curve === null || cut.off) return [];
  return words.flatMap((word, index): { mark: Judged; deviate: number }[] => {
    let worst: { one: WeakCandidate; deviate: number } | null = null;
    for (const one of weakVowelCandidates(read, index)) {
      const deviate = deviateOf(curve, one.lpr);
      if (deviate > cut.maybe) continue;
      if (worst === null || deviate < worst.deviate) worst = { one, deviate };
    }
    const chosen = chosenOf(read, index);
    if (worst === null || chosen === null) return [];
    const { one, deviate } = worst;
    const { said, say } = respellPair(
      chosen.said,
      stressOf(chosen.said),
      one.at,
      one.rival,
      one.last,
    );
    if (said === say) return [];
    const heard = chosen.said.map((phone, at) => (at === one.at ? one.rival : phone));
    const mark: Judged = {
      index,
      check: "weak-vowels",
      word: word.word,
      heard: heard.join(""),
      expected: chosen.said.join(""),
      sound: `uh → ${vowelNamed(one.rival) ?? one.rival}`,
      how: "say it short and weak: uh",
      posterior: 1 - normalShare(deviate),
      level: deviateLevel(deviate, cut),
      said: said.slice(0, MAX_SPELLING),
      say: say.slice(0, MAX_SPELLING),
      fix: weakVowelFix(word.word, one.rival),
    };
    return [{ mark, deviate }];
  });
}
