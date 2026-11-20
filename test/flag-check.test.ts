import { expect, test } from "bun:test";
import { AccentPanel } from "../pronounce/accent-panel";
import { CHECK_IDS, type CheckId } from "../pronounce/checks";
import { NO_BOX } from "../pronounce/extension";
import {
  FLAGS,
  FlagCheck,
  type FlagCheckDeps,
  type FlagsView,
  GONE,
  SCAN_PIECES,
} from "../pronounce/flag-check";
import type { PastPiece } from "../pronounce/past-pieces";
import { MARKS, Personal } from "../pronounce/personal";
import { AccentProfile } from "../pronounce/profile";
import type { ScanAnswer, ScanWorker } from "../pronounce/scan-worker";
import type { Wav } from "../pronounce/wav";
import { much, natives } from "./accent-fixtures";
import { fakeState } from "./fake-api";
import { until } from "./fake-worker";

/** Piece `k`: "Three things." said at 48 kHz, "Three" from 100 to 500 ms. */
function piece(k: number): PastPiece {
  return {
    id: `2026-11-20/1200${String(k).padStart(2, "0")}-d${k}-0`,
    wav: `/rec/${k}.wav`,
    text: "Three things.",
    words: [
      { text: "Three", start: 0, end: 5, startMs: 100, endMs: 500 },
      { text: "things", start: 6, end: 12, startMs: 500, endMs: 900 },
    ],
    rate: 48_000,
  };
}

/** The worker's answer for a piece: th heard in "Three" at `th` (a check thresholds.json has off), stress in "things", and "things"' vowel far off. */
const answerOf = (th: number): ScanAnswer => ({
  flags: [
    { index: 0, check: "th", score: th, sound: "th → t", fix: "Tongue between the teeth." },
    { index: 1, check: "stress", score: 1.4, sound: "stress first → second", fix: "Stress it." },
  ],
  scores: [much(-4, "æ", 1)],
});

/** A worker whose scans wait until the test answers them, one by one. */
function fakeScanWorker() {
  const waiting: { resolve: (a: ScanAnswer) => void; reject: (e: Error) => void }[] = [];
  const asked: {
    audio: Float32Array;
    words: readonly { word: string; from: number; to: number }[];
  }[] = [];
  let stopped = 0;
  const worker: ScanWorker = {
    scan: (audio, words) =>
      new Promise((resolve, reject) => {
        asked.push({ audio, words });
        waiting.push({ resolve, reject });
      }),
    stop: () => {
      stopped++;
      for (const one of waiting.splice(0)) one.reject(new Error("The model stopped (exit 143)"));
    },
  };
  return {
    worker,
    asked,
    waiting,
    stopped: () => stopped,
    /** Answers the oldest scan waiting. */
    answer: async (answer: ScanAnswer) => {
      await until(() => waiting.length > 0);
      waiting.shift()?.resolve(answer);
    },
    fail: async (message: string) => {
      await until(() => waiting.length > 0);
      waiting.shift()?.reject(new Error(message));
    },
  };
}

const FULL: Wav = { rate: 48_000, samples: new Float32Array(48_000).map((_, at) => at / 48_000) };

function setup(
  options: {
    pieces?: number;
    worker?: (signal: AbortSignal) => Promise<ScanWorker>;
    read?: FlagCheckDeps["read"];
    box?: boolean;
  } = {},
) {
  const { state, documents } = fakeState();
  const personal = new Personal(state);
  const scan = fakeScanWorker();
  let now = 1_000_000;
  const played: { which: string; rate: number; length: number; text?: string }[] = [];
  const logs: string[] = [];
  const deps: FlagCheckDeps = {
    state,
    personal,
    list: async (limit) =>
      Array.from({ length: Math.min(limit, options.pieces ?? 5) }, (_, k) => piece(k)),
    read: options.read ?? (async () => ({ full: FULL, audio: new Float32Array(16_000) })),
    worker: options.worker ?? (async () => scan.worker),
    natives: () => natives(),
    // Every switch on but TH's.
    switchedOn: () => new Set<CheckId>(CHECK_IDS.filter((id) => id !== "th")),
    voice: {
      yours: async (clip) => {
        played.push({ which: "yours", rate: clip.rate, length: clip.samples.length });
        return "/clips/yours.wav";
      },
      sayRight: async (job) => {
        played.push({ which: "right", rate: 16_000, length: job.clip.length, text: job.text });
        return "/clips/right.wav";
      },
    },
    sayRight: () => (options.box === false ? NO_BOX : null),
    now: () => now,
    log: (event) => void logs.push(event),
  };
  const check = new FlagCheck(deps);
  const panel = new AccentPanel({
    profile: new AccentProfile(undefined, () => null),
    coach: {
      yoursMissing: () => null,
      exampleYours: async () => "",
      exampleRight: async () => "",
    },
    sayRight: deps.sayRight,
    flags: check,
    readFile: async (path) => new TextEncoder().encode(path),
  });
  const ask = async (path: string, body: unknown = null) =>
    (await panel.handle({ path, query: {}, body })) as FlagsView;
  return {
    check,
    panel,
    ask,
    scan,
    documents,
    personal,
    played,
    logs,
    tick: (ms: number) => {
      now += ms;
    },
  };
}

const checkOf = (view: FlagsView, id: CheckId) => view.checks.find((one) => one.id === id);

test("before any job: Score is on, Cancel and Reset are off, and every check is listed with no flags", async () => {
  const { check, ask } = setup();
  await check.load();
  const view = await ask("flags");
  expect(view.job).toEqual({
    state: "idle",
    done: 0,
    total: 0,
    line: `Scores your last ${SCAN_PIECES} English sentences with every check, the ones switched off too. Mark each flag Right or Wrong: each check's tally shows how often it was wrong for you, and which switch in Settings → Extensions → Pronunciation turns it off.`,
  });
  expect([view.canStart, view.canCancel, view.canReset]).toEqual([true, false, false]);
  expect(view.checks.map((one) => one.id)).toEqual([
    "z-s",
    "final-devoicing",
    "th",
    "w-v",
    "sh-ch",
    "any-sound",
    "stress",
    "vowel-patterns",
    "weak-vowels",
  ]);
  expect(checkOf(view, "z-s")).toMatchObject({ title: "Z said as S", on: true, flags: [] });
  expect(checkOf(view, "th")).toMatchObject({
    on: false,
    marked: 0,
    line: "Not marked yet. Off: switch on “TH said as T, D, S or F” in Settings → Extensions → Pronunciation to underline it again.",
  });
});

test("each check's tally counts Wrong here and Not a mistake in the session alike, beside the switch that turns it off", async () => {
  const { check, ask, scan, personal } = setup({ pieces: 1 });
  await ask("flags/start", {});
  await scan.answer(answerOf(0.9));
  await check.settled();
  await ask("flags/mark", { id: "2026-11-20/120000-d0-0#1#stress", verdict: "right" });
  // "Not a mistake" on a stress underline in the session (coach.ts).
  await personal.mark("session#s1#d1#0##6#stress", "wrong", "stress", 1.3);
  await personal.mark("session#s1#d1#1##6#stress", "wrong", "stress", 1.5);
  const stress = checkOf(await ask("flags"), "stress");
  expect(stress).toMatchObject({ on: true, marked: 3, right: 1, wrong: 2 });
  expect(stress?.line).toBe(
    "2 of 3 not a mistake. Too many? Switch off “Word stress” in Settings → Extensions → Pronunciation.",
  );
});

test("a job scores the pieces one at a time and says how far it is and how long is left", async () => {
  const { check, ask, scan, tick } = setup({ pieces: 5 });
  const started = await ask("flags/start", {});
  expect(started.job.state).not.toBe("idle");
  expect([started.canStart, started.canCancel]).toEqual([false, true]);
  await until(() => scan.waiting.length === 1);
  expect((await ask("flags")).job.line).toBe("Scoring 1 of 5, working out how long");
  // The 16 kHz words of the piece: "Three" from 100 ms.
  expect(scan.asked[0]?.words[0]).toEqual({ word: "Three", from: 1600, to: 8000 });
  tick(90_000);
  await scan.answer(answerOf(0.9));
  await until(() => scan.waiting.length === 1);
  // Only one at a time: the second is asked once the first is answered.
  expect(scan.asked).toHaveLength(2);
  const second = await ask("flags");
  expect(second.job).toEqual({
    state: "running",
    done: 1,
    total: 5,
    line: "Scoring 2 of 5, about 6 minutes left",
  });
  // The flags of the first piece show while the rest is scored.
  expect(checkOf(second, "th")?.flags).toHaveLength(1);
  tick(30_000);
  await scan.answer(answerOf(0.8));
  await until(() => scan.waiting.length === 1);
  expect((await ask("flags")).job.line).toBe("Scoring 3 of 5, about 3 minutes left");
  tick(100_000);
  await scan.answer(answerOf(0.7));
  await until(() => scan.waiting.length === 1);
  expect((await ask("flags")).job.line).toBe("Scoring 4 of 5, about 2 minutes left");
  for (const th of [0.6, 0.55]) await scan.answer(answerOf(th));
  await check.settled();
  expect((await ask("flags")).job).toMatchObject({ state: "done", done: 5 });
});

test("every check's candidates are kept, the ones that are off too, worst first, with the sentence and the word", async () => {
  const { check, ask, scan, documents } = setup({ pieces: 2 });
  await ask("flags/start", {});
  await scan.answer(answerOf(0.6));
  await scan.answer(answerOf(0.93));
  await check.settled();
  const view = await ask("flags");
  expect(view.job).toMatchObject({ state: "done", line: "Scored 2 sentences: 6 flags" });
  expect([view.canStart, view.canCancel]).toEqual([true, false]);
  const th = checkOf(view, "th");
  expect(th?.on).toBe(false);
  expect(th?.flags.map((one) => one.score)).toEqual(["0.93", "0.60"]);
  expect(th?.flags[0]).toEqual({
    id: "2026-11-20/120001-d1-0#0#th",
    word: "Three",
    before: "",
    after: " things.",
    score: "0.93",
    sound: "th → t",
    fix: "Tongue between the teeth.",
    verdict: null,
  });
  expect(checkOf(view, "stress")?.flags[0]).toMatchObject({ word: "things", before: "Three " });
  // "things"' vowel at -4 against natives whose 5th percentile is -2: a vowel flag.
  expect(checkOf(view, "vowel-patterns")?.flags[0]).toMatchObject({
    word: "things",
    sound: "U (cup) → A (cap)",
  });
  // Kept with what plays the word: the recording and the word's times.
  expect(documents.get(FLAGS)).toMatchObject({
    complete: true,
    scanned: 2,
    flags: expect.arrayContaining([
      expect.objectContaining({ check: "th", wav: "/rec/0.wav", fromMs: 100, toMs: 500 }),
    ]),
  });
});

test("Cancel stops the worker; what was found stays, and the job says where it stopped", async () => {
  const { check, ask, scan, documents } = setup({ pieces: 5 });
  await ask("flags/start", {});
  await scan.answer(answerOf(0.9));
  await until(() => scan.waiting.length === 1);
  const cancelled = await ask("flags/cancel", {});
  expect(scan.stopped()).toBeGreaterThan(0);
  expect(cancelled.job).toMatchObject({ state: "cancelled", done: 1, total: 5 });
  expect(cancelled.job.line).toBe("Stopped after 1 of 5 sentences: 3 flags so far");
  expect([cancelled.canStart, cancelled.canCancel]).toEqual([true, false]);
  await check.settled();
  expect(scan.asked).toHaveLength(2);
  expect(documents.get(FLAGS)).toMatchObject({ complete: false, scanned: 1 });
  // The scan that was on its way when it was cancelled added nothing.
  expect((await ask("flags")).job.line).toBe("Stopped after 1 of 5 sentences: 3 flags so far");
});

test("a job stopped early is read back as stopped, one that finished as done", async () => {
  const first = setup({ pieces: 1 });
  await first.ask("flags/start", {});
  await first.scan.answer(answerOf(0.9));
  await first.check.settled();
  const stored = first.documents.get(FLAGS);
  const { state } = fakeState();
  await state.set(FLAGS, stored);
  const read = new FlagCheck({
    state,
    personal: new Personal(state),
    list: async () => [],
    read: async () => ({ full: FULL, audio: new Float32Array(0) }),
    worker: async () => fakeScanWorker().worker,
    natives: () => null,
    switchedOn: () => new Set(),
    voice: null,
    sayRight: () => null,
    log: () => undefined,
  });
  await read.load();
  expect(read.view().job).toMatchObject({ state: "done", line: "Scored 1 sentence: 3 flags" });
  expect(read.view().yours).not.toBeNull();
  await state.set(FLAGS, { ...(stored as object), complete: false });
  await read.load();
  expect(read.view().job.state).toBe("cancelled");
});

test("no English recordings with full audio: the job says how to get some", async () => {
  const { check, ask } = setup({ pieces: 0 });
  await ask("flags/start", {});
  await check.settled();
  const view = await ask("flags");
  expect(view.job.state).toBe("empty");
  expect(view.job.line).toContain("Keep recordings of my dictation");
  expect(view.canStart).toBe(true);
});

test("a model that will not start fails the job with its words; one that fails three pieces in a row stops it", async () => {
  const broken = setup({
    worker: async () => Promise.reject(new Error("download failed: offline")),
  });
  await broken.ask("flags/start", {});
  await broken.check.settled();
  expect((await broken.ask("flags")).job).toMatchObject({
    state: "failed",
    line: "Scoring stopped: download failed: offline",
  });

  const flaky = setup({ pieces: 6 });
  await flaky.ask("flags/start", {});
  await flaky.scan.answer(answerOf(0.9));
  await flaky.scan.fail("bad shape");
  await flaky.scan.answer(answerOf(0.8));
  for (const _ of [1, 2, 3]) await flaky.scan.fail("The model stopped (exit 1)");
  await flaky.check.settled();
  const view = await flaky.ask("flags");
  expect(view.job).toMatchObject({
    state: "failed",
    line: "Scoring stopped: The model stopped (exit 1)",
  });
  // What it found before stays.
  expect(checkOf(view, "th")?.flags).toHaveLength(2);
  expect(flaky.logs.filter((one) => one === "flagPieceFailed")).toHaveLength(4);
});

test("marks are the reader's, changeable, counted per check, and kept when the sentences are scored again", async () => {
  const { check, ask, scan, documents } = setup({ pieces: 2 });
  await ask("flags/start", {});
  await scan.answer(answerOf(0.6));
  await scan.answer(answerOf(0.93));
  await check.settled();
  const [worst, other] = checkOf(await ask("flags"), "th")?.flags ?? [];
  await ask("flags/mark", { id: worst?.id, verdict: "right" });
  let view = await ask("flags/mark", { id: other?.id, verdict: "wrong" });
  expect(checkOf(view, "th")).toMatchObject({ marked: 2, right: 1 });
  expect(view.canReset).toBe(true);
  view = await ask("flags/mark", { id: other?.id, verdict: "right" });
  expect(checkOf(view, "th")).toMatchObject({ marked: 2, right: 2 });
  expect(documents.get(MARKS)).toMatchObject({
    marks: { [other?.id ?? ""]: { verdict: "right", check: "th", score: 0.6 } },
  });

  await ask("flags/start", {});
  await scan.answer(answerOf(0.6));
  await scan.answer(answerOf(0.93));
  await check.settled();
  view = await ask("flags");
  expect(checkOf(view, "th")?.flags.map((one) => one.verdict)).toEqual(["right", "right"]);

  view = await ask("flags/mark", { id: worst?.id, verdict: null });
  expect(checkOf(view, "th")).toMatchObject({ marked: 1, right: 1 });
  view = await ask("flags/reset", {});
  expect(checkOf(view, "th")).toMatchObject({ marked: 0, right: 0 });
  expect(view.canReset).toBe(false);
  await expect(ask("flags/mark", { id: "nope", verdict: "right" })).rejects.toThrow(
    "That flag is no longer in the list",
  );
  await expect(ask("flags/mark", { id: worst?.id, verdict: "maybe" })).rejects.toThrow(
    "Unknown verdict: maybe",
  );
});

test("marks only tally: a check marked Wrong throughout stays as its switch says, and nothing else is kept", async () => {
  const { check, ask, scan, documents } = setup({ pieces: 20 });
  await ask("flags/start", {});
  for (let k = 0; k < 20; k++) await scan.answer(answerOf(0.99 - k / 100));
  await check.settled();
  let view = await ask("flags");
  const th = checkOf(view, "th")?.flags ?? [];
  const stress = checkOf(view, "stress")?.flags ?? [];
  for (const [at, flag] of th.entries()) {
    await ask("flags/mark", { id: flag.id, verdict: at < 16 ? "right" : "wrong" });
  }
  for (const flag of stress) await ask("flags/mark", { id: flag.id, verdict: "wrong" });
  view = await ask("flags");
  expect(checkOf(view, "th")).toMatchObject({ on: false, marked: 20, right: 16, wrong: 4 });
  expect(checkOf(view, "stress")).toMatchObject({ on: true, marked: 20, right: 0, wrong: 20 });
  expect(checkOf(view, "stress")?.line).toBe(
    "20 of 20 not a mistake. Too many? Switch off “Word stress” in Settings → Extensions → Pronunciation.",
  );
  expect([...documents.keys()].sort()).toEqual([FLAGS, MARKS].sort());
});

test("Yours plays the word cut from the piece's full-rate audio; Say it right needs the box; a deleted recording says so", async () => {
  const { check, ask, scan, played, panel } = setup({ pieces: 1 });
  await ask("flags/start", {});
  await scan.answer(answerOf(0.9));
  await check.settled();
  const [flag] = checkOf(await ask("flags"), "th")?.flags ?? [];
  const yours = (await panel.handle({
    path: "flags/play",
    query: {},
    body: { id: flag?.id, which: "yours" },
  })) as { audio: string };
  expect(yours.audio).toBe(
    `data:audio/wav;base64,${Buffer.from("/clips/yours.wav").toString("base64")}`,
  );
  // 100 to 500 ms at 48 kHz.
  expect(played[0]).toEqual({ which: "yours", rate: 48_000, length: 19_200 });
  await panel.handle({ path: "flags/play", query: {}, body: { id: flag?.id, which: "right" } });
  expect(played[1]).toEqual({ which: "right", rate: 16_000, length: 6400, text: "Three" });

  const noBox = setup({ pieces: 1, box: false });
  await noBox.ask("flags/start", {});
  await noBox.scan.answer(answerOf(0.9));
  await noBox.check.settled();
  const view = await noBox.ask("flags");
  expect(view.sayRight).toBe(NO_BOX);
  const id = checkOf(view, "th")?.flags[0]?.id;
  await expect(
    noBox.panel.handle({ path: "flags/play", query: {}, body: { id, which: "right" } }),
  ).rejects.toThrow(NO_BOX);

  let gone = false;
  const deleted = setup({
    pieces: 1,
    read: async () => {
      if (gone) throw new Error("ENOENT");
      return { full: FULL, audio: new Float32Array(16_000) };
    },
  });
  await deleted.ask("flags/start", {});
  await deleted.scan.answer(answerOf(0.9));
  await deleted.check.settled();
  gone = true;
  const lost = checkOf(await deleted.ask("flags"), "th")?.flags[0]?.id;
  await expect(
    deleted.panel.handle({ path: "flags/play", query: {}, body: { id: lost, which: "yours" } }),
  ).rejects.toThrow(GONE);
});

test("the panel refuses an unknown flags request, and says so when there is no Check your flags", async () => {
  const { ask } = setup();
  await expect(ask("flags/nope")).rejects.toThrow("Unknown request: flags/nope");
  const bare = new AccentPanel({
    profile: new AccentProfile(undefined, () => null),
    coach: { yoursMissing: () => null, exampleYours: async () => "", exampleRight: async () => "" },
    sayRight: () => null,
  });
  await expect(bare.handle({ path: "flags", query: {}, body: null })).rejects.toThrow(
    "Check your flags is not available",
  );
});
