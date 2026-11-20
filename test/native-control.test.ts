import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import manifest from "../prifly-extension.json";
import { Coach } from "../pronounce/coach";
import { secMsGec } from "../pronounce/edge-token";
import { audioOf, escapeXml, floatsOfS16 } from "../pronounce/edge-tts";
import { FlagCheck } from "../pronounce/flag-check";
import type { Flag } from "../pronounce/flags";
import type { Judged, JudgeWord } from "../pronounce/judge";
import { oneAtATime } from "../pronounce/latest-queue";
import {
  NATIVE_CHECK,
  NATIVE_VOICES,
  NativeControl,
  NOT_CHECKED,
  sameFlag,
} from "../pronounce/native-control";
import { Personal } from "../pronounce/personal";
import { SENSITIVITY, SENSITIVITY_OPTIONS } from "../pronounce/sensitivity";
import { READING_RATE, Voice } from "../pronounce/voice";
import type { Wav } from "../pronounce/wav";
import { fakeState } from "./fake-api";
import { fakeDictation, THREE_AS_TREE, threeTrees } from "./fake-dictation";

/** A native reading of 0.5 s at Edge's 24 kHz, its first sample saying which voice read it. */
const readingOf = (voice: string): Wav => {
  const samples = new Float32Array(READING_RATE / 2);
  samples.fill(NATIVE_VOICES.indexOf(voice as never) === 0 ? 0.25 : -0.25);
  return { rate: READING_RATE, samples };
};

/** Which voice a judged 16 kHz clip is: the reader's is all zeros (`threeTrees`). */
const voiceOf = (audio: Float32Array) => {
  const first = audio[audio.length / 2] ?? 0;
  if (first > 0.1) return NATIVE_VOICES[0];
  return first < -0.1 ? NATIVE_VOICES[1] : "reader";
};

/** "trees" said with a final S for Z: the second word's mark, a Z check, drawn at "Like 1 in 10" only. */
const TREES_AS_TREESS: Judged = {
  ...THREE_AS_TREE,
  index: 1,
  check: "z-s",
  word: "trees",
  heard: "triːs",
  expected: "triːz",
  sound: "final Z → S",
  posterior: 0.7,
  steps: { drawn: 2, sure: 3 },
  fix: "Z said as S.",
};

type Setup = {
  /** The reader's marks; left out, "Three" and "trees". */
  reader?: Judged[];
  native?: Partial<Record<string, Judged[]>>;
  read?: (text: string, voice: string) => Promise<Wav>;
  settings?: Record<string, unknown>;
};

function setup(options: Setup = {}) {
  const fake = fakeDictation({ [SENSITIVITY]: SENSITIVITY_OPTIONS[2], ...options.settings });
  const read: string[] = [];
  const judged: { voice: string; words: readonly JudgeWord[] }[] = [];
  const control = new NativeControl({
    read:
      options.read ??
      (async (text, voice) => {
        read.push(`${voice}: ${text}`);
        return readingOf(voice);
      }),
  });
  const judge = async (audio: Float32Array, words: readonly JudgeWord[]) => {
    const voice = voiceOf(audio);
    judged.push({ voice, words });
    const reader = options.reader ?? [THREE_AS_TREE, TREES_AS_TREESS];
    const marks = voice === "reader" ? reader : options.native?.[voice];
    return { marks: marks ?? [], scores: [] };
  };
  const coach = new Coach(fake.api, judge, null, null, { control });
  return { fake, coach, read, judged };
}

const labels = (fake: ReturnType<typeof fakeDictation>) =>
  fake.marks.at(-1)?.marks.map((mark) => mark.label);
const controlLogs = (fake: ReturnType<typeof fakeDictation>) =>
  fake.logs.filter((one) => one.event === "control").map((one) => one.fields);

test("a flag a native reading of the same sentence gets too is dropped, the other kept, and the marks wait for it", async () => {
  const { fake, coach, read, judged } = setup({
    native: {
      [NATIVE_VOICES[0]]: [{ ...THREE_AS_TREE, posterior: 0.6, steps: { drawn: 2, sure: 3 } }],
    },
  });
  coach.piece(threeTrees());
  await coach.settled();
  // One marking, after the control: "Three" never drawn and taken away.
  expect(fake.marks).toHaveLength(1);
  expect(labels(fake)).toEqual(["trees"]);
  expect(read.sort()).toEqual(NATIVE_VOICES.map((voice) => `${voice}: Three trees.`).sort());
  const native = judged.find((one) => one.voice === NATIVE_VOICES[0]);
  // The reading's words are the piece's, each free to sit anywhere in its 16 kHz clip.
  expect(native?.words).toEqual([
    { word: "Three", from: 0, to: 8000 },
    { word: "trees", from: 0, to: 8000 },
  ]);
  expect(controlLogs(fake)).toEqual([{ before: 2, dropped: 1, kept: 1 }]);
});

test("either native voice dropping a flag is enough: the American reading gets Z said as S", async () => {
  const { fake, coach } = setup({ native: { [NATIVE_VOICES[1]]: [TREES_AS_TREESS] } });
  coach.piece(threeTrees());
  await coach.settled();
  expect(labels(fake)).toEqual(["Three"]);
});

test("a native flag of another check, another word or another expected sound drops nothing", async () => {
  const { fake, coach } = setup({
    native: {
      [NATIVE_VOICES[0]]: [
        { ...THREE_AS_TREE, check: "any-sound" },
        { ...THREE_AS_TREE, index: 1 },
        { ...TREES_AS_TREESS, sound: "final D → T" },
      ],
    },
  });
  coach.piece(threeTrees());
  await coach.settled();
  expect(labels(fake)).toEqual(["Three", "trees"]);
  expect(controlLogs(fake)).toEqual([{ before: 2, dropped: 0, kept: 2 }]);
});

test("with the native check off every flag is kept and no reading is asked for; switched on, the shared one goes", async () => {
  const { fake, coach, read } = setup({
    settings: { [NATIVE_CHECK]: false },
    native: { [NATIVE_VOICES[0]]: [THREE_AS_TREE] },
  });
  coach.piece(threeTrees());
  await coach.settled();
  expect(labels(fake)).toEqual(["Three", "trees"]);
  expect(read).toEqual([]);
  fake.changeSettings({ [SENSITIVITY]: SENSITIVITY_OPTIONS[2], [NATIVE_CHECK]: true });
  await until(() => controlLogs(fake).length > 0);
  await until(() => labels(fake)?.length === 1);
  expect(labels(fake)).toEqual(["trees"]);
  fake.changeSettings({ [SENSITIVITY]: SENSITIVITY_OPTIONS[2], [NATIVE_CHECK]: false });
  expect(labels(fake)).toEqual(["Three", "trees"]);
});

test("Edge unreachable: every flag is kept and its card says it was not checked", async () => {
  const { fake, coach } = setup({
    read: async () => {
      throw new Error("Edge could not be reached");
    },
  });
  coach.piece(threeTrees());
  await coach.settled();
  expect(labels(fake)).toEqual(["Three", "trees"]);
  for (const mark of fake.marks.at(-1)?.marks ?? []) {
    expect(mark.detail.endsWith(` ${NOT_CHECKED}.`)).toBe(true);
  }
  expect(controlLogs(fake)[0]).toMatchObject({ before: 2, dropped: 0, kept: 2 });
  expect(String(controlLogs(fake)[0]?.["error"])).toContain("Edge could not be reached");
});

test("a piece that draws nothing at the reader's Sensitivity is not read; a looser step reads it then", async () => {
  const { fake, coach, read } = setup({
    settings: { [SENSITIVITY]: SENSITIVITY_OPTIONS[0] },
    reader: [{ ...THREE_AS_TREE, steps: { drawn: 2, sure: 3 } }, TREES_AS_TREESS],
    native: { [NATIVE_VOICES[0]]: [TREES_AS_TREESS] },
  });
  coach.piece(threeTrees());
  await coach.settled();
  expect(fake.marks).toHaveLength(0);
  expect(read).toEqual([]);
  fake.changeSettings({ [SENSITIVITY]: SENSITIVITY_OPTIONS[2] });
  // Nothing is drawn before the reading is judged.
  expect(fake.marks).toHaveLength(0);
  await until(() => fake.marks.length > 0);
  expect(read).toHaveLength(2);
  expect(labels(fake)).toEqual(["Three"]);
});

test("the manifest's Native check setting: on by default, after Sensitivity", () => {
  const at = manifest.settings.findIndex((one) => one.id === NATIVE_CHECK);
  expect(manifest.settings[at - 1]?.id).toBe(SENSITIVITY);
  expect(manifest.settings[at]).toEqual({
    id: NATIVE_CHECK,
    label: "Native check",
    description: "Drops a flag when a native voice reading the same sentence gets it too.",
    type: "boolean",
    default: true,
  });
});

test("the same flag: word, check, and for a swap the expected sound", () => {
  const th = { index: 0, check: "th" as const, sound: "th → t" };
  expect(sameFlag(th, { ...th, sound: "th → f" })).toBe(true);
  expect(sameFlag(th, { ...th, sound: "dh → d" })).toBe(false);
  expect(sameFlag(th, { ...th, index: 1 })).toBe(false);
  const stress = { index: 2, check: "stress" as const, sound: "stress first → second" };
  expect(sameFlag(stress, { ...stress, sound: "stress second → first" })).toBe(true);
});

test("a reading is fetched once per voice and sentence, and kept on disk by the voice folder", async () => {
  const dir = await mkdtemp(join(tmpdir(), "native-"));
  try {
    const asked: string[] = [];
    const voice = new Voice({
      dir,
      pipeline: () => "no box",
      native: async (text, name) => {
        asked.push(`${name}: ${text}`);
        return readingOf(name);
      },
    });
    const first = await voice.native("Three trees.", NATIVE_VOICES[0]);
    const again = await voice.native("Three trees.", NATIVE_VOICES[0]);
    expect(asked).toEqual([`${NATIVE_VOICES[0]}: Three trees.`]);
    expect(again.rate).toBe(READING_RATE);
    expect(again.samples.length).toBe(first.samples.length);
    const wrong = new Voice({
      dir,
      pipeline: () => "no box",
      native: async () => ({ rate: 22_050, samples: new Float32Array(10) }),
    });
    await expect(wrong.native("Other.", NATIVE_VOICES[0])).rejects.toThrow("not its native");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Check your flags drops the candidates a native reading gets too and counts them per check", async () => {
  const { state } = fakeState();
  const logs: string[] = [];
  const pieceOf = {
    id: "2026-11-20/120000-d0-0",
    wav: "/rec/0.wav",
    text: "Three things.",
    words: [
      { text: "Three", start: 0, end: 5, startMs: 100, endMs: 500 },
      { text: "things", start: 6, end: 12, startMs: 500, endMs: 900 },
    ],
    rate: 48_000,
  };
  const th: Flag = { index: 0, check: "th", score: 0.9, sound: "th → t", fix: "Tongue." };
  const stressed: Flag = { ...th, index: 1, check: "stress", sound: "stress first → second" };
  const check = new FlagCheck({
    state,
    personal: new Personal(state),
    list: async () => [pieceOf],
    read: async () => ({
      full: { rate: 48_000, samples: new Float32Array(48_000) },
      audio: new Float32Array(16_000),
    }),
    worker: async () => ({
      scan: async (audio) => ({
        // Every native reading stresses "things" the same way; none says "Three" with a T.
        flags: voiceOf(audio) === "reader" ? [th, stressed] : [stressed],
        scores: [],
      }),
      stop: () => undefined,
    }),
    natives: () => null,
    switchedOn: () => new Set(),
    control: () => new NativeControl({ read: async (_text, voice) => readingOf(voice) }),
    voice: null,
    sayRight: () => null,
    log: (event) => void logs.push(event),
  });
  await check.start();
  await check.settled();
  const view = check.view();
  const stress = view.checks.find((one) => one.id === "stress");
  const thView = view.checks.find((one) => one.id === "th");
  expect(stress?.flags).toHaveLength(0);
  expect(stress?.dropped).toBe(1);
  expect(thView?.flags.map((one) => one.word)).toEqual(["Three"]);
  expect(thView?.dropped).toBe(0);
  expect(logs).toContain("control");
});

test("Check your flags keeps every candidate and says so when no native reading can be made", async () => {
  const { state } = fakeState();
  const check = new FlagCheck({
    state,
    personal: new Personal(state),
    list: async () => [
      {
        id: "p",
        wav: "/rec/0.wav",
        text: "Three.",
        words: [{ text: "Three", start: 0, end: 5, startMs: 100, endMs: 500 }],
        rate: 48_000,
      },
    ],
    read: async () => ({
      full: { rate: 48_000, samples: new Float32Array(48_000) },
      audio: new Float32Array(16_000),
    }),
    worker: async () => ({
      scan: async () => ({
        flags: [{ index: 0, check: "th", score: 0.9, sound: "th → t", fix: "Tongue." }],
        scores: [],
      }),
      stop: () => undefined,
    }),
    natives: () => null,
    switchedOn: () => new Set(),
    control: () =>
      new NativeControl({
        read: async () => {
          throw new Error("Edge could not be reached");
        },
      }),
    voice: null,
    sayRight: () => null,
    log: () => undefined,
  });
  await check.start();
  await check.settled();
  const view = check.view();
  expect(view.checks.find((one) => one.id === "th")?.flags).toHaveLength(1);
  expect(view.job.line).toBe(
    "Scored 1 sentence: 1 flag, 1 sentence not checked against a native reading",
  );
});

test("Edge's token is edge-tts 7.3.1's, and its messages and audio are read as edge-tts reads them", () => {
  // From edge_tts.drm.generate_sec_ms_gec_v2 of the same times.
  expect(secMsGec(1_700_000_000)).toBe(
    "2CD23A2CA0B2595A-F3C846C370E05F9CC83ACC5F995C5F5D87A4D0F14CE8936A0F902E64099E38A2",
  );
  expect(secMsGec(1_795_180_000.5)).toBe(
    "F0D65DD8C26217E7-7D6224387E22C1340BD0191F47C402EDD4FBD46DCC9C5AA79EC455BD2CF347E0",
  );
  expect(escapeXml(`Tom & "Jerry" <it's>`)).toBe("Tom &amp; &quot;Jerry&quot; &lt;it&apos;s&gt;");
  const header = new TextEncoder().encode("X-RequestId:1\r\nPath:audio\r\n");
  const message = new Uint8Array([0, header.length, ...header, 1, 2, 3]);
  expect([...(audioOf(message) ?? [])]).toEqual([1, 2, 3]);
  const other = new TextEncoder().encode("Path:turn.start\r\n");
  expect(audioOf(new Uint8Array([0, other.length, ...other]))).toBeNull();
  expect([...floatsOfS16(new Uint8Array([0, 0x40, 0, 0xc0]))]).toEqual([0.5, -0.5]);
});

test("the two readings are fetched side by side but judged one after another", async () => {
  const fetching: string[] = [];
  let release: () => void = () => undefined;
  const fetched = new Promise<void>((resolve) => {
    release = resolve;
  });
  const control = new NativeControl({
    read: async (_text, voice) => {
      fetching.push(voice);
      await fetched;
      return readingOf(voice);
    },
  });
  let running = 0;
  let most = 0;
  const answer = control.natives("Three trees.", ["Three", "trees"], async () => {
    running++;
    most = Math.max(most, running);
    await Bun.sleep(2);
    running--;
    return [];
  });
  await until(() => fetching.length === 2);
  release();
  expect((await answer).error).toBeNull();
  expect(most).toBe(1);
});

test("the coach's judge takes one request at a time, in order, none dropped, a failure not stopping the next", async () => {
  const order: string[] = [];
  let running = 0;
  let most = 0;
  const judge = oneAtATime(async (name: string) => {
    running++;
    most = Math.max(most, running);
    await Bun.sleep(1);
    running--;
    order.push(name);
    if (name === "b") throw new Error("b failed");
    return name;
  });
  const all = await Promise.allSettled([judge("a"), judge("b"), judge("c")]);
  expect(order).toEqual(["a", "b", "c"]);
  expect(most).toBe(1);
  expect(all.map((one) => one.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
});

test("Check your flags cancelled during a native reading counts nothing of that sentence", async () => {
  const { state } = fakeState();
  let reading = false;
  const flag: Flag = { index: 0, check: "th", score: 0.9, sound: "th → t", fix: "Tongue." };
  const check = new FlagCheck({
    state,
    personal: new Personal(state),
    list: async () => [
      {
        id: "p",
        wav: "/rec/0.wav",
        text: "Three.",
        words: [{ text: "Three", start: 0, end: 5, startMs: 100, endMs: 500 }],
        rate: 48_000,
      },
    ],
    read: async () => ({
      full: { rate: 48_000, samples: new Float32Array(48_000) },
      audio: new Float32Array(16_000),
    }),
    worker: async () => ({
      scan: async () => ({ flags: [flag], scores: [] }),
      stop: () => undefined,
    }),
    natives: () => null,
    switchedOn: () => new Set(),
    control: () =>
      new NativeControl({
        read: async (_text, voice) => {
          reading = true;
          await Bun.sleep(20);
          return readingOf(voice);
        },
      }),
    voice: null,
    sayRight: () => null,
    log: () => undefined,
  });
  await check.start();
  await until(() => reading);
  check.cancel();
  await check.settled();
  const view = check.view();
  expect(view.job.state).toBe("cancelled");
  expect(view.job.done).toBe(0);
  expect(view.checks.find((one) => one.id === "th")?.flags).toHaveLength(0);
  expect(view.checks.every((one) => one.dropped === 0)).toBe(true);
});

async function until(ready: () => boolean): Promise<void> {
  for (let tries = 0; tries < 200 && !ready(); tries++) await Bun.sleep(1);
  expect(ready()).toBe(true);
}
