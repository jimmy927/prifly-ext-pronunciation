/**
 * What the extension assumes about the system it runs on, with the system
 * handed in so that Linux can check the Windows answers (`platform`, `env`
 * and the failing calls are arguments). What only a Windows machine can show
 * is listed in the README's "Checking it on Windows".
 */

import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { constants, tmpdir } from "node:os";
import { join } from "node:path";
import { moveInto, RENAME_WAITS_MS } from "../pronounce/download";
import { cpuSessionOptions } from "../pronounce/engine";
import { userHome } from "../pronounce/extension";
import { exitWhenOrphaned, pidRuns } from "../pronounce/lifetime";
import { priflyDataDir } from "../pronounce/models";
import { decodeArgs, encodeArgs, type PronounceArgs } from "../pronounce/protocol";
import { lowPriority, workerPriority } from "../pronounce/serve";
import { spawnWorker } from "../pronounce/worker-pipe";
import { until } from "./fake-worker";

const ARGS = join(import.meta.dir, "fixtures", "args-worker.ts");

test("on Windows the data folder is %LOCALAPPDATA%\\prifly\\host, as the host decides it", () => {
  expect(priflyDataDir("win32", { LOCALAPPDATA: "D:\\Apps\\Local" }, "C:\\Users\\a")).toBe(
    "D:\\Apps\\Local\\prifly\\host",
  );
  // Unset: the profile's AppData\Local. XDG_DATA_HOME and HOME mean nothing there.
  expect(
    priflyDataDir("win32", { XDG_DATA_HOME: "/x", HOME: "/h" }, "C:\\Users\\Jimmy Engelbrecht"),
  ).toBe("C:\\Users\\Jimmy Engelbrecht\\AppData\\Local\\prifly\\host");
});

test("the home is HOME on POSIX and the profile folder on Windows, where HOME is another shell's", () => {
  const home = () => "C:\\Users\\a";
  expect(userHome("linux", { HOME: "/home/a" }, home)).toBe("/home/a");
  expect(userHome("linux", { HOME: "" }, home)).toBe("C:\\Users\\a");
  expect(userHome("darwin", {}, home)).toBe("C:\\Users\\a");
  expect(userHome("win32", { HOME: "/c/Users/a" }, home)).toBe("C:\\Users\\a");
});

test("the worker's arguments reach it intact through a path with spaces, quotes and backslashes", async () => {
  const args: PronounceArgs = {
    model: 'C:\\Users\\Jimmy "J" Engelbrecht\\AppData\\Local\\prifly\\host\\models\\m.onnx\\',
    vocab: "C:\\Users\\Åsa Öberg\\vocab.json",
    dictionary: "\\\\server\\share\\a b\\britfone.csv",
    cmudict: "C:\\Users\\Åsa Öberg\\cmudict.dict",
    threads: 4,
  };
  expect(decodeArgs(encodeArgs(args))).toEqual(args);
  // The word itself has nothing a command line treats specially.
  expect(encodeArgs(args)).toMatch(/^[A-Za-z0-9+/=]+$/);
  // And through a real child, started the way the extension starts its worker.
  const lines: string[] = [];
  const pipe = spawnWorker([process.execPath, ARGS, encodeArgs(args)], () => undefined);
  pipe.onLine((line) => lines.push(line));
  await pipe.exited;
  await until(() => lines.length === 1);
  expect(JSON.parse(lines[0] ?? "")).toEqual(args);
});

test("a word that is not the arguments is refused, not half-read", () => {
  expect(() => decodeArgs("")).toThrow();
  expect(() => decodeArgs(Buffer.from('{"model":"m"}').toString("base64"))).toThrow();
});

test("the worker runs below normal on Windows, whose lowest class would starve it, and at nice 19 elsewhere", () => {
  expect(workerPriority("win32")).toBe(constants.priority.PRIORITY_BELOW_NORMAL);
  expect(workerPriority("linux")).toBe(constants.priority.PRIORITY_LOW);
  expect(workerPriority("darwin")).toBe(constants.priority.PRIORITY_LOW);
  const asked: number[] = [];
  lowPriority((priority) => asked.push(priority), "win32");
  expect(asked).toEqual([constants.priority.PRIORITY_BELOW_NORMAL]);
});

test("a refused priority is said on stderr and never stops the worker, whatever was thrown", () => {
  const written: string[] = [];
  const real = process.stderr.write;
  process.stderr.write = ((chunk: string) => {
    written.push(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    lowPriority(() => {
      throw new Error("EPERM: operation not permitted");
    }, "win32");
    lowPriority(() => {
      throw "a string, not an Error";
    }, "win32");
  } finally {
    process.stderr.write = real;
  }
  expect(written).toEqual([
    "pronounce: priority not lowered: EPERM: operation not permitted\n",
    "pronounce: priority not lowered: a string, not an Error\n",
  ]);
});

test("a download is moved into place again while Windows holds it for a scan, and not for any other error", async () => {
  const waited: number[] = [];
  const sleep = async (ms: number) => {
    waited.push(ms);
  };
  const busy = (code: string) => Object.assign(new Error(`${code}: busy`), { code });
  let failures = 2;
  const moved: string[] = [];
  await moveInto("a.part", "a", {
    sleep,
    rename: async (from, to) => {
      if (failures-- > 0) throw busy(failures === 1 ? "EPERM" : "EBUSY");
      moved.push(`${from}>${to}`);
    },
  });
  expect(moved).toEqual(["a.part>a"]);
  expect(waited).toEqual(RENAME_WAITS_MS.slice(0, 2));

  waited.length = 0;
  const never = () => Promise.reject(busy("EACCES"));
  await expect(moveInto("a.part", "a", { sleep, rename: never })).rejects.toThrow("EACCES");
  expect(waited).toEqual(RENAME_WAITS_MS);

  waited.length = 0;
  const gone = () => Promise.reject(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  await expect(moveInto("a.part", "a", { sleep, rename: gone })).rejects.toThrow("ENOENT");
  expect(waited).toEqual([]);
});

test("a finished download replaces a file already at its name", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pronounce-move-"));
  await writeFile(join(dir, "a"), "old");
  await writeFile(join(dir, "a.part"), "new");
  await moveInto(join(dir, "a.part"), join(dir, "a"));
  expect(await Bun.file(join(dir, "a")).text()).toBe("new");
  expect(await Bun.file(join(dir, "a.part")).exists()).toBe(false);
});

test("the model session names the CPU provider and no other", () => {
  const options = cpuSessionOptions(4);
  expect(options.executionProviders).toEqual(["cpu"]);
  expect(options.intraOpNumThreads).toBe(4);
});

test("a parent that is gone ends the worker even where the pid is not reparented", async () => {
  let running = true;
  let exits = 0;
  const stop = exitWhenOrphaned({
    ppid: () => 4242,
    alive: () => running,
    exit: () => exits++,
    everyMs: 1,
  });
  await Bun.sleep(5);
  expect(exits).toBe(0);
  running = false;
  await Bun.sleep(5);
  stop();
  expect(exits).toBeGreaterThan(0);
});

test("a pid that runs is told from one that does not", async () => {
  expect(pidRuns(process.pid)).toBe(true);
  const child = Bun.spawn([process.execPath, "-e", "0"], { windowsHide: true });
  await child.exited;
  expect(pidRuns(child.pid)).toBe(false);
});

test("stopping a worker twice, the second time after it is gone, throws nothing", async () => {
  const logged: string[] = [];
  const pipe = spawnWorker(
    [process.execPath, join(import.meta.dir, "fixtures", "echo-worker.ts")],
    (line) => logged.push(line),
  );
  pipe.signal("SIGTERM");
  await pipe.exited;
  expect(() => pipe.signal("SIGTERM")).not.toThrow();
  expect(() => pipe.write("late")).not.toThrow();
});
