/**
 * The marks a dump's words would get at each Sensitivity step (`pronounce/sensitivity.ts`),
 * from the numbers `dump.ts` wrote and nothing else: no model, no audio. Every check is the
 * extension's own code over those numbers (the contrasts' `surestByCheck`, `worstSound`,
 * `worstWeak`, `stressReadings` and `stressLevel`, `steppedVowelMarks`), at the cut-offs of
 * `pronounce/data/thresholds.json` and the natives' of `native-stats.json`. The Vowels check
 * sees no confirmed accent pattern here (the reader's profile is not in a dump), so its marks
 * are the not-sure ones only.
 *
 *   bun tools/calibrate/rescore.ts --dump words.jsonl [--thresholds FILE] [--natives FILE]
 *
 * Prints a markdown table: each mark, its check, from which step it is drawn and its level at
 * each, and its card; then how many words are underlined at each step.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { anySoundFix, worstSound } from "../../pronounce/any-sound";
import { type CheckId, checkOfSwap } from "../../pronounce/checks";
import { plainFix } from "../../pronounce/contrasts";
import { inWordOrder, type Judged, surestByCheck } from "../../pronounce/judge";
import {
  curveFor,
  type NativeCurve,
  type NativeStats,
  parseNativeStats,
} from "../../pronounce/native";
import { respell } from "../../pronounce/respell";
import type { WordScores } from "../../pronounce/scores";
import {
  levelAtStep,
  type Sensitivity,
  STEPS,
  sensitivityLabel,
  stepsOf,
  withSteps,
} from "../../pronounce/sensitivity";
import {
  parseStressCheck,
  type StressCheck,
  type StressReading,
  type StressWord,
  stressCheckAt,
  stressFix,
  stressLevel,
  stressReadings,
} from "../../pronounce/stress";
import {
  cutOf,
  type DeviateCut,
  type DeviateCuts,
  deviateCutAt,
  deviateCutOf,
  deviateLevel,
  levelAt,
  parseDeviateCuts,
  parseThresholds,
  THRESHOLDS_PATH,
  type Thresholds,
  thresholdsAt,
} from "../../pronounce/thresholds";
import { steppedVowelMarks } from "../../pronounce/vowels";
import { SCHWA, weakVowelFix, worstWeak } from "../../pronounce/weak-vowels";
import type { WordRecord } from "./features";

/** The two files' JSON: the cut-offs and the natives' statistics. */
export type RescoreFiles = { thresholds: unknown; natives: unknown };

/** The files read once. */
type Checks = {
  natives: NativeStats;
  schwa: NativeCurve | null;
  thresholds: Thresholds;
  deviates: DeviateCuts;
  stress: StressCheck | null;
};

/** Every check's cut-offs at one Sensitivity step. */
type CutsAt = {
  natives: NativeStats;
  schwa: NativeCurve | null;
  thresholds: Thresholds;
  anySound: DeviateCut;
  weak: DeviateCut;
  stress: StressCheck | null;
};

/** A mark as the table shows it: no respelling, the card's line only. */
function markOf(record: WordRecord, check: CheckId, level: "sure" | "maybe", fix: string): Judged {
  return {
    index: record.i,
    check,
    word: record.word,
    heard: "",
    expected: record.variant ?? "",
    sound: "",
    how: "",
    posterior: 0,
    level,
    said: "",
    say: "",
    fix,
  };
}

function contrastsOf(record: WordRecord, cuts: CutsAt): Judged[] {
  return [...surestByCheck(record.candidates, cuts.thresholds).values()].flatMap((one) => {
    const fix = plainFix(one.expected, one.heard, one.last);
    const level = levelAt(one.posterior, cutOf(cuts.thresholds, one.id));
    return fix === null ? [] : [markOf(record, checkOfSwap(one.id, one.expected), level, fix)];
  });
}

function anySoundOf(record: WordRecord, cuts: CutsAt): Judged[] {
  const cut = cuts.anySound;
  const worst = cut.off ? null : worstSound(record.anySound, cuts.natives, cut);
  if (worst === null) return [];
  const fix = anySoundFix(record.word, worst.one.expected, worst.one.rival);
  return [markOf(record, "any-sound", deviateLevel(worst.deviate, cut), fix)];
}

function weakOf(record: WordRecord, cuts: CutsAt): Judged[] {
  const cut = cuts.weak;
  const worst =
    cuts.schwa === null || cut.off ? null : worstWeak(record.weakVowels, cuts.schwa, cut);
  if (worst === null) return [];
  const fix = weakVowelFix(record.word, worst.one.rival);
  return [markOf(record, "weak-vowels", deviateLevel(worst.deviate, cut), fix)];
}

function stressOf(record: WordRecord, reading: StressReading | null, cuts: CutsAt): Judged[] {
  const level = reading === null || cuts.stress === null ? null : stressLevel(reading, cuts.stress);
  if (reading === null || level === null) return [];
  const phones = (record.variant ?? "").split(" ");
  const say = respell(phones, record.stress, { from: 0, to: 0 }, false);
  return [markOf(record, "stress", level, stressFix(say, reading.stressed, reading.winner))];
}

/** One utterance's marks at step `step`, but the vowels'. */
function marksAt(
  records: readonly WordRecord[],
  readings: readonly (StressReading | null)[],
  checks: Checks,
  step: Sensitivity,
): Judged[] {
  const cuts: CutsAt = {
    natives: checks.natives,
    schwa: checks.schwa,
    thresholds: thresholdsAt(checks.thresholds, step),
    anySound: deviateCutAt(deviateCutOf(checks.deviates, "any-sound"), step),
    weak: deviateCutAt(deviateCutOf(checks.deviates, "weak-vowels"), step),
    stress: checks.stress === null ? null : stressCheckAt(checks.stress, step),
  };
  return records.flatMap((record, at): Judged[] =>
    record.judged
      ? [
          ...contrastsOf(record, cuts),
          ...anySoundOf(record, cuts),
          ...weakOf(record, cuts),
          ...stressOf(record, readings[at] ?? null, cuts),
        ]
      : [],
  );
}

/** The stress check's view of an utterance's words, as `stressWordsOf` makes it from a piece. */
function stressWords(records: readonly WordRecord[]): StressWord[] {
  return records.map((record) => ({
    vowels: record.vowels.map(({ durationMs, rmsDb, f0Hz }) => ({ durationMs, rmsDb, f0Hz })),
    stressed: record.judged ? record.stressVowel : -1,
    accepts: record.stressAccepts,
  }));
}

/** The Vowels check's scores of an utterance's judged words, as `scores.ts` makes them. */
function vowelScores(records: readonly WordRecord[]): WordScores[] {
  return records.flatMap((record): WordScores[] => {
    if (!record.judged || record.variant === null) return [];
    const vowels = record.vowels.flatMap((vowel) => {
      const phone = record.phones[vowel.at];
      return phone === undefined
        ? []
        : [{ at: vowel.at, phone: vowel.phone, lpr: phone.lpr, rival: phone.competitor }];
    });
    const phones = record.variant.split(" ");
    return [{ index: record.i, phones, stress: record.stress, vowels, contrasts: [] }];
  });
}

/** Every utterance's marks, each with the steps it is drawn at (`withSteps`), in the words' order. */
export function rescore(
  records: readonly WordRecord[],
  files: RescoreFiles,
): Map<string, Judged[]> {
  const natives = parseNativeStats(files.natives);
  const checks: Checks = {
    natives,
    schwa: curveFor(natives, "vowel", SCHWA),
    thresholds: parseThresholds(files.thresholds),
    deviates: parseDeviateCuts(files.thresholds),
    stress: parseStressCheck(files.thresholds, files.natives),
  };
  const byUtt = new Map<string, WordRecord[]>();
  for (const record of records) byUtt.set(record.utt, [...(byUtt.get(record.utt) ?? []), record]);
  const out = new Map<string, Judged[]>();
  for (const [utt, words] of byUtt) {
    const readings = stressReadings(stressWords(words));
    const at = (step: Sensitivity) => marksAt(words, readings, checks, step);
    const texts = words.map((record) => record.word);
    const vowels = steppedVowelMarks(vowelScores(words), texts, [], natives);
    out.set(utt, inWordOrder([...withSteps([at(0), at(1), at(2)]), ...vowels]));
  }
  return out;
}

/** How many words of `marks` are underlined at step `step`. */
export function wordsAt(marks: ReadonlyMap<string, readonly Judged[]>, step: Sensitivity): number {
  let words = 0;
  for (const list of marks.values()) {
    const drawn = list.filter((one) => stepsOf(one.steps, one.level ?? "maybe").drawn <= step);
    words += new Set(drawn.map((one) => one.index)).size;
  }
  return words;
}

/** The marks as a markdown table: the word, its check, from which step, its level at each step, its card. */
export function rescoreTable(marks: ReadonlyMap<string, readonly Judged[]>): string {
  const rows = [
    "| piece | word | check | from | level at 1/200, 1/50, 1/10 | card |",
    "|---|---|---|---|---|---|",
  ];
  for (const [utt, list] of marks) {
    for (const one of list) {
      const steps = stepsOf(one.steps, one.level ?? "maybe");
      const levels = STEPS.map((step) => (steps.drawn <= step ? levelAtStep(steps, step) : "–"));
      const from = sensitivityLabel(steps.drawn).replace("Like ", "");
      rows.push(
        `| ${utt} | ${one.word} | ${one.check} | ${from} | ${levels.join(", ")} | ${one.fix} |`,
      );
    }
  }
  const totals = STEPS.map((step) => `${sensitivityLabel(step)}: ${wordsAt(marks, step)}`);
  return `${rows.join("\n")}\n\nWords underlined: ${totals.join("; ")}\n`;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      dump: { type: "string" },
      thresholds: { type: "string", default: THRESHOLDS_PATH },
      natives: { type: "string" },
    },
  });
  if (values.dump === undefined) {
    process.stderr.write("Usage: bun tools/calibrate/rescore.ts --dump words.jsonl\n");
    process.exit(2);
  }
  const thresholdsPath = values.thresholds;
  const nativesPath = values.natives ?? join(dirname(thresholdsPath), "native-stats.json");
  const records = readFileSync(values.dump, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as WordRecord | { error: string })
    .filter((record): record is WordRecord => !("error" in record));
  const files = {
    thresholds: JSON.parse(readFileSync(thresholdsPath, "utf8")),
    natives: JSON.parse(readFileSync(nativesPath, "utf8")),
  };
  process.stdout.write(rescoreTable(rescore(records, files)));
}
