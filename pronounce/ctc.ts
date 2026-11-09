/**
 * The phoneme model's output read greedily: per 20 ms frame the softmax over
 * its tokens (espeak IPA phones, `vocab.json`), the likeliest token of each
 * frame, repeats merged and the blank (`<pad>`, token 0) dropped. Each phone
 * keeps the frames it was heard in, so a word's phones are the ones inside
 * its time, and the posteriors stay for judging how sure the model was.
 */

/** Per-frame probabilities, `frames` rows of `size`, row-major. */
export type Posteriors = { frames: number; size: number; probs: Float32Array };

/** A phone heard, as the model's token `id`, over frames `from` up to `to` (exclusive). */
export type HeardToken = { id: number; token: string; from: number; to: number };

/** The tokens that are no phone: the blank and the sentence marks. */
const SPECIAL = new Set(["<pad>", "<s>", "</s>", "<unk>"]);

/** `logits` (`frames` × `size`) as probabilities, each row by its own softmax. */
export function posteriors(logits: Float32Array, frames: number, size: number): Posteriors {
  const probs = new Float32Array(frames * size);
  for (let t = 0; t < frames; t++) {
    const row = t * size;
    let max = Number.NEGATIVE_INFINITY;
    for (let k = 0; k < size; k++) max = Math.max(max, logits[row + k] ?? 0);
    let sum = 0;
    for (let k = 0; k < size; k++) {
      const e = Math.exp((logits[row + k] ?? 0) - max);
      probs[row + k] = e;
      sum += e;
    }
    for (let k = 0; k < size; k++) probs[row + k] = (probs[row + k] ?? 0) / sum;
  }
  return { frames, size, probs };
}

/** The probability of token `id` at frame `t`. */
export function probAt(post: Posteriors, t: number, id: number): number {
  return post.probs[t * post.size + id] ?? 0;
}

function argmaxAt(post: Posteriors, t: number): number {
  let best = 0;
  for (let k = 1; k < post.size; k++) if (probAt(post, t, k) > probAt(post, t, best)) best = k;
  return best;
}

/** The greedy CTC reading: every phone token heard, with its frames. */
export function greedyTokens(post: Posteriors, vocab: readonly string[]): HeardToken[] {
  const heard: HeardToken[] = [];
  let previous = -1;
  for (let t = 0; t < post.frames; t++) {
    const id = argmaxAt(post, t);
    const token = vocab[id] ?? "<unk>";
    const last = heard.at(-1);
    if (id === previous && last !== undefined && last.id === id && last.to === t) last.to = t + 1;
    else if (!SPECIAL.has(token)) heard.push({ id, token, from: t, to: t + 1 });
    previous = id;
  }
  return heard;
}
