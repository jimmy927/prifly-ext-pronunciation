import { expect, test } from "bun:test";
import type { WordRecord } from "../tools/calibrate/features";
import { rescore, rescoreTable, wordsAt } from "../tools/calibrate/rescore";

/** A judged word of utterance "p0" as dump.ts writes it, with nothing to mark unless `extra` says. */
function record(i: number, word: string, variant: string, extra: Partial<WordRecord>): WordRecord {
  return {
    utt: "p0",
    i,
    word,
    key: word,
    known: true,
    judged: true,
    functionWord: false,
    variants: 1,
    variant,
    variantIndex: 0,
    variantSource: "britfone",
    from: 0,
    to: 1,
    stress: 1,
    stressVowel: 0,
    stressAccepts: [0],
    phones: [],
    vowels: [],
    candidates: [],
    anySound: [],
    weakVowels: [],
    ...extra,
  };
}

const files = {
  thresholds: {
    contrasts: { th: { maybe: 0.5, sure: 0.5, looser: { "1/50": 0.25, "1/10": 0.2 } } },
  },
  // The natives' j: its 5th percentile at LPR 0, between their 2nd and 10th.
  natives: { phones: { dʒ: { lpr: { n: 1000, p1: -2, p5: 0, p10: 1, p50: 4, p90: 6 } } } },
};

test("a dump's numbers are marked by the extension's checks at each Sensitivity step, with the card", () => {
  const thin = record(0, "thin", "θ ɪ n", {
    candidates: [
      {
        at: 0,
        expected: "θ",
        heard: "t",
        id: "th",
        last: false,
        posterior: 0.3,
        wasHeard: true,
        expectedHeard: false,
        variantAccepts: false,
      },
    ],
  });
  const just = record(1, "just", "dʒ ʌ s t", {
    anySound: [{ at: 0, expected: "dʒ", rival: "j", lpr: 0, last: false }],
  });
  const said = record(2, "were", "w ɜː", { judged: false });
  const marks = rescore([thin, just, said], files);
  expect(marks.get("p0")?.map((one) => [one.word, one.check, one.steps])).toEqual([
    ["thin", "th", { drawn: 1, sure: 2 }],
    ["just", "any-sound", { drawn: 2, sure: 3 }],
  ]);
  expect([wordsAt(marks, 0), wordsAt(marks, 1), wordsAt(marks, 2)]).toEqual([0, 1, 2]);
  const table = rescoreTable(marks);
  expect(table).toContain(
    "| p0 | thin | th | 1 in 50 natives | –, maybe, sure | TH said as T. Tongue tip between the teeth, let the air through. |",
  );
  expect(table).toContain(
    "Words underlined: Like 1 in 200 natives: 0; Like 1 in 50 natives: 1; Like 1 in 10 natives: 2",
  );
});
