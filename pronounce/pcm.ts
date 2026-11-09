/** A piece's audio as it is carried in the lines to the worker: float32 samples, base64. */

/** A copy of the bytes of a base64 string, which sits at any offset in Bun's shared pool. */
function bytesOf(base64: string): ArrayBuffer {
  const bytes = Buffer.from(base64, "base64");
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

export function encodeFloats(samples: Float32Array): string {
  return Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).toString("base64");
}

export function decodeFloats(pcm: string): Float32Array {
  return new Float32Array(bytesOf(pcm));
}
