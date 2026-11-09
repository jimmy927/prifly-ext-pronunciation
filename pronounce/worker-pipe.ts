/**
 * The worker process as the runner holds it: lines written to its stdin,
 * lines heard from its stdout, a signal to stop it, and its exit code.
 * `spawnWorker` starts one with `Bun.spawn`; tests hand the runner a fake.
 * Its stderr goes to the extension's log line by line, and its last lines
 * are kept for the error shown when it dies (`stderrTail`).
 */

import { join } from "node:path";
import type { PronounceArgs } from "./protocol";

export type WorkerPipe = {
  write: (line: string) => void;
  onLine: (handler: (line: string) => void) => void;
  signal: (signal: "SIGTERM") => void;
  exited: Promise<number>;
  /** The worker's last lines on stderr, newest last; "" when it said nothing. */
  stderrTail?: () => string;
};

/** The worker's script, beside this file. */
export const WORKER_SCRIPT = join(import.meta.dir, "worker.ts");

/** How many of the worker's last stderr lines are kept for its error. */
const TAIL_LINES = 3;

/** Each line of `stream` to `each`, the last one without its newline too. */
export async function readLines(
  stream: ReadableStream<Uint8Array>,
  each: (line: string) => void,
): Promise<void> {
  const decoder = new TextDecoder();
  let held = "";
  for await (const chunk of stream) {
    held += decoder.decode(chunk, { stream: true });
    const lines = held.split("\n");
    held = lines.pop() ?? "";
    for (const line of lines) each(line.replace(/\r$/u, ""));
  }
  held += decoder.decode();
  if (held !== "") each(held);
}

/**
 * `argv` started as a worker. `BUN_BE_BUN` makes a prifly host built as a
 * single Bun executable run the script as `bun` would; a plain `bun` ignores it.
 */
export function spawnWorker(
  argv: readonly string[],
  log: (line: string) => void,
  cwd?: string,
): WorkerPipe {
  const child = Bun.spawn([...argv], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
    env: { ...process.env, BUN_BE_BUN: "1" },
    ...(cwd === undefined ? {} : { cwd }),
  });
  let handler: (line: string) => void = () => undefined;
  const tail: string[] = [];
  void readLines(child.stdout, (line) => handler(line));
  void readLines(child.stderr, (line) => {
    if (line.trim() === "") return;
    log(line);
    tail.push(line);
    if (tail.length > TAIL_LINES) tail.shift();
  });
  return {
    write: (line) => {
      child.stdin.write(`${line}\n`);
      void child.stdin.flush();
    },
    onLine: (given) => {
      handler = given;
    },
    signal: (signal) => child.kill(signal),
    exited: child.exited,
    stderrTail: () => tail.join(" / "),
  };
}

/** The pronunciation worker for `args`: `bun pronounce/worker.ts '<args>'`. */
export function spawnPronounce(args: PronounceArgs, log: (line: string) => void): WorkerPipe {
  return spawnWorker(
    [process.execPath, WORKER_SCRIPT, JSON.stringify(args)],
    log,
    join(import.meta.dir, ".."),
  );
}
