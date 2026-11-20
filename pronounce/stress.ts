/**
 * Word stress: whether a word of two or more syllables was said with another
 * syllable stressed than the dictionary's ("DEV-eloper" for "de-VEL-oper").
 *
 * Each vowel of the sentence has three cues (`gop.ts`'s `stressCues`, over
 * the stretch the vowel owns, `ownedSpans`): its length, its loudness and
 * its pitch. They are put on one scale by the
 * sentence itself: length as a log, pitch in semitones, and each cue as how
 * many of the sentence's standard deviations it lies from the sentence's mean
 * over every vowel of every aligned word (`sentenceScale`). A slow, loud or
 * high-voiced speaker moves the mean, not the score. A vowel's prominence is
 * the mean of its cues' scores (`COMBOS`: pitch counts only where every vowel
 * of the word and enough of the sentence's are voiced).
 *
 * A word is read (`stressReadings`) when it is judged (no function word, in
 * Britfone, `judge.ts`) and its chosen pronunciation has 2+ vowels and a known
 * stress. Its `lead` is how far the most prominent other vowel stands above
 * the stressed one; natives' words have a lead too, mostly below zero. A word
 * is marked only when its lead reaches the cut-off `tools/calibrate/stats.py`
 * measured on native speech for that cue combination (`thresholds.json`'s
 * `stress` entry: at most 1 native word in 200 for "maybe", 1 in 1000 for
 * "sure"), and no other accepted pronunciation of the word stresses the
 * winning syllable. Precision comes first: a word in doubt is not marked. The
 * Sensitivity setting's looser steps move "maybe" to where natives get 1 word
 * in 50 and 1 in 10 (the entry's `looser`, `stressCheckAt`, `sensitivity.ts`).
 *
 * With no `stress` entry that ships in `thresholds.json`, or no native lead
 * statistics in `native-stats.json` (both written by one calibration run),
 * the check is off (`loadStressCheck` gives null) and nothing is marked.
 *
 * `tools/calibrate/stats.py` (`stress_readings`) computes the same readings
 * from the dump; `test/fixtures/stress-sentence.json` holds both to the same
 * numbers.
 */

import { dirname, join } from "node:path";
import { z } from "zod";
import { stressOf } from "./dictionary";
import { ownedSpans, type StressCues, stressCues } from "./gop";
import { chosenOf, type Judged, type ReadPiece } from "./judge";
import { isVowel } from "./phones";
import { respell } from "./respell";
import { cutAtStep, type Sensitivity } from "./sensitivity";
import { Looser, looserSteps, THRESHOLDS_PATH } from "./thresholds";

/** The check's id in `thresholds.json`, beside the contrasts'. */
export const STRESS_ID = "stress";

/** The cue combinations a lead is measured with: all three, or length and loudness where the pitch is not known. */
export const COMBOS = ["dur+rms+f0", "dur+rms"] as const;
export type Combo = (typeof COMBOS)[number];

/** Fewer vowels than this in the sentence, or voiced ones for pitch, and its spread says too little. */
export const MIN_POOL = 4;
/** The least standard deviation each cue is divided by: log length, dB, semitones. */
const FLOOR = { duration: 0.1, rms: 1, pitch: 0.5 };
/** The longest fix line. */
export const MAX_FIX = 300;

/** One word of the sentence as the stress check sees it: its vowels' cues, which of them the dictionary stresses (-1: the word is not read), and which ones another accepted pronunciation stresses. */
export type StressWord = {
  vowels: readonly StressCues[];
  stressed: number;
  accepts: readonly number[];
};

/** A word read: the combination its cues were scored by, the vowel that stood out most besides the stressed one (`winner`, by vowel), by how much (`lead`), and whether another pronunciation accepts it. */
export type StressReading = {
  combo: Combo;
  stressed: number;
  winner: number;
  lead: number;
  accepted: boolean;
};

type Scale = { mean: number; sd: number } | null;
type SentenceScale = { duration: Scale; rms: Scale; pitch: Scale };

const semitones = (hz: number) => 12 * Math.log2(hz);
const logMs = (ms: number) => Math.log(Math.max(1, ms));

/** The mean and (population) standard deviation of `values`, the deviation at least `floor`; null for fewer than `MIN_POOL`. */
function scaleOf(values: readonly number[], floor: number): Scale {
  if (values.length < MIN_POOL) return null;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return { mean, sd: Math.max(floor, Math.sqrt(variance)) };
}

/** The scales of the cues over every vowel of the sentence's words. */
export function sentenceScale(words: readonly StressWord[]): SentenceScale {
  const vowels = words.flatMap((word) => word.vowels).filter((one) => one.durationMs > 0);
  const voiced = vowels.flatMap((one) => (one.f0Hz !== null && one.f0Hz > 0 ? [one.f0Hz] : []));
  return {
    duration: scaleOf(
      vowels.map((one) => logMs(one.durationMs)),
      FLOOR.duration,
    ),
    rms: scaleOf(
      vowels.map((one) => one.rmsDb),
      FLOOR.rms,
    ),
    pitch: scaleOf(voiced.map(semitones), FLOOR.pitch),
  };
}

const zOf = (x: number, scale: { mean: number; sd: number }) => (x - scale.mean) / scale.sd;

/** A vowel's prominence under `combo`: the mean of its cues' scores. */
function prominence(cues: StressCues, combo: Combo, scale: SentenceScale): number {
  const { duration, rms, pitch } = scale;
  if (duration === null || rms === null) return 0;
  const parts = [zOf(logMs(cues.durationMs), duration), zOf(cues.rmsDb, rms)];
  if (combo === "dur+rms+f0" && pitch !== null && cues.f0Hz !== null) {
    parts.push(zOf(semitones(cues.f0Hz), pitch));
  }
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/** One word's reading; null when it is not read. */
function readingOf(word: StressWord, scale: SentenceScale): StressReading | null {
  const { vowels, stressed } = word;
  if (stressed < 0 || stressed >= vowels.length || vowels.length < 2) return null;
  if (scale.duration === null || scale.rms === null) return null;
  if (vowels.some((one) => one.durationMs <= 0)) return null;
  const voiced = vowels.every((one) => one.f0Hz !== null && one.f0Hz > 0);
  const combo: Combo = voiced && scale.pitch !== null ? "dur+rms+f0" : "dur+rms";
  const scores = vowels.map((one) => prominence(one, combo, scale));
  const own = scores[stressed] ?? 0;
  let winner = -1;
  let lead = Number.NEGATIVE_INFINITY;
  scores.forEach((score, at) => {
    if (at !== stressed && score - own > lead) {
      lead = score - own;
      winner = at;
    }
  });
  return { combo, stressed, winner, lead, accepted: word.accepts.includes(winner) };
}

/** Each word's reading, its cues scaled by the whole sentence's. */
export function stressReadings(words: readonly StressWord[]): (StressReading | null)[] {
  const scale = sentenceScale(words);
  return words.map((word) => readingOf(word, scale));
}

/** The vowels' indexes of a pronunciation. */
function vowelsOf(said: readonly string[]): number[] {
  return said.flatMap((phone, at) => (isVowel(phone) ? [at] : []));
}

/** Which vowel, by order, each pronunciation of the word with as many vowels as `said` stresses. */
export function acceptedStresses(
  pronunciations: readonly (readonly string[])[],
  said: readonly string[],
): number[] {
  const count = vowelsOf(said).length;
  return pronunciations.flatMap((one) => {
    const vowels = vowelsOf(one);
    const at = vowels.indexOf(stressOf(one));
    return vowels.length === count && at >= 0 ? [at] : [];
  });
}

/** The piece's words for `stressReadings`: each aligned word's vowels with their cues from the 16 kHz `audio`. */
export function stressWordsOf(read: ReadPiece, audio: Float32Array): StressWord[] {
  const owned = ownedSpans(read.alignment.words, read.post.frames);
  return read.entries.map((entry, index): StressWord => {
    const chosen = chosenOf(read, index);
    if (chosen === null) return { vowels: [], stressed: -1, accepts: [] };
    const vowelAt = vowelsOf(chosen.said);
    const vowels = vowelAt.flatMap((at) => {
      const span = owned[index]?.[at];
      return span === undefined ? [] : [stressCues(audio, span)];
    });
    const stressed = entry.judged ? vowelAt.indexOf(stressOf(chosen.said)) : -1;
    return {
      vowels,
      stressed: vowels.length === vowelAt.length ? stressed : -1,
      accepts: acceptedStresses(entry.pronunciations, chosen.said),
    };
  });
}

/**
 * A combination's cut-offs: from `maybe` up a lead is marked "maybe", from `sure` up "sure";
 * `looser`: "maybe" at the Sensitivity steps 1 in 50 and 1 in 10 (`sensitivity.ts`), when
 * the file gives them (without, the same lead at every step).
 */
export type StressCut = { maybe: number; sure: number; looser?: readonly [number, number] };

/** Natives' leads as points of their distribution, `[lead, share of native words at or below it]`, by lead. */
export type NativeLeads = readonly (readonly [number, number])[];

/** The check, on: each combination's cut-offs and the natives' leads it was measured from. A combination without both is not marked. */
export type StressCheck = {
  cuts: Partial<Record<Combo, StressCut>>;
  natives: Partial<Record<Combo, NativeLeads>>;
};

const Cut = z.object({
  maybe: z.number().positive(),
  sure: z.number().positive(),
  looser: Looser.optional(),
});
const StressEntry = z.object({
  off: z.boolean(),
  cuts: z.partialRecord(z.enum(COMBOS), Cut).optional(),
});
const ThresholdsFile = z.object({
  contrasts: z.object({ [STRESS_ID]: StressEntry.optional() }).loose(),
});
const NativeFile = z.object({
  stress: z
    .object({
      lead: z.partialRecord(z.enum(COMBOS), z.record(z.string(), z.number().nullable())).optional(),
    })
    .loose()
    .optional(),
});

/** A summary's percentiles ("p99.5": 1.7) as `NativeLeads`. */
function leadsOf(summary: Record<string, number | null>): NativeLeads {
  const points = Object.entries(summary).flatMap(([key, value]): [number, number][] => {
    const found = /^p(\d+(?:\.\d+)?)$/u.exec(key);
    return found?.[1] === undefined || value === null
      ? []
      : [[value, Math.round(Number(found[1]) * 1000) / 100_000]];
  });
  return points.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

/**
 * The check from `thresholds.json`'s and `native-stats.json`'s JSON; null
 * (off) when the stress entry is missing or off, or no combination has both
 * a cut-off and the natives' leads. With `evenOff`, an entry that is off is
 * read too: the flags
 * they mark (`flags.ts`) need its natives' leads. Throws on JSON of another shape.
 */
export function parseStressCheck(
  thresholds: unknown,
  natives: unknown,
  evenOff = false,
): StressCheck | null {
  const entry = ThresholdsFile.parse(thresholds).contrasts[STRESS_ID];
  const leads = NativeFile.parse(natives).stress?.lead ?? {};
  if (entry === undefined || (entry.off && !evenOff)) return null;
  const check: StressCheck = { cuts: {}, natives: {} };
  for (const combo of COMBOS) {
    const cut = entry.cuts?.[combo];
    const summary = leads[combo];
    if (cut === undefined || summary === undefined || (summary["n"] ?? 0) <= 0) continue;
    check.cuts[combo] = {
      maybe: cut.maybe,
      sure: Math.max(cut.maybe, cut.sure),
      ...(cut.looser === undefined
        ? {}
        : {
            looser: looserSteps(cut.maybe, cut.looser, [cut.maybe, cut.maybe], (a, b) => a > b),
          }),
    };
    check.natives[combo] = leadsOf(summary);
  }
  return Object.keys(check.cuts).length === 0 ? null : check;
}

/**
 * The check from the two files, `native-stats.json` beside
 * `thresholds.json` unless named; null (off) when either is missing, or when
 * they do not turn it on. A file that cannot be read is said on stderr (the
 * extension logs it), and the check stays off.
 */
export async function loadStressCheck(
  thresholdsPath: string = THRESHOLDS_PATH,
  statsPath: string = join(dirname(thresholdsPath), "native-stats.json"),
  evenOff = false,
): Promise<StressCheck | null> {
  const thresholds = Bun.file(thresholdsPath);
  const natives = Bun.file(statsPath);
  if (!((await thresholds.exists()) && (await natives.exists()))) return null;
  try {
    return parseStressCheck(await thresholds.json(), await natives.json(), evenOff);
  } catch (caught) {
    const why = caught instanceof Error ? caught.message : String(caught);
    process.stderr.write(`pronounce: word stress off, ${thresholdsPath} or ${statsPath}: ${why}\n`);
    return null;
  }
}

/** `check` with each combination's cut-offs at Sensitivity step `step`; one without `looser` the same at every step. */
export function stressCheckAt(check: StressCheck, step: Sensitivity): StressCheck {
  const cuts: Partial<Record<Combo, StressCut>> = {};
  for (const combo of COMBOS) {
    const cut = check.cuts[combo];
    if (cut === undefined) continue;
    const { maybe, sure, looser } = cut;
    cuts[combo] = looser === undefined ? { maybe, sure } : cutAtStep({ maybe, sure, looser }, step);
  }
  return { ...check, cuts };
}

/** The share of native words whose lead is at or below `lead`, between the natives' known points (`p99.9` the highest, so it stays under 1). */
export function nativeShare(lead: number, natives: NativeLeads): number {
  const [first] = natives;
  if (first === undefined || lead <= first[0]) return first?.[1] ?? 0;
  for (let k = 1; k < natives.length; k++) {
    const [x1, y1] = natives[k] ?? first;
    const [x0, y0] = natives[k - 1] ?? first;
    if (lead <= x1) return x1 === x0 ? y1 : y0 + ((y1 - y0) * (lead - x0)) / (x1 - x0);
  }
  return natives[natives.length - 1]?.[1] ?? first[1];
}

const ORDINALS = ["first", "second", "third", "fourth", "fifth", "sixth"];

function ordinal(at: number): string {
  return ORDINALS[at] ?? `${at + 1}th`;
}

/** The card's first words: the check's name. */
export const STRESS_HEAD = "Word stress.";

/** The card, e.g. "Word stress. You stressed the first syllable; natives stress the second: …". */
export function stressFix(say: string, stressed: number, winner: number): string {
  const syllables = say.split("-");
  const loud = (syllables[stressed] ?? "").toUpperCase();
  const quiet = (syllables[winner] ?? "").toUpperCase();
  return (
    `${STRESS_HEAD} You stressed the ${ordinal(winner)} syllable; natives stress the ${ordinal(stressed)}: ` +
    `make ${loud} louder, longer and a little higher, and keep ${quiet} short.`
  ).slice(0, MAX_FIX);
}

/** No sound is swapped in a stress respelling. */
const NO_SWAP = { from: 0, to: 0 };

/** How sure a mark of `reading` is under `check`'s cut-offs; null when it is not marked: another pronunciation stresses the winner, or the lead does not reach its combination's cut-off. */
export function stressLevel(
  reading: StressReading,
  check: Pick<StressCheck, "cuts">,
): "sure" | "maybe" | null {
  const cut = check.cuts[reading.combo];
  if (cut === undefined || reading.accepted || reading.lead < cut.maybe) return null;
  return reading.lead >= cut.sure ? "sure" : "maybe";
}

/** Word `index`'s mark from its reading, or null when the reading does not reach its combination's cut-off. */
function stressMark(
  read: ReadPiece,
  index: number,
  word: string,
  reading: StressReading,
  check: StressCheck,
): Judged | null {
  const level = stressLevel(reading, check);
  const natives = check.natives[reading.combo];
  const chosen = chosenOf(read, index);
  if (level === null || natives === undefined || chosen === null) return null;
  const vowelAt = vowelsOf(chosen.said);
  const said = respell(chosen.said, vowelAt[reading.winner] ?? -1, NO_SWAP, false);
  const say = respell(chosen.said, stressOf(chosen.said), NO_SWAP, false);
  const syllables = say.split("-");
  return {
    index,
    check: STRESS_ID,
    word,
    heard: said,
    expected: say,
    sound: `stress ${ordinal(reading.stressed)} → ${ordinal(reading.winner)}`,
    how: `stress ${(syllables[reading.stressed] ?? "").toUpperCase()}: louder, longer, a little higher`,
    posterior: nativeShare(reading.lead, natives),
    level,
    said,
    say,
    fix: stressFix(say, reading.stressed, reading.winner),
  };
}

/** The stress marks of a piece read as `read`, each with its lead, its words' cues from its 16 kHz `audio`. */
export function stressFound(
  read: ReadPiece,
  words: readonly { word: string }[],
  audio: Float32Array,
  check: StressCheck,
): { mark: Judged; lead: number }[] {
  return stressReadings(stressWordsOf(read, audio)).flatMap((reading, index) => {
    const word = words[index];
    if (reading === null || word === undefined) return [];
    const mark = stressMark(read, index, word.word, reading, check);
    return mark === null ? [] : [{ mark, lead: reading.lead }];
  });
}

/** The stress marks of a piece read as `read`, its words' cues from its 16 kHz `audio`. */
export function stressMarks(
  read: ReadPiece,
  words: readonly { word: string }[],
  audio: Float32Array,
  check: StressCheck,
): Judged[] {
  return stressFound(read, words, audio, check).map((one) => one.mark);
}
