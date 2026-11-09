/**
 * The worker process as the runner holds it: lines written to its stdin,
 * lines heard from its stdout, a signal to stop it, and its exit code.
 * `spawnWorker` starts one with `Bun.spawn`; tests hand the runner a fake.
 * Its stderr goes to the extension's log line by line, and its last lines
 * are kept for the error shown when it dies (`stderrTail`).
 */

import { join } from "node:path";
import { encodeArgs, type PronounceArgs } from "./protocol";

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
  const failed = (caught: unknown) =>
    log(`could not write to the worker: ${caught instanceof Error ? caught.message : caught}`);
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
      // A worker that just died has a closed pipe (EPIPE, likelier on Windows): its exit
      // answers the call with null, so the write only has to not throw.
      try {
        child.stdin.write(`${line}\n`);
        Promise.resolve(child.stdin.flush()).catch(failed);
      } catch (caught) {
        failed(caught);
      }
    },
    onLine: (given) => {
      handler = given;
    },
    signal: (signal) => {
      // On Windows any signal ends the process outright (libuv's TerminateProcess); a
      // child that is gone already, or cannot be reached, is as stopped as it will get.
      try {
        child.kill(signal);
      } catch (caught) {
        log(`could not stop the worker: ${caught instanceof Error ? caught.message : caught}`);
      }
    },
    exited: child.exited,
    stderrTail: () => tail.join(" / "),
  };
}

/** The pronunciation worker for `args`: `bun pronounce/worker.ts <base64 of args>` (`encodeArgs`). */
export function spawnPronounce(args: PronounceArgs, log: (line: string) => void): WorkerPipe {
  return spawnWorker(
    [process.execPath, WORKER_SCRIPT, encodeArgs(args)],
    log,
    join(import.meta.dir, ".."),
  );
}
