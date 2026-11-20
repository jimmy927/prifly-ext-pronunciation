/**
 * The cut-offs of the checks, from `pronounce/data/thresholds.json` when it is there, written by
 * `tools/calibrate/stats.py` from native and learner speech. Whether a check is drawn at all is
 * the reader's switch in Settings (`checks.ts`); this file only says from where a check marks.
 *
 * - The five contrasts (`contrasts.ts`'s `ContrastId`): from the posterior `maybe` up a heard
 *   swap is marked "maybe", from `sure` up "sure". A contrast the file does not list, or no
 *   file at all, keeps the cut-offs the 13-speaker benchmark settled on (`MIN_HEARD_POSTERIOR`,
 *   `SURE_POSTERIOR`); one it lists with `"off": true` is never marked.
 * - Any other swapped sound and unreduced vowels (`DeviateId`): on the natives' scale, a normal
 *   deviate (`native.ts`): a sound whose goodness sits at or below the natives' `maybe` is marked
 *   "maybe", at or below `sure` "sure". Without an entry: the natives' 0.5th percentile (1 sound
 *   in 200) and 0.1th (1 in 1000).
 *
 * The Sensitivity setting's looser steps (`sensitivity.ts`) are each entry's `looser`: the
 * "maybe" for natives at 1 in 50 and 1 in 10 (`"1/50"`, `"1/10"`), "sure" one step stricter.
 * Without it a contrast keeps its cut-offs at every step, and the natives'-scale checks
 * loosen to the natives' 2nd and 10th percentile. A looser value stricter than the step
 * before is pulled to it.
 *
 * The file: `{ "contrasts": { "z-s": { "maybe": 0.5, "sure": 0.5, "looser": { "1/50": 0.35,
 * "1/10": 0.2 } }, "any-sound": { "maybe": -2.9, "sure": -3.3 } } }`; other top-level keys
 * (where it came from, when, why) are ignored here, and so is the `stress` entry, which
 * `stress.ts` reads.
 */

import { join } from "node:path";
import { z } from "zod";
import { CONTRAST_IDS, type ContrastId } from "./contrasts";
import { Z_P2, Z_P01, Z_P05, Z_P10 } from "./native";
import { cutAtStep, type Sensitivity } from "./sensitivity";

/** The heard phone's highest probability over its frames must reach this for a substitution to count. */
export const MIN_HEARD_POSTERIOR = 0.7;
/** From this posterior up a mark is "sure"; from `MIN_HEARD_POSTERIOR` to just under it, "maybe". */
export const SURE_POSTERIOR = 0.88;

/** A check's cut-offs; `looser`: its "maybe" at the Sensitivity steps 1 in 50 and 1 in 10, when the file gives them. */
export type Cut = { maybe: number; sure: number; off: boolean; looser?: readonly [number, number] };

export type Thresholds = ReadonlyMap<ContrastId, Cut>;

export const DEFAULT_CUT: Cut = { maybe: MIN_HEARD_POSTERIOR, sure: SURE_POSTERIOR, off: false };

/** No file: every check at `DEFAULT_CUT`. */
export const NO_THRESHOLDS: Thresholds = new Map();

/** Where the extension looks for the file. */
export const THRESHOLDS_PATH = join(import.meta.dir, "data", "thresholds.json");

/** An entry's `looser`: the Sensitivity steps' "maybe", by the natives' rate. */
export const Looser = z.object({ "1/50": z.number().optional(), "1/10": z.number().optional() });

/**
 * `looser` as the two steps' "maybe", each no stricter than the one before (`stricter`: whether
 * `a` is stricter than `b` on the check's scale); a step the file leaves out is `fallback`'s.
 */
export function looserSteps(
  maybe: number,
  looser: z.infer<typeof Looser> | undefined,
  fallback: readonly [number, number],
  stricter: (a: number, b: number) => boolean,
): [number, number] {
  const loosen = (value: number, before: number) => (stricter(value, before) ? before : value);
  const fifty = loosen(looser?.["1/50"] ?? fallback[0], maybe);
  return [fifty, loosen(looser?.["1/10"] ?? fallback[1], fifty)];
}

const Entry = z.object({
  maybe: z.number().min(0).max(1).optional(),
  sure: z.number().min(0).max(1).optional(),
  off: z.boolean().optional(),
  looser: Looser.optional(),
});
const File = z.object({ contrasts: z.record(z.string(), z.unknown()) });

/**
 * The cut-offs of the file's JSON; an id that is no contrast is left out
 * unread, so the `stress` entry, whose cut-offs are on its own scale, is
 * `stress.ts`'s. Throws on JSON of another shape.
 */
export function parseThresholds(json: unknown): Thresholds {
  const cuts = new Map<ContrastId, Cut>();
  for (const [id, raw] of Object.entries(File.parse(json).contrasts)) {
    const known = CONTRAST_IDS.find((one) => one === id);
    if (known === undefined) continue;
    const entry = Entry.parse(raw);
    const maybe = entry.maybe ?? DEFAULT_CUT.maybe;
    cuts.set(known, {
      maybe,
      sure: Math.max(maybe, entry.sure ?? DEFAULT_CUT.sure),
      off: entry.off ?? false,
      ...(entry.looser === undefined
        ? {}
        : { looser: looserSteps(maybe, entry.looser, [maybe, maybe], (a, b) => a > b) }),
    });
  }
  return cuts;
}

/**
 * The file's cut-offs; `NO_THRESHOLDS` when there is no file, or when it is
 * not valid, which is said on stderr (the extension logs it) so the worker
 * still starts with the defaults.
 */
export async function loadThresholds(path: string = THRESHOLDS_PATH): Promise<Thresholds> {
  const file = Bun.file(path);
  if (!(await file.exists())) return NO_THRESHOLDS;
  try {
    return parseThresholds(await file.json());
  } catch (caught) {
    const why = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`pronounce: ${path} ignored, defaults used: ${why}\n`);
    return NO_THRESHOLDS;
  }
}

/** The cut-offs of check `id`. */
export function cutOf(thresholds: Thresholds, id: ContrastId): Cut {
  return thresholds.get(id) ?? DEFAULT_CUT;
}

/** How sure a mark of posterior `posterior` is under `cut`. */
export function levelAt(posterior: number, cut: Cut): "sure" | "maybe" {
  return posterior >= cut.sure ? "sure" : "maybe";
}

/** `cut` at Sensitivity step `step`: without `looser`, the same at every step. */
export function cutAt(cut: Cut, step: Sensitivity): Cut {
  const { maybe, sure, off, looser } = cut;
  return looser === undefined
    ? { maybe, sure, off }
    : { ...cutAtStep({ maybe, sure, looser }, step), off };
}

/** Every contrast's cut-offs at Sensitivity step `step`, the defaults included. */
export function thresholdsAt(thresholds: Thresholds, step: Sensitivity): Thresholds {
  return new Map(CONTRAST_IDS.map((id) => [id, cutAt(cutOf(thresholds, id), step)]));
}

/** The checks whose cut-offs are on the natives' scale. */
export const DEVIATE_IDS = ["any-sound", "weak-vowels"] as const;
export type DeviateId = (typeof DEVIATE_IDS)[number];

/**
 * A natives'-scale cut-off: marked "maybe" at or below `maybe`, "sure" at or below `sure` (both
 * normal deviates, below 0); `looser`: "maybe" at the Sensitivity steps 1 in 50 and 1 in 10.
 */
export type DeviateCut = {
  maybe: number;
  sure: number;
  off: boolean;
  looser?: readonly [number, number];
};

/** Without an entry: 1 native sound in 200 for "maybe", 1 in 1000 for "sure". */
export const DEFAULT_DEVIATE_CUT: DeviateCut = { maybe: Z_P05, sure: Z_P01, off: false };

/** The natives'-scale steps without a `looser`: 1 native sound in 50 and 1 in 10. */
export const DEFAULT_DEVIATE_LOOSER: readonly [number, number] = [Z_P2, Z_P10];

export type DeviateCuts = ReadonlyMap<DeviateId, DeviateCut>;

const DeviateEntry = z.object({
  maybe: z.number().max(0).optional(),
  sure: z.number().max(0).optional(),
  off: z.boolean().optional(),
  looser: Looser.optional(),
});

/** The natives'-scale cut-offs of the file's JSON; a check it does not list keeps `DEFAULT_DEVIATE_CUT`. Throws on JSON of another shape. */
export function parseDeviateCuts(json: unknown): DeviateCuts {
  const contrasts = File.parse(json).contrasts;
  const cuts = new Map<DeviateId, DeviateCut>();
  for (const id of DEVIATE_IDS) {
    const raw = contrasts[id];
    if (raw === undefined) continue;
    const entry = DeviateEntry.parse(raw);
    const maybe = entry.maybe ?? DEFAULT_DEVIATE_CUT.maybe;
    cuts.set(id, {
      maybe,
      sure: Math.min(maybe, entry.sure ?? DEFAULT_DEVIATE_CUT.sure),
      off: entry.off ?? false,
      ...(entry.looser === undefined
        ? {}
        : { looser: looserSteps(maybe, entry.looser, DEFAULT_DEVIATE_LOOSER, (a, b) => a < b) }),
    });
  }
  return cuts;
}

/** `parseDeviateCuts` of the file at `path`; the defaults when there is none or it is not valid (said on stderr). */
export async function loadDeviateCuts(path: string = THRESHOLDS_PATH): Promise<DeviateCuts> {
  const file = Bun.file(path);
  if (!(await file.exists())) return new Map();
  try {
    return parseDeviateCuts(await file.json());
  } catch (caught) {
    const why = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`pronounce: ${path} ignored for the natives' cut-offs: ${why}\n`);
    return new Map();
  }
}

/** The natives'-scale cut-off of check `id`. */
export function deviateCutOf(cuts: DeviateCuts, id: DeviateId): DeviateCut {
  return cuts.get(id) ?? DEFAULT_DEVIATE_CUT;
}

/** `cut` at Sensitivity step `step`: without `looser`, the natives' 2nd and 10th percentile, never stricter than `maybe`. */
export function deviateCutAt(cut: DeviateCut, step: Sensitivity): DeviateCut {
  const looser =
    cut.looser ?? looserSteps(cut.maybe, undefined, DEFAULT_DEVIATE_LOOSER, (a, b) => a < b);
  return { ...cutAtStep({ ...cut, looser }, step), off: cut.off };
}

/** How sure a mark whose sound sits at native deviate `deviate` is under `cut`. */
export function deviateLevel(deviate: number, cut: DeviateCut): "sure" | "maybe" {
  return deviate <= cut.sure ? "sure" : "maybe";
}
