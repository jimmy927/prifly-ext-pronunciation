import { expect, test } from "bun:test";
import { join } from "node:path";
import { readLines, spawnWorker, WORKER_SCRIPT } from "../pronounce/worker-pipe";
import { until } from "./fake-worker";

const ECHO = join(import.meta.dir, "fixtures", "echo-worker.ts");

function echo() {
  const logged: string[] = [];
  const lines: string[] = [];
  const pipe = spawnWorker([process.execPath, ECHO], (line) => logged.push(line));
  pipe.onLine((line) => lines.push(line));
  return { pipe, lines, logged };
}

test("lines go to the worker and come back, and SIGTERM stops it", async () => {
  const { pipe, lines } = echo();
  pipe.write("hello");
  await until(() => lines.length === 1);
  expect(lines).toEqual(["echo hello"]);
  pipe.signal("SIGTERM");
  expect(await pipe.exited).not.toBe(0);
});

test("a worker's exit code and stderr reach the runner and the log", async () => {
  const { pipe, logged } = echo();
  pipe.write("boom");
  expect(await pipe.exited).toBe(7);
  await until(() => logged.length === 2);
  expect(logged).toEqual(["first complaint", "last complaint"]);
  expect(pipe.stderrTail?.()).toBe("first complaint / last complaint");
});

test("lines split across chunks, a CR and a last line without a newline are read whole", async () => {
  const encoded = ["on", "e\r\ntw", "o\nthree"].map((part) => new TextEncoder().encode(part));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const part of encoded) controller.enqueue(part);
      controller.close();
    },
  });
  const lines: string[] = [];
  await readLines(stream, (line) => lines.push(line));
  expect(lines).toEqual(["one", "two", "three"]);
});

test("the worker script is the one in this extension", async () => {
  expect(await Bun.file(WORKER_SCRIPT).exists()).toBe(true);
});
