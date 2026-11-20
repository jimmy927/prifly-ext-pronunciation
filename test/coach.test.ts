import { expect, test } from "bun:test";
import type { DictationMark } from "@prifly/extension-api";
import manifest from "../prifly-extension.json";
import { CHECK_IDS, CHECK_LABELS, SWITCHES } from "../pronounce/checks";
import { Coach, isEnglish, KEPT_SESSIONS, NOT_A_MISTAKE, NOT_MISTAKES } from "../pronounce/coach";
import {
  detailOf,
  UNDERLINE,
  UNDERLINE_ALL,
  UNDERLINE_OFF,
  UNDERLINE_SURE,
} from "../pronounce/drawn";
import type { Judged, JudgeWord } from "../pronounce/judge";
import { NATIVE_CHECK } from "../pronounce/native-control";
import { SENSITIVITY, SENSITIVITY_OPTIONS } from "../pronounce/sensitivity";
import {
  type FakeDictation,
  fakeDictation,
  THREE_AS_TREE,
  THREE_DETAIL,
  threeTrees,
} from "./fake-dictation";

type Asked = { audio: Float32Array; words: readonly JudgeWord[] };

function made(answer: (asked: Asked) => Promise<Judged[] | null>, fake = fakeDictation()) {
  const asked: Asked[] = [];
  const coach = new Coach(fake.api, async (audio, words) => {
    const one = { audio, words };
    asked.push(one);
    const marks = await answer(one);
    return marks === null ? null : { marks, scores: [] };
  });
  return { coach, asked, fake };
}

const says = (judged: Judged[] | null) => async () => judged;

const click = (markStart: number, markEnd: number) => ({
  sessionId: "s1",
  dict: "d1",
  piece: 0,
  markStart,
  markEnd,
  action: NOT_A_MISTAKE,
});

const THREE_MARK: DictationMark = {
  start: 0,
  end: 5,
  label: "Three",
  detail: THREE_DETAIL,
  actions: [{ id: NOT_A_MISTAKE, label: "Not a mistake", icon: "check" }],
  level: "sure",
  confidence: 0.95,
  said: "TREE",
  say: "THREE",
};

const correctionOf = (heard: string, word: string, start: number, dict = "d1") => ({
  sessionId: "s1",
  dict,
  piece: 0,
  heard,
  word,
  start,
  end: start + word.length,
});

test("an English piece is judged with each word's samples, and the word said otherwise marked", async () => {
  const { coach, asked, fake } = made(says([THREE_AS_TREE]));
  coach.piece(threeTrees());
  await coach.settled();
  expect(asked[0]?.words).toEqual([
    { word: "Three", from: 1600, to: 8000 },
    { word: "trees", from: 8000, to: 14_400 },
  ]);
  expect(fake.marks).toEqual([{ sessionId: "s1", dict: "d1", piece: 0, marks: [THREE_MARK] }]);
});

test("a piece with nothing said otherwise, or that could not be judged, marks nothing", async () => {
  for (const answer of [[], null]) {
    const { coach, fake } = made(says(answer));
    coach.piece(threeTrees());
    await coach.settled();
    expect(fake.marks).toEqual([]);
  }
});

test("a non-English piece, one without audio and one without words are ignored", async () => {
  const { coach, asked } = made(says([]));
  coach.piece(threeTrees({ language: "sv" }));
  coach.piece(threeTrees({ words: [] }));
  const { audio: _audio, ...silent } = threeTrees();
  coach.piece(silent);
  await coach.settled();
  expect(asked).toEqual([]);
  expect(["en", "en-GB", "sv", "eng"].map(isEnglish)).toEqual([true, true, false, false]);
});

test("while one piece is judged the newest waits and older ones drop", async () => {
  const answers: ((judged: Judged[] | null) => void)[] = [];
  const { coach, asked, fake } = made(() => new Promise((resolve) => void answers.push(resolve)));
  coach.piece(threeTrees({ piece: 0 }));
  coach.piece(threeTrees({ piece: 1 }));
  coach.piece(threeTrees({ piece: 2 }));
  // Nothing has been answered, and every call above came back.
  expect(asked).toHaveLength(1);
  answers[0]?.(null);
  await Bun.sleep(1);
  expect(asked).toHaveLength(2);
  answers[1]?.([THREE_AS_TREE]);
  await coach.settled();
  expect(fake.marks.map((one) => one.piece)).toEqual([2]);
  expect(fake.logs).toContainEqual({ event: "skipped", fields: { reason: "busy" } });
});

test("a judge that throws is logged, and the next piece is still judged", async () => {
  let first = true;
  const { coach, fake } = made(async () => {
    if (!first) return [THREE_AS_TREE];
    first = false;
    throw new Error("worker pipe closed");
  });
  coach.piece(threeTrees());
  await coach.settled();
  coach.piece(threeTrees({ piece: 1 }));
  await coach.settled();
  expect(fake.logs).toContainEqual({
    event: "judgeFailed",
    fields: { error: "worker pipe closed" },
  });
  expect(fake.marks.map((one) => one.piece)).toEqual([1]);
});

async function corrected(fake?: FakeDictation) {
  const answers: (Judged[] | null)[] = [[], [{ ...THREE_AS_TREE, word: "thrice" }]];
  const run = made(async () => answers.shift() ?? [], fake);
  run.coach.piece(threeTrees());
  await run.coach.settled();
  run.coach.correction(correctionOf("three", "thrice", 40));
  await run.coach.settled();
  return run;
}

test("a correction is judged as the corrected word over the heard word's audio, and marked from its place in the box", async () => {
  const { asked, fake } = await corrected();
  expect(asked[1]?.words).toEqual([{ word: "thrice", from: 1600, to: 8000 }]);
  expect(fake.marks).toEqual([
    {
      sessionId: "s1",
      dict: "d1",
      piece: 0,
      at: 40,
      marks: [{ ...THREE_MARK, end: 6, label: "thrice" }],
    },
  ]);
});

test("a correction judged as said right clears what was marked there", async () => {
  const { coach, fake } = made(says([]));
  coach.piece(threeTrees());
  await coach.settled();
  coach.correction(correctionOf("Three", "tree", 3));
  await coach.settled();
  expect(fake.marks).toEqual([{ sessionId: "s1", dict: "d1", piece: 0, at: 3, marks: [] }]);
});

test("a correction of another dictation, or of a word the piece does not have, is not judged", async () => {
  const { coach, asked } = made(says([]));
  coach.piece(threeTrees());
  await coach.settled();
  coach.correction(correctionOf("three", "x", 0, "old"));
  coach.correction(correctionOf("absent", "x", 0));
  await coach.settled();
  expect(asked).toHaveLength(1);
});

test("a new dictation lets go of the last one's audio", async () => {
  const { coach, asked } = made(says([]));
  coach.piece(threeTrees());
  await coach.settled();
  coach.piece(threeTrees({ dict: "d2" }));
  await coach.settled();
  coach.correction(correctionOf("three", "tree", 0));
  await coach.settled();
  expect(asked).toHaveLength(2);
});

test("past the session cap the longest silent session's audio goes, and a recent one's stays", async () => {
  const { coach, asked } = made(says([]));
  const sessionIds = Array.from({ length: KEPT_SESSIONS + 1 }, (_, at) => `s${at}`);
  for (const sessionId of sessionIds.slice(0, KEPT_SESSIONS)) {
    coach.piece(threeTrees({ sessionId }));
    await coach.settled();
  }
  // s0 speaks again, so s1 is now the longest silent when the session over the cap comes.
  coach.piece(threeTrees({ sessionId: "s0", piece: 1 }));
  await coach.settled();
  coach.piece(threeTrees({ sessionId: `s${KEPT_SESSIONS}` }));
  await coach.settled();
  const before = asked.length;
  coach.correction({ ...correctionOf("three", "tree", 0), sessionId: "s1" });
  await coach.settled();
  expect(asked).toHaveLength(before);
  coach.correction({ ...correctionOf("three", "tree", 0), sessionId: "s0" });
  await coach.settled();
  coach.correction({ ...correctionOf("three", "tree", 0), sessionId: "s2" });
  await coach.settled();
  expect(asked).toHaveLength(before + 2);
});

test("Not a mistake keeps the pair in api.state, takes the mark away, and it is never marked again", async () => {
  const { coach, fake } = made(says([THREE_AS_TREE]));
  coach.piece(threeTrees());
  await coach.settled();
  await coach.action(click(0, 5));
  expect(fake.documents.get(NOT_MISTAKES)).toEqual([{ word: "Three", heard: "triː" }]);
  expect(fake.marks.at(-1)).toEqual({ sessionId: "s1", dict: "d1", piece: 0, marks: [] });
  const shown = fake.marks.length;
  coach.piece(threeTrees({ piece: 1 }));
  await coach.settled();
  expect(fake.marks).toHaveLength(shown);
});

test("a pair accepted before is read back from api.state, as the same word in any case", async () => {
  const fake = fakeDictation();
  fake.documents.set(NOT_MISTAKES, [{ word: "three", heard: "triː" }, "garbage"]);
  const { coach } = made(says([THREE_AS_TREE]), fake);
  await coach.load();
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks).toEqual([]);
});

test("the same word heard otherwise is still marked after Not a mistake", async () => {
  const { coach, fake } = made(says([{ ...THREE_AS_TREE, heard: "friː", sound: "th → f" }]));
  fake.documents.set(NOT_MISTAKES, [{ word: "Three", heard: "triː" }]);
  await coach.load();
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks).toHaveLength(1);
});

test("an unknown action or a mark no longer remembered changes nothing", async () => {
  const { coach, fake } = made(says([THREE_AS_TREE]));
  coach.piece(threeTrees());
  await coach.settled();
  await coach.action({ ...click(0, 5), action: "other" });
  await coach.action(click(1, 2));
  expect(fake.documents.has(NOT_MISTAKES)).toBe(false);
  expect(fake.marks).toHaveLength(1);
});

test("a window that refuses marks is logged, not thrown", async () => {
  const fake = fakeDictation();
  fake.api.markDictation = () => {
    throw new Error("bad spec");
  };
  const { coach } = made(says([THREE_AS_TREE]), fake);
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.logs).toContainEqual({ event: "markRefused", fields: { error: "bad spec" } });
});

test("after stop nothing is judged or marked", async () => {
  let release: (judged: Judged[] | null) => void = () => undefined;
  const { coach, asked, fake } = made(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  coach.piece(threeTrees());
  coach.stop();
  release([THREE_AS_TREE]);
  await coach.settled();
  coach.piece(threeTrees({ piece: 1 }));
  await coach.settled();
  expect(asked).toHaveLength(1);
  expect(fake.marks).toEqual([]);
});

test("the hint line is the plain fix, at most what the window takes", () => {
  expect(detailOf(THREE_AS_TREE)).toBe(THREE_DETAIL);
  expect(detailOf({ fix: "x".repeat(400) })).toHaveLength(300);
});

/** The marks of a piece judged as `posteriors`, each for the word "three" said as "tree", with the setting `underline`. */
async function markedWith(underline: string | undefined, posteriors: number[]) {
  const fake = fakeDictation(underline === undefined ? undefined : { [UNDERLINE]: underline });
  const { coach } = made(
    says(posteriors.map((posterior, index) => ({ ...THREE_AS_TREE, index, posterior }))),
    fake,
  );
  coach.piece(threeTrees());
  await coach.settled();
  return fake;
}

test("a mark carries its level, confidence, both respellings clipped to 40, and the plain fix", async () => {
  const { coach, fake } = made(
    says([
      { ...THREE_AS_TREE, posterior: 0.75, said: "x".repeat(60), say: "y".repeat(60) },
      { ...THREE_AS_TREE, index: 1, word: "trees", posterior: 0.9 },
    ]),
    fakeDictation({ [UNDERLINE]: UNDERLINE_ALL }),
  );
  coach.piece(threeTrees());
  await coach.settled();
  const [group] = fake.marks;
  expect(group?.marks.map((mark) => [mark.level, mark.confidence])).toEqual([
    ["maybe", 0.75],
    ["sure", 0.9],
  ]);
  expect(group?.marks[0]?.said).toBe("x".repeat(40));
  expect(group?.marks[0]?.say).toBe("y".repeat(40));
  expect(group?.marks[0]?.actions).toEqual([
    { id: NOT_A_MISTAKE, label: "Not a mistake", icon: "check" },
  ]);
});

test("the setting 'Sure mistakes only' draws the sure marks and not the maybe ones", async () => {
  const fake = await markedWith(UNDERLINE_SURE, [0.75]);
  expect(fake.marks).toEqual([]);
  const sure = await markedWith(UNDERLINE_SURE, [0.9]);
  expect(sure.marks[0]?.marks.map((mark) => mark.level)).toEqual(["sure"]);
});

test("the setting 'Sure and not sure' draws both levels; it is the default", async () => {
  for (const underline of [UNDERLINE_ALL, undefined, "something else"]) {
    const fake = await markedWith(underline, [0.75]);
    expect(fake.marks[0]?.marks.map((mark) => mark.level)).toEqual(["maybe"]);
  }
});

test("the setting 'Off' sends no marks and judges nothing", async () => {
  const fake = fakeDictation({ [UNDERLINE]: UNDERLINE_OFF });
  const { coach, asked } = made(says([THREE_AS_TREE]), fake);
  coach.piece(threeTrees());
  coach.correction(correctionOf("three", "tree", 0));
  await coach.settled();
  expect(fake.marks).toEqual([]);
  expect(asked).toEqual([]);
});

test("a setting changed while the extension runs takes effect at once, on the marks already given too", async () => {
  const fake = fakeDictation({ [UNDERLINE]: UNDERLINE_SURE });
  const { coach } = made(
    says([
      { ...THREE_AS_TREE, posterior: 0.75 },
      { ...THREE_AS_TREE, index: 1, word: "trees", posterior: 0.9 },
    ]),
    fake,
  );
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks.at(-1)?.marks.map((mark) => mark.label)).toEqual(["trees"]);
  fake.changeSettings({ [UNDERLINE]: UNDERLINE_ALL });
  expect(fake.marks.at(-1)?.marks.map((mark) => mark.label)).toEqual(["Three", "trees"]);
  fake.changeSettings({ [UNDERLINE]: UNDERLINE_OFF });
  expect(fake.marks.at(-1)).toEqual({ sessionId: "s1", dict: "d1", piece: 0, marks: [] });
  const shown = fake.marks.length;
  coach.piece(threeTrees({ piece: 1 }));
  await coach.settled();
  expect(fake.marks).toHaveLength(shown);
  fake.changeSettings({ [UNDERLINE]: UNDERLINE_SURE });
  coach.piece(threeTrees({ piece: 2 }));
  await coach.settled();
  expect(fake.marks.at(-1)?.piece).toBe(2);
  expect(fake.marks.at(-1)?.marks.map((mark) => mark.label)).toEqual(["trees"]);
});

test("a piece with only maybe marks sends nothing at first, and its marks are drawn when the setting allows them", async () => {
  const fake = await markedWith(UNDERLINE_SURE, [0.75]);
  expect(fake.marks).toEqual([]);
  fake.changeSettings({ [UNDERLINE]: UNDERLINE_ALL });
  expect(fake.marks).toHaveLength(1);
  expect(fake.marks[0]?.marks.map((mark) => [mark.label, mark.level])).toEqual([
    ["Three", "maybe"],
  ]);
});

test("Sensitivity draws a mark from its step on, sure one step stricter, on the marks already given too", async () => {
  const fake = fakeDictation();
  const { coach } = made(
    says([
      // At every step, as the worker gave marks before Sensitivity.
      { ...THREE_AS_TREE, posterior: 0.9 },
      // Drawn from 1 in 50, sure from 1 in 10.
      { ...THREE_AS_TREE, index: 1, word: "trees", posterior: 0.6, steps: { drawn: 1, sure: 2 } },
    ]),
    fake,
  );
  coach.piece(threeTrees());
  await coach.settled();
  const drawn = () => fake.marks.at(-1)?.marks.map((mark) => [mark.label, mark.level]);
  expect(drawn()).toEqual([["Three", "sure"]]);
  fake.changeSettings({ [SENSITIVITY]: SENSITIVITY_OPTIONS[1] });
  expect(drawn()).toEqual([
    ["Three", "sure"],
    ["trees", "maybe"],
  ]);
  const shown = fake.marks.length;
  fake.changeSettings({ [SENSITIVITY]: SENSITIVITY_OPTIONS[2] });
  // Only a level changed: the marks are given again with it.
  expect(fake.marks).toHaveLength(shown + 1);
  expect(drawn()).toEqual([
    ["Three", "sure"],
    ["trees", "sure"],
  ]);
  fake.changeSettings({ [SENSITIVITY]: SENSITIVITY_OPTIONS[2], [UNDERLINE]: UNDERLINE_SURE });
  expect(drawn()).toEqual([
    ["Three", "sure"],
    ["trees", "sure"],
  ]);
  fake.changeSettings({ [SENSITIVITY]: "something else" });
  expect(drawn()).toEqual([["Three", "sure"]]);
});

test("a change that leaves what is drawn as it was sends nothing", async () => {
  const fake = await markedWith(UNDERLINE_SURE, [0.9]);
  const shown = fake.marks.length;
  fake.changeSettings({ [UNDERLINE]: UNDERLINE_ALL });
  expect(fake.marks).toHaveLength(shown);
});

test("a prifly without mark levels is given the marks as before, without the new fields", async () => {
  const fake = fakeDictation();
  fake.api.features = (fake.api.features ?? []).filter((name) => name !== "dictation-mark-levels");
  const { coach } = made(says([THREE_AS_TREE]), fake);
  coach.piece(threeTrees());
  await coach.settled();
  const { level: _l, confidence: _c, said: _s, say: _y, ...old } = THREE_MARK;
  expect(fake.marks[0]?.marks).toEqual([old]);
});

test("the manifest declares the underline and sensitivity settings the coach reads, a switch per check, all on, the voice box settings, and the version 0.3.0", () => {
  expect(manifest.version).toBe("0.3.0");
  // The native check's setting is native-control.test.ts's.
  expect(manifest.settings.filter((one) => one.id !== NATIVE_CHECK)).toEqual([
    {
      id: UNDERLINE,
      label: "Underline",
      description: expect.any(String),
      type: "select",
      default: UNDERLINE_ALL,
      options: [UNDERLINE_SURE, UNDERLINE_ALL, UNDERLINE_OFF],
    },
    {
      id: SENSITIVITY,
      label: "Sensitivity",
      description:
        "How readily a word is underlined. Each step finds more, and also more words a native speaker says the same way.",
      type: "select",
      default: SENSITIVITY_OPTIONS[0],
      options: [...SENSITIVITY_OPTIONS],
    },
    ...CHECK_IDS.map((id) => ({
      id: SWITCHES[id],
      label: CHECK_LABELS[id],
      description: expect.any(String),
      type: "boolean",
      default: true,
    })),
    {
      id: "voiceBox",
      label: expect.any(String),
      description: expect.any(String),
      type: "string",
      default: "",
    },
    {
      id: "voiceBoxPort",
      label: expect.any(String),
      description: expect.any(String),
      type: "number",
      default: 0,
      min: 0,
      max: 65_535,
    },
    {
      id: "voiceBoxKey",
      label: expect.any(String),
      description: expect.any(String),
      type: "string",
      default: "",
    },
    {
      id: "voiceReference",
      label: expect.any(String),
      description: expect.any(String),
      type: "string",
      default: "",
    },
  ]);
});
