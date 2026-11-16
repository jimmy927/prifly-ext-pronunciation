/** Mono wav files: written 16-bit, read as 16-, 24- or 32-bit PCM or 32-bit float, and resampled up. */

export type Wav = { rate: number; samples: Float32Array };

/** `samples` (-1 to 1) as a 16-bit mono wav at `rate`. */
export function encodeWav(samples: Float32Array, rate: number): Buffer {
  const out = Buffer.alloc(44 + samples.length * 2);
  out.write("RIFF", 0, "ascii");
  out.writeUInt32LE(36 + samples.length * 2, 4);
  out.write("WAVEfmt ", 8, "ascii");
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(1, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * 2, 28);
  out.writeUInt16LE(2, 32);
  out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii");
  out.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((sample, at) => {
    const clipped = Math.max(-1, Math.min(1, sample));
    out.writeInt16LE(Math.round(clipped * (clipped < 0 ? 32768 : 32767)), 44 + at * 2);
  });
  return out;
}

/** A wav's rate and its first channel; throws on anything that is not PCM or float. */
export function decodeWav(bytes: Uint8Array): Wav {
  const data = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a wav file");
  }
  let format = { tag: 0, channels: 1, rate: 0, bits: 16 };
  let at = 12;
  while (at + 8 <= data.length) {
    const id = data.toString("ascii", at, at + 4);
    const size = data.readUInt32LE(at + 4);
    const body = at + 8;
    if (id === "fmt ") {
      format = {
        tag: data.readUInt16LE(body),
        channels: data.readUInt16LE(body + 2),
        rate: data.readUInt32LE(body + 4),
        bits: data.readUInt16LE(body + 14),
      };
    } else if (id === "data") {
      const end = Math.min(data.length, body + size);
      return { rate: format.rate, samples: samplesOf(data, body, end, format) };
    }
    at = body + size + (size % 2);
  }
  throw new Error("A wav file without audio");
}

function samplesOf(
  data: Buffer,
  from: number,
  end: number,
  format: { tag: number; channels: number; bits: number },
): Float32Array {
  const width = format.bits / 8;
  const frame = width * format.channels;
  const out = new Float32Array(Math.floor((end - from) / frame));
  for (let i = 0; i < out.length; i += 1) {
    const at = from + i * frame;
    if (format.tag === 3 && format.bits === 32) out[i] = data.readFloatLE(at);
    else if (format.tag === 1 && format.bits === 16) out[i] = data.readInt16LE(at) / 32768;
    else if (format.tag === 1 && format.bits === 24) out[i] = data.readIntLE(at, 3) / 8_388_608;
    else if (format.tag === 1 && format.bits === 32) out[i] = data.readInt32LE(at) / 2_147_483_648;
    else throw new Error(`A wav of format ${format.tag} at ${format.bits} bits is not read`);
  }
  return out;
}

/** Seconds of audio. */
export const secondsOf = (wav: Wav): number => wav.samples.length / wav.rate;

const SINC_HALF_WIDTH = 16;

/** `samples` from `from` Hz up to `to` Hz, by a Hann-windowed sinc; never down. */
export function resampleUp(samples: Float32Array, from: number, to: number): Float32Array {
  if (to < from) throw new Error(`Refusing to resample down, ${from} Hz to ${to} Hz`);
  if (to === from) return samples;
  const out = new Float32Array(Math.floor((samples.length * to) / from));
  const step = from / to;
  for (let i = 0; i < out.length; i += 1) {
    const centre = i * step;
    const first = Math.ceil(centre - SINC_HALF_WIDTH);
    let sum = 0;
    for (let j = first; j <= centre + SINC_HALF_WIDTH; j += 1) {
      const sample = samples[j];
      if (sample === undefined) continue;
      const x = j - centre;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      sum += sample * sinc * (0.5 + 0.5 * Math.cos((Math.PI * x) / (SINC_HALF_WIDTH + 1)));
    }
    out[i] = sum;
  }
  return out;
}
