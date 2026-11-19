import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Posteriors } from "../pronounce/ctc";
import { parseDictionary } from "../pronounce/dictionary";
import type { StressCues } from "../pronounce/gop";
import { judgeWords, SAMPLES_PER_FRAME, Vocab } from "../pronounce/judge";
import {
  loadStressCheck,
  nativeShare,
  parseStressCheck,
  type StressCheck,
  type StressReading,
  type StressWord,
  stressMarks,
  stressReadings,
} from "../pronounce/stress";
import { cutOf, parseThresholds } from "../pronounce/thresholds";
import fixture from "./fixtures/stress-sentence.json";

const vocab = new Vocab(["<pad>", "<s>", "</s>", "<unk>", "d", "ɪ", "v", "ɛ", "l", "ə", "p", "n"]);
const britfone = parseDictionary("DEVELOPER, d ɪ v ˈɛ l ə p ə\n");
// A second pronunciation, stressed on the first syllable, accepts "DI-ve-lu-per".
const dictionary = parseDictionary("DEVELOPER, d ˈɪ v ɛ l ə p ə\nDEVELOPER(1), d ɪ v ˈɛ l ə p ə\n");

/** A vowel as said: frames, loudness (amplitude of a tone) and pitch (Hz). */
type Said = { frames: number; amp: number; hz: number };

const CONSONANT_FRAMES = 3;

/**
 * "developer" said with its four vowels as `vowels`, each consonant three
 * silent frames the model is sure of: the posteriors and the 16 kHz audio.
 */
function developer(vowels: [Said, Said, Said, Said]): { post: Posteriors; audio: Float32Array } {
  const phones = ["d", "ɪ", "v", "ɛ", "l", "ə", "p", "ə"];
  const runs: { phone: string; said: Said | null }[] = [];
  let v = 0;
  for (const phone of phones) {
    const said = phone === "ɪ" || phone === "ɛ" || phone === "ə" ? (vowels[v++] ?? null) : null;
    runs.push({ phone, said });
  }
  const frames = runs.reduce((n, run) => n + (run.said?.frames ?? CONSONANT_FRAMES), 0);
  const size = vocab.tokens.length;
  const probs = new Float32Array(frames * size);
  const audio = new Float32Array(frames * SAMPLES_PER_FRAME);
  let t = 0;
  for (const run of runs) {
    const count = run.said?.frames ?? CONSONANT_FRAMES;
    for (let k = 0; k < count; k++, t++) {
      probs[t * size + vocab.tokens.indexOf(run.phone)] = 0.95;
      probs[t * size] = 0.05;
      if (run.said === null) continue;
      for (let i = t * SAMPLES_PER_FRAME; i < (t + 1) * SAMPLES_PER_FRAME; i++) {
        audio[i] = run.said.amp * Math.sin((2 * Math.PI * run.said.hz * i) / 16_000);
      }
    }
  }
  return { post: { frames, size, probs }, audio };
}

/** Natives: VEL long, loud and high, the rest short and quiet. */
const NATIVE: [Said, Said, Said, Said] = [
  { frames: 3, amp: 0.1, hz: 170 },
  { frames: 8, amp: 0.4, hz: 220 },
  { frames: 3, amp: 0.08, hz: 165 },
  { frames: 4, amp: 0.08, hz: 160 },
];
/** A learner: DEV long, loud and high, VEL short and quiet. */
const LEARNER: [Said, Said, Said, Said] = [
  { frames: 8, amp: 0.4, hz: 220 },
  { frames: 3, amp: 0.1, hz: 170 },
  { frames: 3, amp: 0.08, hz: 165 },
  { frames: 4, amp: 0.08, hz: 160 },
];

const LEADS: [number, number][] = [
  [-1, 0.5],
  [0.3, 0.95],
  [0.8, 0.995],
  [1.5, 0.999],
];
const CHECK: StressCheck = {
  cuts: { "dur+rms+f0": { maybe: 0.8, sure: 1.5 }, "dur+rms": { maybe: 0.8, sure: 1.5 } },
  natives: { "dur+rms+f0": LEADS, "dur+rms": LEADS },
};

function judge(
  said: [Said, Said, Said, Said],
  dict = britfone,
  check: StressCheck | null = CHECK,
  text = "developer",
) {
  const { post, audio } = developer(said);
  const words = [{ word: text, from: 0, to: audio.length }];
  return judgeWords(
    post,
    vocab,
    dict,
    words,
    undefined,
    check === null ? undefined : (read) => stressMarks(read, words, audio, check),
  );
}

test("a native-like developer, VEL the strongest, is no mark at any cut-off above zero", () => {
  expect(judge(NATIVE)).toEqual([]);
  const any: StressCheck = { ...CHECK, cuts: { "dur+rms+f0": { maybe: 0.001, sure: 0.002 } } };
  expect(judge(NATIVE, britfone, any)).toEqual([]);
  expect(judge(LEARNER, britfone, any)).toHaveLength(1);
});

test("a function word is never read for stress, whatever its vowels do", () => {
  // "their" given developer's phones, so it has four vowels, said as the learner said them.
  const their = parseDictionary("THEIR, d ɪ v ˈɛ l ə p ə\n");
  expect(judge(LEARNER, their, CHECK, "their")).toEqual([]);
});

test("developer stressed on its first syllable is marked, respelt with the stress moved, and told how", () => {
  const [mark] = judge(LEARNER);
  expect(mark).toMatchObject({
    index: 0,
    word: "developer",
    heard: "DI-ve-lu-per",
    expected: "dee-VE-lu-per",
    said: "DI-ve-lu-per",
    say: "dee-VE-lu-per",
    sound: "stress second → first",
    fix:
      "You stressed the first syllable. Natives stress the second: " +
      "make VE louder, longer and a little higher, and keep DEE short.",
  });
  expect(mark?.level).toBe("sure");
  expect(mark?.posterior).toBeGreaterThanOrEqual(0.995);
  expect(mark?.posterior).toBeLessThan(1);
  expect(mark?.fix.length).toBeLessThan(300);
});

test("a lead under the cut-off is no mark, one between maybe and sure is maybe", () => {
  const high: StressCheck = { ...CHECK, cuts: { "dur+rms+f0": { maybe: 50, sure: 60 } } };
  expect(judge(LEARNER, britfone, high)).toEqual([]);
  const middle: StressCheck = { ...CHECK, cuts: { "dur+rms+f0": { maybe: 0.5, sure: 60 } } };
  expect(judge(LEARNER, britfone, middle)).toMatchObject([{ level: "maybe" }]);
});

test("a stress another accepted pronunciation has is no mark", () => {
  expect(judge(LEARNER, dictionary)).toEqual([]);
});

test("without the calibration's stress data the word is not marked at all", () => {
  expect(judge(LEARNER, britfone, null)).toEqual([]);
});

const cues = (durationMs: number, rmsDb: number, f0Hz: number | null): StressCues => ({
  durationMs,
  rmsDb,
  f0Hz,
});
const filler: StressWord = {
  vowels: [cues(60, -30, 150), cues(80, -28, 160), cues(60, -31, 140)],
  stressed: -1,
  accepts: [],
};

test("a word of one vowel, a function word and a word with no known stress are never read", () => {
  const loud = cues(400, -5, 300);
  const readings = stressReadings([
    filler,
    { vowels: [loud], stressed: 0, accepts: [] },
    // stressWordsOf gives a function word, however many vowels, stressed -1.
    { vowels: [loud, cues(40, -40, 120)], stressed: -1, accepts: [] },
  ]);
  expect(readings).toEqual([null, null, null]);
});

test("a loud, slow speaker and a quiet, quick one get the same reading", () => {
  const word = (scale: number, gain: number): StressWord => ({
    vowels: [cues(200 * scale, -10 + gain, 220), cues(60 * scale, -25 + gain, 170)],
    stressed: 1,
    accepts: [],
  });
  const louder = (one: StressWord, scale: number, gain: number): StressWord => ({
    ...one,
    vowels: one.vowels.map((v) => cues(v.durationMs * scale, v.rmsDb + gain, v.f0Hz)),
  });
  const [, slow] = stressReadings([louder(filler, 2, 12), word(2, 12)]);
  const [, quick] = stressReadings([filler, word(1, 0)]);
  expect(slow?.combo).toBe("dur+rms+f0");
  expect(slow?.winner).toBe(0);
  expect(slow?.lead).toBeCloseTo(quick?.lead ?? Number.NaN, 6);
  expect(slow?.lead).toBeGreaterThan(1);
});

test("pitch counts only where every vowel of the word is voiced", () => {
  const [, reading] = stressReadings([
    filler,
    { vowels: [cues(200, -10, null), cues(60, -25, 170)], stressed: 1, accepts: [] },
  ]);
  expect(reading?.combo).toBe("dur+rms");
});

test("the readings match the numbers stats.py computes from the same sentence", () => {
  const words = fixture.words as StressWord[];
  const readings = stressReadings(words);
  expect(readings.length).toBe(fixture.readings.length);
  readings.forEach((reading, at) => {
    const want = fixture.readings[at] as StressReading | null;
    if (want === null) expect(reading).toBeNull();
    else expect(reading).toMatchObject({ ...want, lead: expect.closeTo(want.lead, 6) });
  });
});

const THRESHOLDS = {
  contrasts: {
    "z-s": { maybe: 0.7 },
    stress: { off: false, cuts: { "dur+rms+f0": { maybe: 1.2, sure: 1.8 } } },
  },
};
const NATIVES = {
  stress: { lead: { "dur+rms+f0": { n: 5000, p50: -1, "p99.5": 1.2, "p99.9": 1.8 } } },
};

test("the check is on only with a passing stress entry and the natives' leads", () => {
  expect(parseStressCheck(THRESHOLDS, NATIVES)).toEqual({
    cuts: { "dur+rms+f0": { maybe: 1.2, sure: 1.8 } },
    natives: {
      "dur+rms+f0": [
        [-1, 0.5],
        [1.2, 0.995],
        [1.8, 0.999],
      ],
    },
  });
  const off = { contrasts: { stress: { off: true, cuts: THRESHOLDS.contrasts.stress.cuts } } };
  expect(parseStressCheck(off, NATIVES)).toBeNull();
  expect(parseStressCheck({ contrasts: { "z-s": { maybe: 0.7 } } }, NATIVES)).toBeNull();
  expect(parseStressCheck(THRESHOLDS, { stress: { rmsDb: { n: 10 } } })).toBeNull();
  expect(parseStressCheck(THRESHOLDS, {})).toBeNull();
});

test("a stress entry, its cut-offs above 1, leaves the contrasts' cut-offs read", () => {
  const big = {
    contrasts: {
      ...THRESHOLDS.contrasts,
      stress: { off: false, cuts: { "dur+rms": { maybe: 2, sure: 3 } } },
    },
  };
  expect(cutOf(parseThresholds(big), "z-s")).toEqual({ maybe: 0.7, sure: 0.88, off: false });
});

test("no files, one file, or a broken one: the check is off", async () => {
  const folder = await mkdtemp(join(tmpdir(), "stress-"));
  const thresholds = join(folder, "thresholds.json");
  expect(await loadStressCheck(thresholds)).toBeNull();
  await writeFile(thresholds, JSON.stringify(THRESHOLDS));
  expect(await loadStressCheck(thresholds)).toBeNull();
  await writeFile(join(folder, "native-stats.json"), JSON.stringify(NATIVES));
  expect(await loadStressCheck(thresholds)).not.toBeNull();
  await writeFile(join(folder, "native-stats.json"), "{ not json");
  expect(await loadStressCheck(thresholds)).toBeNull();
});

test("a lead's native share runs between the natives' points and stays under 1", () => {
  expect(nativeShare(-3, LEADS)).toBe(0.5);
  expect(nativeShare(0.55, LEADS)).toBeCloseTo(0.9725, 6);
  expect(nativeShare(9, LEADS)).toBe(0.999);
});
