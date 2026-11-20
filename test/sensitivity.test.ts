import { expect, test } from "bun:test";
import type { Judged } from "../pronounce/judge";
import { Z_P2, Z_P01, Z_P05, Z_P10 } from "../pronounce/native";
import {
  cutAtStep,
  drawnAt,
  levelAtStep,
  SENSITIVITY,
  SENSITIVITY_OPTIONS,
  sensitivityOf,
  stepsOf,
  withSteps,
} from "../pronounce/sensitivity";
import { loadStressCheck, parseStressCheck, stressCheckAt } from "../pronounce/stress";
import {
  cutAt,
  cutOf,
  DEFAULT_CUT,
  DEFAULT_DEVIATE_CUT,
  deviateCutAt,
  deviateCutOf,
  loadDeviateCuts,
  parseDeviateCuts,
  parseThresholds,
  THRESHOLDS_PATH,
  thresholdsAt,
} from "../pronounce/thresholds";

test("the setting's value picks a step; anything else is the default", () => {
  expect(sensitivityOf(undefined)).toBe(0);
  expect(sensitivityOf({ [SENSITIVITY]: SENSITIVITY_OPTIONS[1] })).toBe(1);
  expect(sensitivityOf({ [SENSITIVITY]: SENSITIVITY_OPTIONS[2] })).toBe(2);
  expect(sensitivityOf({ [SENSITIVITY]: "Like 1 in 3 natives" })).toBe(0);
});

test("each step's maybe is its own, its sure the step before's maybe; the default keeps both cut-offs", () => {
  const ladder = { maybe: 0.5, sure: 0.725, looser: [0.35, 0.2] as const };
  expect(cutAtStep(ladder, 0)).toEqual({ maybe: 0.5, sure: 0.725 });
  expect(cutAtStep(ladder, 1)).toEqual({ maybe: 0.35, sure: 0.5 });
  expect(cutAtStep(ladder, 2)).toEqual({ maybe: 0.2, sure: 0.35 });
});

test("a contrast without looser steps stays at its cut-offs at every step; a looser one stricter than the step before is pulled to it", () => {
  expect(cutAt(DEFAULT_CUT, 2)).toEqual({ maybe: 0.7, sure: 0.88, off: false });
  const cuts = parseThresholds({
    contrasts: { th: { maybe: 0.5, sure: 0.6, looser: { "1/50": 0.6, "1/10": 0.3 } } },
  });
  expect(cutOf(cuts, "th").looser).toEqual([0.5, 0.3]);
  expect(cutOf(thresholdsAt(cuts, 2), "th")).toEqual({ maybe: 0.3, sure: 0.5, off: false });
  // Every contrast is in a step's thresholds, the ones the file leaves out at the defaults.
  expect(cutOf(thresholdsAt(cuts, 1), "w-v")).toEqual({ maybe: 0.7, sure: 0.88, off: false });
});

test("the natives'-scale checks loosen to the 2nd and 10th percentile without looser steps, to the file's with", () => {
  expect(deviateCutAt(DEFAULT_DEVIATE_CUT, 0)).toEqual({ maybe: Z_P05, sure: Z_P01, off: false });
  expect(deviateCutAt(DEFAULT_DEVIATE_CUT, 1)).toEqual({ maybe: Z_P2, sure: Z_P05, off: false });
  expect(deviateCutAt(DEFAULT_DEVIATE_CUT, 2)).toEqual({ maybe: Z_P10, sure: Z_P2, off: false });
  const cuts = parseDeviateCuts({
    contrasts: { "any-sound": { maybe: -2.8, looser: { "1/50": -3, "1/10": -1.5 } } },
  });
  // -3 is stricter than the maybe it loosens: pulled to it.
  expect(deviateCutAt(deviateCutOf(cuts, "any-sound"), 1).maybe).toBe(-2.8);
  expect(deviateCutAt(deviateCutOf(cuts, "any-sound"), 2)).toEqual({
    maybe: -1.5,
    sure: -2.8,
    off: false,
  });
});

test("word stress loosens each combination's lead by its looser steps", () => {
  const natives = { stress: { lead: { "dur+rms": { n: 5000, p50: -0.6, p99: 1 } } } };
  const check = parseStressCheck(
    {
      contrasts: {
        stress: {
          off: false,
          cuts: { "dur+rms": { maybe: 1.25, sure: 1.8, looser: { "1/50": 0.9, "1/10": 0.3 } } },
        },
      },
    },
    natives,
  );
  expect(check).not.toBeNull();
  if (check === null) return;
  expect(stressCheckAt(check, 0).cuts["dur+rms"]).toEqual({ maybe: 1.25, sure: 1.8 });
  expect(stressCheckAt(check, 1).cuts["dur+rms"]).toEqual({ maybe: 0.9, sure: 1.25 });
  expect(stressCheckAt(check, 2).cuts["dur+rms"]).toEqual({ maybe: 0.3, sure: 0.9 });
});

test("the shipped files give every check its looser steps, each looser than the one before", async () => {
  const contrasts = parseThresholds(await Bun.file(THRESHOLDS_PATH).json());
  for (const [, cut] of thresholdsAt(contrasts, 0)) expect(cut.maybe).toBe(0.5);
  for (const step of [1, 2] as const) {
    for (const [, cut] of thresholdsAt(contrasts, step)) expect(cut.maybe).toBeLessThan(0.5);
  }
  const deviates = await loadDeviateCuts(THRESHOLDS_PATH);
  for (const id of ["any-sound", "weak-vowels"] as const) {
    expect(deviateCutOf(deviates, id).looser).toEqual([Z_P2, Z_P10]);
  }
  const stress = await loadStressCheck(THRESHOLDS_PATH);
  for (const cut of Object.values(stress?.cuts ?? {})) {
    expect(cut.looser?.[0]).toBeLessThan(cut.maybe);
    expect(cut.looser?.[1]).toBeLessThan(cut.looser?.[0] ?? 0);
  }
  expect(Object.keys(stress?.cuts ?? {})).toHaveLength(2);
});

const mark = (index: number, level: "sure" | "maybe", check: Judged["check"] = "th"): Judged => ({
  index,
  check,
  word: `w${index}`,
  heard: "",
  expected: "",
  sound: "",
  how: "",
  posterior: 0.5,
  level,
  said: "",
  say: "",
  fix: `fix ${index}`,
});

test("a mark judged at every step carries the first step that draws it and the first that draws it sure", () => {
  const merged = withSteps([
    [mark(0, "sure")],
    [mark(0, "sure"), mark(1, "maybe")],
    [mark(0, "sure"), mark(1, "sure"), mark(2, "maybe"), mark(2, "maybe", "stress")],
  ]);
  expect(merged.map((one) => [one.index, one.check, one.steps, one.level])).toEqual([
    [0, "th", { drawn: 0, sure: 0 }, "sure"],
    [1, "th", { drawn: 1, sure: 2 }, "maybe"],
    [2, "th", { drawn: 2, sure: 3 }, "maybe"],
    [2, "stress", { drawn: 2, sure: 3 }, "maybe"],
  ]);
  const [, late] = merged;
  const steps = stepsOf(late?.steps, "maybe");
  expect([0, 1, 2].map((step) => drawnAt(steps, step as 0 | 1 | 2))).toEqual([false, true, true]);
  expect(levelAtStep(steps, 1)).toBe("maybe");
  expect(levelAtStep(steps, 2)).toBe("sure");
  // A mark given without steps (an older worker) is drawn at every step at its own level.
  expect(stepsOf(undefined, "sure")).toEqual({ drawn: 0, sure: 0 });
  expect(stepsOf(undefined, "maybe")).toEqual({ drawn: 0, sure: 3 });
});
