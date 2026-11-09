import { expect, test } from "bun:test";
import type { DictationMark } from "@prifly/extension-api";
import { Coach, detailOf, isEnglish, NOT_A_MISTAKE, NOT_MISTAKES } from "../pronounce/coach";
import type { Judged, JudgeWord } from "../pronounce/judge";
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
  const coach = new Coach(fake.api, (audio, words) => {
    const one = { audio, words };
    asked.push(one);
    return answer(one);
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

test("the hint line is at most what the window takes", () => {
  expect(detailOf(THREE_AS_TREE)).toBe(THREE_DETAIL);
  expect(detailOf({ ...THREE_AS_TREE, how: "x".repeat(400) })).toHaveLength(300);
});
