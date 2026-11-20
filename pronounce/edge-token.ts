/**
 * The Sec-MS-GEC token Edge's read-aloud service asks of every connection (`edge-tts.ts`), as
 * the edge-tts Python package (7.3.1, `drm.py`) makes it: a SHA-256 resumed from a midstate the
 * package ships, of the time in Windows ticks rounded down to five minutes and the client token,
 * plus a CS64 digest of the same, as "<16 hex>-<64 hex>". Ported line for line with 32-bit
 * arithmetic; `test/edge-tts.test.ts` checks it against the package's own output.
 */

export const TRUSTED_CLIENT_TOKEN = "6A5AA1D4EAFF4E9FB37E23D68491D6F4";
const WIN_EPOCH = 11_644_473_600;

const K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const INITIAL = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
];
/** The package's midstate after 14 rounds of its first block, and that block's schedule words 16 to 29. */
const STATE = [
  0xfd9fbea2, 0x91243ce7, 0xbe499094, 0xcd2e1e0a, 0x6c006f49, 0x04bd35ab, 0xfeb0a7e4, 0x03effbd2,
];
const SCHEDULE = [
  0xeb24bf9e, 0x1558691f, 0xa0c09ee2, 0x0cfa32ba, 0xa622ee8c, 0xd1dd9491, 0xc0dd25a0, 0xf9e70ab6,
  0xf0c31573, 0x7058ce4e, 0x7188e606, 0x00e5ab33, 0xd258b060, 0x72766564,
];
const ADJUSTMENT = 0xc9dc06a7;
const BLOCK_K = [...K.slice(0, 14), ADJUSTMENT, ...K.slice(15)];
const SIGMA0_ADJUSTMENT = 0x059c0b80;
const SIGMA1_ADJUSTMENT = 0x000b92c0;
const CS64: readonly (readonly [number, number])[] = [
  [0xe82e91b1, 0xb32700d0],
  [0x44de24c6, 0x88dff51d],
  [0x3beb65bc, 0x29514038],
  [0xc89c5933, 0xb328cbdf],
  [0x8d1ec211, 0xd405b4d5],
  [0x314ef5d5, 0x26e55f3c],
  [0xe92491b1, 0x607801c6],
  [0xf0a5b9d5, 0x82b2c1fb],
  [0x06064cf3, 0xfa51a3da],
  [0xda79fa60, 0x207cc464],
  [0xbed20560, 0x3c3c74f3],
  [0x89f9c9f8, 0xd2d14b61],
  [0x35fa38c6, 0xbb04a2c1],
  [0xcb49e3c6, 0xc5626167],
];
const CS64_FACTOR = 0x82893933;
const CS64_ADJUSTMENT0 = 0xf2f90b1a;
const CS64_ADJUSTMENT1 = 0x0b1a0000;

const u32 = (value: number) => value >>> 0;
const rotr = (value: number, by: number) => u32((value >>> by) | (value << (32 - by)));
const rol16 = (value: number) => rotr(value, 16);
const mul = (a: number, b: number) => u32(Math.imul(a, b));
const sigma0 = (v: number) => u32(rotr(v, 7) ^ rotr(v, 18) ^ (v >>> 3));
const sigma1 = (v: number) => u32(rotr(v, 17) ^ rotr(v, 19) ^ (v >>> 10));
const at = (list: readonly number[], index: number) => list[index] ?? 0;

function expand(words: number[], first: number): void {
  for (let i = first; i < 64; i++) {
    words.push(
      u32(
        sigma1(at(words, i - 2)) + at(words, i - 7) + sigma0(at(words, i - 15)) + at(words, i - 16),
      ),
    );
  }
}

function rounds(state: readonly number[], words: readonly number[], first: number): number[] {
  const constants = first === 14 ? BLOCK_K : K;
  let [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = state;
  for (let i = first; i < 64; i++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = u32(h + s1 + ch + at(constants, i) + at(words, i));
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) | (c & (a | b));
    const t2 = u32(s0 + maj);
    [h, g, f, e, d, c, b, a] = [g, f, e, u32(d + t1), c, b, a, u32(t1 + t2)];
  }
  return [a, b, c, d, e, f, g, h];
}

const added = (x: readonly number[], y: readonly number[]) =>
  x.map((one, i) => u32(one + at(y, i)));

/** Schedule word `i` (16 to 29) of the first block, from the shipped words and the known ones. */
function midWord(words: readonly number[], i: number): number {
  let value = at(SCHEDULE, i - 16);
  if (i - 2 >= 14) {
    const s = sigma1(at(words, i - 2));
    value += i === 16 ? u32(s ^ SIGMA1_ADJUSTMENT) : s;
  }
  if (i - 7 >= 14) value += at(words, i - 7);
  if (i - 15 >= 14) {
    const s = sigma0(at(words, i - 15));
    value += i === 29 ? u32(s ^ SIGMA0_ADJUSTMENT) : s;
  }
  return u32(value);
}

function midstate(head: Uint8Array): number[] {
  const words = [...new Array<number>(14).fill(0)];
  words.push(((head[0] ?? 0) << 16) | ((head[1] ?? 0) << 8) | (head[2] ?? 0));
  words.push(new DataView(head.buffer, head.byteOffset + 3, 4).getUint32(0, false));
  for (let i = 16; i < 30; i++) words.push(midWord(words, i));
  words.push(
    u32(
      sigma1(at(words, 28)) +
        at(words, 23) +
        sigma0(at(words, 15)) +
        at(words, 14) +
        ADJUSTMENT -
        at(K, 14),
    ),
  );
  expand(words, 31);
  return added(INITIAL, rounds(STATE, words, 14));
}

function digest(data: Uint8Array): Uint8Array {
  const length = 57 + data.length;
  const pad = (((55 - length) % 64) + 64) % 64;
  const padded = new Uint8Array(data.length - 7 + 1 + pad + 8);
  padded.set(data.subarray(7));
  padded[data.length - 7] = 0x80;
  new DataView(padded.buffer).setBigUint64(padded.length - 8, BigInt(length * 8), false);
  let state = midstate(data.subarray(0, 7));
  const view = new DataView(padded.buffer);
  for (let offset = 0; offset < padded.length; offset += 64) {
    const words = Array.from({ length: 16 }, (_, i) => view.getUint32(offset + i * 4, false));
    expand(words, 16);
    state = added(state, rounds(state, words, 0));
  }
  const out = new Uint8Array(32);
  const outView = new DataView(out.buffer);
  for (const [i, word] of state.entries()) outView.setUint32(i * 4, word, false);
  return out;
}

/** `data` as little-endian 32-bit words, zero-padded to an even count. */
function evenWords(data: Uint8Array): number[] {
  const padded = new Uint8Array(Math.ceil(data.length / 4) * 4);
  padded.set(data);
  const view = new DataView(padded.buffer);
  const words = Array.from({ length: padded.length / 4 }, (_, i) => view.getUint32(i * 4, true));
  if (words.length % 2 === 1) words.push(0);
  return words;
}

function cs64(data: Uint8Array, sha: Uint8Array): [number, number] {
  const view = new DataView(sha.buffer, sha.byteOffset, 8);
  const keyA = u32(view.getUint32(0, true) | 1);
  const keyB = u32(view.getUint32(4, true) | 1);
  const factors = [mul(keyA, CS64_FACTOR), mul(keyB, CS64_FACTOR)];
  const terms = CS64.map(([coefficient], i) => mul(coefficient, at(factors, i % 2)));
  const offsets = CS64.map(([, offset]) => offset);
  const prefixed = new Uint8Array(data.length + 1);
  prefixed.set(data, 1);
  evenWords(prefixed).forEach((word, i) => {
    let term = mul(word, i % 2 === 0 ? keyA : keyB);
    let offset = mul(rol16(word), i % 2 === 0 ? 0xef0569fb : 0xc31713db);
    if (i === 0) {
      term = u32(term + mul(CS64_ADJUSTMENT0, at(factors, 0)));
      offset = u32(offset + CS64_ADJUSTMENT1);
    }
    terms.push(term);
    offsets.push(offset);
  });
  let swapAcc = 0;
  let swapLast = 0;
  let state = 0;
  let acc = 0;
  for (let i = 0; i < terms.length; i += 2) {
    const x = at(terms, i);
    const y = at(terms, i + 1);
    let q = mul(rol16(u32(at(offsets, i) + x)), 0x76f50f34);
    swapAcc = u32(swapAcc + u32(mul(rol16(q), 0xc3efea97) + q));
    q = mul(rol16(u32(at(offsets, i + 1) + y)), 0x1881ce3c);
    swapLast = u32(mul(rol16(q), 0x35bd1ec9) + q);
    swapAcc = u32(swapAcc + swapLast);
    state = u32(mul(state, keyA) + x);
    for (const factor of [0xcf98b111, 0x87085b9f, 0x12ceb96d, 0x257e1d83]) {
      state = mul(rol16(state), factor);
    }
    acc = u32(acc + state);
    let t = u32(mul(state, keyB) + y);
    t = mul(rol16(t), 0xa27416f5);
    t = mul(rol16(t), 0xd38396ff);
    state = mul(rol16(mul(rol16(t), 0x7c932b89)), 0xbfa49f69);
    acc = u32(acc + state);
  }
  return [u32(swapLast ^ state), u32(swapAcc ^ acc)];
}

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex").toUpperCase();

/** The token for the unix time `seconds` (the clock now, left out). */
export function secMsGec(seconds: number = Date.now() / 1000): string {
  let ticks = seconds + WIN_EPOCH;
  ticks -= ticks % 300;
  const data = new TextEncoder().encode(`${(ticks * 1e7).toFixed(0)}${TRUSTED_CLIENT_TOKEN}`);
  const sha = digest(data);
  const [low, high] = cs64(data, sha);
  const packed = new Uint8Array(8);
  new DataView(packed.buffer).setUint32(0, low, true);
  new DataView(packed.buffer).setUint32(4, high, true);
  return `${hex(packed)}-${hex(sha)}`;
}
