import { expect, test } from "bun:test";
import { Z_P05 } from "../pronounce/native";
import {
  CUTS,
  cutsOf,
  MARKS,
  type Mark,
  MIN_MARKED,
  overridesOf,
  Personal,
  personalCut,
  resultLine,
  vowelSetting,
} from "../pronounce/personal";
import { fakeState } from "./fake-api";

/** `right` right and `wrong` wrong marks, scores falling from `top` by 0.01, rights first. */
function marks(right: number, wrong: number, top = 0.99) {
  return [
    ...Array.from({ length: right }, () => "right" as const),
    ...Array.from({ length: wrong }, () => "wrong" as const),
  ].map((verdict, at) => ({ verdict, score: Math.round((top - at / 100) * 100) / 100 }));
}

test("fewer than 15 marks is not enough, however they went", () => {
  expect(MIN_MARKED).toBe(15);
  expect(personalCut(marks(14, 0))).toEqual({ state: "few", marked: 14, right: 14 });
  expect(resultLine(personalCut(marks(3, 2)))).toBe("Not enough marks yet (5 of 15)");
  expect(resultLine(undefined)).toBe("Not enough marks yet (0 of 15)");
});

test("the cut-off is the lowest score with 80% right above it and 15 marked", () => {
  // 16 right from 0.99 down to 0.84, then 4 wrong from 0.83 to 0.80: down to 0.80, 16 of 20.
  expect(personalCut(marks(16, 4))).toEqual({ state: "on", cut: 0.8, marked: 20, right: 16 });
  // 12 right then 8 wrong: 12 of 15, at 0.85, holds; 12 of 16 below it does not.
  expect(personalCut(marks(12, 8))).toEqual({ state: "on", cut: 0.85, marked: 15, right: 12 });
  expect(resultLine(personalCut(marks(16, 4)))).toBe("On for you from score 0.80 (16 of 20 right)");
});

test("wrong flags at the top keep the cut-off above them only when 15 are left under 80% right", () => {
  // The worst-scored are wrong, then all right: every cut-off has the wrong ones above it.
  const wrongFirst = [
    ...Array.from({ length: 5 }, (_, at) => ({
      verdict: "wrong" as const,
      score: 0.99 - at / 100,
    })),
    ...Array.from({ length: 15 }, (_, at) => ({
      verdict: "right" as const,
      score: 0.9 - at / 100,
    })),
  ];
  // 15 of 20 is 75%: no cut-off holds, so the check is off for the reader.
  expect(personalCut(wrongFirst)).toEqual({ state: "off", marked: 20, right: 15 });
  expect(resultLine(personalCut(wrongFirst))).toBe("Off: only 15 of 20 right");
});

test("a cut-off takes every flag of its score: a tie is never split", () => {
  // 15 right at 0.9 and 5 wrong at 0.9: one place to cut, 15 of 20.
  const tied = [
    ...Array.from({ length: 15 }, () => ({ verdict: "right" as const, score: 0.9 })),
    ...Array.from({ length: 5 }, () => ({ verdict: "wrong" as const, score: 0.9 })),
  ];
  expect(personalCut(tied)).toEqual({ state: "off", marked: 20, right: 15 });
  const one = [...tied.slice(0, 16), { verdict: "right" as const, score: 0.95 }];
  expect(personalCut(one)).toEqual({ state: "on", cut: 0.9, marked: 17, right: 16 });
});

test("the worker's settings: on from the cut-off, off, and none for a check with too few marks", () => {
  const doc = {
    v: 1 as const,
    marks: Object.fromEntries([
      ...marks(16, 4).map((one, at): [string, Mark] => [`th${at}`, { ...one, check: "th" }]),
      ...marks(5, 15).map((one, at): [string, Mark] => [`zs${at}`, { ...one, check: "z-s" }]),
      ...marks(16, 0, 2.5).map((one, at): [string, Mark] => [
        `st${at}`,
        { ...one, check: "stress" },
      ]),
      ...marks(3, 0).map((one, at): [string, Mark] => [`wv${at}`, { ...one, check: "w-v" }]),
    ]),
  };
  const cuts = cutsOf(doc);
  expect(cuts.checks["w-v"]).toEqual({ state: "few", marked: 3, right: 3 });
  expect(overridesOf(cuts)).toEqual({
    contrasts: { th: { off: false, maybe: 0.8 }, "z-s": { off: true, maybe: 1 } },
    stress: { off: false, maybe: 2.35 },
  });
  expect(overridesOf(cutsOf({ v: 1, marks: {} }))).toBeUndefined();
});

test("the vowel patterns follow the reader's marks over the file, at minus their score as the deviate", () => {
  const vowel = (right: number, wrong: number) =>
    cutsOf({
      v: 1,
      marks: Object.fromEntries(
        marks(right, wrong, 3.5).map((one, at): [string, Mark] => [
          `v${at}`,
          { ...one, check: "vowel-patterns" },
        ]),
      ),
    });
  expect(vowelSetting(vowel(2, 0), false)).toEqual({ on: false, deviate: Z_P05 });
  expect(vowelSetting(vowel(2, 0), true)).toEqual({ on: true, deviate: Z_P05 });
  expect(vowelSetting(vowel(16, 0), false)).toEqual({ on: true, deviate: -3.35 });
  expect(vowelSetting(vowel(4, 16), true)).toEqual({ on: false, deviate: Z_P05 });
});

test("marks are kept in api.state with the cut-offs they make; one taken back goes; reset clears both", async () => {
  const { state, documents } = fakeState();
  const personal = new Personal(state);
  await personal.load();
  for (const [at, one] of marks(15, 0).entries()) {
    await personal.mark(`f${at}`, one.verdict, "th", one.score);
  }
  expect(personal.verdictOf("f0")).toBe("right");
  expect(personal.results().checks.th).toEqual({ state: "on", cut: 0.85, marked: 15, right: 15 });
  expect(documents.get(CUTS)).toEqual(personal.results());
  expect(personal.overrides()).toEqual({ contrasts: { th: { off: false, maybe: 0.85 } } });

  await personal.mark("f14", null, "th", 0.85);
  expect(personal.verdictOf("f14")).toBeNull();
  expect(personal.results().checks.th?.state).toBe("few");

  // Read back by a new start.
  const again = new Personal(state);
  await again.load();
  expect(again.count()).toBe(14);

  await again.reset();
  expect(again.count()).toBe(0);
  expect(again.overrides()).toBeUndefined();
  expect(documents.get(MARKS)).toEqual({ v: 1, marks: {} });
  expect(documents.get(CUTS)).toEqual({ v: 1, checks: {} });
});
