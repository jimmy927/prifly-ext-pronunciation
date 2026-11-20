/**
 * The Sensitivity setting: how readily a word is underlined, as how many native speakers' words
 * would be underlined the same way. Three steps, each looser than the one before:
 *
 * - "Like 1 in 200 natives" (the default): every check at the cut-offs it had before the
 *   setting, "not sure" from where natives get it on 1 word (or sound) in 200, "sure" from 1 in
 *   1000;
 * - "Like 1 in 50 natives" and "Like 1 in 10 natives": "not sure" from 1 in 50 and 1 in 10,
 *   and "sure" stays one step stricter: from the step before's "not sure".
 *
 * Each check keeps a ladder of cut-offs, one "not sure" per step and the default's "sure"
 * (`thresholds.json`'s `looser`, `thresholds.ts`, `stress.ts`; the vowels' in `vowels.ts`). The
 * worker judges a piece at every step and gives each mark the first step that draws it and the
 * first that draws it sure (`withSteps`); the coach draws what the setting asks for now, so a
 * change applies at once to the marks already given (`drawn.ts`).
 */

import type { SettingValues } from "@prifly/extension-api";
import type { Judged } from "./judge";

/** The setting's id in `prifly-extension.json`. */
export const SENSITIVITY = "sensitivity";

/** Its options, as `prifly-extension.json` declares them, strictest first: a step is its index. */
export const SENSITIVITY_OPTIONS = [
  "Like 1 in 200 natives",
  "Like 1 in 50 natives",
  "Like 1 in 10 natives",
] as const;

/** A step: 0 is the default, 2 the loosest. */
export type Sensitivity = 0 | 1 | 2;
export const STEPS: readonly Sensitivity[] = [0, 1, 2];

/** The step `values` pick; an unknown or missing value is the default. */
export function sensitivityOf(values: SettingValues | undefined): Sensitivity {
  const at = SENSITIVITY_OPTIONS.findIndex((one) => one === values?.[SENSITIVITY]);
  return at === 1 || at === 2 ? at : 0;
}

/** The option's text of step `step`, as Settings shows it. */
export function sensitivityLabel(step: Sensitivity): string {
  return SENSITIVITY_OPTIONS[step];
}

/** From which step a mark is drawn (`drawn`), and from which it is drawn sure (`sure`; 3: never). */
export type Steps = { drawn: Sensitivity; sure: 0 | 1 | 2 | 3 };

/** A mark's steps; one given without them is drawn at every step, at `level`, the level it came with. */
export function stepsOf(steps: Steps | undefined, level: "sure" | "maybe"): Steps {
  return steps ?? { drawn: 0, sure: level === "sure" ? 0 : 3 };
}

/** Whether a mark of `steps` is drawn at step `step`. */
export function drawnAt(steps: Steps, step: Sensitivity): boolean {
  return steps.drawn <= step;
}

/** A mark's level at step `step`. */
export function levelAtStep(steps: Steps, step: Sensitivity): "sure" | "maybe" {
  return steps.sure <= step ? "sure" : "maybe";
}

/**
 * A ladder's cut-offs at step `step`: "not sure" from `maybe[step]`, "sure" from the step
 * before's "not sure", or from `sure` at the default.
 */
export function cutAtStep(
  ladder: { maybe: number; sure: number; looser: readonly [number, number] },
  step: Sensitivity,
): { maybe: number; sure: number } {
  const maybes = [ladder.maybe, ...ladder.looser];
  const before = step === 0 ? ladder.sure : (maybes[step - 1] ?? ladder.maybe);
  return { maybe: maybes[step] ?? ladder.maybe, sure: before };
}

const keyOf = (one: Pick<Judged, "index" | "check">) => `${one.index}\n${one.check}`;

/**
 * One check run at each step (`byStep[0]` the default's marks, `byStep[2]` the loosest's), as
 * the loosest step's marks, each with the first step that gave it and the first that gave it
 * sure. A looser step marks every word a stricter one does, with the same sound: the check's
 * worst one in the word, whatever the cut-off.
 */
export function withSteps(byStep: readonly [Judged[], Judged[], Judged[]]): Judged[] {
  const [, , loosest] = byStep;
  return loosest.map((one): Judged => {
    const key = keyOf(one);
    const at = (step: Sensitivity) => byStep[step].find((other) => keyOf(other) === key);
    const drawn = STEPS.find((step) => at(step) !== undefined) ?? 2;
    const sure = STEPS.find((step) => at(step)?.level === "sure") ?? 3;
    return {
      ...one,
      level: sure <= drawn ? "sure" : "maybe",
      steps: { drawn, sure: Math.max(sure, drawn) as Steps["sure"] },
    };
  });
}
