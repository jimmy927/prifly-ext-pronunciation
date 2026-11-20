/**
 * Audio from one rate to another, through a Hann-windowed sinc low-pass at the lower rate's
 * Nyquist (a little under it): a recording at the microphone's 48 kHz to the 16 kHz the phoneme
 * model takes, without the aliasing that dropping samples would fold in.
 */

/** Input samples the kernel reaches on each side, at the output's rate when it is the lower. */
const HALF_TAPS = 16;
/** The pass band's edge, as a share of the lower rate's Nyquist. */
const PASS = 0.95;

/** `samples` at `from` Hz as samples at `to` Hz. */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples.slice();
  const ratio = to / from;
  const cutoff = Math.min(1, ratio) * PASS;
  const half = Math.ceil(HALF_TAPS / cutoff);
  const out = new Float32Array(Math.floor(samples.length * ratio));
  for (let i = 0; i < out.length; i++) {
    const centre = i / ratio;
    const first = Math.max(0, Math.ceil(centre - half));
    const last = Math.min(samples.length - 1, Math.floor(centre + half));
    let sum = 0;
    let weights = 0;
    for (let j = first; j <= last; j++) {
      const x = j - centre;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const window = 0.5 + 0.5 * Math.cos((Math.PI * x) / half);
      const weight = sinc * window;
      sum += (samples[j] ?? 0) * weight;
      weights += weight;
    }
    out[i] = weights === 0 ? 0 : sum / weights;
  }
  return out;
}
