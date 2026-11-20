/**
 * The coach's busy rule (`coach.ts`): tasks run one at a time; while one runs, the newest that
 * came meanwhile waits and any older waiting one is dropped. A task that throws an `Error` is
 * logged and the next one runs.
 */

export type Task = () => Promise<void>;

type Log = (event: string, fields: Record<string, string>) => void;

export class LatestQueue {
  private readonly log: Log;
  private waiting: Task | null = null;
  private draining: Promise<void> | null = null;
  private stopped = false;

  constructor(log: Log) {
    this.log = log;
  }

  /** `task` now, or after the one running: the newest waits, an older waiting one is dropped. */
  run(task: Task): void {
    if (this.stopped) return;
    if (this.draining !== null) {
      if (this.waiting !== null) this.log("skipped", { reason: "busy" });
      this.waiting = task;
      return;
    }
    this.draining = this.drain(task);
  }

  /** Nothing more runs: the waiting task is dropped. */
  stop(): void {
    this.stopped = true;
    this.waiting = null;
  }

  /** Resolves once every task handed over so far is done. */
  async settled(): Promise<void> {
    while (this.draining !== null) await this.draining;
  }

  private async drain(first: Task): Promise<void> {
    let task: Task | null = first;
    while (task !== null && !this.stopped) {
      try {
        await task();
      } catch (caught) {
        if (!(caught instanceof Error)) throw caught;
        this.log("judgeFailed", { error: caught.message });
      }
      task = this.waiting;
      this.waiting = null;
    }
    this.draining = null;
  }
}
