/**
 * Goodness of pronunciation of each aligned phone (`force-align.ts`), and
 * what a vowel's stress is heard by:
 *
 * - `phoneScore`: over the phone's frames, the mean log posterior of the
 *   phone itself (`lp`, every token that is the same sound summed, as the
 *   alignment scores it), the best other token's (`competitor`,
 *   `lpCompetitor`; the blank and the sentence marks are no competitor), and
 *   their difference, the log posterior ratio (`lpr`): near 0 or above when
 *   the phone was said, well below when another sound won.
 * - `stressCues`: a vowel's length, loudness (RMS of its 16 kHz samples, in
 *   dB) and mean pitch (`pitch.ts`, unvoiced frames left out), over the
 *   stretch the phone owns (`ownedSpans`), not its aligned frames: CTC's
 *   posteriors are peaky, so the alignment gives most phones one frame
 *   (20 ms) with blanks around it, whatever their real length. LPR stays on
 *   the aligned (peak) frames, where the model said what it heard.
 *
 * These are what `tools/calibrate` measures on native speech; nothing here
 * decides anything.
 */

import { type Posteriors, SPECIAL } from "./ctc";
import type { AlignedPhone, AlignedWord, PhoneSet } from "./force-align";
import { SAMPLES_PER_FRAME } from "./judge";
import { meanPitch } from "./pitch";

/** The least probability a token is given at a frame, so its log stays finite (as the alignment floors it). */
const FLOOR = 1e-8;
/** Milliseconds per model frame. */
const FRAME_MS = 20;
/** How many of the likeliest tokens `phoneScore` lists. */
const TOP = 3;

export type PhoneScore = {
  phone: string;
  from: number;
  to: number;
  lp: number;
  competitor: string;
  lpCompetitor: number;
  lpr: number;
  /** The likeliest tokens over the phone's frames, by mean log posterior, the blank left out. */
  top: [string, number][];
};

const logOf = (p: number) => Math.log(Math.max(FLOOR, Math.min(1, p)));

/** The mean log posterior over frames `from` to `to` of the tokens `own` together, and of every token alone. */
function meanLogs(
  post: Posteriors,
  own: Int32Array,
  from: number,
  to: number,
): { lp: number; means: Float64Array } {
  const span = Math.max(1, to - from);
  const means = new Float64Array(post.size);
  let lp = 0;
  for (let t = from; t < to; t++) {
    const row = t * post.size;
    let sum = 0;
    for (const id of own) sum += post.probs[row + id] ?? 0;
    lp += logOf(sum);
    for (let k = 0; k < post.size; k++)
      means[k] = (means[k] ?? 0) + logOf(post.probs[row + k] ?? 0);
  }
  return { lp: lp / span, means: means.map((sum) => sum / span) };
}

/** `phone`'s goodness over its frames in `post`. */
export function phoneScore(post: Posteriors, set: PhoneSet, phone: AlignedPhone): PhoneScore {
  const from = Math.max(0, phone.from);
  const to = Math.min(post.frames, Math.max(phone.to, from + 1));
  const own = set.idsOf(phone.phone);
  const { lp, means } = meanLogs(post, own, from, to);
  const ids = Array.from(means.keys()).filter((k) => !SPECIAL.has(set.tokens[k] ?? ""));
  const rivals = ids.filter((k) => !own.includes(k));
  const best = rivals.reduce(
    (a, b) => ((means[b] ?? 0) > (means[a] ?? 0) ? b : a),
    rivals[0] ?? -1,
  );
  const competitor = set.tokens[best] ?? "";
  const lpCompetitor = means[best] ?? logOf(0);
  const ranked = ids
    .map((k): [string, number] => [set.tokens[k] ?? "", means[k] ?? 0])
    .sort((a, b) => b[1] - a[1]);
  return {
    phone: phone.phone,
    from,
    to,
    lp,
    competitor,
    lpCompetitor,
    lpr: lp - lpCompetitor,
    top: ranked.slice(0, TOP),
  };
}

/** Frames `from` up to `to`; halves where a run of blanks is split between two phones. */
export type Span = { from: number; to: number };

/** The most frames of blank a phone at a word's edge takes beside its word: 100 ms, so a pause is not counted as the phone. */
export const EDGE_FRAMES = 5;

/**
 * The stretch each aligned phone of each word owns, in the words' order
 * (none for a word not aligned): its own frames, and each run of blanks
 * beside it split half and half with the phone on the other side, so
 * neighbouring phones' stretches meet and never overlap. At a word's edge
 * the phone takes its half of the blanks to the next word's phone, or all
 * of them at the piece's start or end, at most `EDGE_FRAMES`.
 */
export function ownedSpans(words: readonly (AlignedWord | null)[], frames: number): Span[][] {
  const flat = words.flatMap((word, w) => (word?.phones ?? []).map((phone) => ({ w, phone })));
  const out: Span[][] = words.map(() => []);
  flat.forEach(({ w, phone }, k) => {
    const prev = flat[k - 1];
    const next = flat[k + 1];
    const before = Math.max(0, phone.from - (prev?.phone.to ?? 0));
    const after = Math.max(0, (next?.phone.from ?? frames) - phone.to);
    const edge = (gap: number, shared: boolean) => Math.min(EDGE_FRAMES, shared ? gap / 2 : gap);
    const left = prev?.w === w ? before / 2 : edge(before, prev !== undefined);
    const right = next?.w === w ? after / 2 : edge(after, next !== undefined);
    out[w]?.push({ from: phone.from - left, to: phone.to + right });
  });
  return out;
}

export type StressCues = { durationMs: number; rmsDb: number; f0Hz: number | null };

/** A vowel's length, loudness and pitch over `span` (its `ownedSpans` stretch), from the 16 kHz `audio`. */
export function stressCues(audio: Float32Array, span: Span): StressCues {
  const from = Math.max(0, Math.round(span.from * SAMPLES_PER_FRAME));
  const to = Math.min(audio.length, Math.round(span.to * SAMPLES_PER_FRAME));
  let energy = 0;
  for (let i = from; i < to; i++) energy += (audio[i] ?? 0) ** 2;
  const rms = to > from ? Math.sqrt(energy / (to - from)) : 0;
  return {
    durationMs: Math.max(0, span.to - span.from) * FRAME_MS,
    rmsDb: 20 * Math.log10(Math.max(1e-6, rms)),
    f0Hz: to > from ? meanPitch(audio, from, to) : null,
  };
}
