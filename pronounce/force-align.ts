/**
 * Where each word and each of its phones sits in a piece, by CTC forced
 * (Viterbi) alignment of the whole sentence over the model's posteriors
 * (`ctc.ts`): the words in order, each as one of its pronunciations, a blank
 * allowed between any two phones. Parakeet's word times are off by up to
 * 440 ms, so they only bound where a word may go (`from`/`to`, widened by
 * `WINDOW_FRAMES`); within that, the audio decides.
 *
 * - A word's pronunciations are alternatives in one graph: the path takes the
 *   one the audio fits best, word by word, in a single pass.
 * - A phone always gets at least one frame, even when it was not said at all
 *   (CTC's minimal span); how well it fits is for `gop.ts` to say.
 * - A word with no pronunciation (not in the dictionary), and any speech
 *   before the first word or after the last, is taken by a filler that fits
 *   anything at a cost of `FILLER_PENALTY` per frame, so a phone that fits
 *   always beats it. An unknown word may also take no frames.
 *
 * A phone's score at a frame is the log of the summed posterior of every
 * token that is the same sound (`samePhone`, with the model's two-phone
 * tokens counted for each of their phones), floored so a phone missing from
 * the vocabulary still aligns.
 */

import { BLANK_ID, type Posteriors, SPECIAL } from "./ctc";
import { samePhone, splitHeard } from "./phones";

/** Frames a word may sit outside the time it was given, on each side: 600 ms, over Parakeet's worst 440 ms. */
export const WINDOW_FRAMES = 30;
/** What a frame of filler costs, in nats, below the best token of that frame. */
export const FILLER_PENALTY = 1;
/** The least probability a phone is given at a frame, so its log stays finite. */
const FLOOR = 1e-8;
const NONE = Number.NEGATIVE_INFINITY;

/** The model's tokens grouped by the phone each stands for. */
export class PhoneSet {
  readonly tokens: readonly string[];
  private readonly classes = new Map<string, Int32Array>();
  private readonly ids = new Map<string, number>();

  constructor(tokens: readonly string[]) {
    this.tokens = tokens;
    tokens.forEach((token, id) => {
      if (!this.ids.has(token)) this.ids.set(token, id);
    });
  }

  /** The id of exactly this token; -1 when the model has none. */
  idOf(token: string): number {
    return this.ids.get(token) ?? -1;
  }

  /** Every token that is `phone` here: alone, or as one of the two phones it is written as. */
  idsOf(phone: string): Int32Array {
    const known = this.classes.get(phone);
    if (known !== undefined) return known;
    const ids: number[] = [];
    this.tokens.forEach((token, id) => {
      if (SPECIAL.has(token)) return;
      if (splitHeard(token).some((part) => samePhone(part, phone))) ids.push(id);
    });
    const found = Int32Array.from(ids);
    this.classes.set(phone, found);
    return found;
  }

  /** Whether token `id` is `phone` here. */
  isPhone(id: number, phone: string): boolean {
    return this.idsOf(phone).includes(id);
  }
}

const SETS = new WeakMap<readonly string[], PhoneSet>();

/** The phone set of a vocabulary, made once. */
export function phoneSetOf(tokens: readonly string[]): PhoneSet {
  const known = SETS.get(tokens);
  if (known !== undefined) return known;
  const made = new PhoneSet(tokens);
  SETS.set(tokens, made);
  return made;
}

/** The log probability, per frame, that the model heard `phone`. */
export function phoneLogProbs(post: Posteriors, ids: Int32Array): Float32Array {
  const out = new Float32Array(post.frames);
  for (let t = 0; t < post.frames; t++) {
    let sum = 0;
    const row = t * post.size;
    for (const id of ids) sum += post.probs[row + id] ?? 0;
    out[t] = Math.log(Math.max(FLOOR, Math.min(1, sum)));
  }
  return out;
}

/** One word to align: its pronunciations (none: a filler), and the frames it was said in, when known. */
export type AlignInput = {
  variants: readonly (readonly string[])[];
  from?: number;
  to?: number;
};

/** A phone and its frames, `from` up to `to` (exclusive). */
export type AlignedPhone = { phone: string; from: number; to: number };

/** A word as aligned: the pronunciation chosen (`variant`), its phones' frames, and its log score over them. */
export type AlignedWord = {
  variant: number;
  from: number;
  to: number;
  phones: AlignedPhone[];
  score: number;
};

/** Each word aligned (null for a filler word), and the path's total log score. */
export type Alignment = { words: (AlignedWord | null)[]; score: number };

/** The state graph of one sentence. */
type Graph = {
  /** Each state's emission row (0 the blank, 1 the filler, then one per phone). */
  row: number[];
  /** Each state's allowed frames, `lo` up to `hi`. */
  lo: number[];
  hi: number[];
  /** Each state's predecessors other than itself; -1 is the start. */
  preds: number[][];
  /** Which word, pronunciation and phone a state is; -1 for blanks and fillers. */
  word: number[];
  variant: number[];
  phone: number[];
  /** The states a path may end in. */
  finals: number[];
  /** The phones, by emission row (rows 0 and 1 have none). */
  phones: string[];
};

const BLANK_ROW = 0;
const FILLER_ROW = 1;

function windowOf(input: AlignInput, frames: number, bounded: boolean): [number, number] {
  if (!bounded || input.from === undefined || input.to === undefined) return [0, frames];
  return [
    Math.max(0, Math.min(frames, input.from) - WINDOW_FRAMES),
    Math.min(frames, Math.max(input.from, input.to) + WINDOW_FRAMES),
  ];
}

/** The graph of `words`, each kept to its window when `bounded`. */
function buildGraph(words: readonly AlignInput[], frames: number, bounded: boolean): Graph {
  const g: Graph = {
    row: [],
    lo: [],
    hi: [],
    preds: [],
    word: [],
    variant: [],
    phone: [],
    finals: [],
    phones: ["", ""],
  };
  const rowOf = new Map<string, number>();
  const rowFor = (phone: string): number => {
    const known = rowOf.get(phone);
    if (known !== undefined) return known;
    g.phones.push(phone);
    rowOf.set(phone, g.phones.length - 1);
    return g.phones.length - 1;
  };
  const add = (
    row: number,
    span: [number, number],
    preds: number[],
    at: [number, number, number] = [-1, -1, -1],
  ): number => {
    g.row.push(row);
    g.lo.push(span[0]);
    g.hi.push(span[1]);
    g.preds.push(preds);
    g.word.push(at[0]);
    g.variant.push(at[1]);
    g.phone.push(at[2]);
    return g.row.length - 1;
  };
  const all: [number, number] = [0, frames];
  /** The phone a state is, or "" for a blank or filler. */
  const phoneOfState = (s: number) =>
    s >= 0 && (g.phone[s] ?? -1) >= 0 ? (g.phones[g.row[s] ?? 0] ?? "") : "";
  const start = add(BLANK_ROW, all, [-1]);
  const lead = add(FILLER_ROW, all, [-1, start]);
  g.preds[start]?.push(lead);
  let entries = [-1, start, lead];
  words.forEach((input, w) => {
    const span = windowOf(input, frames, bounded);
    const exits: number[] = [];
    if (input.variants.length === 0) {
      exits.push(add(FILLER_ROW, span, [...entries]), ...entries);
    }
    input.variants.forEach((said, v) => {
      let previous = -1;
      let gap = -1;
      said.forEach((phone, p) => {
        const row = rowFor(phone);
        // CTC: the same phone twice in a row needs a blank between.
        const preds =
          p === 0
            ? entries.filter((s) => phoneOfState(s) !== phone)
            : [gap, ...(phoneOfState(previous) === phone ? [] : [previous])];
        const state = add(row, span, preds, [w, v, p]);
        if (p < said.length - 1) gap = add(BLANK_ROW, span, [state], [w, v, -1]);
        previous = state;
      });
      if (previous >= 0) exits.push(previous);
    });
    const after = add(BLANK_ROW, all, exits);
    entries = [...new Set([after, ...exits])];
  });
  const trail = add(FILLER_ROW, all, entries);
  g.finals = [...entries.filter((s) => s >= 0), trail];
  return g;
}

/** The emission rows of `graph` over `post`. */
function emissions(post: Posteriors, set: PhoneSet, graph: Graph): Float32Array[] {
  const blank = new Float32Array(post.frames);
  const filler = new Float32Array(post.frames);
  for (let t = 0; t < post.frames; t++) {
    const row = t * post.size;
    let best = 0;
    for (let k = 0; k < post.size; k++) best = Math.max(best, post.probs[row + k] ?? 0);
    blank[t] = Math.log(Math.max(FLOOR, post.probs[row + BLANK_ID] ?? 0));
    filler[t] = Math.log(Math.max(FLOOR, best)) - FILLER_PENALTY;
  }
  const rows: Float32Array[] = [blank, filler];
  for (const phone of graph.phones.slice(2)) rows.push(phoneLogProbs(post, set.idsOf(phone)));
  return rows;
}

/** The graph's predecessors as one flat list, state s's from `first[s]` up to `first[s + 1]`; the start left out. */
function flatPreds(graph: Graph): { first: Int32Array; preds: Int32Array } {
  const first = new Int32Array(graph.preds.length + 1);
  const flat: number[] = [];
  graph.preds.forEach((preds, s) => {
    for (const p of preds) if (p >= 0) flat.push(p);
    first[s + 1] = flat.length;
  });
  return { first, preds: Int32Array.from(flat) };
}

/** The Viterbi tables of `graph` over its emissions. */
type Trellis = {
  graph: Graph;
  emitting: readonly Float32Array[];
  lo: Int32Array;
  hi: Int32Array;
  first: Int32Array;
  preds: Int32Array;
};

/** The state, `s` itself or one of its predecessors, with the best score in `prev`. */
function bestFrom(trellis: Trellis, prev: Float64Array, s: number): number {
  const { first, preds } = trellis;
  let from = s;
  const end = first[s + 1] ?? 0;
  for (let i = first[s] ?? 0; i < end; i++) {
    const p = preds[i] ?? 0;
    if ((prev[p] ?? NONE) > (prev[from] ?? NONE)) from = p;
  }
  return from;
}

/** One frame `t`: each state's best score from `prev` into `cur`, and where it came from into `back`. */
function advance(
  trellis: Trellis,
  t: number,
  prev: Float64Array,
  cur: Float64Array,
  back: Int32Array,
): void {
  const { emitting, lo, hi } = trellis;
  const states = cur.length;
  for (let s = 0; s < states; s++) {
    if (t < (lo[s] ?? 0) || t >= (hi[s] ?? 0)) {
      cur[s] = NONE;
      continue;
    }
    const from = bestFrom(trellis, prev, s);
    const best = prev[from] ?? NONE;
    cur[s] = best === NONE ? NONE : best + (emitting[s]?.[t] ?? NONE);
    back[t * states + s] = from;
  }
}

/** The likeliest state per frame through `graph`; null when no path fits. */
function viterbi(rows: readonly Float32Array[], graph: Graph, frames: number): Int32Array | null {
  const states = graph.row.length;
  const trellis: Trellis = {
    graph,
    emitting: graph.row.map((row) => rows[row] ?? new Float32Array(frames)),
    lo: Int32Array.from(graph.lo),
    hi: Int32Array.from(graph.hi),
    ...flatPreds(graph),
  };
  const back = new Int32Array(frames * states).fill(-1);
  let prev = new Float64Array(states);
  let cur = new Float64Array(states);
  for (let s = 0; s < states; s++) {
    const open = graph.preds[s]?.includes(-1) === true && (trellis.lo[s] ?? 0) <= 0;
    prev[s] = open ? (trellis.emitting[s]?.[0] ?? NONE) : NONE;
  }
  for (let t = 1; t < frames; t++) {
    advance(trellis, t, prev, cur, back);
    [prev, cur] = [cur, prev];
  }
  const end = graph.finals.reduce((a, b) => ((prev[b] ?? NONE) > (prev[a] ?? NONE) ? b : a));
  if ((prev[end] ?? NONE) === NONE) return null;
  const path = new Int32Array(frames);
  let s = end;
  for (let t = frames - 1; t >= 0; t--) {
    path[t] = s;
    if (t > 0) s = back[t * states + s] ?? -1;
  }
  return path;
}

/** Frame `t` of state `s` added to its word in `words`: the word's span, score and, for a phone, the phone's span. */
function addFrame(
  words: (AlignedWord | null)[],
  graph: Graph,
  s: number,
  t: number,
  score: number,
): void {
  const w = graph.word[s] ?? -1;
  if (w < 0) return;
  const word = words[w] ?? { variant: graph.variant[s] ?? 0, from: t, to: t, phones: [], score: 0 };
  words[w] = word;
  word.to = t + 1;
  word.score += score;
  // Blanks inside a word belong to it but are no phone.
  if (graph.row[s] === BLANK_ROW) return;
  const p = graph.phone[s] ?? 0;
  const last = word.phones[p];
  if (last === undefined)
    word.phones[p] = { phone: graph.phones[graph.row[s] ?? 0] ?? "", from: t, to: t + 1 };
  else last.to = t + 1;
}

/** The words of `path` with their phones' frames and scores. */
function wordsOf(
  path: Int32Array,
  graph: Graph,
  rows: readonly Float32Array[],
  count: number,
): Alignment {
  const words: (AlignedWord | null)[] = Array.from({ length: count }, () => null);
  let total = 0;
  path.forEach((s, t) => {
    const score = rows[graph.row[s] ?? 0]?.[t] ?? 0;
    total += score;
    addFrame(words, graph, s, t, score);
  });
  return { words, score: total };
}

/**
 * The sentence `words` aligned over `post`: each word's chosen pronunciation
 * and its phones' frames. Kept to each word's window first; when that fits no
 * path (times far off), again over the whole piece; null when even that
 * fails (fewer frames than phones).
 */
export function forceAlign(
  post: Posteriors,
  set: PhoneSet,
  words: readonly AlignInput[],
): Alignment | null {
  if (post.frames === 0) return null;
  for (const bounded of [true, false]) {
    const graph = buildGraph(words, post.frames, bounded);
    const rows = emissions(post, set, graph);
    const path = viterbi(rows, graph, post.frames);
    if (path !== null) return wordsOf(path, graph, rows, words.length);
  }
  return null;
}
