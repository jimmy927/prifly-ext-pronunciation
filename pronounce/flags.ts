/**
 * Every candidate flag of a piece, from every check (`checks.ts`), at loose cut-offs: what "Check
 * your flags" (`flag-check.ts`) shows the reader to mark right or wrong, so they can see which
 * checks they agree with, and switch the others off in Settings.
 *
 * - The five contrasts (`judge.ts`): a swap heard from a posterior of `LOOSE_POSTERIOR` up,
 *   with the same conditions a mark has otherwise (the expected phone not heard there too, no
 *   other accepted pronunciation has the heard phone). Its score is the posterior. At most one
 *   flag per word and check: the surest.
 * - Any other swapped sound (`any-sound.ts`) and unreduced vowels (`weak-vowels.ts`): as they
 *   mark in the session, from their cut-off on the natives' scale. Their score is how many
 *   native standard deviations the sound sits below their median.
 * - Word stress (`stress.ts`): a lead from its combination's `maybe` cut-off up, the check read
 *   even where the file has it off. Its score is the lead.
 * - Vowels: a content word's vowel past the natives' 5th percentile (`Z_P5`, from the extension's
 *   native statistics); the word's worst one. Its score is how many native standard deviations
 *   it sits below their median (higher is further off), so every check's score rises with how
 *   far off the word is.
 *
 * The worker makes all but the vowels' (`serve.ts`, a `scan` request); the extension makes the
 * vowels' from the scores the worker sends with them, since the natives' numbers it compares
 * them with are its own.
 */

import { soundOf, titleOf, vowelKey } from "./accent-words";
import { anySoundFound } from "./any-sound";
import type { CheckId } from "./checks";
import { CONTRAST_IDS, type ContrastId } from "./contrasts";
import { contrastMarks, type JudgeWord, type ReadPiece } from "./judge";
import { deviateOf, type NativeStats } from "./native";
import { curveOfKey } from "./profile";
import type { WordScores } from "./scores";
import { type StressCheck, stressFound } from "./stress";
import { type Cut, type DeviateCuts, deviateCutOf, type Thresholds } from "./thresholds";
import { weakVowelFound } from "./weak-vowels";

/** A contrast is a flag from this posterior up. */
export const LOOSE_POSTERIOR = 0.5;
/** z of the natives' 5th percentile: a vowel below it is a flag. */
export const Z_P5 = -1.6449;

/** A candidate flag: which word of the piece (`index`), which check, its score, and what the sound was. */
export type Flag = { index: number; check: CheckId; score: number; sound: string; fix: string };

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Every contrast on, from `LOOSE_POSTERIOR` up. */
const LOOSE: Thresholds = new Map<ContrastId, Cut>(
  CONTRAST_IDS.map((id) => [id, { maybe: LOOSE_POSTERIOR, sure: 1, off: false }]),
);

/** What the worker scans a piece with: word stress read even when off (null without its data), the natives' statistics and their cut-offs. */
export type ScanChecks = {
  stress: StressCheck | null;
  natives: NativeStats | null;
  cuts: DeviateCuts;
};

/** Every flag but the vowels' of a piece already read, its 16 kHz `audio` for word stress. */
export function scanFlags(
  read: ReadPiece,
  words: readonly JudgeWord[],
  audio: Float32Array,
  checks: ScanChecks,
): Flag[] {
  const { stress, natives, cuts } = checks;
  const contrasts = contrastMarks(read, words, LOOSE).map(
    (mark): Flag => ({
      index: mark.index,
      check: mark.check,
      score: round(mark.posterior),
      sound: mark.sound,
      fix: mark.fix,
    }),
  );
  const swapped = anySoundFound(read, words, natives, deviateCutOf(cuts, "any-sound")).map(
    ({ mark, deviate }): Flag => ({
      index: mark.index,
      check: mark.check,
      score: round(-deviate),
      sound: mark.sound,
      fix: mark.fix,
    }),
  );
  const weak = weakVowelFound(read, words, natives, deviateCutOf(cuts, "weak-vowels")).map(
    ({ mark, deviate }): Flag => ({
      index: mark.index,
      check: mark.check,
      score: round(-deviate),
      sound: mark.sound,
      fix: mark.fix,
    }),
  );
  const stressed =
    stress === null
      ? []
      : stressFound(read, words, audio, stress).map(
          ({ mark, lead }): Flag => ({
            index: mark.index,
            check: "stress",
            score: round(lead),
            sound: mark.sound,
            fix: mark.fix,
          }),
        );
  return [...contrasts, ...swapped, ...stressed, ...weak];
}

/** The word's vowel furthest below the natives' median, when it is past `Z_P5`; null otherwise. */
function worstVowel(
  word: WordScores,
  stats: NativeStats,
): { deviate: number; phone: string; rival: string } | null {
  let worst: { deviate: number; phone: string; rival: string } | null = null;
  for (const vowel of word.vowels) {
    const curve = curveOfKey(stats, vowelKey(vowel.phone));
    const deviate = curve === null ? 0 : deviateOf(curve, vowel.lpr);
    if (deviate <= Z_P5 && (worst === null || deviate < worst.deviate)) {
      worst = { deviate, phone: vowel.phone, rival: vowel.rival };
    }
  }
  return worst;
}

/** Every flag of a scanned piece (`flag-check.ts`): the worker's and the vowels'. */
export function flagsOfScan(
  answer: { flags: readonly Flag[]; scores: readonly WordScores[] },
  stats: NativeStats | null,
): Flag[] {
  return [...answer.flags, ...vowelFlags(answer.scores, stats)];
}

/** The vowel flags of a piece from its content words' scores: each word's vowel furthest past `Z_P5`. */
export function vowelFlags(scores: readonly WordScores[], stats: NativeStats | null): Flag[] {
  if (stats === null) return [];
  return scores.flatMap((word): Flag[] => {
    const worst = worstVowel(word, stats);
    if (worst === null) return [];
    return [
      {
        index: word.index,
        check: "vowel-patterns",
        score: round(-worst.deviate),
        sound: worst.rival === "" ? worst.phone : soundOf(worst.phone, worst.rival),
        fix: titleOf(vowelKey(worst.phone), worst.rival === "" ? null : worst.rival),
      },
    ];
  });
}
