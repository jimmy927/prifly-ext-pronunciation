/**
 * The voice box: a GPU machine the reader runs Seed-VC on, reached over ssh.
 *
 * prifly's extension api cannot rent a box for an extension on demand: `api.onRent`
 * answers only the New session dialog's "Rent a box…" row, for a session the
 * reader is starting, and `api.machines.report` only lists boxes the extension
 * itself rents. So the box is configured: the `voiceBox` setting (an ssh
 * destination such as `root@ssh2.vast.ai`), `voiceBoxPort` and `voiceBoxKey`.
 * The first conversion puts `box/runner.py` there and has it install Seed-VC
 * and edge-tts (minutes, once); after that each clip is one ssh call per step.
 */

import { join } from "node:path";
import type { Pipeline } from "./voice";
import { decodeWav, encodeWav, type Wav } from "./wav";

/** What came of a command on the box. */
export type Ran = { code: number; out: Uint8Array; err: string };

/** A command on the box: `argv` is run through ssh with `stdin` fed to it. */
export type Exec = (argv: string[], stdin?: Uint8Array) => Promise<Ran>;

export type BoxSettings = { host: string; port: number; key: string };

/** The remote script, beside this file. */
const RUNNER_SOURCE = join(import.meta.dir, "box", "runner.py");
const RUNNER = "~/prifly-voice/runner.py";
/** What the runner exits with when the reference is not on the box. */
const NEED_REFERENCE = 3;

/** `text` as one word of a remote shell line. */
export const quoted = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`;

/** The ssh argv that runs `remote` on the box. */
export function sshArgv(box: BoxSettings, remote: string): string[] {
  return [
    "ssh",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=accept-new",
    ...(box.key === "" ? [] : ["-i", box.key, "-o", "IdentitiesOnly=yes"]),
    ...(box.port > 0 ? ["-p", String(box.port)] : []),
    box.host,
    remote,
  ];
}

/** `ssh` as a real process; a console program, so its window is hidden on Windows. */
export const spawnExec: Exec = async (argv, stdin) => {
  const child = Bun.spawn(argv, {
    stdin: stdin === undefined ? "ignore" : stdin,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { code, out: new Uint8Array(out), err };
};

export class SeedVcBox implements Pipeline {
  private readonly box: () => BoxSettings;
  private readonly exec: Exec;
  private readonly source: () => Promise<Uint8Array>;
  private ready: Promise<void> | null = null;
  private readonly known = new Set<string>();

  constructor(
    box: () => BoxSettings,
    exec: Exec = spawnExec,
    source: () => Promise<Uint8Array> = async () =>
      new Uint8Array(await Bun.file(RUNNER_SOURCE).arrayBuffer()),
  ) {
    this.box = box;
    this.exec = exec;
    this.source = source;
  }

  async read(text: string): Promise<Wav> {
    await this.setup();
    const ran = await this.run(["read"], new TextEncoder().encode(text));
    return decodeWav(ran.out);
  }

  async convert(job: Parameters<Pipeline["convert"]>[0]): Promise<Wav> {
    await this.setup();
    const reading = encodeWav(job.reading.samples, job.reading.rate);
    const args = [
      "convert",
      job.referenceKey,
      "--",
      ...job.flags,
      "--length-adjust",
      String(job.lengthAdjust),
    ];
    if (this.known.has(job.referenceKey)) {
      const ran = await this.exec(this.argv(args), reading);
      if (ran.code !== NEED_REFERENCE) return decodeWav(this.checked(ran).out);
      this.known.delete(job.referenceKey);
    }
    await this.run(
      ["put-ref", job.referenceKey],
      encodeWav(job.reference.samples, job.reference.rate),
    );
    this.known.add(job.referenceKey);
    return decodeWav((await this.run(args, reading)).out);
  }

  /** The runner put on the box and its installs done, once; a failure is tried again next time. */
  private setup(): Promise<void> {
    if (this.ready === null) {
      const task = (async () => {
        const put = await this.exec(
          sshArgv(this.box(), `mkdir -p ~/prifly-voice && cat > ${RUNNER}`),
          await this.source(),
        );
        this.checked(put);
        this.checked(await this.exec(this.argv(["setup"])));
      })();
      this.ready = task;
      task.catch(() => {
        this.ready = null;
      });
    }
    return this.ready;
  }

  private argv(args: string[]): string[] {
    return sshArgv(this.box(), `python3 ${RUNNER} ${args.map(quoted).join(" ")}`);
  }

  private async run(args: string[], stdin?: Uint8Array): Promise<Ran> {
    return this.checked(await this.exec(this.argv(args), stdin));
  }

  private checked(ran: Ran): Ran {
    if (ran.code === 0) return ran;
    const tail = ran.err.trim().split("\n").slice(-3).join(" | ");
    throw new Error(`The voice box failed (exit ${ran.code}): ${tail}`);
  }
}
