/**
 * Requests handed to the worker and answered by id, the line it says, and
 * how long to wait before starting one that died — as prifly's own speech
 * workers do it (`dictation/worker-calls.ts` there).
 */

import type { z } from "zod";
import type { WorkerPipe } from "./worker-pipe";

/** Deaths in a row after which the worker stays down. */
export const MAX_FAILURES = 5;

/** The wait before starting the worker again after its `failures`th death in a row: 1, 2, 4 … 30 s. */
export function restartWait(failures: number): number {
  return Math.min(30_000, 1000 * 2 ** (failures - 1));
}

/** What the worker said in `schema`'s terms, or null for a line that is no message — a native library printing to stdout. */
export function readLine<T>(schema: z.ZodType<T>, line: string): T | null {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch (caught) {
    if (caught instanceof SyntaxError) return null;
    throw caught;
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? parsed.data : null;
}

/** Requests handed to the worker and not yet answered. */
export class PendingCalls<T> {
  private readonly pending = new Map<string, (value: T | null) => void>();
  private nextId = 0;

  /** The answer to `request`, made for a new id: null when the worker could not answer it or died with it. */
  ask(pipe: WorkerPipe, request: (id: string) => object): Promise<T | null> {
    const id = String(++this.nextId);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      pipe.write(JSON.stringify(request(id)));
    });
  }

  answer(id: string, value: T | null): void {
    const resolve = this.pending.get(id);
    this.pending.delete(id);
    resolve?.(value);
  }

  /** Answer everything on its way with null: the worker is gone. */
  dropAll(): void {
    for (const resolve of this.pending.values()) resolve(null);
    this.pending.clear();
  }
}
