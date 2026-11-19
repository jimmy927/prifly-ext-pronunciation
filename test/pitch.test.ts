import { expect, test } from "bun:test";
import { meanPitch, PITCH_HOP_MS, pitchTrack } from "../pronounce/pitch";

const RATE = 16_000;

/** A voice-like tone: `hz` with two weaker harmonics, `seconds` long, the frequency moving to `endHz`. */
function voice(hz: number, seconds: number, endHz = hz): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const f = hz + ((endHz - hz) * i) / out.length;
    phase += (2 * Math.PI * f) / RATE;
    out[i] = 0.3 * Math.sin(phase) + 0.15 * Math.sin(2 * phase) + 0.08 * Math.sin(3 * phase);
  }
  return out;
}

/** Noise from a fixed seed, so the test is the same every run. */
function noise(seconds: number): Float32Array {
  let seed = 12345;
  return Float32Array.from({ length: Math.round(seconds * RATE) }, () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return (seed / 2147483648 - 0.5) * 0.4;
  });
}

test("a steady voice's pitch is found within 2%, low and high", () => {
  for (const hz of [90, 150, 220, 330]) {
    const found = meanPitch(voice(hz, 0.3), 0, 0.3 * RATE);
    expect(Math.abs((found ?? 0) - hz) / hz).toBeLessThan(0.02);
  }
});

test("a rising voice's track rises, one frame every 10 ms", () => {
  expect(PITCH_HOP_MS).toBe(10);
  const track = [...pitchTrack(voice(120, 0.5, 240))].filter((hz) => hz > 0);
  expect(track.length).toBeGreaterThan(30);
  expect(track[0] ?? 0).toBeLessThan(140);
  expect(track.at(-1) ?? 0).toBeGreaterThan(200);
});

test("silence and noise are unvoiced and left out of the mean", () => {
  expect(meanPitch(new Float32Array(RATE / 2), 0, RATE / 2)).toBeNull();
  const track = [...pitchTrack(noise(0.5))];
  expect(track.filter((hz) => hz > 0).length).toBeLessThan(track.length * 0.2);
  // A vowel of voice after silence: only its voiced frames count.
  const both = new Float32Array(RATE / 2);
  both.set(voice(200, 0.25), RATE / 4);
  expect(Math.abs((meanPitch(both, 0, RATE / 2) ?? 0) - 200)).toBeLessThan(4);
});

test("a vowel shorter than a pitch window still gets a pitch", () => {
  const audio = voice(180, 0.2);
  expect(Math.abs((meanPitch(audio, 0, 0.04 * RATE) ?? 0) - 180)).toBeLessThan(4);
});
