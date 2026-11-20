/**
 * The native check: the reader cannot tell by ear whether a flag is theirs or the model's (or
 * the dictionary's), so a flag a native voice gets too is dropped. The sentence is read by two
 * Edge voices on this machine (`edge-tts.ts`, kept per text by `Voice.native`), a British and an
 * American one, since the dictionary takes both ways of saying a word; each reading, resampled
 * from Edge's 24 kHz to the model's 16 kHz, is judged by the same model and checks as the
 * reader's piece; and every flag of the reader's that either reading also gets is dropped: the
 * same check on the same word (by its place in the sentence) and, for a swapped sound, the same
 * expected sound. The rest are kept.
 *
 * The readings' words are given the whole clip each: the sentence alignment places them
 * (`force-align.ts`), as it does a piece's words within their times.
 *
 * A native reading is judged at every Sensitivity step like the reader's, and compared at the
 * loosest (1 in 10 natives): every mark it gets at any step counts, so a native flag just short
 * of the reader's step still says "natives do this too". The coach (`coach.ts`) and "Check your
 * flags" (`flag-check.ts`) hand in how a reading is judged; this file only reads and compares.
 */

import type { SettingValues } from "@prifly/extension-api";
import type { CheckId } from "./checks";
import { CONTRAST_IDS } from "./contrasts";
import type { JudgeWord } from "./judge";
import { resample } from "./resample";
import { PIECE_RATE } from "./voice";
import type { Wav } from "./wav";

/** The setting's id in `prifly-extension.json`: on unless the reader turns it off. */
export const NATIVE_CHECK = "nativeCheck";
/** The voices a sentence is read in: "Say it right"'s British one and an American one. */
export const NATIVE_VOICES = ["en-GB-RyanNeural", "en-US-GuyNeural"] as const;
/** The card's line when no native reading could be judged. */
export const NOT_CHECKED = "Not checked against a native reading";
/** Readings kept in memory, at 16 kHz. */
const KEPT_READINGS = 32;

/** Whether the native check is on in `values`: unless set to false. */
export function nativeCheckOn(values: SettingValues | undefined): boolean {
  return values?.[NATIVE_CHECK] !== false;
}

/** A flag as the native check compares it: its word, its check and its sound ("TH → T"). */
export type Flagged = { index: number; check: CheckId; sound: string };

/** The checks whose flags are a swapped sound, compared by the sound that was expected. */
const SWAPS: ReadonlySet<CheckId> = new Set<CheckId>([...CONTRAST_IDS, "any-sound"]);

/** The expected sound of a swap's `sound`: what stands before the arrow ("final D" of "final D → T"). */
export function expectedOf(sound: string): string {
  return (sound.split(" → ")[0] ?? sound).trim();
}

/** Whether `native` is the same flag as `flag`: the same word and check, and for a swap the same expected sound. */
export function sameFlag(flag: Flagged, native: Flagged): boolean {
  if (flag.index !== native.index || flag.check !== native.check) return false;
  return !SWAPS.has(flag.check) || expectedOf(flag.sound) === expectedOf(native.sound);
}

/** `flags` split into those no native flag shares (`kept`) and those one does (`dropped`). */
export function splitByNative<T extends Flagged>(
  flags: readonly T[],
  natives: readonly Flagged[],
): { kept: T[]; dropped: T[] } {
  const kept: T[] = [];
  const dropped: T[] = [];
  for (const flag of flags) {
    (natives.some((native) => sameFlag(flag, native)) ? dropped : kept).push(flag);
  }
  return { kept, dropped };
}

/** A mark the native check has seen: a native reading gets it too (`native`), or none could be judged (`unchecked`). */
export type Controlled = { native?: boolean; unchecked?: boolean };

/**
 * `marks` compared with what the native readings got (`answer`): each one they share set
 * `native`, or, when none could be judged, every one `unchecked`; and the log line's fields:
 * the marks before, dropped and kept, and why none was checked.
 */
export function withNatives<T extends Flagged & Controlled>(
  marks: readonly T[],
  answer: NativeAnswer,
): { marks: (T & Controlled)[]; fields: Record<string, string | number> } {
  const { dropped } = splitByNative(marks, answer.flags);
  const unchecked = answer.error !== null;
  return {
    marks: marks.map((one) => {
      if (dropped.includes(one)) return { ...one, native: true };
      return unchecked ? { ...one, unchecked: true } : one;
    }),
    fields: {
      before: marks.length,
      dropped: dropped.length,
      kept: marks.length - dropped.length,
      ...(answer.error === null ? {} : { error: answer.error }),
    },
  };
}

/** The words of a native reading `length` samples long: each may sit anywhere in it. */
export function wholeClipWords(words: readonly string[], length: number): JudgeWord[] {
  return words.map((word) => ({ word, from: 0, to: length }));
}

/** A reading's flags, by the same model and checks as the reader's; null when the model could not say. */
export type NativeFlagsOf = (
  audio: Float32Array,
  words: readonly JudgeWord[],
) => Promise<readonly Flagged[] | null>;

/** What the native readings of a sentence got: their flags, and why none could be judged (`error`, null when one was). */
export type NativeAnswer = { flags: Flagged[]; error: string | null };

export type NativeControlDeps = {
  /** `text` read in `voice` (`Voice.native`), at any rate. */
  read: (text: string, voice: string) => Promise<Wav>;
  voices?: readonly string[];
};

const errorText = (caught: unknown) => (caught instanceof Error ? caught.message : String(caught));

export class NativeControl {
  private readonly read: NativeControlDeps["read"];
  private readonly voices: readonly string[];
  private readonly readings = new Map<string, Promise<Float32Array>>();

  constructor(deps: NativeControlDeps) {
    this.read = deps.read;
    this.voices = deps.voices ?? NATIVE_VOICES;
  }

  /**
   * The flags the native readings of `text` get, its words `words`, each reading judged by
   * `flagsOf`. A reading that cannot be made or judged is left out; with none, `error` says why.
   */
  async natives(
    text: string,
    words: readonly string[],
    flagsOf: NativeFlagsOf,
  ): Promise<NativeAnswer> {
    const errors: string[] = [];
    let judged = 0;
    const flags: Flagged[] = [];
    await Promise.all(
      this.voices.map(async (voice) => {
        try {
          const audio = await this.audio(text, voice);
          const found = await flagsOf(audio, wholeClipWords(words, audio.length));
          if (found === null) throw new Error("the model could not judge the reading");
          judged++;
          flags.push(...found);
        } catch (caught) {
          errors.push(`${voice}: ${errorText(caught)}`);
        }
      }),
    );
    return { flags, error: judged > 0 ? null : errors.join("; ") };
  }

  /** `text` in `voice` at 16 kHz, kept for the next ask; a failed reading is not kept. */
  private audio(text: string, voice: string): Promise<Float32Array> {
    const key = `${voice}\n${text}`;
    const kept = this.readings.get(key);
    if (kept !== undefined) {
      this.readings.delete(key);
      this.readings.set(key, kept);
      return kept;
    }
    const reading = this.read(text, voice).then((wav) =>
      wav.rate === PIECE_RATE ? wav.samples : resample(wav.samples, wav.rate, PIECE_RATE),
    );
    this.readings.set(key, reading);
    reading.catch(() => this.readings.delete(key));
    for (const old of this.readings.keys()) {
      if (this.readings.size <= KEPT_READINGS) break;
      this.readings.delete(old);
    }
    return reading;
  }
}
