/**
 * Which words of a piece were said with one of the accent features learners
 * are marked for. For each word, with its time in the piece (the piece's
 * `startMs`/`endMs`, `coach.ts`): the phones the model heard inside that time
 * (`ctc.ts`) are lined up with each of the word's pronunciations in the
 * dictionary (`align.ts`). A word is marked only when every pronunciation
 * has a substitution that is one of the accent features in `contrasts.ts`
 * (z to s, final devoicing, th for t/s/f/d, w and v, sh/ch/j/zh swaps) and
 * whose heard phone the model gave a posterior of at least
 * `MIN_HEARD_POSTERIOR`. Vowel differences, left-out and added sounds, other
 * swaps and `FUNCTION_WORDS` are ignored: on 13 Speech Accent Archive
 * speakers (5 German, 5 Swedish, 3 native English) those flagged natives as
 * often as learners. The surest such sound is the mark's.
 *
 * These rules and `MIN_HEARD_POSTERIOR` are the ones that benchmark settled
 * on: do not retune them without running it again.
 */

import { alignPhones, type Step } from "./align";
import { accentContrast, type Contrast, plainFix } from "./contrasts";
import { greedyTokens, type HeardToken, type Posteriors, probAt } from "./ctc";
import { type Dictionary, stressOf, wordKey } from "./dictionary";
import { splitHeard } from "./phones";
import { respellPair } from "./respell";

/** Audio samples per model frame: wav2vec2's 20 ms at 16 kHz. */
export const SAMPLES_PER_FRAME = 320;
/** The heard phone's highest probability over its frames must reach this for a substitution to count. */
export const MIN_HEARD_POSTERIOR = 0.7;
/** From this posterior up a mark is "sure"; from `MIN_HEARD_POSTERIOR` to just under it, "maybe". */
export const SURE_POSTERIOR = 0.88;
/** Model frames (20 ms) a word's time is widened by on each side: Parakeet's frames are 80 ms, and a token comes at or after its sound. */
export const WORD_SLACK_FRAMES = 2;

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

/** A word said otherwise: which of the words asked about (`index`), the phones heard and expected, the sound, how sure the model was (`posterior`), and for the reader the word respelt as heard (`said`) and as it should be said (`say`, `respell.ts`) with one plain line on the fix. */
export type Judged = {
  index: number;
  word: string;
  heard: string;
  expected: string;
  sound: string;
  how: string;
  posterior: number;
  said: string;
  say: string;
  fix: string;
};

/** How sure a mark with this posterior is: "sure" from `SURE_POSTERIOR`, "maybe" below it. */
export function levelOf(posterior: number): "sure" | "maybe" {
  return posterior >= SURE_POSTERIOR ? "sure" : "maybe";
}

/** A heard phone, from a token the model may have written as two (`splitHeard`). */
type HeardPhone = { phone: string; id: number; from: number; to: number };

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

/** An accent-feature substitution the model was sure of, with how sure and what to say of it, and where it is: the phone of the pronunciation at `at`, heard as `heard`. */
type Finding = {
  posterior: number;
  contrast: Contrast;
  fix: string;
  at: number;
  heard: string;
  last: boolean;
};

/** The highest probability of the heard phone over its frames. */
function heardPeak(post: Posteriors, heard: HeardPhone): number {
  let peak = 0;
  for (let t = heard.from; t < heard.to; t++) peak = Math.max(peak, probAt(post, t, heard.id));
  return peak;
}

/** A step's difference when it is a substitution in an accent feature that the model was sure of; null otherwise. Deletions and insertions never are. */
function findingOf(
  said: readonly string[],
  step: Step,
  heardPhones: readonly HeardPhone[],
  post: Posteriors,
): Finding | null {
  if (step.kind !== "sub") return null;
  const heard = heardPhones[step.heard];
  if (heard === undefined) return null;
  const last = step.expected === said.length - 1;
  const contrast = accentContrast(said[step.expected] ?? "", heard.phone, last);
  const fix = plainFix(said[step.expected] ?? "", heard.phone, last);
  if (contrast === null || fix === null) return null;
  const posterior = heardPeak(post, heard);
  if (posterior < MIN_HEARD_POSTERIOR) return null;
  return { posterior, contrast, fix, at: step.expected, heard: heard.phone, last };
}

/** The confident accent-feature differences of one pronunciation from what was heard. */
function findings(
  said: readonly string[],
  heardPhones: readonly HeardPhone[],
  post: Posteriors,
): Finding[] {
  const steps = alignPhones(
    said,
    heardPhones.map((h) => h.phone),
  );
  return steps.flatMap((step) => {
    const found = findingOf(said, step, heardPhones, post);
    return found === null ? [] : [found];
  });
}

/** The phones heard inside frames `from` to `to`: each token whose middle falls there, split into its phones. */
function heardIn(tokens: readonly HeardToken[], from: number, to: number): HeardPhone[] {
  return tokens
    .filter((token) => {
      const middle = (token.from + token.to) / 2;
      return middle >= from && middle < to;
    })
    .flatMap((token) => splitHeard(token.token).map((phone) => ({ ...token, phone })));
}

/** One word's mark, or null when it was said as written, or cannot be judged. */
function judgeWord(
  word: JudgeWord,
  index: number,
  tokens: readonly HeardToken[],
  post: Posteriors,
  dictionary: Dictionary,
): Judged | null {
  const key = wordKey(word.word);
  if (FUNCTION_WORDS.has(key)) return null;
  const pronunciations = dictionary.get(key);
  if (pronunciations === undefined) return null;
  const from = Math.max(0, Math.floor(word.from / SAMPLES_PER_FRAME) - WORD_SLACK_FRAMES);
  const to = Math.min(post.frames, Math.ceil(word.to / SAMPLES_PER_FRAME) + WORD_SLACK_FRAMES);
  const heard = heardIn(tokens, from, to);
  if (heard.length === 0) return null;
  let chosen: { said: readonly string[]; finding: Finding } | null = null;
  for (const said of pronunciations) {
    const found = findings(said, heard, post);
    if (found.length === 0) return null;
    const surest = found.reduce((a, b) => (b.posterior > a.posterior ? b : a));
    if (chosen === null || surest.posterior < chosen.finding.posterior)
      chosen = { said, finding: surest };
  }
  if (chosen === null) return null;
  const { finding } = chosen;
  const { said, say } = respellPair(
    chosen.said,
    stressOf(chosen.said),
    finding.at,
    finding.heard,
    finding.last,
  );
  return {
    index,
    word: word.word,
    heard: heard.map((h) => h.phone).join(""),
    expected: chosen.said.join(""),
    ...finding.contrast,
    posterior: finding.posterior,
    said,
    say,
    fix: finding.fix,
  };
}

/** The marks for `words` of a piece whose model output is `post`. */
export function judgeWords(
  post: Posteriors,
  vocab: Vocab,
  dictionary: Dictionary,
  words: readonly JudgeWord[],
): Judged[] {
  const tokens = greedyTokens(post, vocab.tokens);
  return words.flatMap((word, index) => {
    const judged = judgeWord(word, index, tokens, post, dictionary);
    return judged === null ? [] : [judged];
  });
}
