import { expect, test } from "bun:test";
import { curveFor, deviateOf, parseNativeStats, valueAt, Z_P05, Z_P10 } from "../pronounce/native";
import {
  AccentProfile,
  addPiece,
  assess,
  clearBy,
  EMPTY_PROFILE,
  type IsClear,
  MAX_SAMPLES,
  MIN_EXAMPLES,
  PROFILE,
  type Profile,
  parseProfile,
  piecesIn,
  type ScoredWord,
} from "../pronounce/profile";
import { CURVE, DAY, much, NOW, natives, WHERE, word, zed } from "./accent-fixtures";
import { fakeState } from "./fake-api";

const keepAll: IsClear = () => true;

/** `count` pieces of one word each, a minute apart, ending at `end`. */
function fed(
  words: (k: number) => ScoredWord[],
  count: number,
  end = NOW,
  isClear = keepAll,
  from: Profile = EMPTY_PROFILE,
): Profile {
  let profile = from;
  for (let k = 0; k < count; k++) {
    const at = end - (count - 1 - k) * 60_000;
    profile = addPiece(profile, words(k), { ...WHERE, piece: k }, at, isClear);
  }
  return profile;
}

test("a native score is placed by the percentiles, and p0.5 carries the p1 to p5 line on", () => {
  const stats = natives();
  const curve = curveFor(stats, "vowel", "ʌ");
  if (curve === null) throw new Error("no curve");
  expect(deviateOf(curve, CURVE.p10)).toBeCloseTo(Z_P10, 4);
  expect(deviateOf(curve, CURVE.p50)).toBeCloseTo(0, 4);
  expect(valueAt(curve, Z_P10)).toBeCloseTo(CURVE.p10, 4);
  // Normal tail: p1 less (2.5758 - 2.3263) / (2.3263 - 1.6449) of the p1 to p5 gap.
  expect(valueAt(curve, Z_P05)).toBeCloseTo(-3 - (0.2495 / 0.6814) * 1, 3);
  expect(deviateOf(curve, valueAt(curve, -3))).toBeCloseTo(-3, 4);
});

test("natives that said a sound too rarely, or a curve that falls, are not compared with", () => {
  expect(
    curveFor(natives({ vowels: { ʌ: { lpr: { ...CURVE, n: 99 } } } }), "vowel", "ʌ"),
  ).toBeNull();
  const falling = parseNativeStats({ phones: {}, vowels: { ʌ: { lpr: { ...CURVE, p5: -4 } } } });
  expect(falling.vowels.has("ʌ")).toBe(false);
  expect(curveFor(null, "vowel", "ʌ")).toBeNull();
  expect(() => parseNativeStats({ vowels: { ʌ: { lpr: "x" } } })).toThrow();
});

test("each content word's vowels and checked consonants are added, and a piece is counted once", () => {
  const profile = addPiece(
    EMPTY_PROFILE,
    [word(much(-2)), word(zed(-1.7, 1), "is", 8000, 9600)],
    WHERE,
    NOW,
    keepAll,
  );
  expect(Object.keys(profile.features).sort()).toEqual(["vowel/ɪ", "vowel/ʌ", "z-s/z"]);
  expect(profile.features["vowel/ʌ"]?.s).toEqual([[NOW / 1000, -2, "æ"]]);
  expect(profile.features["z-s/z"]?.s).toEqual([[NOW / 1000, -1.7, ""]]);
  expect(profile.features["vowel/ʌ"]?.ex[0]).toMatchObject({
    word: "much",
    ...WHERE,
    from: 1600,
    to: 8000,
  });
  expect(piecesIn(profile, NOW)).toBe(1);
  expect(piecesIn(addPiece(profile, [], WHERE, NOW, keepAll), NOW)).toBe(1);
});

test(`a feature is confirmed from ${MIN_EXAMPLES} examples whose median is past the natives' 10th percentile`, () => {
  const stats = natives();
  const few = fed(() => [word(much(-2.5))], MIN_EXAMPLES - 1);
  expect(assess(few, stats, NOW)[0]).toMatchObject({ key: "vowel/ʌ", confirmed: false });
  const enough = fed(() => [word(much(-2.5))], MIN_EXAMPLES);
  const [cup] = assess(enough, stats, NOW);
  expect(cup).toMatchObject({ key: "vowel/ʌ", n: MIN_EXAMPLES, confirmed: true, rival: "æ" });
  expect(cup?.nativeBetter ?? 0).toBeGreaterThan(0.95);
  // Half the examples native-like: the median sits inside the natives' range.
  const mixed = fed((k) => [word(much(k % 2 === 0 ? -2.5 : 0))], 2 * MIN_EXAMPLES);
  expect(assess(mixed, stats, NOW)[0]?.confirmed).toBe(false);
  // No natives: collected, never confirmed.
  expect(assess(enough, null, NOW)[0]).toMatchObject({ confirmed: false, deviate: null });
});

test("the confirmed come first, furthest from native first", () => {
  const stats = natives();
  const profile = fed(() => [word(much(-2.2)), word(zed(-3.5, 1), "is")], MIN_EXAMPLES);
  const order = assess(profile, stats, NOW).map((one) => [one.key, one.confirmed]);
  expect(order).toEqual([
    ["z-s/z", true],
    ["vowel/ʌ", true],
    ["vowel/ɪ", false],
  ]);
});

test(`each feature keeps the newest ${MAX_SAMPLES} scores inside 30 days`, () => {
  const old = fed(() => [word(much(-2.5))], 10, NOW - 31 * DAY);
  expect(assess(old, natives(), NOW)).toEqual([]);
  expect(piecesIn(old, NOW)).toBe(0);
  const many = fed((k) => [word(much(k < 50 ? 1 : -2.5))], MAX_SAMPLES + 50);
  const [cup] = assess(many, natives(), NOW);
  expect(cup?.n).toBe(MAX_SAMPLES);
  // The 50 native-like ones were the oldest and went.
  expect(cup?.median).toBe(-2.5);
});

test("examples kept: the 3 newest and the 5 furthest off, only clear ones once there are natives", () => {
  const scores = [-2, -6, -2.1, -5, -2.2, -7, -2.3, -4, -2.4, -3, -2.5, -2.6];
  const profile = fed((k) => [word(much(scores[k] ?? 0), `w${k}`)], scores.length);
  const kept = profile.features["vowel/ʌ"]?.ex.map((one) => one.word) ?? [];
  expect(kept.slice(0, 3)).toEqual(["w11", "w10", "w9"]);
  expect(kept.slice(3)).toEqual(["w5", "w1", "w3", "w7", "w8"]);
  const clear = fed((k) => [word(much(k === 0 ? -2 : -1), `w${k}`)], 5, NOW, clearBy(natives()));
  expect(clear.features["vowel/ʌ"]?.ex.map((one) => one.word)).toEqual(["w0"]);
});

test("a full profile stays far under api.state's 1 MB document", () => {
  const vowels = [
    "iː",
    "ɪ",
    "e",
    "æ",
    "ʌ",
    "ɑː",
    "ɒ",
    "ɔː",
    "ʊ",
    "uː",
    "ɜː",
    "ə",
    "eɪ",
    "aɪ",
    "ɔɪ",
    "əʊ",
    "aʊ",
    "ɪə",
    "eə",
    "ʊə",
  ];
  const every: ScoredWord = word(
    {
      index: 0,
      phones: vowels,
      stress: 0,
      vowels: vowels.map((phone, at) => ({ at, phone, lpr: -2.123, rival: "æ" })),
      contrasts: ["z", "d", "b", "v", "ð"].map((phone, at) => ({
        id: "final-devoicing" as const,
        at,
        phone,
        lpr: -2.5,
      })),
    },
    "a-rather-long-word-of-many-letters",
  );
  const profile = fed(() => [every], MAX_SAMPLES + 10);
  expect(JSON.stringify(profile).length).toBeLessThan(400_000);
});

test("the profile is kept in api.state and read back; a broken document starts empty", async () => {
  const { state, documents } = fakeState();
  let now = NOW;
  const profile = new AccentProfile(
    state,
    () => natives(),
    () => now,
  );
  await profile.load();
  await profile.add([word(much(-2.5))], WHERE);
  now += 60_000;
  await profile.add([word(much(-2.5))], WHERE);
  expect(profile.pieces()).toBe(2);
  const again = new AccentProfile(
    state,
    () => null,
    () => now,
  );
  await again.load();
  expect(again.pieces()).toBe(2);
  expect(parseProfile(documents.get(PROFILE)).features["vowel/ʌ"]?.s).toHaveLength(2);
  expect(parseProfile({ v: 2 })).toEqual(EMPTY_PROFILE);
});
