/** A worker process that is a handful of lines: what was written to it, and what it says and how it ends on request. */

import type { WorkerPipe } from "../pronounce/worker-pipe";

export type FakeWorker = WorkerPipe & {
  lines: string[];
  say: (line: object) => void;
  exit: (code: number) => void;
};

export function fakeWorker(stderr = ""): FakeWorker {
  let handler: (line: string) => void = () => undefined;
  let exit: (code: number) => void = () => undefined;
  const lines: string[] = [];
  return {
    lines,
    write: (line) => void lines.push(line),
    onLine: (given) => {
      handler = given;
    },
    signal: () => exit(143),
    exited: new Promise<number>((resolve) => {
      exit = resolve;
    }),
    stderrTail: () => stderr,
    say: (line) => handler(JSON.stringify(line)),
    exit: (code) => exit(code),
  };
}

/** Waits, a millisecond at a time and at most a second, until `done` holds. */
export async function until(done: () => boolean): Promise<void> {
  for (let waited = 0; waited < 1000 && !done(); waited++) await Bun.sleep(1);
  if (!done()) throw new Error("the condition did not come true within a second");
}
