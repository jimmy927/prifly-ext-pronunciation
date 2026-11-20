/**
 * The reader's own cut-offs, from their marks in "Check your flags" (`flag-check.ts`). Each flag
 * they mark is kept with its check and score; per check, the cut-off is the lowest score at
 * which at least `MIN_RIGHT_SHARE` of the marked flags at or above it are "Right", with at least
 * `MIN_MARKED` of them. A check that has one is on for this reader from it; one with
 * `MIN_MARKED` marks or more and no such score is off for them; one with fewer keeps what
 * `thresholds.json` says (Z/S ships on, the rest off).
 *
 * The marks and the cut-offs they make are kept in `api.state` (`MARKS`, `CUTS`), on this machine
 * only. The worker gets the contrasts' and word stress's with each piece (`overridesOf`, a judge
 * request's `overrides`), which beat `thresholds.json`'s; the confirmed-pattern vowels' are the
 * coach's (`vowelSetting`).
 */

import { z } from "zod";
import { Z_P05 } from "./native";
import type { Overrides } from "./protocol";
import { CHECK_IDS, type CheckId, type Override } from "./thresholds";

/** The `api.state` documents: the reader's marks, and the cut-offs made from them. */
export const MARKS = "flag-marks";
export const CUTS = "personal-cuts";
/** Marks a check needs at or above its cut-off. */
export const MIN_MARKED = 15;
/** The share of them that must be "Right". */
export const MIN_RIGHT_SHARE = 0.8;

export type Verdict = "right" | "wrong";

const Mark = z.object({
  verdict: z.enum(["right", "wrong"]),
  check: z.enum(CHECK_IDS),
  score: z.number(),
});
export type Mark = z.infer<typeof Mark>;
const MarksDoc = z.object({ v: z.literal(1), marks: z.record(z.string(), Mark) });
export type MarksDoc = z.infer<typeof MarksDoc>;

const Result = z.discriminatedUnion("state", [
  z.object({ state: z.literal("few"), marked: z.number(), right: z.number() }),
  z.object({ state: z.literal("off"), marked: z.number(), right: z.number() }),
  z.object({
    state: z.literal("on"),
    cut: z.number(),
    marked: z.number(),
    right: z.number(),
  }),
]);
/**
 * A check's result: "few" with under `MIN_MARKED` marks; "on" from `cut`, where `right` of the
 * `marked` flags at or above it are right; "off" when no cut-off makes it, `right` of all
 * `marked` being right.
 */
export type Result = z.infer<typeof Result>;
const CutsDoc = z.object({ v: z.literal(1), checks: z.partialRecord(z.enum(CHECK_IDS), Result) });
export type CutsDoc = z.infer<typeof CutsDoc>;

export const NO_MARKS: MarksDoc = { v: 1, marks: {} };
export const NO_CUTS: CutsDoc = { v: 1, checks: {} };

export function parseMarks(json: unknown): MarksDoc {
  const parsed = MarksDoc.safeParse(json);
  return parsed.success ? parsed.data : NO_MARKS;
}

export function parseCuts(json: unknown): CutsDoc {
  const parsed = CutsDoc.safeParse(json);
  return parsed.success ? parsed.data : NO_CUTS;
}

/** One check's result from its marks. */
export function personalCut(marks: readonly Pick<Mark, "verdict" | "score">[]): Result {
  const total = marks.length;
  const rights = marks.filter((one) => one.verdict === "right").length;
  if (total < MIN_MARKED) return { state: "few", marked: total, right: rights };
  const sorted = [...marks].sort((a, b) => b.score - a.score);
  let found: Result = { state: "off", marked: total, right: rights };
  let right = 0;
  for (let at = 0; at < sorted.length; at++) {
    const one = sorted[at];
    if (one === undefined) continue;
    if (one.verdict === "right") right++;
    // A cut-off takes every flag of its score: only the last of equal scores is a place to cut.
    if (sorted[at + 1]?.score === one.score) continue;
    const marked = at + 1;
    if (marked >= MIN_MARKED && right >= MIN_RIGHT_SHARE * marked) {
      found = { state: "on", cut: one.score, marked, right };
    }
  }
  return found;
}

/** Every check's result from the reader's marks. */
export function cutsOf(doc: MarksDoc): CutsDoc {
  const checks: CutsDoc["checks"] = {};
  for (const id of CHECK_IDS) {
    const marks = Object.values(doc.marks).filter((one) => one.check === id);
    if (marks.length > 0) checks[id] = personalCut(marks);
  }
  return { v: 1, checks };
}

/** A result as a setting: on from its cut-off, off, or none while there are too few marks. */
function settingOf(result: Result | undefined): Override | undefined {
  if (result === undefined || result.state === "few") return undefined;
  return result.state === "on" ? { off: false, maybe: result.cut } : { off: true, maybe: 1 };
}

/** The settings the worker gets with each piece: the contrasts' and word stress's; undefined when there are none. */
export function overridesOf(cuts: CutsDoc): Overrides | undefined {
  const contrasts: NonNullable<Overrides["contrasts"]> = {};
  for (const id of CHECK_IDS) {
    const setting = settingOf(cuts.checks[id]);
    if (setting === undefined || id === "stress" || id === "vowel-patterns") continue;
    contrasts[id] = setting;
  }
  const stress = settingOf(cuts.checks.stress);
  if (Object.keys(contrasts).length === 0 && stress === undefined) return undefined;
  return {
    ...(Object.keys(contrasts).length === 0 ? {} : { contrasts }),
    ...(stress === undefined ? {} : { stress }),
  };
}

/**
 * Whether the confirmed-pattern vowels are underlined, and from which native deviate down:
 * the reader's own (the flag's score is minus the deviate) where they have one, else
 * `shipped` at `Z_P05`.
 */
export function vowelSetting(cuts: CutsDoc, shipped: boolean): { on: boolean; deviate: number } {
  const own = settingOf(cuts.checks["vowel-patterns"]);
  if (own === undefined) return { on: shipped, deviate: Z_P05 };
  return { on: !own.off, deviate: own.off ? Z_P05 : -own.maybe };
}

/** "On for you from score 0.62 (17 of 20 right)", "Not enough marks yet", "Off: only 6 of 18 right". */
export function resultLine(result: Result | undefined): string {
  if (result === undefined || result.state === "few") {
    const marked = result?.marked ?? 0;
    return `Not enough marks yet (${marked} of ${MIN_MARKED})`;
  }
  if (result.state === "off") return `Off: only ${result.right} of ${result.marked} right`;
  return `On for you from score ${result.cut.toFixed(2)} (${result.right} of ${result.marked} right)`;
}

type State = {
  get(name: string): Promise<unknown>;
  update<T>(name: string, fn: (current: T | undefined) => T | Promise<T>): Promise<T>;
  set(name: string, value: unknown): Promise<void>;
};

/** The reader's marks and cut-offs as the extension keeps them: in `api.state`, with a copy at hand. */
export class Personal {
  private readonly state: State | undefined;
  private marks: MarksDoc = NO_MARKS;
  private cuts: CutsDoc = NO_CUTS;
  private loaded: Promise<void> = Promise.resolve();

  constructor(state: State | undefined) {
    this.state = state;
  }

  /** The kept marks and cut-offs read; a mark meanwhile waits for it. */
  load(): Promise<void> {
    this.loaded = (async () => {
      this.marks = parseMarks(await this.state?.get(MARKS));
      this.cuts = parseCuts(await this.state?.get(CUTS));
    })();
    return this.loaded;
  }

  /** The reader's verdict on flag `id` (of `check`, at `score`); null takes it back. The cut-offs are made again. */
  async mark(id: string, verdict: Verdict | null, check: CheckId, score: number): Promise<void> {
    await this.loaded.catch(() => undefined);
    const change = (current: unknown): MarksDoc => {
      const marks = { ...parseMarks(current).marks };
      if (verdict === null) delete marks[id];
      else marks[id] = { verdict, check, score };
      return { v: 1, marks };
    };
    this.marks =
      this.state === undefined
        ? change(this.marks)
        : await this.state.update<MarksDoc>(MARKS, (current) => change(current));
    await this.keepCuts(cutsOf(this.marks));
  }

  /** Every mark gone, and the cut-offs with them: each check as `thresholds.json` says. */
  async reset(): Promise<void> {
    await this.loaded.catch(() => undefined);
    this.marks = NO_MARKS;
    await this.state?.set(MARKS, NO_MARKS);
    await this.keepCuts(NO_CUTS);
  }

  private async keepCuts(cuts: CutsDoc): Promise<void> {
    this.cuts = cuts;
    await this.state?.set(CUTS, cuts);
  }

  /** The reader's verdict on flag `id`; null when unmarked. */
  verdictOf(id: string): Verdict | null {
    return this.marks.marks[id]?.verdict ?? null;
  }

  /** Each check's result now. */
  results(): CutsDoc {
    return this.cuts;
  }

  /** What the worker gets with each piece. */
  overrides(): Overrides | undefined {
    return overridesOf(this.cuts);
  }

  /** How many marks there are. */
  count(): number {
    return Object.keys(this.marks.marks).length;
  }
}
