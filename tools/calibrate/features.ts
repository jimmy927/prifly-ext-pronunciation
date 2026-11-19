/**
 * What `dump.ts` writes for each word of an utterance, one JSON line each:
 * the pronunciation the alignment chose, each phone's goodness
 * (`pronounce/gop.ts`), each vowel's stress cues, the dictionary's stress
 * (and which vowel the other accepted pronunciations stress), and every swap the checks look at with its posterior and the conditions
 * `judge.ts` marks it under (`candidatesOf`), so `stats.py` can choose
 * cut-offs that the extension then applies exactly as measured.
 */

import type { Posteriors } from "../../pronounce/ctc";
import { type Dictionary, sourceOf, stressOf } from "../../pronounce/dictionary";
import type { AlignedPhone } from "../../pronounce/force-align";
import { phoneScore, stressCues } from "../../pronounce/gop";
import {
  type Candidate,
  candidatesOf,
  chosenOf,
  FUNCTION_WORDS,
  type JudgeWord,
  type ReadPiece,
  readPiece,
  type Vocab,
} from "../../pronounce/judge";
import { isVowel } from "../../pronounce/phones";
import { acceptedStresses } from "../../pronounce/stress";

/** Numbers kept to 4 decimals: enough for any cut-off, a third the bytes. */
const round = (x: number) => Math.round(x * 1e4) / 1e4;

export type PhoneRecord = {
  phone: string;
  from: number;
  to: number;
  lp: number;
  competitor: string;
  lpCompetitor: number;
  lpr: number;
  top: [string, number][];
};

export type VowelRecord = {
  at: number;
  phone: string;
  stressed: boolean;
  durationMs: number;
  rmsDb: number;
  f0Hz: number | null;
};

export type WordRecord = {
  utt: string;
  i: number;
  word: string;
  key: string;
  /** In a dictionary at all; judged: one `judge.ts` would mark (no function word, in Britfone). */
  known: boolean;
  judged: boolean;
  functionWord: boolean;
  variants: number;
  /** The chosen pronunciation, its index and its dictionary; null when the word was not aligned. */
  variant: string | null;
  variantIndex: number;
  variantSource: string | null;
  from: number;
  to: number;
  /** The index of the stressed phone of the chosen pronunciation, and which of its vowels that is (-1: none). */
  stress: number;
  stressVowel: number;
  /** Which vowel, by order, each accepted pronunciation with as many vowels stresses (`stress.ts`): a lead to one of them is no flag. */
  stressAccepts: number[];
  phones: PhoneRecord[];
  vowels: VowelRecord[];
  candidates: Candidate[];
};

/** An utterance that could not be aligned at all: written so a resumed dump skips it. */
export type FailedRecord = { utt: string; error: string };

/** The words of `text`, as `judge.ts` is asked about them: the whole utterance as each one's time. */
export function wordsOf(text: string, samples: number): JudgeWord[] {
  return text
    .split(/\s+/u)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .map((word) => ({ word, from: 0, to: samples }));
}

/** One utterance's records, from its model output `post` and its 16 kHz `audio`. */
export function utteranceRecords(
  utt: string,
  text: string,
  audio: Float32Array,
  post: Posteriors,
  vocab: Vocab,
  dictionary: Dictionary,
): WordRecord[] | FailedRecord {
  const words = wordsOf(text, audio.length);
  const read = readPiece(post, vocab, dictionary, words);
  if (read === null) return { utt, error: `no alignment (${post.frames} frames)` };
  return words.map((word, i) => wordRecord(utt, word.word, i, read, audio));
}

/** Each aligned phone's goodness, rounded. */
function phoneRecords(read: ReadPiece, phones: readonly AlignedPhone[]): PhoneRecord[] {
  return phones.map((phone): PhoneRecord => {
    const score = phoneScore(read.post, read.set, phone);
    return {
      ...score,
      lp: round(score.lp),
      lpCompetitor: round(score.lpCompetitor),
      lpr: round(score.lpr),
      top: score.top.map(([token, lp]) => [token, round(lp)]),
    };
  });
}

/** The stress cues of the vowels of `said` at `vowelAt`, as aligned in `phones`. */
function vowelRecords(
  audio: Float32Array,
  said: readonly string[],
  phones: readonly AlignedPhone[],
  vowelAt: readonly number[],
  stress: number,
): VowelRecord[] {
  return vowelAt.map((at): VowelRecord => {
    const phone = phones[at] ?? { phone: said[at] ?? "", from: 0, to: 0 };
    const cues = stressCues(audio, phone);
    return {
      at,
      phone: phone.phone,
      stressed: at === stress,
      durationMs: cues.durationMs,
      rmsDb: round(cues.rmsDb),
      f0Hz: cues.f0Hz === null ? null : round(cues.f0Hz),
    };
  });
}

/** Word `i` of the utterance as its record. */
function wordRecord(
  utt: string,
  word: string,
  i: number,
  read: ReadPiece,
  audio: Float32Array,
): WordRecord {
  const entry = read.entries[i] ?? { key: "", pronunciations: [], judged: false };
  const chosen = chosenOf(read, i);
  const said = chosen?.said ?? [];
  const phones = chosen?.word.phones ?? [];
  const stress = chosen === null ? -1 : stressOf(said);
  const vowelAt = said.flatMap((phone, at) => (isVowel(phone) ? [at] : []));
  return {
    utt,
    i,
    word,
    key: entry.key,
    known: entry.pronunciations.length > 0,
    judged: entry.judged,
    functionWord: FUNCTION_WORDS.has(entry.key),
    variants: entry.pronunciations.length,
    variant: chosen === null ? null : said.join(" "),
    variantIndex: chosen?.word.variant ?? -1,
    variantSource: chosen === null ? null : (sourceOf(said) ?? null),
    from: chosen?.word.from ?? -1,
    to: chosen?.word.to ?? -1,
    stress,
    stressVowel: vowelAt.indexOf(stress),
    stressAccepts: chosen === null ? [] : acceptedStresses(entry.pronunciations, said),
    phones: phoneRecords(read, phones),
    vowels: vowelRecords(audio, said, phones, vowelAt, stress),
    candidates: candidatesOf(read, i).map((one) => ({ ...one, posterior: round(one.posterior) })),
  };
}
