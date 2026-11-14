import { afterEach, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionManifest, ExtensionModule } from "@prifly/extension-api";
import * as extension from "../index";
import { NOT_A_MISTAKE, NOT_MISTAKES } from "../pronounce/coach";
import { type StartDeps, type Started, start, TOO_OLD } from "../pronounce/extension";
import { JudgeRequest } from "../pronounce/protocol";
import { fakeApi } from "./fake-api";
import { fakeDictation, THREE_AS_TREE, THREE_DETAIL, threeTrees } from "./fake-dictation";
import { type FakeWorker, fakeWorker, until } from "./fake-worker";

// The module is what prifly imports: it must fit the contract as a whole.
const module: ExtensionModule = extension;
const ROOT = join(import.meta.dir, "..");
const FILES = { model: "/m", vocab: "/v", dictionary: "/d" };

let running: Started | undefined;
afterEach(() => running?.stop());

/** A worker that says `marks` of every request, a moment after it. */
function judging(marks: object[]): FakeWorker {
  const worker = fakeWorker();
  const record = worker.write;
  worker.write = (line) => {
    record(line);
    const { id } = JudgeRequest.parse(JSON.parse(line));
    queueMicrotask(() => worker.say({ type: "marks", id, marks, ms: 3 }));
  };
  return worker;
}

/** The extension on a fake api and a fake worker that has said `ready`. */
async function ready(marks: object[] = [THREE_AS_TREE]) {
  const fake = fakeDictation();
  const workers: FakeWorker[] = [];
  const deps: StartDeps = {
    ensure: async (progress) => {
      progress({ what: "the dictionary", file: "b.csv", done: 5_000_000, total: 10_000_000 });
      return FILES;
    },
    spawn: () => {
      const worker = judging(marks);
      workers.push(worker);
      return worker;
    },
  };
  const on = start(fake.api, deps);
  running = on;
  await until(() => workers.length === 1);
  workers[0]?.say({ type: "ready" });
  return { fake, workers, on };
}

test("the manifest says it hears dictation with audio, and names its entry", async () => {
  const manifest: ExtensionManifest = await Bun.file(join(ROOT, "prifly-extension.json")).json();
  expect(manifest).toMatchObject({
    id: "pronunciation",
    name: "Pronunciation",
    main: "index.ts",
    dictation: { audio: true },
  });
});

test("the module offers no launcher, and on a prifly without dictation only says so", () => {
  expect(module.choices).toBeUndefined();
  expect(module.launch).toBeUndefined();
  const fake = fakeApi();
  const stop = extension.activate(fake.api);
  expect(fake.statuses).toEqual([TOO_OLD]);
  stop();
});

test("enabled: the status line goes from download through loading to ready", async () => {
  const { fake } = await ready();
  expect(fake.statuses).toEqual([
    "Downloading the phoneme model and the dictionary",
    "Downloading the dictionary: b.csv, 50% of 10 MB",
    "Loading the phoneme model",
    "Ready: underlines accent features in your English dictation",
  ]);
});

test("a failed download is on the status line, and dictation goes on unmarked", async () => {
  const fake = fakeDictation();
  const on = start(fake.api, {
    ensure: () => Promise.reject(new Error("HTTP 503 for https://x")),
    spawn: () => fakeWorker(),
  });
  running = on;
  await until(() => fake.statuses.at(-1)?.startsWith("Error") === true);
  expect(fake.statuses.at(-1)).toBe("Error: download failed: HTTP 503 for https://x");
  await fake.heard.piece?.(threeTrees());
  await on.coach?.settled();
  expect(fake.marks).toEqual([]);
});

test("a dictated word said with an accent feature is marked with its hint and Not a mistake", async () => {
  const { fake, on } = await ready();
  // The handler is done before the worker has answered: dictation waits on nothing.
  expect(fake.heard.piece?.(threeTrees())).toBeUndefined();
  expect(fake.marks).toEqual([]);
  await on.coach?.settled();
  expect(fake.marks).toEqual([
    {
      sessionId: "s1",
      dict: "d1",
      piece: 0,
      marks: [
        {
          start: 0,
          end: 5,
          label: "Three",
          detail: THREE_DETAIL,
          actions: [{ id: NOT_A_MISTAKE, label: "Not a mistake", icon: "check" }],
          level: "sure",
          confidence: 0.95,
          said: "TREE",
          say: "THREE",
        },
      ],
    },
  ]);
});

test("a Swedish piece reaches no worker", async () => {
  const { fake, workers, on } = await ready();
  await fake.heard.piece?.(threeTrees({ language: "sv" }));
  await on.coach?.settled();
  expect(workers[0]?.lines).toEqual([]);
});

test("Not a mistake is persisted, and a correction reaches the worker as the corrected word", async () => {
  const { fake, workers, on } = await ready();
  await fake.heard.piece?.(threeTrees());
  await on.coach?.settled();
  await fake.heard.action?.({
    sessionId: "s1",
    dict: "d1",
    piece: 0,
    markStart: 0,
    markEnd: 5,
    action: NOT_A_MISTAKE,
  });
  expect(fake.documents.get(NOT_MISTAKES)).toEqual([{ word: "Three", heard: "triː" }]);
  await fake.heard.correction?.({
    sessionId: "s1",
    dict: "d1",
    piece: 0,
    heard: "trees",
    word: "threes",
    start: 6,
    end: 12,
  });
  await on.coach?.settled();
  const request = JudgeRequest.parse(JSON.parse(workers[0]?.lines[1] ?? "{}"));
  expect(request.words).toEqual([{ word: "threes", from: 8000, to: 14_400 }]);
});

test("disabling stops the worker and clears the status", async () => {
  const { fake, workers, on } = await ready();
  on.stop();
  expect(await workers[0]?.exited).toBe(143);
  expect(fake.statuses.at(-1)).toBe("");
});

test("only the worker's own files touch onnxruntime: the host never loads it", async () => {
  const names = (await readdir(join(ROOT, "pronounce"))).filter((name) => name.endsWith(".ts"));
  const found: string[] = [];
  for (const name of names) {
    const text = (await Bun.file(join(ROOT, "pronounce", name)).text()).replace(
      /import type .*/gu,
      "",
    );
    if (/from "onnxruntime-node"/u.test(text)) found.push(name);
    if (/from "\.\/phone-model"/u.test(text)) found.push(`${name} imports phone-model`);
  }
  expect(found).toEqual(["phone-model.ts"]);
});
