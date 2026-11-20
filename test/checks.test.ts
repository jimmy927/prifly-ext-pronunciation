import { expect, test } from "bun:test";
import manifest from "../prifly-extension.json";
import { CHECK_IDS, CHECK_LABELS, type CheckId, SWITCHES, switchedOn } from "../pronounce/checks";
import { Coach, NOT_A_MISTAKE } from "../pronounce/coach";
import { UNDERLINE, UNDERLINE_OFF, UNDERLINE_SURE, UNDERLINE_SWITCH } from "../pronounce/drawn";
import type { Judged } from "../pronounce/judge";
import { Personal } from "../pronounce/personal";
import { type FakeDictation, fakeDictation, THREE_AS_TREE, threeTrees } from "./fake-dictation";

function made(answer: Judged[], fake = fakeDictation()) {
  const asked: unknown[] = [];
  const coach = new Coach(fake.api, async (audio) => {
    asked.push(audio);
    return { marks: answer, scores: [] };
  });
  return { coach, asked, fake };
}

/** A piece of nine words, "w0 w1 … w8", one for each check. */
function ninePiece(piece = 0) {
  const words = CHECK_IDS.map((_, k) => ({
    text: `w${k}`,
    start: k * 3,
    end: k * 3 + 2,
    startMs: 100 * k,
    endMs: 100 * k + 90,
  }));
  return threeTrees({ piece, text: words.map((one) => one.text).join(" "), words });
}

/** A mark of check `check` on word `index`. */
const markOf = (check: CheckId, index: number): Judged => ({
  ...THREE_AS_TREE,
  check,
  index,
  word: `w${index}`,
  heard: `h${index}`,
});

const labels = (fake: FakeDictation) => fake.marks.at(-1)?.marks.map((mark) => mark.label);

test("the manifest's switches are the checks', every one on by default, with the reader's words", () => {
  const switches = manifest.settings.filter((one) => one.type === "boolean");
  expect(switches.map((one) => [one.id, one.label, one.default])).toEqual(
    CHECK_IDS.map((id) => [SWITCHES[id], CHECK_LABELS[id], true]),
  );
  expect(switches.find((one) => one.id === "checkAnySound")?.description).toBe(
    "Every sound the model heard as another: the J in just said as Y, R, L. The noisiest check.",
  );
  expect([...switchedOn({})]).toEqual([...CHECK_IDS]);
  expect([...switchedOn({ checkTh: false, checkStress: true })]).not.toContain("th");
});

test("each check's switch takes away only that check's marks, those given already too, and gives them back", async () => {
  const fake = fakeDictation();
  const { coach } = made(
    CHECK_IDS.map((check, k) => markOf(check, k)),
    fake,
  );
  coach.piece(ninePiece());
  await coach.settled();
  const all = CHECK_IDS.map((_, k) => `w${k}`);
  expect(labels(fake)).toEqual(all);
  for (const [k, check] of CHECK_IDS.entries()) {
    fake.changeSettings({ [SWITCHES[check]]: false });
    expect(labels(fake)).toEqual(all.filter((_, j) => j !== k));
    fake.changeSettings({ [SWITCHES[check]]: true });
    expect(labels(fake)).toEqual(all);
  }
  // A piece judged while a check is off keeps that check's marks, drawn once it is on again.
  fake.changeSettings({ checkStress: false });
  coach.piece(ninePiece(1));
  await coach.settled();
  expect(fake.marks.at(-1)?.piece).toBe(1);
  expect(labels(fake)).not.toContain(`w${CHECK_IDS.indexOf("stress")}`);
  fake.changeSettings({});
  expect(labels(fake)).toEqual(all);
});

test("a word two checks mark shows the first switched on; switching it off shows the other", async () => {
  const fake = fakeDictation();
  const stress = { ...THREE_AS_TREE, check: "stress" as const, said: "three-STRESS" };
  const { coach } = made([THREE_AS_TREE, stress], fake);
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks.at(-1)?.marks.map((mark) => mark.said)).toEqual(["TREE"]);
  fake.changeSettings({ checkTh: false });
  expect(fake.marks.at(-1)?.marks.map((mark) => mark.said)).toEqual(["three-STRESS"]);
  fake.changeSettings({ checkTh: false, checkStress: false });
  expect(fake.marks.at(-1)?.marks).toEqual([]);
  // Every check off: nothing more is judged.
  const { coach: idle, asked } = made(
    [THREE_AS_TREE],
    fakeDictation(Object.fromEntries(CHECK_IDS.map((check) => [SWITCHES[check], false]))),
  );
  idle.piece(threeTrees());
  await idle.settled();
  expect(asked).toEqual([]);
});

test("a kept 'Sure mistakes only' is switched to 'Sure and not sure' once; the reader's later choice stands", async () => {
  const fake = fakeDictation({ [UNDERLINE]: UNDERLINE_SURE });
  const maybe = [{ ...THREE_AS_TREE, posterior: 0.75 }];
  const { coach } = made(maybe, fake);
  await coach.load();
  expect(fake.documents.get(UNDERLINE_SWITCH)).toEqual({ v: 1, active: true });
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks.at(-1)?.marks.map((mark) => mark.level)).toEqual(["maybe"]);
  // Another setting changed: Underline still says what it said, and the switch holds.
  fake.changeSettings({ [UNDERLINE]: UNDERLINE_SURE, checkWv: false });
  expect(fake.marks.at(-1)?.marks.map((mark) => mark.level)).toEqual(["maybe"]);
  // The reader picks Off, then Sure mistakes only: theirs stands, now and after a restart.
  fake.changeSettings({ [UNDERLINE]: UNDERLINE_OFF });
  expect(fake.marks.at(-1)?.marks).toEqual([]);
  fake.changeSettings({ [UNDERLINE]: UNDERLINE_SURE });
  expect(fake.documents.get(UNDERLINE_SWITCH)).toEqual({ v: 1, active: false });
  coach.piece(threeTrees({ piece: 1 }));
  await coach.settled();
  expect(fake.marks.filter((one) => one.piece === 1)).toEqual([]);
  const { coach: again } = made(maybe, fake);
  await again.load();
  again.piece(threeTrees({ piece: 2 }));
  await again.settled();
  expect(fake.marks.filter((one) => one.piece === 2)).toEqual([]);
});

test("a first start on the new default remembers no switch, so a later 'Sure mistakes only' is the reader's", async () => {
  const fake = fakeDictation();
  const { coach } = made([{ ...THREE_AS_TREE, posterior: 0.75 }], fake);
  await coach.load();
  expect(fake.documents.get(UNDERLINE_SWITCH)).toEqual({ v: 1, active: false });
  fake.changeSettings({ [UNDERLINE]: UNDERLINE_SURE });
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks).toEqual([]);
});

test("Not a mistake adds a Wrong verdict on the mark's check and switches nothing off", async () => {
  const fake = fakeDictation();
  const personal = new Personal(fake.api.state);
  await personal.load();
  const trees = { ...THREE_AS_TREE, index: 1, word: "trees", heard: "tɹiːs" };
  const coach = new Coach(
    fake.api,
    async () => ({ marks: [THREE_AS_TREE, trees], scores: [] }),
    null,
    null,
    { personal },
  );
  coach.piece(threeTrees());
  await coach.settled();
  await coach.action({
    sessionId: "s1",
    dict: "d1",
    piece: 0,
    markStart: 0,
    markEnd: 5,
    action: NOT_A_MISTAKE,
  });
  expect(personal.tally("th")).toEqual({ marked: 1, right: 0, wrong: 1 });
  expect(labels(fake)).toEqual(["trees"]);
  // The check stays on: the next piece's other TH word is still underlined.
  coach.piece(threeTrees({ piece: 1 }));
  await coach.settled();
  expect(fake.marks.at(-1)?.piece).toBe(1);
  expect(labels(fake)).toEqual(["trees"]);
});
