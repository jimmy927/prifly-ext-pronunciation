/**
 * What the accent profile (`profile.ts`) learns from one piece: for each
 * content word (one `judge.ts` judges: no function word, in Britfone), the
 * goodness (`gop.ts`) of each of its vowels and of each phone a consonant
 * check looks at, with the sound the model liked best instead. The worker
 * scores a piece beside judging it (`serve.ts`), over the same alignment the
 * calibration measured natives with (`tools/calibrate/features.ts`), so the
 * reader's numbers and the natives' are the same kind.
 */

import type { ContrastId } from "./contrasts";
import type { Posteriors } from "./ctc";
import type { Dictionary } from "./dictionary";
import { stressOf } from "./dictionary";
import { phoneScore } from "./gop";
import {
  candidatesOf,
  chosenOf,
  type Judged,
  type JudgeWord,
  type ReadPiece,
  readPiece,
  type Vocab,
} from "./judge";
import { isVowel } from "./phones";

/** A vowel of the word: where it is in `phones`, as aligned, its LPR and the token that won over it most. */
export type VowelScore = { at: number; phone: string; lpr: number; rival: string };

/** A phone a consonant check looks at: which check, the phone expected, its LPR. */
export type ContrastScore = { id: ContrastId; at: number; phone: string; lpr: number };

/** One content word of the piece (`index` of the words asked about): its pronunciation as aligned, where its stress is, and its scores. */
export type WordScores = {
  index: number;
  phones: string[];
  stress: number;
  vowels: VowelScore[];
  contrasts: ContrastScore[];
};

/** What the worker says of a piece: its marks (`judge.ts`) and its content words' scores. */
export type Judgement = { marks: Judged[]; scores: WordScores[] };

const round = (x: number) => Math.round(x * 1000) / 1000;

/** Word `index`'s scores; null when it is not judged or was not aligned. */
function scoresOf(read: ReadPiece, index: number): WordScores | null {
  if (read.entries[index]?.judged !== true) return null;
  const chosen = chosenOf(read, index);
  if (chosen === null) return null;
  const { word, said } = chosen;
  const score = (at: number) => {
    const phone = word.phones[at];
    return phone === undefined ? null : phoneScore(read.post, read.set, phone);
  };
  const vowels = said.flatMap((phone, at): VowelScore[] => {
    const one = isVowel(phone) ? score(at) : null;
    return one === null
      ? []
      : [{ at, phone: one.phone, lpr: round(one.lpr), rival: one.competitor }];
  });
  const seen = new Set<string>();
  const contrasts = candidatesOf(read, index).flatMap((candidate): ContrastScore[] => {
    const key = `${candidate.id}\n${candidate.at}`;
    const one = seen.has(key) ? null : score(candidate.at);
    seen.add(key);
    if (one === null) return [];
    return [{ id: candidate.id, at: candidate.at, phone: one.phone, lpr: round(one.lpr) }];
  });
  return { index, phones: [...said], stress: stressOf(said), vowels, contrasts };
}

/** The scores of a piece already read (`readPiece`). */
export function scoresOfRead(read: ReadPiece): WordScores[] {
  return read.entries.flatMap((_, index) => {
    const scores = scoresOf(read, index);
    return scores === null ? [] : [scores];
  });
}

/** The content words' scores of a piece whose model output is `post`; none when it cannot be aligned. */
export function scorePiece(
  post: Posteriors,
  vocab: Vocab,
  dictionary: Dictionary,
  words: readonly JudgeWord[],
): WordScores[] {
  const read = readPiece(post, vocab, dictionary, words);
  return read === null ? [] : scoresOfRead(read);
}
