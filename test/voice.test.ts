import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Exec, quoted, SeedVcBox, sshArgv } from "../pronounce/box";
import { Coach, KEPT_SESSIONS, NOT_A_MISTAKE, PLAY_RIGHT, PLAY_YOURS } from "../pronounce/coach";
import { type AudioFull, type FullPiece, MARK_AUDIO } from "../pronounce/play-shim";
import {
  MIN_RATE,
  PIECE_RATE,
  type Pipeline,
  READING_RATE,
  referenceFrom,
  SEED_FLAGS,
  Voice,
} from "../pronounce/voice";
import { decodeWav, encodeWav, type Wav } from "../pronounce/wav";
import { fakeDictation, THREE_AS_TREE, threeTrees } from "./fake-dictation";

const FULL_RATE = 48_000;
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const tmp = async () => {
  const dir = await mkdtemp(join(tmpdir(), "voice-test-"));
  dirs.push(dir);
  return dir;
};

const tone = (seconds: number, rate: number, amplitude = 0.5): Float32Array =>
  Float32Array.from({ length: Math.round(seconds * rate) }, (_, at) =>
    Math.fround(amplitude * Math.sin((2 * Math.PI * 440 * at) / rate)),
  );

type Fake = {
  pipeline: Pipeline;
  reads: string[];
  converts: Parameters<Pipeline["convert"]>[0][];
};

/** A pipeline that asserts nothing itself: it records, and says what it is told to (a 1 s reading at 24 kHz, a conversion at 44.1 kHz). */
function fakePipeline(readRate = READING_RATE, madeRate = 44_100): Fake {
  const reads: string[] = [];
  const converts: Fake["converts"] = [];
  return {
    reads,
    converts,
    pipeline: {
      read: async (text) => {
        reads.push(text);
        return { rate: readRate, samples: tone(1, readRate) };
      },
      convert: async (job) => {
        converts.push(job);
        return { rate: madeRate, samples: tone(0.8, madeRate) };
      },
    },
  };
}

/** A second of the piece at the device's rate, 48 kHz: "Three" (100 to 500 ms) a tone, the rest silent. */
function fullPiece(rate = 48_000): AudioFull {
  const samples = new Float32Array(rate);
  samples.set(tone(0.4, rate), rate / 10);
  return { rate, samples };
}

/** `threeTrees` as prifly 0.18 gives it: with `audioFull` unless `full` is null. */
const withFull = (patch: Partial<FullPiece>, full: AudioFull | null = fullPiece()): FullPiece => ({
  ...threeTrees(),
  ...(full === null ? {} : { audioFull: full }),
  ...patch,
});

/** A coach over `fakeDictation` that has judged "Three trees." (the first word 100 to 500 ms, silent after, the second 500 to 900 ms silent), hearing play actions when `audio`, the piece with its full-rate audio at `full`'s rate unless null. */
async function coached(voice: Voice | null, audio = true, full: AudioFull | null = fullPiece()) {
  const fake = fakeDictation();
  if (audio) fake.api.features = [...(fake.api.features ?? []), MARK_AUDIO];
  const coach = new Coach(fake.api, async () => ({ marks: [THREE_AS_TREE], scores: [] }), voice);
  const samples = new Float32Array(16_000);
  samples.set(tone(0.4, PIECE_RATE), 1600);
  coach.piece(withFull({ audio: samples }, full));
  await coach.settled();
  const click = (action: string) => ({
    sessionId: "s1",
    dict: "d1",
    piece: 0,
    markStart: 0,
    markEnd: 5,
    action,
  });
  return { fake, coach, click };
}

const voiceOver = (dir: string, fake: Fake | string) =>
  new Voice({ dir, pipeline: () => (typeof fake === "string" ? fake : fake.pipeline) });

test("the play actions are on a mark only where prifly has dictation-mark-audio", async () => {
  const dir = await tmp();
  const ids = async (voice: Voice | null, audio: boolean) =>
    (await coached(voice, audio)).fake.marks[0]?.marks[0]?.actions?.map((one) => one.id);
  const bare = async (full: AudioFull | null) =>
    (
      await coached(voiceOver(dir, fakePipeline()), true, full)
    ).fake.marks[0]?.marks[0]?.actions?.map((one) => one.id);
  // No full-rate audio, no "Yours": the 16 kHz copy is never offered, and not played up either.
  expect(await bare(null)).toEqual([NOT_A_MISTAKE, PLAY_RIGHT]);
  // Audio that is itself at 22.05 kHz or below is no full-rate audio.
  expect(await bare(fullPiece(22_050))).toEqual([NOT_A_MISTAKE, PLAY_RIGHT]);
  expect(await ids(voiceOver(dir, fakePipeline()), true)).toEqual([
    NOT_A_MISTAKE,
    PLAY_YOURS,
    PLAY_RIGHT,
  ]);
  expect(await ids(voiceOver(dir, fakePipeline()), false)).toEqual([NOT_A_MISTAKE]);
  expect(await ids(null, true)).toEqual([NOT_A_MISTAKE]);
  const played = (await coached(voiceOver(dir, fakePipeline()))).fake.marks[0]?.marks[0]?.actions;
  expect(played?.slice(1) as unknown).toEqual([
    { id: PLAY_YOURS, label: "Yours", kind: "play" },
    { id: PLAY_RIGHT, label: "Say it right", kind: "play" },
  ]);
});

test("Yours is the word's own span of the full-rate audio, at that rate", async () => {
  const { coach, click } = await coached(voiceOver(await tmp(), fakePipeline()));
  const result = await coach.action(click(PLAY_YOURS));
  const wav = decodeWav(await Bun.file((result as { audio: string }).audio).bytes());
  expect(wav.rate).toBe(FULL_RATE);
  // "Three" is 400 ms of tone: 400 ms of the wav, and loud, where "trees" next to it is silent.
  expect(wav.samples.length).toBe(0.4 * FULL_RATE);
  const middle = wav.samples.slice(2000, wav.samples.length - 2000);
  expect(Math.max(...middle)).toBeGreaterThan(0.45);
  expect(middle.filter((sample) => Math.abs(sample) < 0.001).length).toBeLessThan(
    middle.length / 10,
  );
});

test("Say it right reads the sentence at 24 kHz and converts it to the reader's clip length with the f0 flags", async () => {
  const fake = fakePipeline();
  const dir = await tmp();
  const { coach, click } = await coached(voiceOver(dir, fake));
  const result = await coach.action(click(PLAY_RIGHT));
  expect(fake.reads).toEqual(["Three trees."]);
  const [job] = fake.converts;
  expect(job?.reading.rate).toBe(READING_RATE);
  // The reader said it in 0.8 s (100 to 900 ms), the reading takes 1 s: stretched by 0.8.
  expect(job?.lengthAdjust).toBeCloseTo(0.8, 6);
  expect(job?.flags).toEqual(SEED_FLAGS);
  expect(job?.flags.join(" ")).toContain("--f0-condition True --auto-f0-adjust True");
  expect(job?.flags.join(" ")).toContain("--diffusion-steps 100 --inference-cfg-rate 0.7");
  // The voice reference is the full-rate piece, not the 16 kHz one.
  expect(job?.reference.rate).toBe(FULL_RATE);
  const wav = decodeWav(await Bun.file((result as { audio: string }).audio).bytes());
  expect(wav.rate).toBeGreaterThanOrEqual(MIN_RATE);
  expect(wav.samples.length).toBe(Math.round(0.8 * 44_100));
});

test("Say it right is made on the first click only: later clicks, and a new Voice, play the cached clip", async () => {
  const fake = fakePipeline();
  const dir = await tmp();
  const { coach, click } = await coached(voiceOver(dir, fake));
  const [one, two] = await Promise.all([
    coach.action(click(PLAY_RIGHT)),
    coach.action(click(PLAY_RIGHT)),
  ]);
  const three = await coach.action(click(PLAY_RIGHT));
  expect(fake.converts).toHaveLength(1);
  expect(two).toEqual(one);
  expect(three).toEqual(one);
  const again = await coached(voiceOver(dir, fake));
  expect(await again.coach.action(again.click(PLAY_RIGHT))).toEqual(one);
  expect(fake.converts).toHaveLength(1);
  expect((await readdir(dir)).filter((name) => name.endsWith(".part"))).toEqual([]);
});

test("no output below 44.1 kHz is ever made: a low reading or conversion is refused and leaves no file", async () => {
  for (const [readRate, madeRate] of [
    [22_050, 44_100],
    [READING_RATE, 22_050],
    [READING_RATE, 24_000],
  ] as const) {
    const dir = await tmp();
    const { coach, click } = await coached(voiceOver(dir, fakePipeline(readRate, madeRate)));
    await expect(coach.action(click(PLAY_RIGHT))).rejects.toThrow(/Hz/);
    expect(await readdir(dir)).toEqual([]);
  }
});

test("a box that is not set up says so, and the stretch stays inside what Seed-VC takes", async () => {
  const dir = await tmp();
  const none = await coached(voiceOver(dir, "Set the box"));
  await expect(none.coach.action(none.click(PLAY_RIGHT))).rejects.toThrow("Set the box");
  const fake = fakePipeline();
  fake.pipeline.read = async () => ({ rate: READING_RATE, samples: tone(10, READING_RATE) });
  const slow = await coached(voiceOver(await tmp(), fake));
  await slow.coach.action(slow.click(PLAY_RIGHT));
  expect(fake.converts[0]?.lengthAdjust).toBe(0.4);
});

test("a piece whose audio is no longer kept cannot be played", async () => {
  const fake = fakeDictation();
  fake.api.features = [...(fake.api.features ?? []), MARK_AUDIO];
  const coach = new Coach(
    fake.api,
    async () => ({ marks: [THREE_AS_TREE], scores: [] }),
    voiceOver(await tmp(), fakePipeline()),
  );
  for (let at = 0; at <= KEPT_SESSIONS; at += 1) {
    coach.piece(withFull({ sessionId: `s${at}`, audio: tone(1, PIECE_RATE) }));
    await coach.settled();
  }
  const click = (sessionId: string) => ({
    sessionId,
    dict: "d1",
    piece: 0,
    markStart: 0,
    markEnd: 5,
    action: PLAY_YOURS,
  });
  await expect(coach.action(click("s0"))).rejects.toThrow(/no longer kept/);
  expect(await coach.action(click(`s${KEPT_SESSIONS}`))).toHaveProperty("audio");
});

test("a correction's Say it right is the corrected word, as long as the reader's word was", async () => {
  const fake = fakePipeline();
  const fakeApi = fakeDictation();
  fakeApi.api.features = [...(fakeApi.api.features ?? []), MARK_AUDIO];
  const coach = new Coach(
    fakeApi.api,
    async () => ({ marks: [{ ...THREE_AS_TREE, word: "three" }], scores: [] }),
    voiceOver(await tmp(), fake),
  );
  coach.piece(withFull({ audio: tone(1, PIECE_RATE) }));
  await coach.settled();
  coach.correction({
    sessionId: "s1",
    dict: "d1",
    piece: 0,
    heard: "Three",
    word: "three",
    start: 10,
    end: 15,
  });
  await coach.settled();
  const result = await coach.action({
    sessionId: "s1",
    dict: "d1",
    piece: 0,
    at: 10,
    markStart: 0,
    markEnd: 5,
    action: PLAY_RIGHT,
  });
  expect(fake.reads).toEqual(["three"]);
  // "Three" is 400 ms of the reader's, the reading 1 s: 0.4.
  expect(fake.converts[0]?.lengthAdjust).toBeCloseTo(0.4, 6);
  expect(result).toHaveProperty("audio");
});

test("the box: the runner is put there once, the reference only when it is missing, and the flags and stretch go to Seed-VC", async () => {
  const calls: { remote: string; stdin?: Uint8Array }[] = [];
  let hasReference = false;
  const exec: Exec = async (argv, stdin) => {
    const remote = argv[argv.length - 1] ?? "";
    calls.push({ remote, ...(stdin === undefined ? {} : { stdin }) });
    if (remote.includes("'read'")) {
      return { code: 0, out: encodeWav(tone(1, READING_RATE), READING_RATE), err: "" };
    }
    if (remote.includes("'put-ref'")) {
      hasReference = true;
      return { code: 0, out: new Uint8Array(), err: "" };
    }
    if (remote.includes("'convert'")) {
      return hasReference
        ? { code: 0, out: encodeWav(tone(0.8, 44_100), 44_100), err: "" }
        : { code: 3, out: new Uint8Array(), err: "" };
    }
    return { code: 0, out: new Uint8Array(), err: "" };
  };
  const box = new SeedVcBox(
    () => ({ host: "root@box", port: 14_218, key: "/k/key" }),
    exec,
    async () => new TextEncoder().encode("runner"),
  );
  const reading = await box.read("Three trees.");
  expect(reading.rate).toBe(READING_RATE);
  const reference: Wav = { rate: MIN_RATE, samples: tone(1, MIN_RATE) };
  const made = await box.convert({
    reading,
    reference,
    referenceKey: "abc",
    lengthAdjust: 0.8,
    flags: SEED_FLAGS,
  });
  const job = { reading, reference, referenceKey: "abc", lengthAdjust: 0.8, flags: SEED_FLAGS };
  await box.convert(job);
  expect(made.rate).toBe(MIN_RATE);
  // The box lost its references (it was reset): the runner says so, and the reference goes again.
  hasReference = false;
  await box.convert(job);
  const remotes = calls.map((call) => call.remote);
  expect(remotes.filter((remote) => remote.includes("cat >"))).toHaveLength(1);
  expect(remotes.filter((remote) => remote.includes("'put-ref'"))).toHaveLength(2);
  expect(remotes.filter((remote) => remote.includes("'convert'"))).toHaveLength(4);
  const convert = remotes.find((remote) => remote.includes("'convert'")) ?? "";
  expect(convert).toContain(
    "'--' '--f0-condition' 'True' '--auto-f0-adjust' 'True' '--diffusion-steps' '100' '--inference-cfg-rate' '0.7' '--length-adjust' '0.8'",
  );
  const sent = calls.find((call) => call.remote.includes("'convert'"))?.stdin;
  expect(decodeWav(sent ?? new Uint8Array()).rate).toBe(READING_RATE);
});

test("ssh gets the host, port and key; a quote in an argument cannot end its quoting", () => {
  const argv = sshArgv({ host: "root@box", port: 2222, key: "/k" }, "echo");
  expect(argv).toContain("-p");
  expect(argv.slice(argv.indexOf("-i"), argv.indexOf("-i") + 2)).toEqual(["-i", "/k"]);
  expect(argv.slice(-2)).toEqual(["root@box", "echo"]);
  expect(sshArgv({ host: "h", port: 0, key: "" }, "x")).not.toContain("-p");
  expect(quoted("a'b")).toBe(`'a'\\''b'`);
});

test("wav: written and read back", () => {
  const samples = tone(0.1, PIECE_RATE);
  const back = decodeWav(encodeWav(samples, PIECE_RATE));
  expect(back.rate).toBe(PIECE_RATE);
  expect(back.samples.length).toBe(samples.length);
  expect(back.samples[40]).toBeCloseTo(samples[40] ?? 0, 3);
});

test("the voice reference is made of full-rate pieces only, at one rate", async () => {
  const piece = (rate: number, amplitude: number): Wav => ({
    rate,
    samples: tone(2, rate, amplitude),
  });
  expect(referenceFrom([])).toBeNull();
  // Nothing at 16 kHz or 22.05 kHz is a reference, however clean.
  expect(referenceFrom([piece(PIECE_RATE, 0.5), piece(22_050, 0.5)])).toBeNull();
  const made = referenceFrom([piece(PIECE_RATE, 0.5), piece(22_050, 0.5), piece(48_000, 0.5)]);
  expect(made?.rate).toBe(48_000);
  expect(made?.samples.length).toBe(2.5 * 48_000);
  // Pieces at another rate than the cleanest's are left out.
  const mixed = referenceFrom([piece(48_000, 0.5), piece(44_100, 0.5)]);
  expect(mixed?.rate).toBeGreaterThanOrEqual(MIN_RATE);
  expect(mixed?.samples.length).toBe(Math.round(2.5 * (mixed?.rate ?? 0)));
});

test("a Voice refuses to hand over audio at a low rate as Yours", async () => {
  const voice = voiceOver(await tmp(), fakePipeline());
  await expect(voice.yours({ rate: PIECE_RATE, samples: tone(0.2, PIECE_RATE) })).rejects.toThrow(
    /below/,
  );
});

test("with no full-rate piece kept there is no voice reference, so no Say it right is made", async () => {
  const fake = fakePipeline();
  const { coach, click } = await coached(voiceOver(await tmp(), fake), true, null);
  await expect(coach.action(click(PLAY_RIGHT))).rejects.toThrow(/reference/);
  expect(fake.converts).toEqual([]);
});
