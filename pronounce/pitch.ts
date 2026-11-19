/**
 * The pitch (F0) of 16 kHz speech by YIN (de Cheveigné and Kawahara, 2002),
 * small and on the CPU: the audio is halved to 8 kHz (pairs averaged, which
 * keeps everything under the 400 Hz the voice reaches), then every 10 ms a
 * 25 ms window is compared with itself shifted by each period from 2.5 ms
 * (400 Hz) to 16.7 ms (60 Hz). The first period whose cumulative-mean
 * normalised difference dips under `YIN_THRESHOLD` is the pitch, refined
 * between samples by a parabola; a frame with no such dip, or too quiet, is
 * unvoiced (0) and is left out of any mean.
 */

/** The rate YIN works at: the 16 kHz input halved. */
const RATE = 8000;
const HOP = 80;
const WINDOW = 200;
const MIN_HZ = 60;
const MAX_HZ = 400;
/** The normalised difference a period's dip must reach for the frame to count as voiced. */
export const YIN_THRESHOLD = 0.15;
/** Frames quieter than this RMS (of samples from -1 to 1) are unvoiced whatever YIN says: about -50 dBFS. */
const MIN_RMS = 0.003;

/** Milliseconds per pitch frame. */
export const PITCH_HOP_MS = (HOP / RATE) * 1000;

/** 16 kHz samples `from` to `to` at 8 kHz, each pair averaged. */
function halved(audio: Float32Array, from: number, to: number): Float32Array {
  const start = Math.max(0, from);
  const end = Math.min(audio.length, to);
  const out = new Float32Array(Math.max(0, Math.floor((end - start) / 2)));
  for (let i = 0; i < out.length; i++) {
    out[i] = ((audio[start + 2 * i] ?? 0) + (audio[start + 2 * i + 1] ?? 0)) / 2;
  }
  return out;
}

/** YIN's cumulative-mean normalised difference of the window of `x` at `at`, for each lag up to `maxLag`, into `diff`. */
function differences(x: Float32Array, at: number, maxLag: number, diff: Float64Array): void {
  diff[0] = 1;
  let running = 0;
  for (let lag = 1; lag <= maxLag; lag++) {
    let sum = 0;
    for (let i = 0; i < WINDOW; i++) {
      const d = (x[at + i] ?? 0) - (x[at + i + lag] ?? 0);
      sum += d * d;
    }
    running += sum;
    diff[lag] = running === 0 ? 1 : (sum * lag) / running;
  }
}

/** YIN's pitch of the window of `x` starting at `at`, in Hz; 0 when unvoiced. */
function pitchAt(x: Float32Array, at: number, diff: Float64Array): number {
  const maxLag = Math.floor(RATE / MIN_HZ);
  const minLag = Math.floor(RATE / MAX_HZ);
  let energy = 0;
  for (let i = 0; i < WINDOW; i++) energy += (x[at + i] ?? 0) ** 2;
  if (Math.sqrt(energy / WINDOW) < MIN_RMS) return 0;
  differences(x, at, maxLag, diff);
  return firstDip(diff, minLag, maxLag);
}

/** The pitch at the first dip of `diff` under `YIN_THRESHOLD` between `minLag` and `maxLag`, refined by a parabola; 0 for none. */
function firstDip(diff: Float64Array, minLag: number, maxLag: number): number {
  for (let lag = minLag; lag < maxLag; lag++) {
    if ((diff[lag] ?? 1) >= YIN_THRESHOLD) continue;
    while (lag + 1 < maxLag && (diff[lag + 1] ?? 1) < (diff[lag] ?? 1)) lag++;
    const a = diff[lag - 1] ?? 1;
    const b = diff[lag] ?? 1;
    const c = diff[lag + 1] ?? 1;
    const bend = a - 2 * b + c;
    const shift = bend === 0 ? 0 : (a - c) / (2 * bend);
    return RATE / (lag + Math.max(-1, Math.min(1, shift)));
  }
  return 0;
}

/** The pitch every `PITCH_HOP_MS` over 16 kHz samples `from` to `to` (default all), in Hz, 0 where unvoiced. */
export function pitchTrack(audio: Float32Array, from = 0, to = audio.length): Float32Array {
  const x = halved(audio, from, to);
  const maxLag = Math.floor(RATE / MIN_HZ);
  const count = Math.max(0, Math.floor((x.length - WINDOW - maxLag) / HOP) + 1);
  const track = new Float32Array(count);
  const diff = new Float64Array(maxLag + 1);
  for (let f = 0; f < count; f++) track[f] = pitchAt(x, f * HOP, diff);
  return track;
}

/**
 * The mean pitch of the voiced frames of 16 kHz samples `from` to `to`, in
 * Hz; null when none is voiced. The window reaches 41 ms past `to` (25 ms
 * plus the longest period), so a short vowel still gets a frame.
 */
export function meanPitch(audio: Float32Array, from: number, to: number): number | null {
  const reach = 2 * (WINDOW + Math.floor(RATE / MIN_HZ));
  const track = pitchTrack(audio, from, Math.max(to, from + reach));
  const end = Math.max(1, Math.floor((to - from) / 2 / HOP));
  let sum = 0;
  let voiced = 0;
  for (let f = 0; f < Math.min(track.length, end); f++) {
    const hz = track[f] ?? 0;
    if (hz <= 0) continue;
    sum += hz;
    voiced++;
  }
  return voiced === 0 ? null : sum / voiced;
}
