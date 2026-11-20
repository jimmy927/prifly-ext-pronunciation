import { expect, test } from "bun:test";
import { start } from "../pronounce/extension";
import { FLAGS } from "../pronounce/flag-check";
import type { PastPiece } from "../pronounce/past-pieces";
import { CUTS } from "../pronounce/personal";
import { JudgeRequest, type PronounceArgs, ScanRequest } from "../pronounce/protocol";
import { SCAN_THREADS, startScanWorker } from "../pronounce/scan-worker";
import { fakeDictation, threeTrees } from "./fake-dictation";
import { type FakeWorker, fakeWorker, until } from "./fake-worker";

const FILES = { model: "/m", vocab: "/v", dictionary: "/d", cmudict: "/c" };

function spawner() {
  const spawned: { args: PronounceArgs; worker: FakeWorker }[] = [];
  return {
    spawned,
    spawn: (args: PronounceArgs) => {
      const worker = fakeWorker("onnx said no");
      spawned.push({ args, worker });
      return worker;
    },
  };
}

test("the scoring worker runs on two threads, is asked one scan by id, and answers with its flags", async () => {
  const { spawned, spawn } = spawner();
  const starting = startScanWorker(
    { ensure: async () => FILES, spawn },
    new AbortController().signal,
  );
  await until(() => spawned.length === 1);
  expect(spawned[0]?.args).toEqual({ ...FILES, threads: SCAN_THREADS });
  expect(SCAN_THREADS).toBe(2);
  const worker = spawned[0]?.worker;
  worker?.say({ type: "ready" });
  const scanner = await starting;
  const answer = scanner.scan(new Float32Array([0.5]), [{ word: "three", from: 0, to: 10 }]);
  const asked = ScanRequest.parse(JSON.parse(worker?.lines[0] ?? ""));
  expect(asked).toMatchObject({ op: "scan", words: [{ word: "three", from: 0, to: 10 }] });
  const flag = { index: 0, check: "th" as const, score: 0.9, sound: "th → t", fix: "Teeth." };
  worker?.say({ type: "flags", id: asked.id, flags: [flag], scores: [], ms: 5 });
  expect(await answer).toEqual({ flags: [flag], scores: [] });

  const failing = scanner.scan(new Float32Array([0.5]), []);
  const second = ScanRequest.parse(JSON.parse(worker?.lines[1] ?? ""));
  worker?.say({ type: "error", id: second.id, message: "bad shape" });
  await expect(failing).rejects.toThrow("bad shape");

  // A scan on its way when the worker dies fails with what it said on stderr.
  const dying = scanner.scan(new Float32Array([0.5]), []);
  worker?.exit(1);
  await expect(dying).rejects.toThrow("The model stopped (exit 1): onnx said no");
  await expect(scanner.scan(new Float32Array(1), [])).rejects.toThrow("The model stopped");
});

test("a worker that dies before it is ready, or a cancel while it starts, fails the start and stops it", async () => {
  const { spawned, spawn } = spawner();
  const dead = startScanWorker({ ensure: async () => FILES, spawn }, new AbortController().signal);
  await until(() => spawned.length === 1);
  spawned[0]?.worker.exit(3);
  await expect(dead).rejects.toThrow("The model stopped (exit 3)");

  const abort = new AbortController();
  const cancelled = startScanWorker({ ensure: async () => FILES, spawn }, abort.signal);
  await until(() => spawned.length === 2);
  let stopped = false;
  const second = spawned[1]?.worker;
  if (second !== undefined) {
    second.signal = () => {
      stopped = true;
    };
  }
  abort.abort(new Error("Cancelled"));
  await expect(cancelled).rejects.toThrow("Cancelled");
  expect(stopped).toBe(true);
});

/** A past piece "Three trees." at 48 kHz. */
const PAST: PastPiece = {
  id: "2026-11-20/120000-d1-0",
  wav: "/rec/0.wav",
  text: "Three trees.",
  words: [
    { text: "Three", start: 0, end: 5, startMs: 100, endMs: 500 },
    { text: "trees", start: 6, end: 11, startMs: 500, endMs: 900 },
  ],
  rate: 48_000,
};

test("in the extension: the job scores past pieces on a worker of its own, and the reader's marks reach the judge", async () => {
  const fake = fakeDictation();
  const { spawned, spawn } = spawner();
  const on = start(fake.api, {
    ensure: async () => FILES,
    spawn,
    natives: async () => null,
    shipped: async () => new Set(["z-s"]),
    past: {
      list: async () => Array.from({ length: 15 }, (_, k) => ({ ...PAST, id: `${PAST.id}${k}` })),
      read: async () => ({
        full: { rate: 48_000, samples: new Float32Array(48_000) },
        audio: new Float32Array(16_000),
      }),
    },
  });
  try {
    await until(() => spawned.length === 1);
    const dictation = spawned[0]?.worker;
    dictation?.say({ type: "ready" });
    await until(() => on.runner?.state === "ready");

    await on.panel?.handle({ path: "flags/start", query: {}, body: {} });
    await until(() => spawned.length === 2);
    expect(spawned[1]?.args.threads).toBe(SCAN_THREADS);
    const scoring = spawned[1]?.worker;
    scoring?.say({ type: "ready" });
    for (let k = 0; k < 15; k++) {
      await until(() => (scoring?.lines.length ?? 0) === k + 1);
      const { id } = ScanRequest.parse(JSON.parse(scoring?.lines[k] ?? ""));
      const flag = { index: 0, check: "th", score: 0.9 - k / 100, sound: "th → t", fix: "" };
      scoring?.say({ type: "flags", id, flags: [flag], scores: [], ms: 5 });
    }
    await until(
      () =>
        fake.documents.has(FLAGS) && (fake.documents.get(FLAGS) as { complete: boolean }).complete,
    );
    const view = (await on.panel?.handle({ path: "flags", query: {}, body: null })) as {
      checks: { id: string; flags: { id: string }[] }[];
    };
    const th = view.checks.find((one) => one.id === "th")?.flags ?? [];
    expect(th).toHaveLength(15);
    for (const flag of th) {
      await on.panel?.handle({
        path: "flags/mark",
        query: {},
        body: { id: flag.id, verdict: "right" },
      });
    }
    expect(fake.documents.get(CUTS)).toMatchObject({
      checks: { th: { state: "on", cut: 0.76, marked: 15, right: 15 } },
    });

    // The next piece dictated is judged with th on from 0.76, beating thresholds.json's off.
    void fake.heard.piece?.(threeTrees());
    await until(() => (dictation?.lines.length ?? 0) === 1);
    expect(JudgeRequest.parse(JSON.parse(dictation?.lines[0] ?? "")).overrides).toEqual({
      contrasts: { th: { off: false, maybe: 0.76 } },
    });
  } finally {
    on.stop();
  }
});
