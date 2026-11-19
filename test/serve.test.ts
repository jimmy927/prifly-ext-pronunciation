import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { engineLoadError } from "../pronounce/engine";
import { exitWhenOrphaned } from "../pronounce/lifetime";
import { decodeFloats, encodeFloats } from "../pronounce/pcm";
import { answerJudge, loadAll, lowPriority, normalised, type PhoneModel } from "../pronounce/serve";

const VOCAB = { "<pad>": 0, "<s>": 1, "</s>": 2, "<unk>": 3, θ: 4, t: 5, ɹ: 6, iː: 7 };

/** A model that hears "t ɹ iː" twice whatever it is given, sure of each, and keeps what it was given. */
function fakeModel(given: Float32Array[]): PhoneModel {
  const rows = [0, 5, 0, 6, 7, 0, 5, 0, 6, 7, 0];
  const size = Object.keys(VOCAB).length;
  return {
    logits: async (audio) => {
      given.push(audio);
      const data = new Float32Array(rows.length * size);
      rows.forEach((id, t) => {
        data[t * size + id] = 12;
      });
      return { data, frames: rows.length, size };
    },
  };
}

/** The worker's files in a folder of their own; `thresholds`, when given, as its thresholds.json. */
async function loaded(given: Float32Array[] = [], thresholds?: object) {
  const folder = await mkdtemp(join(tmpdir(), "pronounce-"));
  await writeFile(join(folder, "vocab.json"), JSON.stringify(VOCAB));
  await writeFile(join(folder, "britfone.csv"), "THREE, θ ɹ ˈiː\nTREE, t ɹ ˈiː\n");
  await writeFile(join(folder, "cmudict.dict"), "three TH R IY1\nstreet S T R IY1 T\n");
  if (thresholds !== undefined) {
    await writeFile(join(folder, "thresholds.json"), JSON.stringify(thresholds));
  }
  const args = {
    model: join(folder, "model.onnx"),
    vocab: join(folder, "vocab.json"),
    dictionary: join(folder, "britfone.csv"),
    cmudict: join(folder, "cmudict.dict"),
    threads: 4,
  };
  const opened: [string, number][] = [];
  const open = async (path: string, threads: number) => {
    opened.push([path, threads]);
    return fakeModel(given);
  };
  const all = await loadAll(args, open, join(folder, "thresholds.json"));
  return { all, opened, args };
}

const TWO_WORDS = {
  op: "judge" as const,
  id: "7",
  pcm: encodeFloats(new Float32Array([0.2, 0.4, 0.6])),
  words: [
    { word: "three", from: 0, to: 6 * 320 },
    { word: "tree", from: 6 * 320, to: 11 * 320 },
  ],
};

test("the worker has both dictionaries, and a check thresholds.json turns off is never marked", async () => {
  const { all } = await loaded([], { contrasts: { th: { off: true } } });
  expect(all.dictionary.get("street")).toEqual([["s", "t", "ɹ", "iː", "t"]]);
  expect(all.dictionary.get("three")).toHaveLength(1);
  expect(await answerJudge(TWO_WORDS, all)).toMatchObject({ type: "marks", marks: [] });
});

test("the worker loads the model on the threads it is given, and answers a piece with its marks", async () => {
  const given: Float32Array[] = [];
  const { all, opened, args } = await loaded(given);
  expect(opened).toEqual([[args.model, 4]]);
  expect(await answerJudge(TWO_WORDS, all)).toMatchObject({
    type: "marks",
    id: "7",
    marks: [{ index: 0, word: "three", heard: "tɹiː", expected: "θɹiː", sound: "th → t" }],
  });
  // The model is given the audio normalised: zero mean.
  const [audio] = given;
  expect(audio).toHaveLength(3);
  expect(Math.abs((audio?.reduce((a, b) => a + b, 0) ?? 1) / 3)).toBeLessThan(1e-6);
});

test("a model that throws answers that piece with an error line", async () => {
  const { all } = await loaded();
  const broken = { ...all, model: { logits: async () => Promise.reject(new Error("bad shape")) } };
  const request = {
    op: "judge" as const,
    id: "9",
    pcm: encodeFloats(new Float32Array(4)),
    words: [],
  };
  expect(await answerJudge(request, broken)).toEqual({
    type: "error",
    id: "9",
    message: "Error: bad shape",
  });
});

test("normalised audio has zero mean and unit variance; silence stays silent", () => {
  const out = normalised(Float32Array.from([1, 3]));
  expect([...out].map((x) => Math.round(x * 1000) / 1000)).toEqual([-1, 1]);
  expect([...normalised(new Float32Array(3))]).toEqual([0, 0, 0]);
});

test("the worker lowers its own priority, and goes on when the system refuses", () => {
  const asked: number[] = [];
  lowPriority((priority) => asked.push(priority));
  expect(asked).toHaveLength(1);
  expect(() =>
    lowPriority(() => {
      throw new Error("EACCES");
    }),
  ).not.toThrow();
});

test("audio survives the line to the worker, from any offset of its buffer", () => {
  const whole = Float32Array.from([9, 0.5, -0.25, 9]);
  expect([...decodeFloats(encodeFloats(whole.subarray(1, 3)))]).toEqual([0.5, -0.25]);
});

test("onnxruntime that will not load is reported with the loader's words", async () => {
  expect(await engineLoadError(async () => undefined)).toBe("");
  expect(await engineLoadError(() => Promise.reject(new Error("libonnxruntime: not found")))).toBe(
    "libonnxruntime: not found",
  );
});

test("the worker exits when its parent changes, not before", async () => {
  let parent = 10;
  let exits = 0;
  const stop = exitWhenOrphaned({
    ppid: () => parent,
    alive: () => true,
    exit: () => exits++,
    everyMs: 1,
  });
  await Bun.sleep(5);
  expect(exits).toBe(0);
  parent = 1;
  await Bun.sleep(5);
  stop();
  expect(exits).toBeGreaterThan(0);
});

test("the worker exits when its parent no longer runs, though its pid is the same", async () => {
  let exits = 0;
  const stop = exitWhenOrphaned({
    ppid: () => 10,
    alive: () => false,
    exit: () => exits++,
    everyMs: 1,
  });
  await Bun.sleep(5);
  stop();
  expect(exits).toBeGreaterThan(0);
});
