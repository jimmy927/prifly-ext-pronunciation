import { expect, test } from "bun:test";
import { ShaMismatch } from "../pronounce/download";
import type { Fetching } from "../pronounce/models";
import { decodeFloats } from "../pronounce/pcm";
import { JudgeRequest, type PronounceArgs } from "../pronounce/protocol";
import { PRONOUNCE_THREADS, PronounceRunner, type RunnerDeps } from "../pronounce/runner";
import { statusLine } from "../pronounce/status";
import { type FakeWorker, fakeWorker } from "./fake-worker";

const FILES = {
  model: "/m/model.onnx",
  vocab: "/m/vocab.json",
  dictionary: "/b/britfone.csv",
  cmudict: "/c/cmudict.dict",
};

function made(fetch: RunnerDeps["ensure"], stderr = "") {
  const workers: FakeWorker[] = [];
  const spawned: PronounceArgs[] = [];
  const lines: string[] = [];
  const runner: PronounceRunner = new PronounceRunner({
    ensure: fetch,
    spawn: (args) => {
      spawned.push(args);
      const worker = fakeWorker(stderr);
      workers.push(worker);
      return worker;
    },
    onChange: () => lines.push(statusLine(runner)),
    log: () => undefined,
    backoffMs: () => 1,
  });
  return { runner, workers, spawned, lines };
}

const file = (done: number): Fetching => ({
  what: "the phoneme model",
  file: "onnx/model_quantized.onnx",
  done,
  total: 318_000_000,
});

const fetched: RunnerDeps["ensure"] = async (progress) => {
  progress(file(79_500_000));
  progress(file(79_600_000));
  progress(file(159_000_000));
  return FILES;
};

const ONE_WORD = [{ word: "a", from: 0, to: 4 }];

test("the first start tells each percent once, starts the worker on 4 threads, and is ready when it says so", async () => {
  const { runner, workers, spawned, lines } = made(fetched);
  await runner.start();
  expect(spawned).toEqual([{ ...FILES, threads: PRONOUNCE_THREADS }]);
  expect(PRONOUNCE_THREADS).toBe(4);
  expect(runner.state).toBe("loading");
  workers[0]?.say({ type: "ready" });
  expect(runner.state).toBe("ready");
  expect(lines).toEqual([
    "Downloading the phoneme model and the dictionary",
    "Downloading the phoneme model: onnx/model_quantized.onnx, 25% of 318 MB",
    "Downloading the phoneme model: onnx/model_quantized.onnx, 50% of 318 MB",
    "Loading the phoneme model",
    "Ready: underlines accent features in your English dictation",
  ]);
});

test("a piece goes to the worker with only its words' text and time, and its marks come back", async () => {
  const { runner, workers } = made(fetched);
  await runner.start();
  const worker = workers[0];
  worker?.say({ type: "ready" });
  const words = [{ word: "three", from: 0, to: 320, start: 4, end: 9 }];
  const marks = runner.judge(new Float32Array([0.5, -0.5]), words);
  const request = JudgeRequest.parse(JSON.parse(worker?.lines[0] ?? "{}"));
  expect(request.words).toEqual([{ word: "three", from: 0, to: 320 }]);
  expect([...decodeFloats(request.pcm)]).toEqual([0.5, -0.5]);
  const judged = {
    index: 0,
    check: "th" as const,
    word: "three",
    heard: "tɹiː",
    expected: "θɹiː",
    sound: "th → t",
    how: "",
    posterior: 0.9,
    said: "TREE",
    say: "THREE",
    fix: "",
  };
  worker?.say({ type: "marks", id: request.id, marks: [judged], ms: 12 });
  expect(await marks).toEqual({ marks: [judged], scores: [] });
});

test("nothing is judged before the worker is ready", async () => {
  const { runner, workers } = made(fetched);
  expect(await runner.judge(new Float32Array(4), ONE_WORD)).toBeNull();
  await runner.start();
  expect(await runner.judge(new Float32Array(4), ONE_WORD)).toBeNull();
  expect(workers[0]?.lines).toEqual([]);
});

test("a piece on its way when the worker dies is answered null", async () => {
  const { runner, workers } = made(fetched);
  await runner.start();
  workers[0]?.say({ type: "ready" });
  const answer = runner.judge(new Float32Array(4), ONE_WORD);
  workers[0]?.exit(1);
  expect(await answer).toBeNull();
});

test("a failed download says why, and is not fetched again until stopped", async () => {
  let fetches = 0;
  const { runner, spawned, lines } = made(async () => {
    fetches++;
    throw new Error("HTTP 404 for https://x");
  });
  await runner.start();
  expect(runner.state).toBe("failed");
  expect(lines.at(-1)).toBe("Error: download failed: HTTP 404 for https://x");
  await runner.start();
  expect(fetches).toBe(1);
  runner.stop();
  await runner.start();
  expect([fetches, spawned.length]).toEqual([2, 0]);
});

test("a sha mismatch has its own error", async () => {
  const { runner, lines } = made(async () => {
    throw new ShaMismatch("url: sha256 aaa... is not the pinned bbb...");
  });
  await runner.start();
  expect(lines.at(-1)).toBe(
    "Error: sha256 mismatch, nothing kept: url: sha256 aaa... is not the pinned bbb...",
  );
});

test("a worker that dies is started again, and after five deaths stays down saying what it said", async () => {
  const { runner, workers, lines } = made(fetched, "Killed: out of memory");
  await runner.start();
  for (let death = 1; death <= 5; death++) {
    workers.at(-1)?.exit(1);
    await Bun.sleep(5);
  }
  expect(workers).toHaveLength(5);
  expect(runner.state).toBe("failed");
  expect(lines.at(-1)).toBe("Error: the worker crashed 5 times (exit 1): Killed: out of memory");
});

test("a worker that gets ready between deaths starts its count over", async () => {
  const { runner, workers } = made(fetched);
  await runner.start();
  for (let death = 1; death <= 7; death++) {
    workers.at(-1)?.say({ type: "ready" });
    workers.at(-1)?.exit(1);
    await Bun.sleep(5);
  }
  expect(runner.state).toBe("loading");
  expect(workers).toHaveLength(8);
});

test("a worker that cannot load onnxruntime fails at once with the reason, and is not restarted", async () => {
  const { runner, workers, lines } = made(fetched);
  await runner.start();
  workers[0]?.say({ type: "unavailable", message: "libonnxruntime.so: not found" });
  workers[0]?.exit(3);
  await Bun.sleep(1);
  expect(lines.at(-1)).toBe(
    "Error: onnxruntime could not load on this machine: libonnxruntime.so: not found",
  );
  expect(workers).toHaveLength(1);
});

test("a line that is no message is ignored", async () => {
  const { runner, workers } = made(fetched);
  await runner.start();
  workers[0]?.say({ type: "something else" });
  expect(runner.state).toBe("loading");
});

test("stop ends the worker without counting it as a crash, and clears the status", async () => {
  const { runner, workers, lines } = made(fetched);
  await runner.start();
  workers[0]?.say({ type: "ready" });
  runner.stop();
  await Bun.sleep(3);
  expect(workers).toHaveLength(1);
  expect(runner.state).toBe("off");
  expect(lines.at(-1)).toBe("");
});

test("stop during a download aborts it, and no worker starts", async () => {
  let signal: AbortSignal | undefined;
  let finish: () => void = () => undefined;
  const { runner, spawned } = made(async (_progress, given) => {
    signal = given;
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return FILES;
  });
  const started = runner.start();
  await Bun.sleep(1);
  expect(signal?.aborted).toBe(false);
  runner.stop();
  expect(signal?.aborted).toBe(true);
  finish();
  await started;
  expect(spawned).toEqual([]);
  expect(runner.state).toBe("off");
});

test("stop during the wait before a restart starts nothing", async () => {
  const { runner, workers } = made(fetched);
  await runner.start();
  workers[0]?.exit(1);
  await Bun.sleep(0);
  runner.stop();
  await Bun.sleep(5);
  expect(workers).toHaveLength(1);
});

test("a download of unknown size is told in MB", () => {
  const fetching = { what: "the dictionary", file: "b.csv", done: 3_000_000, total: 0 };
  expect(statusLine({ state: "downloading", fetching, error: "" })).toBe(
    "Downloading the dictionary: b.csv, 3 MB so far",
  );
});
