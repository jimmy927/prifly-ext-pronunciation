/**
 * The vowel patterns the accent profile has confirmed (`profile.ts`: over 40 and more examples
 * the reader's median sits past the natives' 10th percentile), as the Vowels check (`vowels.ts`)
 * uses them. A word's vowel of a confirmed pattern, heard as the pattern's own sound (the A in
 * "cap" for an open U in "cup"), is
 *
 * - underlined "sure": the reader says it that way over and over, not once;
 * - underlined even where it is not the word's stressed vowel, which the Vowels check otherwise
 *   leaves alone;
 * - given the pattern's card ("Your U in 'cup' tends to open, like the A in 'cap'; here too").
 *
 * Whether it is underlined at all is still the natives' 0.5th percentile's, as for every vowel.
 */

import { vowelKey } from "./accent-words";
import { samePhone } from "./phones";
import type { Assessed } from "./profile";
import type { VowelScore } from "./scores";

/** The confirmed vowel patterns of `assessed`, by feature key (`vowel/ʌ`), with a sound heard instead. */
export function confirmedPatterns(assessed: readonly Assessed[]): ReadonlyMap<string, Assessed> {
  return new Map(
    assessed
      .filter((one) => one.confirmed && one.key.startsWith("vowel/") && one.rival !== "")
      .map((one) => [one.key, one]),
  );
}

/** The confirmed pattern `vowel` is an example of: its vowel's, heard as the pattern's sound; null for none. */
export function patternOf(
  patterns: ReadonlyMap<string, Assessed>,
  vowel: Pick<VowelScore, "phone" | "rival">,
): Assessed | null {
  const pattern = patterns.get(vowelKey(vowel.phone));
  return pattern !== undefined && samePhone(vowel.rival, pattern.rival) ? pattern : null;
}
