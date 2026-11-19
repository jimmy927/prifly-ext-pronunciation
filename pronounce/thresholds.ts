/**
 * The posterior cut-offs of each check (`contrasts.ts`'s `ContrastId`):
 * from `maybe` up a heard swap is marked "maybe", from `sure` up "sure". They
 * come from `pronounce/data/thresholds.json` when it is there, written by
 * `tools/calibrate/stats.py` from native and learner speech; a check it lists
 * with `"off": true` is never marked, and a check it does not list, or no
 * file at all, keeps the cut-offs the 13-speaker benchmark settled on
 * (`MIN_HEARD_POSTERIOR`, `SURE_POSTERIOR`).
 *
 * The file: `{ "contrasts": { "z-s": { "maybe": 0.74, "sure": 0.9 }, "th": { "off": true } } }`;
 * other top-level keys (where it came from, when) are ignored here, and so is
 * the `stress` entry, which `stress.ts` reads: word stress, unlike the
 * contrasts, is off unless the file turns it on.
 */

import { join } from "node:path";
import { z } from "zod";
import { CONTRAST_IDS, type ContrastId } from "./contrasts";

/** The heard phone's highest probability over its frames must reach this for a substitution to count. */
export const MIN_HEARD_POSTERIOR = 0.7;
/** From this posterior up a mark is "sure"; from `MIN_HEARD_POSTERIOR` to just under it, "maybe". */
export const SURE_POSTERIOR = 0.88;

export type Cut = { maybe: number; sure: number; off: boolean };

export type Thresholds = ReadonlyMap<ContrastId, Cut>;

export const DEFAULT_CUT: Cut = { maybe: MIN_HEARD_POSTERIOR, sure: SURE_POSTERIOR, off: false };

/** No file: every check at `DEFAULT_CUT`. */
export const NO_THRESHOLDS: Thresholds = new Map();

/** Where the extension looks for the file. */
export const THRESHOLDS_PATH = join(import.meta.dir, "data", "thresholds.json");

const Entry = z.object({
  maybe: z.number().min(0).max(1).optional(),
  sure: z.number().min(0).max(1).optional(),
  off: z.boolean().optional(),
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
