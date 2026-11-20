/**
 * Which words of a piece were said with one of the accent features learners
 * are marked for. The piece's words are aligned over the model's output as
 * one sentence (`force-align.ts`), each as the pronunciation the audio fits
 * best; Parakeet's word times (the piece's `startMs`/`endMs`, `coach.ts`)
 * only bound where a word may go. Then, phone by phone of that pronunciation,
 * the phones the model heard there (`ctc.ts`, a few frames either side
 * allowed) are looked at: a phone heard as another that is one of the accent
 * features in `contrasts.ts` (z to s, final devoicing, th for t/s/f/d, w and
 * v, sh/ch/j/zh swaps) is a candidate (`candidatesOf`). It is marked when the
 * model's posterior for the heard phone reaches its check's cut-off
 * (`thresholds.ts`), the expected phone itself was not heard there too, and
 * no other accepted pronunciation of the word has the heard phone in that
 * place, so a British or American way of saying it never counts. Left-out
 * and added sounds and `FUNCTION_WORDS` are ignored: on 13 Speech Accent
 * Archive speakers (5 German, 5 Swedish, 3 native English) those flagged
 * natives as often as learners. Each check (`checks.ts`) marks a word at most
 * once, with the surest such sound; the other checks (other swaps, word
 * stress, vowels) are their own files' and come in through `MoreMarks`.
 */

import { alignPhones } from "./align";
import { CHECK_IDS, type CheckId, checkOfSwap } from "./checks";
import { accentContrast, type ContrastId, contrastId, plainFix, swapsFrom } from "./contrasts";
import { greedyTokens, type HeardToken, type Posteriors, probAt } from "./ctc";
import { type Dictionary, sourceOf, stressOf, wordKey } from "./dictionary";
import {
  type AlignedPhone,
  type AlignedWord,
  type Alignment,
  forceAlign,
  type PhoneSet,
  phoneSetOf,
} from "./force-align";
import { samePhone, splitHeard } from "./phones";
import { respellPair } from "./respell";
import type { Steps } from "./sensitivity";
import {
  cutOf,
  levelAt,
  MIN_HEARD_POSTERIOR,
  NO_THRESHOLDS,
  SURE_POSTERIOR,
  type Thresholds,
} from "./thresholds";

export { MIN_HEARD_POSTERIOR, SURE_POSTERIOR };

/** Audio samples per model frame: wav2vec2's 20 ms at 16 kHz. */
export const SAMPLES_PER_FRAME = 320;
/** Frames a phone's look for what was heard reaches past its own frames, on each side, short of the next phone's. */
export const SPILL_FRAMES = 3;

/** Words never marked: said weak or fast by natives and learners alike, so their edits say nothing about an accent. */
export const FUNCTION_WORDS: ReadonlySet<string> = new Set(
  (
    "the a an of to in on at is are was were and or but as it its this that with for from by be " +
    "have has had do does did not so if than then there their they them he she we you i me my " +
    "our your his her"
  ).split(" "),
);

/** A word to check: as it is to be said (`word`), and its samples in the piece's audio. */
export type JudgeWord = { word: string; from: number; to: number };

/** A word said otherwise: which of the words asked about (`index`), the check that heard it (`checks.ts`), the phones heard and expected, the sound, how sure the model was (`posterior`) and what that makes the mark (`level`), and for the reader the word respelt as heard (`said`) and as it should be said (`say`, `respell.ts`) with the card's plain words on what was off and the fix (`fix`, starting with the check's name). */
export type Judged = {
  index: number;
  check: CheckId;
  word: string;
  heard: string;
  expected: string;
  sound: string;
  how: string;
  posterior: number;
  level?: "sure" | "maybe" | undefined;
  /** From which Sensitivity step it is drawn, and drawn sure (`sensitivity.ts`); left out, at every step at `level`. */
  steps?: Steps | undefined;
  said: string;
  say: string;
  fix: string;
};

/** How sure a mark with this posterior is under the default cut-offs: "sure" from `SURE_POSTERIOR`, "maybe" below it. */
export function levelOf(posterior: number): "sure" | "maybe" {
  return posterior >= SURE_POSTERIOR ? "sure" : "maybe";
}

/** The model's vocabulary: each token, by id. */
export class Vocab {
  readonly tokens: readonly string[];

  constructor(tokens: readonly string[]) {
    this.tokens = tokens;
  }
}

/** `vocab.json`'s `{ token: id }` as the tokens in id order. */
export function vocabFrom(json: Record<string, number>): Vocab {
  const tokens: string[] = [];
  for (const [token, id] of Object.entries(json)) tokens[id] = token;
  return new Vocab(Array.from(tokens, (token) => token ?? "<unk>"));
}

/** A word of the piece as looked up: its key, its pronunciations, and whether it is one that is judged at all. */
export type WordEntry = {
  key: string;
  pronunciations: readonly (readonly string[])[];
  judged: boolean;
};

/** A heard phone, from a token the model may have written as two (`splitHeard`). */
export type HeardPhone = { phone: string; id: number; from: number; to: number };

/** A piece read: its words looked up and aligned, and what the model heard, greedily, given to the aligned phone it was heard over. */
export type ReadPiece = {
  post: Posteriors;
  set: PhoneSet;
  entries: readonly WordEntry[];
  alignment: Alignment;
  /** Every aligned phone of the sentence in order. */
  flat: readonly AlignedPhone[];
  /** The phones heard over each of `flat`'s phones (`heardBy`). */
  heard: ReadonlyMap<AlignedPhone, readonly HeardPhone[]>;
};

/**
 * A swap the checks look at: the phone at `at` of the chosen pronunciation
 * (`expected`) and a phone it may have been heard as (`heard`), with the
 * heard phone's peak posterior around it (`posterior`), whether the model's
 * greedy reading heard it there (`wasHeard`), whether it heard the expected
 * phone there too (`expectedHeard`), and whether another accepted
 * pronunciation of the word has the heard phone in that place
 * (`variantAccepts`).
 */
export type Candidate = {
  at: number;
  expected: string;
  heard: string;
  id: ContrastId;
  last: boolean;
  posterior: number;
  wasHeard: boolean;
  expectedHeard: boolean;
  variantAccepts: boolean;
};

/** `word` looked up: judged when it is no function word and Britfone has it. */
function entryOf(word: string, dictionary: Dictionary): WordEntry {
  const key = wordKey(word);
  const pronunciations = dictionary.get(key) ?? [];
  const judged =
    !FUNCTION_WORDS.has(key) && pronunciations.some((said) => sourceOf(said) === "britfone");
  return { key, pronunciations, judged };
}

/** The piece's words aligned over `post`; null when they cannot be (no frames, fewer frames than phones). */
export function readPiece(
  post: Posteriors,
  vocab: Vocab,
  dictionary: Dictionary,
  words: readonly JudgeWord[],
): ReadPiece | null {
  const set = phoneSetOf(vocab.tokens);
  const entries = words.map((word) => entryOf(word.word, dictionary));
  const alignment = forceAlign(
    post,
    set,
    words.map((word, at) => ({
      variants: entries[at]?.pronunciations ?? [],
      from: Math.floor(word.from / SAMPLES_PER_FRAME),
      to: Math.ceil(word.to / SAMPLES_PER_FRAME),
    })),
  );
  if (alignment === null) return null;
  const flat = alignment.words.flatMap((word) => word?.phones ?? []);
  return {
    post,
    set,
    entries,
    alignment,
    flat,
    heard: heardBy(greedyTokens(post, vocab.tokens), flat),
  };
}

/** How many frames `token` and `phone` share; minus the frames between them when they share none. */
function overlap(token: HeardToken, phone: AlignedPhone): number {
  return Math.min(token.to, phone.to) - Math.max(token.from, phone.from);
}

/**
 * Each heard token, split into its phones, given to the aligned phone it
 * shares the most frames with; one heard over blanks only goes to the
 * nearest phone within `SPILL_FRAMES`, else to none.
 */
function heardBy(
  tokens: readonly HeardToken[],
  flat: readonly AlignedPhone[],
): Map<AlignedPhone, HeardPhone[]> {
  const heard = new Map<AlignedPhone, HeardPhone[]>(flat.map((phone) => [phone, []]));
  for (const token of tokens) {
    let best: AlignedPhone | undefined;
    let most = -SPILL_FRAMES - 1;
    for (const phone of flat) {
      const shared = overlap(token, phone);
      if (shared > most) {
        most = shared;
        best = phone;
      }
    }
    if (best === undefined) continue;
    for (const phone of splitHeard(token.token)) heard.get(best)?.push({ ...token, phone });
  }
  return heard;
}

/** The frames `phone` looks at for a heard phone's peak: its own, `SPILL_FRAMES` more each side, never into a neighbour's. */
function lookOf(read: ReadPiece, phone: AlignedPhone): [number, number] {
  const at = read.flat.indexOf(phone);
  const before = read.flat[at - 1]?.to ?? 0;
  const after = read.flat[at + 1]?.from ?? read.post.frames;
  return [Math.max(before, phone.from - SPILL_FRAMES), Math.min(after, phone.to + SPILL_FRAMES)];
}

/** The highest probability of token `id` over frames `from` to `to`. */
function peakOf(post: Posteriors, id: number, from: number, to: number): number {
  let peak = 0;
  for (let t = Math.max(0, from); t < Math.min(post.frames, to); t++) {
    peak = Math.max(peak, probAt(post, t, id));
  }
  return peak;
}

/** Whether a pronunciation of the word other than `said` has `heard` where `said` has its phone `at`. */
export function otherHas(
  entry: WordEntry,
  said: readonly string[],
  at: number,
  heard: string,
): boolean {
  return entry.pronunciations.some((other) => {
    if (other === said) return false;
    const step = alignPhones(said, other).find((one) => one.kind !== "ins" && one.expected === at);
    if (step === undefined || step.kind === "del" || step.kind === "ins") return false;
    return samePhone(other[step.heard] ?? "", heard);
  });
}

/** The aligned word `index` of `read` with its chosen pronunciation; null when it was not aligned. */
export function chosenOf(
  read: ReadPiece,
  index: number,
): { word: AlignedWord; said: readonly string[] } | null {
  const word = read.alignment.words[index];
  const said = read.entries[index]?.pronunciations[word?.variant ?? -1];
  if (word === null || word === undefined || said === undefined) return null;
  return { word, said };
}

/** Every swap the checks look at in word `index`, whatever its posterior. */
export function candidatesOf(read: ReadPiece, index: number): Candidate[] {
  const chosen = chosenOf(read, index);
  const entry = read.entries[index];
  if (chosen === null || entry === undefined) return [];
  const { word, said } = chosen;
  return word.phones.flatMap((phone, at): Candidate[] => {
    const expected = said[at] ?? phone.phone;
    const last = at === said.length - 1;
    const swaps = swapsFrom(expected, last);
    if (swaps.length === 0) return [];
    const look = lookOf(read, phone);
    const heard = read.heard.get(phone) ?? [];
    const expectedHeard = heard.some((one) => samePhone(one.phone, expected));
    return swaps.flatMap((swap): Candidate[] => {
      const id = contrastId(expected, swap, last);
      const token = read.set.idOf(swap);
      if (id === null || token < 0) return [];
      const tokens = heard.filter((one) => one.phone === swap);
      let posterior = peakOf(read.post, token, look[0], look[1]);
      for (const one of tokens)
        posterior = Math.max(posterior, peakOf(read.post, token, one.from, one.to));
      return [
        {
          at,
          expected,
          heard: swap,
          id,
          last,
          posterior,
          wasHeard: tokens.length > 0,
          expectedHeard,
          variantAccepts: otherHas(entry, said, at, swap),
        },
      ];
    });
  });
}

/** Whether `candidate` is marked under `thresholds`. */
export function marks(candidate: Candidate, thresholds: Thresholds): boolean {
  const cut = cutOf(thresholds, candidate.id);
  return (
    !cut.off &&
    candidate.wasHeard &&
    !candidate.expectedHeard &&
    !candidate.variantAccepts &&
    candidate.posterior >= cut.maybe
  );
}

/** The phones heard over `word`'s phones, joined. */
function heardOver(read: ReadPiece, word: AlignedWord): string {
  return word.phones
    .flatMap((phone) => read.heard.get(phone) ?? [])
    .map((one) => one.phone)
    .join("");
}

/** The mark of `surest`, the surest swap of its check in word `index`; null when it cannot be put in plain words. */
function markOf(
  read: ReadPiece,
  index: number,
  word: JudgeWord,
  surest: Candidate,
  thresholds: Thresholds,
): Judged | null {
  const chosen = chosenOf(read, index);
  const contrast = accentContrast(surest.expected, surest.heard, surest.last);
  const fix = plainFix(surest.expected, surest.heard, surest.last);
  if (chosen === null || contrast === null || fix === null) return null;
  const { said, say } = respellPair(
    chosen.said,
    stressOf(chosen.said),
    surest.at,
    surest.heard,
    surest.last,
  );
  return {
    index,
    check: checkOfSwap(surest.id, surest.expected),
    word: word.word,
    heard: heardOver(read, chosen.word),
    expected: chosen.said.join(""),
    ...contrast,
    posterior: surest.posterior,
    level: levelAt(surest.posterior, cutOf(thresholds, surest.id)),
    said,
    say,
    fix,
  };
}

/** Of a word's `candidates`, the surest that `thresholds` mark, one per check. */
export function surestByCheck(
  candidates: readonly Candidate[],
  thresholds: Thresholds,
): Map<CheckId, Candidate> {
  const surest = new Map<CheckId, Candidate>();
  for (const one of candidates) {
    if (!marks(one, thresholds)) continue;
    const check = checkOfSwap(one.id, one.expected);
    const known = surest.get(check);
    if (known === undefined || one.posterior > known.posterior) surest.set(check, one);
  }
  return surest;
}

/** One word's marks, at most one per check (the surest swap of each), in `CHECK_IDS` order; none when it was said as written, or is not judged. */
function judgeWord(
  read: ReadPiece,
  index: number,
  word: JudgeWord,
  thresholds: Thresholds,
): Judged[] {
  if (read.entries[index]?.judged !== true) return [];
  const surest = surestByCheck(candidatesOf(read, index), thresholds);
  return CHECK_IDS.flatMap((check): Judged[] => {
    const one = surest.get(check);
    const mark = one === undefined ? null : markOf(read, index, word, one, thresholds);
    return mark === null ? [] : [mark];
  });
}

/** The contrasts' marks of a piece already read (`readPiece`), at most one a word per check, in the words' order. */
export function contrastMarks(
  read: ReadPiece,
  words: readonly JudgeWord[],
  thresholds: Thresholds,
): Judged[] {
  return words.flatMap((word, index) => judgeWord(read, index, word, thresholds));
}

/** Marks of another kind for a piece once read (other swaps, word stress, weak vowels), handed in by the worker so this file needs none of their data. */
export type MoreMarks = (read: ReadPiece) => readonly Judged[];

/** `marks` in the words' order, and within a word in `CHECK_IDS` order: the order the coach draws them in. */
export function inWordOrder(marks: readonly Judged[]): Judged[] {
  const rank = (one: Judged) => CHECK_IDS.indexOf(one.check);
  return [...marks].sort((a, b) => a.index - b.index || rank(a) - rank(b));
}

/**
 * Every mark for `words` of a piece whose model output is `post`: the
 * contrasts' (`judgeWord`) and `more`'s, at most one a word per check, in
 * `inWordOrder`. A word marked by several checks keeps every mark: which is
 * drawn is the reader's switches' (`coach.ts`).
 */
export function judgeWords(
  post: Posteriors,
  vocab: Vocab,
  dictionary: Dictionary,
  words: readonly JudgeWord[],
  thresholds: Thresholds = NO_THRESHOLDS,
  more?: MoreMarks,
): Judged[] {
  const read = readPiece(post, vocab, dictionary, words);
  if (read === null) return [];
  return inWordOrder([...contrastMarks(read, words, thresholds), ...(more?.(read) ?? [])]);
}
