/**
 * The reader's accent profile: what all of their English dictation says
 * together, which one word cannot. After each judged piece every content
 * word's vowels and consonant-check phones (`scores.ts`) are added to a
 * document in `api.state` (on this machine only), one feature per vowel
 * (`vowel/ʌ`) and per check and phone (`z-s/z`, `accent-words.ts`).
 *
 * A feature is compared with native speakers (`native.ts`) once it has
 * `MIN_EXAMPLES` in the window: it is confirmed when the reader's median
 * goodness sits below the natives' 10th percentile, further from native than
 * 9 in 10 native ones. Why 40: were the reader native-like, each example would
 * fall below that percentile 1 time in 10, and a median below it needs 20 of
 * 40 to, which happens about once in 10^8 (binomial); 40 of the commonest
 * vowels come in within a day or two of dictation. With fewer, or with no
 * native statistics at all, a feature is still collecting.
 *
 * Bounds: per feature the newest `MAX_SAMPLES` within `WINDOW_DAYS`, and a few
 * example words to play (`NEWEST_EXAMPLES` newest and `BEST_EXAMPLES` furthest
 * off, each a clear case: past the natives' 10th percentile when there are
 * natives to say so). An example keeps where its audio was (session,
 * dictation, piece, samples); the audio itself is the coach's, kept only for
 * a session's last dictation, so an old example may have none left.
 */

import { z } from "zod";
import { contrastKey, type FeatureKey, parseKey, vowelKey } from "./accent-words";
import {
  curveFor,
  deviateOf,
  type NativeCurve,
  type NativeStats,
  normalShare,
  Z_P10,
} from "./native";
import type { WordScores } from "./scores";

/** The `api.state` document the profile is kept in. */
export const PROFILE = "accent-profile";
export const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * 24 * 3600 * 1000;
/** Examples a feature needs before it is compared with natives. */
export const MIN_EXAMPLES = 40;
/** Scores kept per feature: the newest. */
export const MAX_SAMPLES = 150;
/** Pieces counted for "from N dictated sentences": the newest. */
export const MAX_PIECES = 3000;
export const NEWEST_EXAMPLES = 3;
export const BEST_EXAMPLES = 5;

/** A score: when (epoch s), its LPR, and the token that won over it ("" for a consonant). */
const Sample = z.tuple([z.number(), z.number(), z.string()]);
const Example = z.object({
  word: z.string(),
  lpr: z.number(),
  rival: z.string(),
  t: z.number(),
  sessionId: z.string(),
  dict: z.string(),
  piece: z.number(),
  from: z.number(),
  to: z.number(),
});
const Feature = z.object({ s: z.array(Sample), ex: z.array(Example) });
const Stored = z.object({
  v: z.literal(1),
  pieces: z.array(z.number()),
  features: z.record(z.string(), Feature),
});

export type Example = z.infer<typeof Example>;
export type Profile = z.infer<typeof Stored>;

export const EMPTY_PROFILE: Profile = { v: 1, pieces: [], features: {} };

/** The stored document as a profile; a missing or broken one starts empty. */
export function parseProfile(json: unknown): Profile {
  const parsed = Stored.safeParse(json);
  return parsed.success ? parsed.data : EMPTY_PROFILE;
}

/** A judged piece's content word: its scores, its text, and its samples in the piece's audio. */
export type ScoredWord = { scores: WordScores; word: string; from: number; to: number };
/** Where a piece's audio is. */
export type PieceAt = { sessionId: string; dict: string; piece: number };
/** Whether a score is a clear example of its feature, worth keeping to play. */
export type IsClear = (key: FeatureKey, lpr: number) => boolean;

type Score = { key: FeatureKey; lpr: number; rival: string; word: ScoredWord };

function scoresOf(words: readonly ScoredWord[]): Score[] {
  return words.flatMap((word) => [
    ...word.scores.vowels.map((one) => ({
      key: vowelKey(one.phone),
      lpr: one.lpr,
      rival: one.rival,
      word,
    })),
    ...word.scores.contrasts.map((one) => ({
      key: contrastKey(one.id, one.phone),
      lpr: one.lpr,
      rival: "",
      word,
    })),
  ]);
}

/** The newest `NEWEST_EXAMPLES` and, of the rest, the `BEST_EXAMPLES` furthest off. */
function trimExamples(examples: readonly Example[]): Example[] {
  const newest = [...examples].sort((a, b) => b.t - a.t);
  const kept = newest.slice(0, NEWEST_EXAMPLES);
  const best = newest
    .slice(NEWEST_EXAMPLES)
    .sort((a, b) => a.lpr - b.lpr)
    .slice(0, BEST_EXAMPLES);
  return [...kept, ...best];
}

/** `profile` with only what is inside the window and the bounds at `now` (epoch ms). */
export function pruned(profile: Profile, now: number): Profile {
  const since = (now - WINDOW_MS) / 1000;
  const features: Profile["features"] = {};
  for (const [key, feature] of Object.entries(profile.features)) {
    const s = feature.s.filter((one) => one[0] >= since).slice(-MAX_SAMPLES);
    const ex = trimExamples(feature.ex.filter((one) => one.t >= since));
    if (s.length > 0) features[key] = { s, ex };
  }
  const pieces = profile.pieces.filter((t) => t >= since).slice(-MAX_PIECES);
  return { v: 1, pieces, features };
}

/** `profile` with a judged piece's content words added at `now` (epoch ms); a piece with none is not counted. */
export function addPiece(
  profile: Profile,
  words: readonly ScoredWord[],
  where: PieceAt,
  now: number,
  isClear: IsClear,
): Profile {
  const scores = scoresOf(words);
  if (scores.length === 0) return pruned(profile, now);
  const t = Math.round(now / 1000);
  const features = { ...profile.features };
  for (const score of scores) {
    const old = features[score.key] ?? { s: [], ex: [] };
    const s = [...old.s, [t, score.lpr, score.rival] as [number, number, string]];
    const { word, from, to } = score.word;
    const ex = isClear(score.key, score.lpr)
      ? trimExamples([
          ...old.ex,
          { word, lpr: score.lpr, rival: score.rival, t, ...where, from, to },
        ])
      : old.ex;
    features[score.key] = { s, ex };
  }
  return pruned({ v: 1, pieces: [...profile.pieces, t], features }, now);
}

/** The curve a feature is compared with: the natives' vowel, or their phone for a consonant check. */
export function curveOfKey(stats: NativeStats | null, key: FeatureKey): NativeCurve | null {
  const parsed = parseKey(key);
  if (parsed === null) return null;
  return curveFor(stats, parsed.kind === "vowel" ? "vowel" : "phone", parsed.phone);
}

/** Whether `lpr` is past the natives' 10th percentile for `key`; with no natives, every score is kept. */
export function clearBy(stats: NativeStats | null): IsClear {
  return (key, lpr) => {
    const curve = curveOfKey(stats, key);
    return curve === null ? stats === null : deviateOf(curve, lpr) <= Z_P10;
  };
}

/** A feature as the profile has it now. */
export type Assessed = {
  key: FeatureKey;
  n: number;
  /** The reader's median LPR, its native deviate and the share of native ones better than it; null without natives. */
  median: number;
  deviate: number | null;
  nativeBetter: number | null;
  confirmed: boolean;
  /** The token most often heard instead, over the clear cases ("" for a consonant, or none). */
  rival: string;
  examples: Example[];
};

function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const at = (k: number) => sorted[k] ?? 0;
  return sorted.length % 2 === 1 ? at(mid) : (at(mid - 1) + at(mid)) / 2;
}

/** The commonest of `tokens`, ignoring ""; "" for none. */
function commonest(tokens: readonly string[]): string {
  const counts = new Map<string, number>();
  for (const token of tokens) if (token !== "") counts.set(token, (counts.get(token) ?? 0) + 1);
  let best = "";
  for (const [token, count] of counts) if (count > (counts.get(best) ?? 0)) best = token;
  return best;
}

function assessOne(
  key: FeatureKey,
  feature: Profile["features"][string],
  stats: NativeStats | null,
): Assessed {
  const curve = curveOfKey(stats, key);
  const lprs = feature.s.map((one) => one[1]);
  const median = medianOf(lprs);
  const deviate = curve === null ? null : deviateOf(curve, median);
  const clear =
    curve === null ? feature.s : feature.s.filter((one) => deviateOf(curve, one[1]) <= Z_P10);
  return {
    key,
    n: lprs.length,
    median,
    deviate,
    nativeBetter: deviate === null ? null : 1 - normalShare(deviate),
    confirmed: deviate !== null && lprs.length >= MIN_EXAMPLES && deviate < Z_P10,
    rival: commonest(clear.map((one) => one[2])),
    examples: feature.ex,
  };
}

/** Every feature of `profile` at `now`, the confirmed ones first, furthest from native first. */
export function assess(profile: Profile, stats: NativeStats | null, now: number): Assessed[] {
  const current = pruned(profile, now);
  return Object.entries(current.features)
    .map(([key, feature]) => assessOne(key, feature, stats))
    .sort(
      (a, b) =>
        Number(b.confirmed) - Number(a.confirmed) ||
        (a.deviate ?? 0) - (b.deviate ?? 0) ||
        b.n - a.n,
    );
}

/** Judged pieces in the window at `now`. */
export function piecesIn(profile: Profile, now: number): number {
  return pruned(profile, now).pieces.length;
}

type ProfileState = {
  get(name: string): Promise<unknown>;
  update<T>(name: string, fn: (current: T | undefined) => T | Promise<T>): Promise<T>;
};

/** The profile as the extension keeps it: in `api.state`, with a copy at hand for the marks. */
export class AccentProfile {
  private readonly state: ProfileState | undefined;
  private readonly natives: () => NativeStats | null;
  private readonly now: () => number;
  private profile: Profile = EMPTY_PROFILE;
  private loaded: Promise<void> = Promise.resolve();

  constructor(
    state: ProfileState | undefined,
    natives: () => NativeStats | null,
    now: () => number = Date.now,
  ) {
    this.state = state;
    this.natives = natives;
    this.now = now;
  }

  /** The kept profile read; an `add` meanwhile waits for it, so the read never undoes the add. */
  load(): Promise<void> {
    this.loaded = (async () => {
      this.profile = parseProfile(await this.state?.get(PROFILE));
    })();
    return this.loaded;
  }

  /** A judged piece's content words added, and kept. */
  async add(words: readonly ScoredWord[], where: PieceAt): Promise<void> {
    await this.loaded.catch(() => undefined);
    const at = this.now();
    const clear = clearBy(this.natives());
    const add = (current: unknown) => addPiece(parseProfile(current), words, where, at, clear);
    this.profile =
      this.state === undefined
        ? add(this.profile)
        : await this.state.update<Profile>(PROFILE, (current) => add(current));
  }

  /** Every feature now, as `assess` orders them. */
  assessed(): Assessed[] {
    return assess(this.profile, this.natives(), this.now());
  }

  /** Judged pieces in the window. */
  pieces(): number {
    return piecesIn(this.profile, this.now());
  }

  /** The native statistics compared with; null until the calibration has made them. */
  nativeStats(): NativeStats | null {
    return this.natives();
  }
}
