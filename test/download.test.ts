import { expect, test } from "bun:test";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DownloadDeps,
  ensureModelFiles,
  type FileProgress,
  type ModelFiles,
  ShaMismatch,
  urlOf,
} from "../pronounce/download";
import {
  BRITFONE,
  CMUDICT,
  ensurePronounce,
  type Fetching,
  PHONEME_MODEL,
  priflyDataDir,
} from "../pronounce/models";

const sha = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

const CONTENT: Record<string, string> = { "a/one.bin": "first file", "two.txt": "second" };

const SPEC: ModelFiles = {
  repo: "org/repo",
  revision: "abc",
  files: { "a/one.bin": sha("first file"), "two.txt": sha("second") },
};

const folder = () => mkdtemp(join(tmpdir(), "pronounce-download-"));

/** A server holding `content` by the path after the revision, recording what was asked. */
function server(content: Record<string, string>, urls: string[] = []): DownloadDeps {
  return {
    fetch: async (url) => {
      urls.push(url);
      const body = content[url.split("/abc/")[1] ?? ""];
      if (body === undefined) return new Response("gone", { status: 404 });
      return new Response(body, { headers: { "content-length": String(body.length) } });
    },
  };
}

test("each file comes from its pinned revision, its progress told per file, kept under its path", async () => {
  const dir = await folder();
  const urls: string[] = [];
  const seen: FileProgress[] = [];
  expect(await ensureModelFiles(dir, SPEC, (at) => seen.push(at), server(CONTENT, urls))).toBe(dir);
  expect(urls).toEqual([
    "https://huggingface.co/org/repo/resolve/abc/a/one.bin",
    "https://huggingface.co/org/repo/resolve/abc/two.txt",
  ]);
  expect(seen).toEqual([
    { file: "a/one.bin", done: 0, total: 0 },
    { file: "a/one.bin", done: 10, total: 10 },
    { file: "two.txt", done: 0, total: 0 },
    { file: "two.txt", done: 6, total: 6 },
  ]);
  expect(await Bun.file(join(dir, "a/one.bin")).text()).toBe("first file");
});

test("a folder fetched before is not fetched again", async () => {
  const dir = await folder();
  await ensureModelFiles(dir, SPEC, () => undefined, server(CONTENT));
  const urls: string[] = [];
  await ensureModelFiles(dir, SPEC, () => undefined, server(CONTENT, urls));
  expect(urls).toEqual([]);
});

test("only the file a broken download left missing is fetched", async () => {
  const dir = await folder();
  await writeFile(join(dir, "two.txt"), "second");
  const urls: string[] = [];
  await ensureModelFiles(dir, SPEC, () => undefined, server(CONTENT, urls));
  expect(urls).toEqual(["https://huggingface.co/org/repo/resolve/abc/a/one.bin"]);
});

test("a file whose hash is not the pinned one is refused, and nothing of it kept", async () => {
  const dir = await folder();
  const tampered = server({ ...CONTENT, "a/one.bin": "tampered" });
  await expect(ensureModelFiles(dir, SPEC, () => undefined, tampered)).rejects.toBeInstanceOf(
    ShaMismatch,
  );
  expect(await readdir(join(dir, "a"))).toEqual([]);
  expect(await Bun.file(join(dir, ".verified")).exists()).toBe(false);
});

test("a server's error names the status and the URL", async () => {
  const dir = await folder();
  await expect(ensureModelFiles(dir, SPEC, () => undefined, server({}))).rejects.toThrow(
    "HTTP 404 for https://huggingface.co/org/repo/resolve/abc/a/one.bin",
  );
});

test("a stream cut off midway fails the download, and the retry starts the file over", async () => {
  const dir = await folder();
  const cut: DownloadDeps = {
    fetch: async () =>
      new Response(
        new ReadableStream({
          pull(controller) {
            controller.enqueue(new TextEncoder().encode("a long partial body, cut"));
            controller.error(new Error("connection reset"));
          },
        }),
      ),
  };
  await expect(ensureModelFiles(dir, SPEC, () => undefined, cut)).rejects.toThrow(
    "connection reset",
  );
  await ensureModelFiles(dir, SPEC, () => undefined, server(CONTENT));
  expect(await Bun.file(join(dir, "a/one.bin")).text()).toBe("first file");
});

test("the pins are the benchmarked model and Britfone with its licence", () => {
  expect(PHONEME_MODEL.repo).toBe("onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX");
  expect(PHONEME_MODEL.key).toBe("onnx/model_quantized.onnx");
  expect(PHONEME_MODEL.files["onnx/model_quantized.onnx"]).toBe(
    "3d1479b5c70836645a4310902479f7f7e8bbc8c16c58745d918804f4f6f9d120",
  );
  expect(Object.keys(BRITFONE.files)).toEqual(["britfone.main.3.0.1.csv", "LICENSE.txt"]);
  expect(urlOf(BRITFONE, "LICENSE.txt")).toBe(
    `https://raw.githubusercontent.com/JoseLlarena/Britfone/${BRITFONE.revision}/LICENSE.txt`,
  );
  expect(Object.keys(CMUDICT.files)).toEqual(["cmudict.dict", "LICENSE"]);
  expect(urlOf(CMUDICT, CMUDICT.key)).toBe(
    `https://raw.githubusercontent.com/cmusphinx/cmudict/${CMUDICT.revision}/cmudict.dict`,
  );
});

test("the dictionary comes first, named with what it is, and the worker gets the pinned paths", async () => {
  const data = await folder();
  const asked: string[] = [];
  const seen: Fetching[] = [];
  const deps: DownloadDeps = {
    fetch: async (url) => {
      asked.push(url);
      return new Response("not the real file");
    },
  };
  // A fake server cannot match the real pins: the first hash refusal is as far as it goes.
  await expect(ensurePronounce(data, (at) => seen.push(at), deps)).rejects.toBeInstanceOf(
    ShaMismatch,
  );
  expect(asked).toEqual([urlOf(BRITFONE, BRITFONE.key)]);
  expect(seen[0]).toMatchObject({ what: "the dictionary", file: BRITFONE.key });
  // With both folders marked as fetched nothing is asked.
  for (const spec of [BRITFONE, CMUDICT, PHONEME_MODEL]) {
    const dir = join(data, "models", `${spec.name}-${(spec.files[spec.key] ?? "").slice(0, 8)}`);
    await Bun.write(join(dir, ".verified"), JSON.stringify(spec.files));
  }
  asked.length = 0;
  const files = await ensurePronounce(data, () => undefined, deps);
  expect(asked).toEqual([]);
  expect(files.model).toEndWith(
    join("wav2vec2-lv-60-espeak-3d1479b5", "onnx", "model_quantized.onnx"),
  );
  expect(files.dictionary).toEndWith(join("britfone-59f197e9", "britfone.main.3.0.1.csv"));
  expect(files.cmudict).toEndWith(join("cmudict-81917843", "cmudict.dict"));
});

test("prifly's data folder per system", () => {
  expect(priflyDataDir("linux", {}, "/home/a")).toBe("/home/a/.local/share/prifly");
  expect(priflyDataDir("linux", { XDG_DATA_HOME: "/x" }, "/home/a")).toBe("/x/prifly");
  expect(priflyDataDir("darwin", {}, "/Users/a")).toBe(
    "/Users/a/Library/Application Support/prifly",
  );
  expect(priflyDataDir("win32", { LOCALAPPDATA: "C:\\L" }, "C:\\U")).toBe("C:\\L\\prifly\\host");
});
