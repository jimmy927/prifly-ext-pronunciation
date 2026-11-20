/**
 * Any other swapped sound: a consonant of a content word that the model heard as another
 * English consonant, the J in "just" as a Y, an R as an L, where that swap is none of the five
 * the named checks look at (`contrasts.ts`). The noisiest check, so it asks for a lot:
 *
 * - the consonant's goodness (`gop.ts`'s LPR: its own log posterior minus its best competitor's,
 *   over its aligned frames) sits at or past the natives' cut-off for that very consonant
 *   (`thresholds.ts`'s `any-sound`, by default their 0.5th percentile: 1 native sound in 200);
 * - the competitor that won is an English consonant, not the same sound (`samePhone`), not one
 *   of the five named swaps, and not the consonant before or after it in the word, where the
 *   alignment's edges blur;
 * - no other accepted pronunciation of the word has that consonant there.
 *
 * Function words and words not in Britfone are never looked at, as for every check. The worst
 * such consonant of a word is its mark. The worker makes these (`serve.ts`), with the natives'
 * statistics beside the cut-offs; `tools/calibrate/stats.py` measures the cut-off on the same
 * candidates (`anySoundCandidates`, written by `dump.ts`).
 */

import { cameOutAs, contrastId, soundName } from "./contrasts";
import { stressOf, wordKey } from "./dictionary";
import { phoneScore } from "./gop";
import { chosenOf, type Judged, type JudgeWord, otherHas, type ReadPiece } from "./judge";
import { curveFor, deviateOf, type NativeStats, normalShare } from "./native";
import { isVowel, samePhone } from "./phones";
import { respellPair, spellsConsonant } from "./respell";
import { type DeviateCut, deviateLevel } from "./thresholds";

/** `markDictation`'s limits for a card's line and a respelling. */
const MAX_DETAIL = 300;
const MAX_SPELLING = 40;

/** The card's first words: the check's name. */
export const ANY_SOUND_HEAD = "Swapped sound.";

/** How to say each English consonant, for the card's fix. */
const HOW_TO: Record<string, string> = {
  p: "Close both lips, then open them with a puff of air.",
  b: "Close both lips and keep your voice on as they open.",
  t: "Tongue tip on the ridge behind the top teeth, then let go.",
  d: "Tongue tip on the ridge behind the top teeth, voice on, then let go.",
  k: "Back of the tongue up against the roof of the mouth, then let go.",
  ɡ: "Back of the tongue up against the roof of the mouth, voice on, then let go.",
  f: "Top teeth on the bottom lip, blow without voice.",
  v: "Top teeth on the bottom lip, voice on: a buzz.",
  θ: "Tongue tip between the teeth, let the air through.",
  ð: "Tongue tip between the teeth, voice on, let the air through.",
  s: "Tongue tip behind the top teeth: a sharp hiss, no voice.",
  z: "Tongue tip behind the top teeth, voice on: a buzz.",
  ʃ: "Round the lips and hush, the tongue a little further back than for S.",
  ʒ: "As SH, with your voice on.",
  tʃ: "Start with the tongue touching, as for T, then hush.",
  dʒ: "Start with the tongue touching, as for D, then let it go with your voice on.",
  h: "Only breath from the throat; nothing in the mouth.",
  m: "Lips closed, hum through the nose.",
  n: "Tongue tip on the ridge behind the top teeth, hum through the nose.",
  ŋ: "Back of the tongue up, hum through the nose, no G after it.",
  l: "Tongue tip on the ridge behind the top teeth, the air round its sides.",
  ɹ: "Tongue tip up and back without touching anything, lips a little round.",
  j: "Tongue high and forward, as in 'yes', gliding into the vowel.",
  w: "Round the lips as for OO and glide into the vowel; teeth off the lip.",
};

/** A consonant that lost to another: where it is in the chosen pronunciation, the two sounds, its LPR, and whether it ends the word. */
export type SoundCandidate = {
  at: number;
  expected: string;
  rival: string;
  lpr: number;
  last: boolean;
};

/** Every consonant of word `index` that the check would mark were it far enough off: the conditions but the natives' cut-off. */
export function anySoundCandidates(read: ReadPiece, index: number): SoundCandidate[] {
  const entry = read.entries[index];
  const chosen = chosenOf(read, index);
  if (entry?.judged !== true || chosen === null) return [];
  const { word, said } = chosen;
  return said.flatMap((expected, at): SoundCandidate[] => {
    const phone = word.phones[at];
    if (phone === undefined || isVowel(expected) || !spellsConsonant(expected)) return [];
    const score = phoneScore(read.post, read.set, phone);
    const rival = score.competitor;
    const last = at === said.length - 1;
    const neighbour = [said[at - 1], said[at + 1]].some(
      (one) => one !== undefined && samePhone(one, rival),
    );
    if (!spellsConsonant(rival) || samePhone(rival, expected) || neighbour) return [];
    if (contrastId(expected, rival, last) !== null || otherHas(entry, said, at, rival)) return [];
    return [{ at, expected, rival, lpr: score.lpr, last }];
  });
}

/** The card: "Swapped sound. The J in 'just' came out as a Y. Start with the tongue touching, …". */
export function anySoundFix(word: string, expected: string, rival: string): string {
  const how = HOW_TO[expected] ?? "";
  const what = `The ${soundName(expected)} in '${wordKey(word)}' came out as ${cameOutAs(rival)}.`;
  return `${ANY_SOUND_HEAD} ${what}${how === "" ? "" : ` ${how}`}`.slice(0, MAX_DETAIL);
}

/** The check's marks of a piece already read, at most one a word; none without native statistics. */
export function anySoundMarks(
  read: ReadPiece,
  words: readonly JudgeWord[],
  natives: NativeStats | null,
  cut: DeviateCut,
): Judged[] {
  return anySoundFound(read, words, natives, cut).map((one) => one.mark);
}

/** Word `index`'s consonant furthest past the natives' cut-off for it; null when none is. */
function worstOf(
  read: ReadPiece,
  index: number,
  natives: NativeStats,
  cut: DeviateCut,
): { one: SoundCandidate; deviate: number } | null {
  return worstSound(anySoundCandidates(read, index), natives, cut);
}

/** Of a word's `candidates`, the consonant furthest past the natives' cut-off for it; null when none is. */
export function worstSound(
  candidates: readonly SoundCandidate[],
  natives: NativeStats,
  cut: DeviateCut,
): { one: SoundCandidate; deviate: number } | null {
  let worst: { one: SoundCandidate; deviate: number } | null = null;
  for (const one of candidates) {
    const curve = curveFor(natives, "phone", one.expected);
    const deviate = curve === null ? 0 : deviateOf(curve, one.lpr);
    if (curve === null || deviate > cut.maybe) continue;
    if (worst === null || deviate < worst.deviate) worst = { one, deviate };
  }
  return worst;
}

/** `anySoundMarks`, each with the native deviate of its consonant. */
export function anySoundFound(
  read: ReadPiece,
  words: readonly JudgeWord[],
  natives: NativeStats | null,
  cut: DeviateCut,
): { mark: Judged; deviate: number }[] {
  if (natives === null || cut.off) return [];
  return words.flatMap((word, index): { mark: Judged; deviate: number }[] => {
    const worst = worstOf(read, index, natives, cut);
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
    const heard = chosen.said.map((phone, at) => (at === one.at ? one.rival : phone));
    const mark: Judged = {
      index,
      check: "any-sound",
      word: word.word,
      heard: heard.join(""),
      expected: chosen.said.join(""),
      sound: `${soundName(one.expected)} → ${soundName(one.rival)}`,
      how: HOW_TO[one.expected] ?? "",
      posterior: 1 - normalShare(deviate),
      level: deviateLevel(deviate, cut),
      said: said.slice(0, MAX_SPELLING),
      say: say.slice(0, MAX_SPELLING),
      fix: anySoundFix(word.word, one.expected, one.rival),
    };
    return [{ mark, deviate }];
  });
}
