/**
 * The extension put together: on enable the runner fetches the model and
 * the dictionary and starts the worker, its state on the status line; the
 * coach hears dictation and marks words; on disable the worker and any
 * download on its way are stopped. What fetches and what starts the worker
 * are handed in (`StartDeps`), so tests run it over fakes; `index.ts` hands
 * in the real ones.
 */

import { homedir } from "node:os";
import type { ExtensionApi } from "@prifly/extension-api";
import { Coach } from "./coach";
import { ensurePronounce, priflyDataDir } from "./models";
import { PronounceRunner, type RunnerDeps } from "./runner";
import { statusLine } from "./status";
import { spawnPronounce } from "./worker-pipe";

export type StartDeps = Pick<RunnerDeps, "ensure" | "spawn" | "backoffMs">;

/** What the extension needs of prifly: the dictation api, 0.16 and later. */
const NEEDED = ["dictation-pieces", "dictation-marks"];

/** Said on the status line when prifly is too old to pass dictation to an extension. */
export const TOO_OLD = "Needs a newer prifly: this one does not pass dictation to extensions";

export type Started = { stop: () => void; runner: PronounceRunner | null; coach: Coach | null };

/** The extension running on `api` with `deps`. */
export function start(api: ExtensionApi, deps: StartDeps): Started {
  const features = api.features ?? [];
  if (!NEEDED.every((name) => features.includes(name)) || api.onDictationPiece === undefined) {
    api.status?.(TOO_OLD);
    return { stop: () => undefined, runner: null, coach: null };
  }
  const runner: PronounceRunner = new PronounceRunner({
    ...deps,
    onChange: () => api.status?.(statusLine(runner)),
    log: (event, fields) => api.log(event, fields),
  });
  const coach = new Coach(api, (audio, words) => runner.judge(audio, words));
  api.onDictationPiece((piece) => coach.piece(piece));
  api.onDictationCorrection?.((correction) => coach.correction(correction));
  api.onDictationMarkAction?.((click) => coach.action(click));
  void coach.load();
  void runner.start();
  api.log("activated", {});
  return {
    stop: () => {
      coach.stop();
      runner.stop();
    },
    runner,
    coach,
  };
}

/** The user's home as prifly's host reads it: `HOME` on POSIX, the profile folder on Windows. */
function userHome(): string {
  const env = process.env["HOME"];
  return process.platform !== "win32" && env !== undefined && env !== "" ? env : homedir();
}

/** The real deps: the files under prifly's data folder, the worker a process of its own. */
export function realDeps(api: Pick<ExtensionApi, "log">): StartDeps {
  const data = priflyDataDir(process.platform, process.env, userHome());
  return {
    ensure: (progress, signal) => ensurePronounce(data, progress, { signal }),
    spawn: (args) =>
      spawnPronounce(args, (line) => api.log("worker", { line: line.slice(0, 500) })),
  };
}
