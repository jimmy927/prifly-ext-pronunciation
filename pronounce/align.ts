/**
 * A word's expected phones lined up with the phones heard in it, by edit
 * distance: each expected phone is matched (the same sound, `samePhone`),
 * substituted by a heard one, or deleted (not heard at all); heard phones
 * left over are insertions. A vowel for a consonant, or the reverse, costs
 * more than a like-for-like substitution, so a vowel lines up with a vowel.
 */

import { isVowel, samePhone } from "./phones";

export type Step =
  | { kind: "same"; expected: number; heard: number }
  | { kind: "sub"; expected: number; heard: number }
  | { kind: "del"; expected: number }
  | { kind: "ins"; heard: number };

/** A like-for-like substitution costs one; vowel for consonant this much. */
const CROSS_COST = 1.6;
const GAP_COST = 1;

function subCost(a: string, b: string): number {
  if (samePhone(a, b)) return 0;
  return isVowel(a) === isVowel(b) ? 1 : CROSS_COST;
}

/** The cheapest steps from `expected` to `heard`, in order. */
export function alignPhones(expected: readonly string[], heard: readonly string[]): Step[] {
  const rows = expected.length + 1;
  const cols = heard.length + 1;
  const cost = new Float64Array(rows * cols);
  for (let i = 0; i < rows; i++) cost[i * cols] = i * GAP_COST;
  for (let j = 0; j < cols; j++) cost[j] = j * GAP_COST;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const diagonal =
        (cost[(i - 1) * cols + j - 1] ?? 0) + subCost(expected[i - 1] ?? "", heard[j - 1] ?? "");
      const up = (cost[(i - 1) * cols + j] ?? 0) + GAP_COST;
      const left = (cost[i * cols + j - 1] ?? 0) + GAP_COST;
      cost[i * cols + j] = Math.min(diagonal, up, left);
    }
  }
  return backtrace(expected, heard, cost, cols);
}

/** The last step of the cheapest way to `(i, j)` in the filled table. */
function lastStep(
  expected: readonly string[],
  heard: readonly string[],
  at: (r: number, c: number) => number,
  i: number,
  j: number,
): Step {
  /** Whether the cheapest way to `(i, j)` came from `(r, c)` at `price`. */
  const came = (r: number, c: number, price: number) =>
    Math.abs(at(i, j) - (at(r, c) + price)) < 1e-9;
  const sub = i > 0 && j > 0 ? subCost(expected[i - 1] ?? "", heard[j - 1] ?? "") : -1;
  if (sub >= 0 && came(i - 1, j - 1, sub)) {
    return { kind: sub === 0 ? "same" : "sub", expected: i - 1, heard: j - 1 };
  }
  if (i > 0 && came(i - 1, j, GAP_COST)) return { kind: "del", expected: i - 1 };
  return { kind: "ins", heard: j - 1 };
}

function backtrace(
  expected: readonly string[],
  heard: readonly string[],
  cost: Float64Array,
  cols: number,
): Step[] {
  const steps: Step[] = [];
  let i = expected.length;
  let j = heard.length;
  const at = (r: number, c: number) => cost[r * cols + c] ?? 0;
  while (i > 0 || j > 0) {
    const step = lastStep(expected, heard, at, i, j);
    steps.push(step);
    if (step.kind !== "ins") i--;
    if (step.kind !== "del") j--;
  }
  return steps.reverse();
}
