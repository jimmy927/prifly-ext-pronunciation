import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readPast, recentPieces } from "../pronounce/past-pieces";
import { resample } from "../pronounce/resample";
import { encodeWav } from "../pronounce/wav";

/** A piece as prifly's host keeps it: `<day>/<name>.json` and its wav. */
async function keep(
  folder: string,
  day: string,
  name: string,
  patch: { language?: string; rate?: number; source?: string; words?: boolean; wav?: boolean } = {},
) {
  const rate = patch.rate ?? 48_000;
  await mkdir(join(folder, day), { recursive: true });
  const sidecar = {
    dict: "d",
    piece: 0,
    sessionId: "s",
    at: `${day}T12:00:00+01:00`,
    language: patch.language ?? "en",
    engine: "parakeet",
    text: "Three trees.",
    ...(patch.words === false
      ? {}
      : { words: [{ text: "Three", start: 0, end: 5, startMs: 100, endMs: 500 }] }),
    boosted: [],
    audio: {
      file: `${name}.wav`,
      rate,
      bits: 24,
      samples: rate,
      seconds: 1,
      source: patch.source ?? "raw",
    },
  };
  await writeFile(join(folder, day, `${name}.json`), JSON.stringify(sidecar));
  if (patch.wav !== false) {
    await writeFile(join(folder, day, `${name}.wav`), encodeWav(new Float32Array(rate / 10), rate));
  }
}

test("the newest English pieces with words and full-rate audio, newest first, up to the limit", async () => {
  const folder = await mkdtemp(join(tmpdir(), "recordings-"));
  await keep(folder, "2026-11-19", "090000-a-0");
  await keep(folder, "2026-11-20", "080000-b-0");
  await keep(folder, "2026-11-20", "080000-b-1", { language: "en-GB" });
  await keep(folder, "2026-11-20", "090000-c-0", { language: "sv" });
  await keep(folder, "2026-11-20", "091000-d-0", { rate: 16_000, source: "dictation" });
  await keep(folder, "2026-11-20", "092000-e-0", { words: false });
  await keep(folder, "2026-11-20", "093000-f-0", { wav: false });
  await writeFile(join(folder, "2026-11-20", "080000-b.sent.json"), "{}");
  await writeFile(join(folder, "2026-11-20", "094000-g-0.json"), "{ half written");
  await mkdir(join(folder, "not-a-day"));

  const all = await recentPieces(folder, 10);
  expect(all.map((one) => one.id)).toEqual([
    "2026-11-20/080000-b-1",
    "2026-11-20/080000-b-0",
    "2026-11-19/090000-a-0",
  ]);
  expect(all[0]).toEqual({
    id: "2026-11-20/080000-b-1",
    wav: join(folder, "2026-11-20", "080000-b-1.wav"),
    text: "Three trees.",
    words: [{ text: "Three", start: 0, end: 5, startMs: 100, endMs: 500 }],
    rate: 48_000,
  });
  expect((await recentPieces(folder, 2)).map((one) => one.id)).toHaveLength(2);
  expect(await recentPieces(join(folder, "none"), 10)).toEqual([]);

  const { full, audio } = await readPast(all[0]?.wav ?? "");
  expect(full.rate).toBe(48_000);
  expect(full.samples).toHaveLength(4800);
  expect(audio).toHaveLength(1600);
});

test("audio to 16 kHz keeps a low tone and takes away what 16 kHz cannot hold", () => {
  const rate = 48_000;
  const tone = (hz: number) =>
    new Float32Array(rate).map((_, at) => Math.sin((2 * Math.PI * hz * at) / rate));
  const rms = (samples: Float32Array) =>
    Math.sqrt(samples.slice(200, -200).reduce((sum, x) => sum + x * x, 0) / (samples.length - 400));
  const low = resample(tone(440), rate, 16_000);
  expect(low).toHaveLength(16_000);
  expect(rms(low)).toBeCloseTo(Math.SQRT1_2, 1);
  // 12 kHz folds to 4 kHz when samples are only dropped; filtered, it is all but gone.
  expect(rms(resample(tone(12_000), rate, 16_000))).toBeLessThan(0.02);
  const same = new Float32Array([0.1, 0.2]);
  expect(resample(same, 16_000, 16_000)).toEqual(same);
});
