/**
 * Which of the marks given are drawn (`coach.ts`): the Sensitivity setting says from which step
 * a mark is drawn and at which level (`sensitivity.ts`), the Underline setting which levels (sure
 * ones, or not sure ones too, or none), and each check's switch whether its marks are drawn at
 * all (`checks.ts`). Of a word marked by several checks, the first drawn in `CHECK_IDS` order is
 * its mark (`pickDrawn`).
 *
 * Underline's default became "Sure and not sure" when every check shipped on. A reader who had
 * picked "Sure mistakes only" before keeps that value in prifly's settings, which an extension
 * cannot write; so on the first start after the change it counts as "Sure and not sure", once
 * (`UnderlineSwitch`, remembered in `api.state` as `UNDERLINE_SWITCH`), until the reader picks
 * an Underline themselves, which then stands.
 */

import type { DictationMark, ExtensionStateApi, SettingValues } from "@prifly/extension-api";
import { z } from "zod";
import { type CheckId, switchedOn } from "./checks";
import { type Judged, levelOf } from "./judge";
import {
  drawnAt,
  levelAtStep,
  type Sensitivity,
  type Steps,
  sensitivityOf,
  stepsOf,
} from "./sensitivity";

/** `markDictation`'s limit for a mark's line, and `DictationMark`'s for `said` and `say`. */
const MAX_DETAIL = 300;
const MAX_SPELLING = 40;

/** The `underline` setting's options, as `prifly-extension.json` declares them: which marks are drawn. */
export const UNDERLINE_SURE = "Sure mistakes only";
export const UNDERLINE_ALL = "Sure and not sure";
export const UNDERLINE_OFF = "Off";
/** The setting's id in `api.settings`. */
export const UNDERLINE = "underline";
/** The `api.state` document of the one switch of a kept "Sure mistakes only". */
export const UNDERLINE_SWITCH = "underline-switch";

const SwitchDoc = z.object({ v: z.literal(1), active: z.boolean() });
type SwitchDoc = z.infer<typeof SwitchDoc>;

export type Level = "sure" | "maybe";

/** What decides which marks are drawn: the levels the Underline setting draws, the checks switched on, and the Sensitivity step (`sensitivity.ts`). */
export type Drawn = {
  levels: readonly Level[];
  checks: ReadonlySet<CheckId>;
  sensitivity: Sensitivity;
};

/** A mark as given, with the word and what was heard in it, for "Not a mistake", its check and from which Sensitivity step it is drawn and drawn sure: whether it is drawn, and at which level, is the settings'. `score` is the mark's posterior; `from` and `to` are the word's samples in the piece's audio. */
export type Shown = {
  mark: DictationMark;
  word: string;
  heard: string;
  check: CheckId;
  steps: Steps;
  score: number;
  from: number;
  to: number;
};

/** The card's line after the bold word: the check's name, what was off and the fix, no phonetic letters. */
export function detailOf(judged: Pick<Judged, "fix">): string {
  return judged.fix.slice(0, MAX_DETAIL);
}

/**
 * `one` as a mark on the word at `spot`, with `actions`; `levels`: prifly takes its level,
 * confidence and respellings ("dictation-mark-levels"); an older one refuses the fields, and
 * draws every mark as sure.
 */
export function shownMark(
  one: Judged,
  spot: { text: string; start: number; end: number; from: number; to: number },
  actions: NonNullable<DictationMark["actions"]>,
  levels: boolean,
): Shown {
  const level = one.level ?? levelOf(one.posterior);
  const mark: DictationMark = {
    start: spot.start,
    end: spot.end,
    label: spot.text,
    detail: detailOf(one),
    actions,
    ...(levels
      ? {
          level,
          confidence: one.posterior,
          said: one.said.slice(0, MAX_SPELLING),
          say: one.say.slice(0, MAX_SPELLING),
        }
      : {}),
  };
  const { word, heard, check, posterior: score } = one;
  const steps = stepsOf(one.steps, level);
  return { mark, word, heard, check, steps, score, from: spot.from, to: spot.to };
}

/** `one`'s mark as `drawn` draws it: its level the one at the Sensitivity step now, where prifly takes levels. */
export function drawnMark(one: Pick<Shown, "mark" | "steps">, drawn: Drawn): DictationMark {
  if (one.mark.level === undefined) return one.mark;
  return { ...one.mark, level: levelAtStep(one.steps, drawn.sensitivity) };
}

/** The levels each option of the `underline` setting draws; an unknown value is the default, both. */
function allowedLevels(value: unknown): readonly Level[] {
  if (value === UNDERLINE_OFF) return [];
  return value === UNDERLINE_SURE ? ["sure"] : ["sure", "maybe"];
}

/** What `values` draw; `switched`: a kept "Sure mistakes only" counts as "Sure and not sure". */
export function drawnBy(values: SettingValues | undefined, switched: boolean): Drawn {
  const underline = values?.[UNDERLINE];
  const levels = allowedLevels(
    switched && underline === UNDERLINE_SURE ? UNDERLINE_ALL : underline,
  );
  return { levels, checks: switchedOn(values), sensitivity: sensitivityOf(values) };
}

/** Whether `drawn` draws nothing at all: Underline is Off, or every check is switched off. */
export function drawsNothing(drawn: Drawn): boolean {
  return drawn.levels.length === 0 || drawn.checks.size === 0;
}

/**
 * The marks of `shown` that `drawn` draws: of each word's (by where it starts), in their order,
 * the first the Sensitivity step draws, at a level Underline draws there, whose check is
 * switched on; at most `max`.
 */
export function pickDrawn<T extends { mark: { start: number }; steps: Steps; check: CheckId }>(
  shown: readonly T[],
  drawn: Drawn,
  max: number,
): T[] {
  const taken = new Set<number>();
  const picked: T[] = [];
  for (const one of shown) {
    if (taken.has(one.mark.start) || !drawnAt(one.steps, drawn.sensitivity)) continue;
    if (!drawn.levels.includes(levelAtStep(one.steps, drawn.sensitivity))) continue;
    if (!drawn.checks.has(one.check)) continue;
    taken.add(one.mark.start);
    picked.push(one);
  }
  return picked.slice(0, max);
}

type Log = (event: string, fields: Record<string, string>) => void;

/** The one switch of a kept "Sure mistakes only" to "Sure and not sure", kept in `api.state`. */
export class UnderlineSwitch {
  private readonly state: Pick<ExtensionStateApi, "update" | "set"> | undefined;
  private readonly log: Log;
  private on = false;

  constructor(state: Pick<ExtensionStateApi, "update" | "set"> | undefined, log: Log) {
    this.state = state;
    this.log = log;
  }

  /** Whether a kept "Sure mistakes only" counts as "Sure and not sure" now. */
  get active(): boolean {
    return this.on;
  }

  /**
   * Read, or made on the first start: active when Underline says "Sure mistakes only" then. An
   * Underline changed while the extension was off ends it. A refused write is logged, and it
   * stays off.
   */
  async load(underline: unknown): Promise<void> {
    if (this.state === undefined) return;
    const sure = underline === UNDERLINE_SURE;
    try {
      const doc = await this.state.update<SwitchDoc>(UNDERLINE_SWITCH, (current) => {
        const known = SwitchDoc.safeParse(current);
        if (!known.success) return { v: 1, active: sure };
        return known.data.active && !sure ? { v: 1, active: false } : known.data;
      });
      this.on = doc.active;
    } catch (caught) {
      if (!(caught instanceof Error)) throw caught;
      this.log("underlineSwitchFailed", { error: caught.message });
    }
  }

  /** The settings changed to say `underline`: an Underline the reader picked ends it for good. */
  changed(underline: unknown): void {
    if (!this.on || underline === UNDERLINE_SURE) return;
    this.on = false;
    this.state?.set(UNDERLINE_SWITCH, { v: 1, active: false }).catch((caught: unknown) => {
      if (caught instanceof Error) this.log("underlineSwitchFailed", { error: caught.message });
    });
  }
}
