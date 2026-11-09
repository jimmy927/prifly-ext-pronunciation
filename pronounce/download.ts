/**
 * Model files fetched the way prifly fetches its own (`models/download.ts`
 * there): pinned to a revision, each file checked against its sha256 on the
 * way in, kept under a folder of its own. A file only gets its name once its
 * hash matched, so a file that is there is trusted; a folder whose
 * `.verified` names the same hashes is trusted whole.
 */

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A repo at a revision, and each file's path in it with its sha256: on Hugging Face unless `host` says GitHub. */
export type ModelFiles = {
  repo: string;
  revision: string;
  files: Record<string, string>;
  host?: "github";
};

/** How far one file's download is: `total` 0 when the server did not say its size. */
export type FileProgress = { file: string; done: number; total: number };

export type DownloadDeps = {
  fetch?: (url: string, init: { signal: AbortSignal }) => Promise<Response>;
  signal?: AbortSignal;
  /** Moves the finished `.part` into place; tests make it fail the way Windows does. */
  rename?: (from: string, to: string) => Promise<void>;
  /** Waits between tries to move it; tests make it instant. */
  sleep?: (ms: number) => Promise<void>;
};

/** A downloaded file whose sha256 is not the pinned one: nothing was kept. */
export class ShaMismatch extends Error {
  override name = "ShaMismatch";
}

/** The longest one file may take. */
const FILE_TIMEOUT_MS = 30 * 60_000;

const MARKER = ".verified";

/**
 * What Windows answers a rename with while another process holds the file:
 * Defender or a search indexer scanning the 318 MB file that was just
 * closed, which lasts seconds. POSIX never says these for a rename.
 */
const BUSY = new Set(["EPERM", "EBUSY", "EACCES"]);

/** The waits, in ms, between the tries to move a finished file into place. */
export const RENAME_WAITS_MS = [100, 250, 500, 1000, 2000, 4000];

/**
 * `from` moved onto `to`, replacing a file already there (Node's rename does
 * on every system, Windows included, when nothing holds it open). A file held
 * by another process is tried again after each wait in `RENAME_WAITS_MS`; the
 * last failure, and any other, is thrown.
 */
export async function moveInto(from: string, to: string, deps: DownloadDeps = {}): Promise<void> {
  const move = deps.rename ?? rename;
  const sleep = deps.sleep ?? ((ms: number) => Bun.sleep(ms));
  for (let tries = 0; ; tries++) {
    try {
      await move(from, to);
      return;
    } catch (caught) {
      const code = caught instanceof Error && "code" in caught ? String(caught.code) : "";
      const wait = RENAME_WAITS_MS[tries];
      if (!BUSY.has(code) || wait === undefined) throw caught;
      await sleep(wait);
    }
  }
}

export function urlOf(spec: ModelFiles, path: string): string {
  if (spec.host === "github") {
    return `https://raw.githubusercontent.com/${spec.repo}/${spec.revision}/${path}`;
  }
  return `https://huggingface.co/${spec.repo}/resolve/${spec.revision}/${path}`;
}

async function verified(folder: string, spec: ModelFiles): Promise<boolean> {
  const marker = Bun.file(join(folder, MARKER));
  return (await marker.exists()) && (await marker.text()) === JSON.stringify(spec.files);
}

/** One file, streamed to a temporary name, hashed on the way, moved into place only if the hash matches. */
async function download(
  url: string,
  target: string,
  sha: string,
  onBytes: (done: number, total: number) => void,
  deps: DownloadDeps,
): Promise<void> {
  const timeout = AbortSignal.timeout(FILE_TIMEOUT_MS);
  const signal = deps.signal === undefined ? timeout : AbortSignal.any([deps.signal, timeout]);
  const response = await (deps.fetch ?? fetch)(url, { signal });
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status} for ${url}`);
  const total = Number(response.headers.get("content-length") ?? 0) || 0;
  await mkdir(dirname(target), { recursive: true });
  const part = `${target}.part`;
  const writer = Bun.file(part).writer();
  const hasher = new Bun.CryptoHasher("sha256");
  let done = 0;
  try {
    for await (const chunk of response.body) {
      hasher.update(chunk);
      writer.write(chunk);
      done += chunk.byteLength;
      onBytes(done, total);
    }
  } finally {
    await writer.end();
  }
  const got = hasher.digest("hex");
  if (got !== sha) {
    await rm(part, { force: true });
    throw new ShaMismatch(
      `${url}: sha256 ${got.slice(0, 12)}... is not the pinned ${sha.slice(0, 12)}...`,
    );
  }
  await moveInto(part, target, deps);
}

/**
 * `folder`, holding every file of `spec`, downloading what is missing one
 * file after another; `progress` hears each file's bytes as they come.
 */
export async function ensureModelFiles(
  folder: string,
  spec: ModelFiles,
  progress: (at: FileProgress) => void,
  deps: DownloadDeps = {},
): Promise<string> {
  if (await verified(folder, spec)) return folder;
  for (const [path, sha] of Object.entries(spec.files)) {
    const target = join(folder, path);
    if (await Bun.file(target).exists()) continue;
    progress({ file: path, done: 0, total: 0 });
    await download(
      urlOf(spec, path),
      target,
      sha,
      (done, total) => progress({ file: path, done, total }),
      deps,
    );
  }
  await Bun.write(join(folder, MARKER), JSON.stringify(spec.files));
  return folder;
}
