/**
 * How native speakers' sounds score, from `pronounce/data/native-stats.json`
 * (written by `tools/calibrate/stats.py` on LibriSpeech and VCTK): per phone
 * and per vowel, percentiles of the goodness (LPR, `gop.ts`) of every one the
 * natives said. The accent profile (`profile.ts`), the Vowels check
 * (`vowels.ts`), any other swapped sound (`any-sound.ts`) and unreduced vowels
 * (`weak-vowels.ts`) place the reader's scores among them.
 *
 * A score is placed by its normal deviate: the percentiles given (p1, p5, p10
 * … p99, and p0.5 when the file has it) are points of value against z, and a
 * value between two is read off the line between them; past the last point
 * the end segment is carried on, which is what a normal tail does. So p0.5,
 * when the file lacks it, is p1 less 0.37 of the p1 to p5 gap.
 *
 * The file's shape: `{ "phones": { "z": { "lpr": { "n": 812, "p1": -4.1, … } } },
 * "vowels": { "ʌ": { "lpr": { … }, "durationMs": { … } } }, "stress": { … } }`;
 * other keys are ignored here.
 */

import { join } from "node:path";
import { z } from "zod";

/** The normal deviate of each percentile `stats.py` may write. */
const Z_OF: ReadonlyArray<readonly [string, number]> = [
  ["p0.5", -2.5758],
  ["p1", -2.3263],
  ["p5", -1.6449],
  ["p10", -1.2816],
  ["p25", -0.6745],
  ["p50", 0],
  ["p75", 0.6745],
  ["p90", 1.2816],
  ["p95", 1.6449],
  ["p99", 2.3263],
];

/** z of the natives' 10th percentile: a feature whose median sits below it is further off than 9 in 10 native ones. */
export const Z_P10 = -1.2816;
/** z of the natives' 2nd percentile: 1 native sound in 50 (the Sensitivity step "Like 1 in 50 natives"). */
export const Z_P2 = -2.0537;
/** z of the natives' 0.5th percentile: at most 1 native word in 200 sits below it. */
export const Z_P05 = -2.5758;
/** z of the natives' 0.1th percentile: 1 native sound in 1000. */
export const Z_P01 = -3.0902;
/** Native examples a phone needs before the reader's are compared with them. */
export const MIN_NATIVE = 100;

const Summary = z.object({ n: z.number() }).catchall(z.number().nullable());
const Entry = z.looseObject({ lpr: Summary });
const File = z.looseObject({
  phones: z.record(z.string(), Entry).default({}),
  vowels: z.record(z.string(), Entry).default({}),
});

/** One phone's native LPR distribution, as (value, z) points in rising order. */
export type NativeCurve = { n: number; points: readonly (readonly [number, number])[] };

export type NativeStats = {
  phones: ReadonlyMap<string, NativeCurve>;
  vowels: ReadonlyMap<string, NativeCurve>;
};

/** Where the extension looks for the file. */
export const NATIVE_STATS_PATH = join(import.meta.dir, "data", "native-stats.json");

function curveOf(summary: z.infer<typeof Summary>): NativeCurve | null {
  const points: [number, number][] = [];
  for (const [key, deviate] of Z_OF) {
    const value = summary[key];
    if (typeof value === "number") points.push([value, deviate]);
  }
  // Percentiles never fall as z rises; a file where they do is not read.
  const rising = points.every((point, at) => at === 0 || point[0] >= (points[at - 1]?.[0] ?? 0));
  return points.length >= 2 && rising ? { n: summary.n, points } : null;
}

function curves(entries: Record<string, z.infer<typeof Entry>>): Map<string, NativeCurve> {
  const out = new Map<string, NativeCurve>();
  for (const [phone, entry] of Object.entries(entries)) {
    const curve = curveOf(entry.lpr);
    if (curve !== null) out.set(phone, curve);
  }
  return out;
}

/** The statistics of the file's JSON. Throws on JSON of another shape. */
export function parseNativeStats(json: unknown): NativeStats {
  const file = File.parse(json);
  return { phones: curves(file.phones), vowels: curves(file.vowels) };
}

/**
 * The file's statistics; null when there is none yet (the calibration has not
 * run), or when it is not valid, which is logged: either way nothing is
 * compared, the profile only collects.
 */
export async function loadNativeStats(
  path: string = NATIVE_STATS_PATH,
  log: (why: string) => void = () => undefined,
): Promise<NativeStats | null> {
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  try {
    return parseNativeStats(await file.json());
  } catch (caught) {
    log(caught instanceof Error ? caught.message : String(caught));
    return null;
  }
}

/** The curve to compare `phone` with, as a vowel or any phone; null when the natives said too few. */
export function curveFor(
  stats: NativeStats | null,
  kind: "vowel" | "phone",
  phone: string,
): NativeCurve | null {
  const curve = (kind === "vowel" ? stats?.vowels : stats?.phones)?.get(phone);
  return curve !== undefined && curve.n >= MIN_NATIVE ? curve : null;
}

/** Linear between `a` and `b` on one axis, read on the other: `from` 0 is the value, 1 is z. */
function across(a: readonly number[], b: readonly number[], x: number, from: 0 | 1): number {
  const to = from === 0 ? 1 : 0;
  const ax = a[from] ?? 0;
  const bx = b[from] ?? 0;
  if (bx === ax) return a[to] ?? 0;
  return (a[to] ?? 0) + ((x - ax) * ((b[to] ?? 0) - (a[to] ?? 0))) / (bx - ax);
}

/** The two points of `curve` whose segment covers `x` on axis `from`, the end ones past either end. */
function segment(curve: NativeCurve, x: number, from: 0 | 1) {
  const { points } = curve;
  let at = 1;
  while (at < points.length - 1 && (points[at]?.[from] ?? 0) < x) at++;
  return [points[at - 1] ?? [0, 0], points[at] ?? [0, 0]] as const;
}

/** The normal deviate of `lpr` among the natives: below 0 is worse than their median. */
export function deviateOf(curve: NativeCurve, lpr: number): number {
  const [a, b] = segment(curve, lpr, 0);
  return across(a, b, lpr, 0);
}

/** The LPR at deviate `z` among the natives. */
export function valueAt(curve: NativeCurve, deviate: number): number {
  const [a, b] = segment(curve, deviate, 1);
  return across(a, b, deviate, 1);
}

/** The standard normal's cumulative share at `x` (Abramowitz and Stegun 26.2.17, error under 1e-7). */
export function normalShare(x: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(x));
  const poly =
    t *
    (0.31938153 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const tail = (Math.exp((-x * x) / 2) / Math.sqrt(2 * Math.PI)) * poly;
  return x >= 0 ? 1 - tail : tail;
}
