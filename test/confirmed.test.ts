import { expect, test } from "bun:test";
import type { SettingValues } from "@prifly/extension-api";
import { Coach, NOT_A_MISTAKE, UNDERLINE, UNDERLINE_ALL } from "../pronounce/coach";
import { confirmedMarks } from "../pronounce/confirmed";
import { type NativeStats, valueAt, Z_P05 } from "../pronounce/native";
import {
  AccentProfile,
  addPiece,
  assess,
  curveOfKey,
  MIN_EXAMPLES,
  type Profile,
} from "../pronounce/profile";
import type { WordScores } from "../pronounce/scores";
import { much, NOW, natives, WHERE, word } from "./accent-fixtures";
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

const marksOf = (
  scores: WordScores[],
  profile = confirmedCup(),
  native: NativeStats | null = stats,
  taken = new Set<number>(),
) => confirmedMarks(scores, ["much", "Butter"], assess(profile, native, NOW), native, taken);

test("a word past the natives' 0.5th percentile, heard as the pattern's sound, is underlined from the pattern", () => {
  const [mark] = marksOf([much(CUT - 0.05)]);
  expect(mark).toMatchObject({
    index: 0,
    word: "much",
    level: "maybe",
    said: "MACH",
    say: "MUCH",
    fix: "Your U in 'cup' tends to open, like the A in 'cap'; here too. Drop your jaw less.",
    heard: "mætʃ",
    expected: "mʌtʃ",
  });
  expect(mark?.fix.length ?? 999).toBeLessThan(300);
  expect(mark?.posterior ?? 0).toBeGreaterThan(0.995);
});

test("far past, beyond 1 native word in 2000, it is sure", () => {
  expect(marksOf([much(-6)])[0]?.level).toBe("sure");
});

test("no underline short of the cut-off, for another sound, for a word marked already, or without natives", () => {
  expect(marksOf([much(CUT + 0.05)])).toEqual([]);
  expect(marksOf([much(-6, "ɑː")])).toEqual([]);
  expect(marksOf([much(-6)], confirmedCup(), stats, new Set([0]))).toEqual([]);
  expect(marksOf([much(-6)], confirmedCup(), null)).toEqual([]);
});

test("the reader's own cut-off from their marks moves where a vowel is underlined", () => {
  const theirs = (scores: WordScores[], cut: number) =>
    confirmedMarks(scores, ["much"], assess(confirmedCup(), stats, NOW), stats, new Set(), cut);
  const looser = valueAt(curve, -2);
  // Short of the natives' 0.5th percentile, past the reader's own -2.
  expect(theirs([much(looser - 0.05)], -2)).toMatchObject([{ index: 0, word: "much" }]);
  expect(marksOf([much(looser - 0.05)])).toEqual([]);
  expect(theirs([much(CUT - 0.05)], -4)).toEqual([]);
});

test("no underline from a pattern that is not confirmed", () => {
  let few: Profile = { v: 1, pieces: [], features: {} };
  for (let k = 0; k < MIN_EXAMPLES - 1; k++) {
    few = addPiece(few, [word(much(-2.5))], WHERE, NOW - k * 60_000, () => true);
  }
  expect(marksOf([much(-6)], few)).toEqual([]);
});

/** A coach over a fake api whose profile has the cup pattern confirmed, judging "much" at `lpr` in every piece. */
async function coachWith(
  lpr: number,
  settings: SettingValues = { [UNDERLINE]: UNDERLINE_ALL },
  patternsOn = true,
) {
  const fake = fakeDictation(settings);
  const profile = new AccentProfile(
    undefined,
    () => stats,
    () => NOW,
  );
  for (let k = 0; k < MIN_EXAMPLES; k++) await profile.add([word(much(-2.5))], WHERE);
  const coach = new Coach(
    fake.api,
    async () => ({ marks: [], scores: [much(lpr)] }),
    null,
    profile,
    () => patternsOn,
  );
  return { fake, coach, profile };
}

test("the coach underlines a confirmed pattern's word, adds the piece to the profile, and Not a mistake holds", async () => {
  const { fake, coach, profile } = await coachWith(-6);
  coach.piece(threeTrees({ text: "Much trees." }));
  await coach.settled();
  expect(fake.marks[0]?.marks).toMatchObject([
    { start: 0, end: 5, label: "Three", level: "sure", said: "MACH", say: "MUCH" },
  ]);
  expect(profile.pieces()).toBe(MIN_EXAMPLES + 1);
  await coach.action({ ...WHERE, markStart: 0, markEnd: 5, action: NOT_A_MISTAKE });
  coach.piece(threeTrees({ piece: 1 }));
  await coach.settled();
  expect(fake.marks.filter((one) => one.piece === 1)).toEqual([]);
});

test("a maybe from the pattern is not drawn under Sure mistakes only", async () => {
  const { fake, coach } = await coachWith(CUT - 0.05, {});
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks).toEqual([]);
});

test("a word another check marked keeps that mark alone", async () => {
  const fake = fakeDictation();
  const profile = new AccentProfile(
    undefined,
    () => stats,
    () => NOW,
  );
  for (let k = 0; k < MIN_EXAMPLES; k++) await profile.add([word(much(-2.5))], WHERE);
  const coach = new Coach(
    fake.api,
    async () => ({ marks: [THREE_AS_TREE], scores: [much(-6)] }),
    null,
    profile,
    () => true,
  );
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks[0]?.marks.map((one) => one.said)).toEqual(["TREE"]);
});

test("with vowel-patterns off or missing the coach underlines nothing from the pattern, though natives and a confirmed pattern are there", async () => {
  const { fake, coach, profile } = await coachWith(-6, { [UNDERLINE]: UNDERLINE_ALL }, false);
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks).toEqual([]);
  // The profile still collects, so the panel keeps showing it.
  expect(profile.pieces()).toBe(MIN_EXAMPLES + 1);
  expect(profile.assessed().some((one) => one.confirmed)).toBe(true);
  // A coach built without the switch (the default) is off too.
  const bare = fakeDictation();
  const plain = new Coach(bare.api, async () => ({ marks: [], scores: [much(-6)] }), null, profile);
  plain.piece(threeTrees());
  await plain.settled();
  expect(bare.marks).toEqual([]);
});
