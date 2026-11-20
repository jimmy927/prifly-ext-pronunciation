/**
 * The checks as the reader sees them, each with its own switch in Settings → Extensions →
 * Pronunciation (`prifly-extension.json`), every one on unless the reader turns it off:
 *
 * - the five consonant contrasts (`contrasts.ts`, `judge.ts`), at their cut-offs in
 *   `thresholds.json` (`thresholds.ts`);
 * - any other swapped consonant (`any-sound.ts`);
 * - word stress (`stress.ts`);
 * - vowels (`vowels.ts`): a stressed full vowel natives almost never say that way. Its id,
 *   `vowel-patterns`, is the one it had when only confirmed vowel patterns were underlined,
 *   kept so the reader's marks of it stay readable;
 * - unreduced vowels (`weak-vowels.ts`).
 *
 * A switched-off check's marks are not drawn, those already given included (`coach.ts`).
 * Nothing else turns a check off: not the calibration, not the reader's marks.
 *
 * The order is also each word's: where several checks mark one word, the first of them that
 * is switched on is the mark drawn.
 */

import type { SettingValues } from "@prifly/extension-api";
import { CONTRAST_IDS, type ContrastId } from "./contrasts";

export const CHECK_IDS = [
  ...CONTRAST_IDS,
  "any-sound",
  "stress",
  "vowel-patterns",
  "weak-vowels",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/** Each check's switch: its boolean setting's id in `prifly-extension.json`. */
export const SWITCHES: Record<CheckId, string> = {
  "z-s": "checkZs",
  "final-devoicing": "checkFinalD",
  th: "checkTh",
  "w-v": "checkWv",
  "sh-ch": "checkShCh",
  "any-sound": "checkAnySound",
  stress: "checkStress",
  "vowel-patterns": "checkVowels",
  "weak-vowels": "checkWeakVowels",
};

/** Each check's name: its switch's label in Settings, and its title in "Check your flags". */
export const CHECK_LABELS: Record<CheckId, string> = {
  "z-s": "Z said as S",
  "final-devoicing": "Final D said as T",
  th: "TH said as T, D, S or F",
  "w-v": "W and V swapped",
  "sh-ch": "SH, CH and J swapped",
  "any-sound": "Any other swapped sound",
  stress: "Word stress",
  "vowel-patterns": "Vowels",
  "weak-vowels": "Unreduced vowels",
};

/** The checks switched on in `values`: every one whose switch is not set to false. */
export function switchedOn(values: SettingValues | undefined): ReadonlySet<CheckId> {
  return new Set(CHECK_IDS.filter((id) => values?.[SWITCHES[id]] !== false));
}

/**
 * The reader's check of a contrast's swap of `expected`: a final Z said as S is "Z said as S"
 * to the reader (please, these, was), though its cut-offs stay final devoicing's, the check the
 * calibration measured it in. Every other swap is its contrast's own.
 */
export function checkOfSwap(id: ContrastId, expected: string): CheckId {
  return id === "final-devoicing" && expected === "z" ? "z-s" : id;
}
