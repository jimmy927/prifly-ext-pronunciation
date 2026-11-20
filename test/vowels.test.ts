import { expect, test } from "bun:test";
import { Coach, NOT_A_MISTAKE } from "../pronounce/coach";
import {
  NATIVE_STATS_PATH,
  type NativeStats,
  parseNativeStats,
  valueAt,
  Z_P05,
} from "../pronounce/native";
import {
  AccentProfile,
  type Assessed,
  addPiece,
  assess,
  curveOfKey,
  MIN_EXAMPLES,
  type Profile,
} from "../pronounce/profile";
import type { WordScores } from "../pronounce/scores";
import { steppedVowelMarks, vowelMarks } from "../pronounce/vowels";
import { CURVE, much, NOW, natives, WHERE, word } from "./accent-fixtures";
import { fakeDictation, THREE_AS_TREE, threeTrees } from "./fake-dictation";

const stats = natives();
const curve = curveOfKey(stats, "vowel/ʌ");
if (curve === null) throw new Error("no curve");
/** The cup vowel's cut-off: natives' 0.5th percentile. */
const CUT = valueAt(curve, Z_P05);

/** A profile where the cup vowel's pattern (open, like "cap") is confirmed. */
function confirmedCup(): Profile {
  let profile: Profile = { v: 1, pieces: [], features: {} };
  for (let k = 0; k < MIN_EXAMPLES; k++) {
    profile = addPiece(profile, [word(much(-2.5))], WHERE, NOW - k * 60_000, () => true);
  }
  return profile;
}

const NONE: Assessed[] = [];

const marksOf = (
  scores: WordScores[],
  assessed: readonly Assessed[] = NONE,
  native: NativeStats | null = stats,
) => vowelMarks(scores, ["much", "Butter"], assessed, native);

test("a stressed vowel past the natives' 0.5th percentile is a not-sure Vowel mark saying what was off and the fix", () => {
  const [mark] = marksOf([much(CUT - 0.05)]);
  expect(mark).toMatchObject({
    index: 0,
    check: "vowel-patterns",
    word: "much",
    level: "maybe",
    said: "MACH",
    say: "MUCH",
    fix:
      "Vowel. The vowel in 'much' should be the U of 'cup'; it came out like the A in 'cap'. " +
      "Drop your jaw less.",
    heard: "mætʃ",
    expected: "mʌtʃ",
  });
  expect(mark?.fix.length ?? 999).toBeLessThan(300);
  expect(mark?.posterior ?? 0).toBeGreaterThan(0.995);
});

test("the reader's \"we're\" (ɜː at LPR -4.81, ɪ won) would be a Vowel mark at every step were it scored; it is not, as Britfone lacks it (scores.test.ts)", async () => {
  const shipped = parseNativeStats(await Bun.file(NATIVE_STATS_PATH).json());
  const were: WordScores = {
    index: 0,
    phones: ["w", "ɜː"],
    stress: 1,
    vowels: [{ at: 1, phone: "ɜː", lpr: -4.8104, rival: "ɪ" }],
    contrasts: [],
  };
  const [mark] = steppedVowelMarks([were], ["we're"], NONE, shipped);
  expect(mark).toMatchObject({ check: "vowel-patterns", steps: { drawn: 0, sure: 3 } });
});

test("a vowel between the natives' 0.5th and 10th percentile is drawn from a looser Sensitivity step", () => {
  const between = valueAt(curve, -2.3);
  const [mark] = steppedVowelMarks([much(between)], ["much"], NONE, stats);
  expect(mark?.steps).toEqual({ drawn: 1, sure: 3 });
  expect(steppedVowelMarks([much(valueAt(curve, -1.5))], ["much"], NONE, stats)[0]?.steps).toEqual({
    drawn: 2,
    sure: 3,
  });
  expect(steppedVowelMarks([much(valueAt(curve, -1))], ["much"], NONE, stats)).toEqual([]);
});

test("no mark short of the cut-off, for an unstressed vowel, a rival that is no vowel, or without natives", () => {
  expect(marksOf([much(CUT + 0.05)])).toEqual([]);
  const unstressed: WordScores = { ...much(-6), stress: 0 };
  expect(marksOf([unstressed])).toEqual([]);
  expect(marksOf([much(-6, "t")])).toEqual([]);
  expect(marksOf([much(-6, "")])).toEqual([]);
  expect(marksOf([much(-6)], NONE, null)).toEqual([]);
});

test("a gliding vowel said flat is looked at too, and its fix says to let it glide", () => {
  const glides = natives({ vowels: { eɪ: { lpr: CURVE, durationMs: CURVE } } });
  const day: WordScores = {
    index: 0,
    phones: ["d", "eɪ"],
    stress: 1,
    vowels: [{ at: 1, phone: "eɪ", lpr: -6, rival: "ɛ" }],
    contrasts: [],
  };
  const [mark] = vowelMarks([day], ["day"], NONE, glides);
  expect(mark?.fix).toBe(
    "Vowel. The vowel in 'day' should be the AY of 'day'; it came out like the E in 'bed'. " +
      "Let it glide to its end.",
  );
  expect(mark?.said).not.toBe(mark?.say);
});

test("a vowel of a pattern the profile has confirmed is sure, with the pattern's card, stressed or not", () => {
  const assessed = assess(confirmedCup(), stats, NOW);
  expect(marksOf([much(CUT - 0.05)], assessed)).toMatchObject([
    {
      level: "sure",
      fix: "Vowel. Your U in 'cup' tends to open, like the A in 'cap'; here too. Drop your jaw less.",
    },
  ]);
  const unstressed: WordScores = { ...much(CUT - 0.05), stress: 0 };
  expect(marksOf([unstressed], assessed)).toMatchObject([{ level: "sure" }]);
  // Heard as another sound than the pattern's: a stressed one is a plain not-sure mark.
  expect(marksOf([much(-6, "ɑː")], assessed)).toMatchObject([{ level: "maybe" }]);
  // Short of the natives' cut-off, a confirmed pattern marks nothing either.
  expect(marksOf([much(CUT + 0.05)], assessed)).toEqual([]);
});

/** A coach over a fake api, its profile with natives, judging "much" at `lpr` in every piece. */
async function coachWith(lpr: number, confirmed = false) {
  const fake = fakeDictation();
  const profile = new AccentProfile(
    undefined,
    () => stats,
    () => NOW,
  );
  if (confirmed) {
    for (let k = 0; k < MIN_EXAMPLES; k++) await profile.add([word(much(-2.5))], WHERE);
  }
  const coach = new Coach(
    fake.api,
    async () => ({ marks: [], scores: [much(lpr)] }),
    null,
    profile,
  );
  return { fake, coach, profile };
}

test("the coach underlines a word's stressed vowel, adds the piece to the profile, and Not a mistake holds", async () => {
  const { fake, coach, profile } = await coachWith(-6);
  coach.piece(threeTrees({ text: "Much trees." }));
  await coach.settled();
  expect(fake.marks[0]?.marks).toMatchObject([
    { start: 0, end: 5, label: "Three", level: "maybe", said: "MACH", say: "MUCH" },
  ]);
  expect(profile.pieces()).toBe(1);
  await coach.action({ ...WHERE, markStart: 0, markEnd: 5, action: NOT_A_MISTAKE });
  coach.piece(threeTrees({ piece: 1 }));
  await coach.settled();
  expect(fake.marks.filter((one) => one.piece === 1)).toEqual([]);
});

test("the Vowels switch takes the vowel marks away and gives them back; the profile still collects", async () => {
  const { fake, coach, profile } = await coachWith(-6, true);
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks.at(-1)?.marks.map((one) => one.level)).toEqual(["sure"]);
  fake.changeSettings({ checkVowels: false });
  expect(fake.marks.at(-1)?.marks).toEqual([]);
  coach.piece(threeTrees({ piece: 1 }));
  await coach.settled();
  expect(profile.pieces()).toBe(MIN_EXAMPLES + 2);
  fake.changeSettings({ checkVowels: true });
  expect(fake.marks.at(-1)?.marks.map((one) => one.label)).toEqual(["Three"]);
});

test("a word another check marked shows that mark first; the vowel mark is behind it", async () => {
  const fake = fakeDictation();
  const profile = new AccentProfile(
    undefined,
    () => stats,
    () => NOW,
  );
  const coach = new Coach(
    fake.api,
    async () => ({ marks: [THREE_AS_TREE], scores: [much(-6)] }),
    null,
    profile,
  );
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks[0]?.marks.map((one) => one.said)).toEqual(["TREE"]);
  fake.changeSettings({ checkTh: false });
  expect(fake.marks.at(-1)?.marks.map((one) => one.said)).toEqual(["MACH"]);
});
