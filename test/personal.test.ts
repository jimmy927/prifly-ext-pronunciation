import { expect, test } from "bun:test";
import {
  MARKS,
  MAX_MARKS,
  NO_MARKS,
  Personal,
  parseMarks,
  tallyOf,
  withMark,
} from "../pronounce/personal";
import { fakeState } from "./fake-api";

test("a check's tally counts its own verdicts only", () => {
  let doc = NO_MARKS;
  doc = withMark(doc, "a", "right", "th", 0.9);
  doc = withMark(doc, "b", "wrong", "th", 0.7);
  doc = withMark(doc, "c", "wrong", "th", 0.6);
  doc = withMark(doc, "d", "wrong", "stress", 1.4);
  expect(tallyOf(doc, "th")).toEqual({ marked: 3, right: 1, wrong: 2 });
  expect(tallyOf(doc, "stress")).toEqual({ marked: 1, right: 0, wrong: 1 });
  expect(tallyOf(doc, "z-s")).toEqual({ marked: 0, right: 0, wrong: 0 });
  // A verdict given again replaces the first; null takes it back.
  doc = withMark(doc, "b", "right", "th", 0.7);
  doc = withMark(doc, "c", null, "th", 0.6);
  expect(tallyOf(doc, "th")).toEqual({ marked: 2, right: 2, wrong: 0 });
});

test("at most MAX_MARKS verdicts are kept, the oldest going first; a broken document is none", () => {
  const full = Array.from({ length: MAX_MARKS }, (_, k) => [
    `f${k}`,
    { verdict: "wrong" as const, check: "z-s" as const, score: 0.5 },
  ]);
  let doc = { v: 1 as const, marks: Object.fromEntries(full) };
  for (let k = MAX_MARKS; k < MAX_MARKS + 3; k++) doc = withMark(doc, `f${k}`, "wrong", "z-s", 0.5);
  expect(Object.keys(doc.marks)).toHaveLength(MAX_MARKS);
  expect(doc.marks["f0"]).toBeUndefined();
  expect(doc.marks[`f${MAX_MARKS + 2}`]).toBeDefined();
  expect(parseMarks({ v: 2 })).toEqual(NO_MARKS);
  expect(parseMarks({ v: 1, marks: { x: { verdict: "maybe", check: "th", score: 1 } } })).toEqual(
    NO_MARKS,
  );
});

test("verdicts are kept in api.state; one taken back goes; reset clears them; nothing else is written", async () => {
  const { state, documents } = fakeState();
  const personal = new Personal(state);
  await personal.load();
  for (let k = 0; k < 15; k++) await personal.mark(`f${k}`, "right", "th", 0.9 - k / 100);
  await personal.mark("w", "wrong", "weak-vowels", 3.1);
  expect(personal.verdictOf("f0")).toBe("right");
  expect(personal.tally("th")).toEqual({ marked: 15, right: 15, wrong: 0 });
  expect(personal.tally("weak-vowels")).toEqual({ marked: 1, right: 0, wrong: 1 });
  // The verdicts switch nothing: no cut-offs are made or kept from them.
  expect([...documents.keys()]).toEqual([MARKS]);

  await personal.mark("f14", null, "th", 0.76);
  expect(personal.verdictOf("f14")).toBeNull();

  // Read back by a new start.
  const again = new Personal(state);
  await again.load();
  expect(again.count()).toBe(15);

  await again.reset();
  expect(again.count()).toBe(0);
  expect(documents.get(MARKS)).toEqual({ v: 1, marks: {} });
});
