/**
 * The worker lives only as long as the prifly host that started it. Two ways
 * it learns the host is gone, because either alone has failed in prifly's
 * own speech workers:
 *
 * - its stdin ends (`serve.ts` stops reading and the worker exits), as it
 *   does when the host closes the pipe or dies — unless the write end was
 *   inherited by another child and so never closes;
 * - its parent process changes or is gone: `process.ppid` is the host's while
 *   the host lives, and the init process's (or a subreaper's) once it is gone
 *   on Linux and macOS. Windows does not reparent a child, so `ppid` keeps
 *   naming the dead host; there the worker also asks whether that pid still
 *   runs (`process.kill(pid, 0)`).
 *
 * Without them a worker outlives a killed host holding a gigabyte of memory.
 */

export type Orphan = {
  /** The parent's pid now. */
  ppid?: () => number;
  /** Whether the process with this pid still runs. */
  alive?: (pid: number) => boolean;
  /** What to do when it has changed or is gone: exit. */
  exit?: () => void;
  /** Milliseconds between looks. */
  everyMs?: number;
};

/** Whether `pid` runs: only "no such process" says no, so a process we may not signal counts as running. */
export function pidRuns(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (caught) {
    return !(caught instanceof Error && "code" in caught && caught.code === "ESRCH");
  }
}

/** Exit when the parent is no longer the one that started this worker; the timer never keeps it alive. */
export function exitWhenOrphaned(options: Orphan = {}): () => void {
  const ppid = options.ppid ?? (() => process.ppid);
  const alive = options.alive ?? pidRuns;
  const exit = options.exit ?? (() => process.exit(0));
  const parent = ppid();
  const timer = setInterval(() => {
    if (ppid() !== parent || !alive(parent)) exit();
  }, options.everyMs ?? 1000);
  timer.unref();
  return () => clearInterval(timer);
}
