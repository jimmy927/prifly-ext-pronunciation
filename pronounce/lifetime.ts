/**
 * The worker lives only as long as the prifly host that started it. Two ways
 * it learns the host is gone, because either alone has failed in prifly's
 * own speech workers:
 *
 * - its stdin ends (`serve.ts` stops reading and the worker exits), as it
 *   does when the host closes the pipe or dies — unless the write end was
 *   inherited by another child and so never closes;
 * - its parent process changes: `process.ppid` is the host's while the host
 *   lives, and the init process's (or a subreaper's) once it is gone.
 *
 * Without them a worker outlives a killed host holding a gigabyte of memory.
 */

export type Orphan = {
  /** The parent's pid now. */
  ppid?: () => number;
  /** What to do when it has changed: exit. */
  exit?: () => void;
  /** Milliseconds between looks. */
  everyMs?: number;
};

/** Exit when the parent is no longer the one that started this worker; the timer never keeps it alive. */
export function exitWhenOrphaned(options: Orphan = {}): () => void {
  const ppid = options.ppid ?? (() => process.ppid);
  const exit = options.exit ?? (() => process.exit(0));
  const parent = ppid();
  const timer = setInterval(() => {
    if (ppid() !== parent) exit();
  }, options.everyMs ?? 1000);
  timer.unref();
  return () => clearInterval(timer);
}
