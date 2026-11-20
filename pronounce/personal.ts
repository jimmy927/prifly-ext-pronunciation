/**
 * The reader's verdicts on the checks' flags: each Right or Wrong they mark in "Check your flags"
 * (`flag-check.ts`), and each "Not a mistake" on an underline in the session (`coach.ts`), which
 * counts as Wrong. Kept per flag with its check and score, so the page can show per check how
 * often the reader found it wrong, and which switch in Settings turns it off (`checks.ts`).
 *
 * The verdicts never turn a check on or off, nor move its cut-off: that is the reader's switch
 * alone. They are kept in `api.state` (`MARKS`), on this machine only, at most `MAX_MARKS`, the
 * oldest going first.
 */

import { z } from "zod";
import { CHECK_IDS, type CheckId } from "./checks";

/** The `api.state` document the verdicts are kept in. */
export const MARKS = "flag-marks";
/** The most verdicts kept. */
export const MAX_MARKS = 5000;

export type Verdict = "right" | "wrong";

const Mark = z.object({
  verdict: z.enum(["right", "wrong"]),
  check: z.enum(CHECK_IDS),
  score: z.number(),
});
export type Mark = z.infer<typeof Mark>;
const MarksDoc = z.object({ v: z.literal(1), marks: z.record(z.string(), Mark) });
export type MarksDoc = z.infer<typeof MarksDoc>;

export const NO_MARKS: MarksDoc = { v: 1, marks: {} };

export function parseMarks(json: unknown): MarksDoc {
  const parsed = MarksDoc.safeParse(json);
  return parsed.success ? parsed.data : NO_MARKS;
}

/** A check's verdicts: how many the reader gave, and how many of them were Right and Wrong. */
export type Tally = { marked: number; right: number; wrong: number };

/** Check `check`'s tally in `doc`. */
export function tallyOf(doc: MarksDoc, check: CheckId): Tally {
  const marks = Object.values(doc.marks).filter((one) => one.check === check);
  const right = marks.filter((one) => one.verdict === "right").length;
  return { marked: marks.length, right, wrong: marks.length - right };
}

/** `doc` with flag `id`'s verdict set (null takes it back), the newest last, at most `MAX_MARKS`. */
export function withMark(
  doc: MarksDoc,
  id: string,
  verdict: Verdict | null,
  check: CheckId,
  score: number,
): MarksDoc {
  const marks = { ...doc.marks };
  delete marks[id];
  if (verdict !== null) marks[id] = { verdict, check, score };
  const kept = Object.entries(marks).slice(-MAX_MARKS);
  return { v: 1, marks: Object.fromEntries(kept) };
}

type State = {
  get(name: string): Promise<unknown>;
  update<T>(name: string, fn: (current: T | undefined) => T | Promise<T>): Promise<T>;
  set(name: string, value: unknown): Promise<void>;
};

/** The reader's verdicts as the extension keeps them: in `api.state`, with a copy at hand. */
export class Personal {
  private readonly state: State | undefined;
  private marks: MarksDoc = NO_MARKS;
  private loaded: Promise<void> = Promise.resolve();

  constructor(state: State | undefined) {
    this.state = state;
  }

  /** The kept verdicts read; a mark meanwhile waits for it. */
  load(): Promise<void> {
    this.loaded = (async () => {
      this.marks = parseMarks(await this.state?.get(MARKS));
    })();
    return this.loaded;
  }

  /** The reader's verdict on flag `id` (of `check`, at `score`); null takes it back. */
  async mark(id: string, verdict: Verdict | null, check: CheckId, score: number): Promise<void> {
    await this.loaded.catch(() => undefined);
    const change = (current: unknown) => withMark(parseMarks(current), id, verdict, check, score);
    this.marks =
      this.state === undefined
        ? change(this.marks)
        : await this.state.update<MarksDoc>(MARKS, (current) => change(current));
  }

  /** Every verdict gone. */
  async reset(): Promise<void> {
    await this.loaded.catch(() => undefined);
    this.marks = NO_MARKS;
    await this.state?.set(MARKS, NO_MARKS);
  }

  /** The reader's verdict on flag `id`; null when unmarked. */
  verdictOf(id: string): Verdict | null {
    return this.marks.marks[id]?.verdict ?? null;
  }

  /** Check `check`'s tally now. */
  tally(check: CheckId): Tally {
    return tallyOf(this.marks, check);
  }

  /** How many verdicts there are. */
  count(): number {
    return Object.keys(this.marks.marks).length;
  }
}
