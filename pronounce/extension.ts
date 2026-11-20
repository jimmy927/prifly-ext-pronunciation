/**
 * The extension put together: on enable the runner fetches the model and
 * the dictionary and starts the worker, its state on the status line; the
 * coach hears dictation and marks words, and adds each judged piece to the
 * accent profile, which the "Your accent" window shows (`accent-panel.ts`),
 * beside "Check your flags" (`flag-check.ts`), whose marks set the checks for
 * this reader (`personal.ts`); on disable the worker and any
 * download on its way are stopped. What fetches and what starts the worker
 * are handed in (`StartDeps`), so tests run it over fakes; `index.ts` hands
 * in the real ones.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionApi } from "@prifly/extension-api";
import { AccentPanel } from "./accent-panel";
import { SeedVcBox } from "./box";
import { Coach } from "./coach";
import { FlagCheck, type FlagCheckDeps } from "./flag-check";
import { ensurePronounce, priflyDataDir } from "./models";
import { loadNativeStats, type NativeStats } from "./native";
import { RECORDINGS_FOLDER, readPast, recentPieces } from "./past-pieces";
import { Personal, vowelSetting } from "./personal";
import type { OnMarkAction } from "./play-shim";
import { AccentProfile } from "./profile";
import { PronounceRunner, type RunnerDeps } from "./runner";
import { startScanWorker } from "./scan-worker";
import { statusLine } from "./status";
import { type CheckId, loadShipped, loadVowelPatterns } from "./thresholds";
import { readReference, Voice } from "./voice";
import { spawnPronounce } from "./worker-pipe";

export type StartDeps = Pick<RunnerDeps, "ensure" | "spawn" | "backoffMs"> & {
  /** The two play buttons' audio; left out, a mark has none. */
  voice?: Voice;
  /** The natives' statistics (`native.ts`); left out, `NATIVE_STATS_PATH` is read. */
  natives?: () => Promise<NativeStats | null>;
  /** Whether the confirmed-pattern vowel underlines are on (`loadVowelPatterns`); left out, `thresholds.json` is read. */
  vowelPatterns?: () => Promise<boolean>;
  /** Clock for the accent profile; tests set it. */
  now?: () => number;
  /** The reader's past dictation for "Check your flags" (`past-pieces.ts`); left out, there is none. */
  past?: Pick<FlagCheckDeps, "list" | "read">;
  /** The checks `thresholds.json` ships on (`loadShipped`); left out, the file is read. */
  shipped?: () => Promise<ReadonlySet<CheckId>>;
};

/** What the extension needs of prifly: the dictation api, 0.16 and later. */
const NEEDED = ["dictation-pieces", "dictation-marks"];

/** The settings that say where "Say it right" is made: the box's ssh address, port and key file, and the reader's own voice sample. */
export const VOICE_BOX = "voiceBox";
export const VOICE_BOX_PORT = "voiceBoxPort";
export const VOICE_BOX_KEY = "voiceBoxKey";
export const VOICE_REFERENCE = "voiceReference";

/** What "Say it right" says while no box is set. */
export const NO_BOX =
  "Say it right needs a GPU box: set its ssh address in Settings, Extensions, Pronunciation";

/** Said on the status line when prifly is too old to pass dictation to an extension. */
export const TOO_OLD = "Needs a newer prifly: this one does not pass dictation to extensions";

export type Started = {
  stop: () => void;
  runner: PronounceRunner | null;
  coach: Coach | null;
  /** The "Your accent" window's data; null when prifly is too old to dictate to the extension. */
  panel: AccentPanel | null;
};

/** The extension running on `api` with `deps`. */
export function start(api: ExtensionApi, deps: StartDeps): Started {
  const features = api.features ?? [];
  if (!NEEDED.every((name) => features.includes(name)) || api.onDictationPiece === undefined) {
    api.status?.(TOO_OLD);
    return { stop: () => undefined, runner: null, coach: null, panel: null };
  }
  const runner: PronounceRunner = new PronounceRunner({
    ...deps,
    onChange: () => api.status?.(statusLine(runner)),
    log: (event, fields) => api.log(event, fields),
  });
  let natives: NativeStats | null = null;
  const profile = new AccentProfile(api.state, () => natives, deps.now);
  const personal = new Personal(api.state);
  let patternsOn = false;
  // The reader's own settings from their marks beat thresholds.json's (`personal.ts`).
  const vowels = () => vowelSetting(personal.results(), patternsOn);
  const coach = new Coach(
    api,
    (audio, words) => runner.judge(audio, words, personal.overrides()),
    deps.voice ?? null,
    profile,
    () => vowels().on,
    () => vowels().deviate,
  );
  const sayRight = () => (String(api.settings?.[VOICE_BOX] ?? "").trim() === "" ? NO_BOX : null);
  let shipped: ReadonlySet<CheckId> = new Set();
  const flags = new FlagCheck({
    state: api.state,
    personal,
    list: deps.past?.list ?? (async () => []),
    read:
      deps.past?.read ??
      (() => Promise.reject(new Error("No past dictation is read without prifly's recordings"))),
    worker: (signal) => startScanWorker(deps, signal),
    natives: () => natives,
    shipped: () => shipped,
    voice: deps.voice ?? null,
    sayRight,
    ...(deps.now === undefined ? {} : { now: deps.now }),
    log: (event, fields) => api.log(event, fields),
  });
  const panel = new AccentPanel({ profile, coach, sayRight, flags });
  api.onDictationPiece((piece) => coach.piece(piece));
  api.onDictationCorrection?.((correction) => coach.correction(correction));
  // With "dictation-mark-audio" prifly plays what a click's handler resolves to.
  (api.onDictationMarkAction as OnMarkAction | undefined)?.((click) => coach.action(click));
  void coach.load();
  void profile.load();
  void personal.load();
  void flags.load();
  void (deps.shipped ?? (() => loadShipped()))().then((on) => {
    shipped = on;
  });
  const readNatives =
    deps.natives ??
    (() => loadNativeStats(undefined, (why) => api.log("nativeStatsIgnored", { why })));
  void readNatives().then((stats) => {
    natives = stats;
  });
  void (deps.vowelPatterns ?? (() => loadVowelPatterns()))().then((on) => {
    patternsOn = on;
  });
  void runner.start();
  api.log("activated", {});
  return {
    stop: () => {
      flags.cancel();
      coach.stop();
      runner.stop();
    },
    runner,
    coach,
    panel,
  };
}

/**
 * The user's home as prifly's host reads it (`platform/data-dir.ts` there):
 * `HOME` on POSIX, the profile folder on Windows, where `HOME` is usually
 * unset and a Git Bash or MSYS shell sets it to a path of its own.
 */
export function userHome(
  platform: NodeJS.Platform = process.platform,
  env: Record<string, string | undefined> = process.env,
  home: () => string = homedir,
): string {
  const set = env["HOME"];
  return platform !== "win32" && set !== undefined && set !== "" ? set : home();
}

/** The real deps: the files under prifly's data folder, the worker a process of its own. */
export function realDeps(api: Pick<ExtensionApi, "log" | "settings">): StartDeps {
  const data = priflyDataDir(process.platform, process.env, userHome());
  const text = (id: string) => String(api.settings?.[id] ?? "").trim();
  const box = new SeedVcBox(() => ({
    host: text(VOICE_BOX),
    port: Number(api.settings?.[VOICE_BOX_PORT] ?? 0),
    key: text(VOICE_BOX_KEY),
  }));
  const voice = new Voice({
    dir: join(data, "pronunciation", "voice"),
    pipeline: () => (text(VOICE_BOX) === "" ? NO_BOX : box),
    referenceFile: async () =>
      text(VOICE_REFERENCE) === "" ? null : readReference(text(VOICE_REFERENCE)),
    log: (event, fields) => api.log(event, fields),
  });
  const recordings = join(data, RECORDINGS_FOLDER);
  return {
    voice,
    past: { list: (limit) => recentPieces(recordings, limit), read: readPast },
    ensure: (progress, signal) => ensurePronounce(data, progress, { signal }),
    spawn: (args) =>
      spawnPronounce(args, (line) => api.log("worker", { line: line.slice(0, 500) })),
  };
}
