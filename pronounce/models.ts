/**
 * What the extension fetches the first time it is enabled, pinned like
 * prifly's dictation models:
 *
 * - wav2vec2-lv-60-espeak-cv-ft (Facebook, Apache-2.0) as ONNX
 *   (`onnx-community`): 16 kHz audio in, espeak IPA phones out by CTC, one
 *   frame per 20 ms. `model_quantized.onnx` (uint8, 318 MB, the same file as
 *   `model_uint8.onnx`) instead of the fp32 `model.onnx` (1.26 GB): about 55
 *   ms per audio second at 4 threads, ~1.1 GB RSS. Not `model_int8.onnx`: it
 *   fails in onnxruntime's CPU provider ("NOT_IMPLEMENTED ConvInteger").
 * - Britfone 3.0.1 (Jose Llarena, MIT), the British pronouncing dictionary
 *   the heard phones are compared with (`dictionary.ts`), from GitHub, with
 *   its LICENSE.
 * - CMUdict (Carnegie Mellon, BSD-2-Clause), the American pronunciations
 *   accepted beside Britfone's (`dictionary.ts`), from GitHub, with its
 *   LICENSE: 3.6 MB, fetched rather than kept in the repository.
 *
 * They go where prifly keeps its own models, `<prifly data>/models/`, in the
 * folders prifly's built-in version used, so a machine that has them already
 * fetches nothing.
 */

import { join, posix, win32 } from "node:path";
import { type DownloadDeps, ensureModelFiles, type ModelFiles } from "./download";

export type Pinned = ModelFiles & { name: string; what: string; key: string };

export const PHONEME_MODEL: Pinned & { vocab: string } = {
  name: "wav2vec2-lv-60-espeak",
  what: "the phoneme model",
  repo: "onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX",
  revision: "c69750f5043e5e1f8a71ab95dd3b98338c280c92",
  key: "onnx/model_quantized.onnx",
  vocab: "vocab.json",
  files: {
    "onnx/model_quantized.onnx": "3d1479b5c70836645a4310902479f7f7e8bbc8c16c58745d918804f4f6f9d120",
    "vocab.json": "d732ab2456c0c017930001dc9af0b41b3b93d25b2eb9740bf9d925508d7d87d0",
  },
};

export const BRITFONE: Pinned = {
  name: "britfone",
  what: "the dictionary",
  host: "github",
  repo: "JoseLlarena/Britfone",
  revision: "1062be14adc96c358f2087ac5449d72130c7a6f4",
  key: "britfone.main.3.0.1.csv",
  files: {
    "britfone.main.3.0.1.csv": "59f197e98520856d1cc88e380beb54e4314d8712efc4d588b6778819c502d920",
    "LICENSE.txt": "ec93e71cd6fcdced20da7a0137bdfc1ff5fd8ea420d1fab332f95804668f9c49",
  },
};

export const CMUDICT: Pinned = {
  name: "cmudict",
  what: "the American dictionary",
  host: "github",
  repo: "cmusphinx/cmudict",
  revision: "74790861f652b15e4ac49015a90074ad62a27690",
  key: "cmudict.dict",
  files: {
    "cmudict.dict": "81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22",
    LICENSE: "bd4ce8e44170a5f9f481310ca85c51de3c4f851a65e679b40e603b143bd3542a",
  },
};

/** Where the worker finds its files. */
export type PronounceFiles = { model: string; vocab: string; dictionary: string; cmudict: string };

/** One file on its way: which of the two (`what`), the file, and its bytes. */
export type Fetching = { what: string; file: string; done: number; total: number };

/**
 * prifly's data folder, as its host decides it (`platform/data-dir.ts`
 * there): `$XDG_DATA_HOME/prifly` or `~/.local/share/prifly` on Linux,
 * `~/Library/Application Support/prifly` on macOS, `%LOCALAPPDATA%\prifly\host`
 * on Windows.
 */
export function priflyDataDir(
  platform: NodeJS.Platform,
  env: Record<string, string | undefined>,
  home: string,
): string {
  if (platform === "win32") {
    return win32.join(
      env["LOCALAPPDATA"] ?? win32.join(home, "AppData", "Local"),
      "prifly",
      "host",
    );
  }
  if (platform === "darwin") return posix.join(home, "Library", "Application Support", "prifly");
  const xdg = env["XDG_DATA_HOME"];
  return posix.join(
    xdg !== undefined && xdg !== "" ? xdg : posix.join(home, ".local", "share"),
    "prifly",
  );
}

/** `<data>/models/<name>-<first 8 of the key file's sha256>`, as prifly names its model folders. */
function folderOf(dataFolder: string, spec: Pinned): string {
  return join(dataFolder, "models", `${spec.name}-${(spec.files[spec.key] ?? "").slice(0, 8)}`);
}

/** All three fetched where they are missing, the dictionaries first (they are small); `progress` hears each file. */
export async function ensurePronounce(
  dataFolder: string,
  progress: (at: Fetching) => void,
  deps: DownloadDeps = {},
): Promise<PronounceFiles> {
  const fetchOf = (spec: Pinned) =>
    ensureModelFiles(
      folderOf(dataFolder, spec),
      spec,
      (at) => progress({ what: spec.what, ...at }),
      deps,
    );
  const words = await fetchOf(BRITFONE);
  const american = await fetchOf(CMUDICT);
  const model = await fetchOf(PHONEME_MODEL);
  return {
    model: join(model, PHONEME_MODEL.key),
    vocab: join(model, PHONEME_MODEL.vocab),
    dictionary: join(words, BRITFONE.key),
    cmudict: join(american, CMUDICT.key),
  };
}
