/**
 * The reader's past dictation, as prifly keeps it while "Keep recordings of my dictation" is on
 * (Settings, Dictation): `@prifly/extension-api` has no call for it (an extension hears a piece
 * only as it is said, `onDictationPiece`, and prifly keeps no audio for it after), so it is read
 * where prifly's host writes it (its `dictation/recordings.ts` and `recording-files.ts`):
 *
 *   <prifly data>/dictation-recordings/YYYY-MM-DD/HHMMSS-<dict>-<piece>.wav
 *   <prifly data>/dictation-recordings/YYYY-MM-DD/HHMMSS-<dict>-<piece>.json
 *
 * The `.json` holds the piece's language, text, words with their times (ms into the audio) and
 * its audio's rate and source: "raw", the microphone's own capture at its rate, lined up with
 * the 16 kHz audio the speech model heard, or "dictation", that 16 kHz audio. Only raw pieces at
 * 44.1 kHz or more are taken: "Yours" never plays anything less (`voice.ts`). Prifly prunes the
 * oldest days past its cap, so a piece can go between the listing and the playing.
 */

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { isEnglish } from "./coach";
import { resample } from "./resample";
import { MIN_RATE, PIECE_RATE } from "./voice";
import { decodeWav, type Wav } from "./wav";

/** The folder in prifly's data folder that holds them. */
export const RECORDINGS_FOLDER = "dictation-recordings";

const DAY = /^\d{4}-\d{2}-\d{2}$/u;

const Sidecar = z.looseObject({
  language: z.string(),
  text: z.string(),
  words: z
    .array(
      z.looseObject({
        text: z.string(),
        start: z.number(),
        end: z.number(),
        startMs: z.number(),
        endMs: z.number(),
      }),
    )
    .optional(),
  audio: z.looseObject({ file: z.string(), rate: z.number(), source: z.string() }),
});

export type PastWord = { text: string; start: number; end: number; startMs: number; endMs: number };

/** A kept piece: `id` its day and name, `wav` its audio file, its text and timed words, and the audio's rate. */
export type PastPiece = {
  id: string;
  wav: string;
  text: string;
  words: PastWord[];
  rate: number;
};

async function namesIn(folder: string): Promise<string[]> {
  try {
    return await readdir(folder);
  } catch (caught) {
    if ((caught as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw caught;
  }
}

async function sidecarOf(file: string): Promise<z.infer<typeof Sidecar> | null> {
  try {
    const parsed = Sidecar.safeParse(JSON.parse(await readFile(file, "utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    // Half written, or gone since the listing: not a piece to score.
    return null;
  }
}

async function exists(file: string): Promise<boolean> {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

/**
 * The newest `limit` English pieces in `folder` (prifly's `dictation-recordings`) with timed
 * words and their full-rate audio still there, newest first. A missing folder has none.
 */
export async function recentPieces(folder: string, limit: number): Promise<PastPiece[]> {
  const days = (await namesIn(folder))
    .filter((name) => DAY.test(name))
    .sort()
    .reverse();
  const found: PastPiece[] = [];
  for (const day of days) {
    const names = (await namesIn(join(folder, day)))
      .filter((name) => name.endsWith(".json") && !name.endsWith(".sent.json"))
      .sort()
      .reverse();
    for (const name of names) {
      if (found.length >= limit) return found;
      const piece = await pieceOf(folder, day, name);
      if (piece !== null) found.push(piece);
    }
  }
  return found;
}

/** The piece whose sidecar is `<folder>/<day>/<name>`, when it is English, timed and at full rate with its audio there; null otherwise. */
async function pieceOf(folder: string, day: string, name: string): Promise<PastPiece | null> {
  const sidecar = await sidecarOf(join(folder, day, name));
  const words = sidecar?.words ?? [];
  if (sidecar === null || !isEnglish(sidecar.language) || words.length === 0) return null;
  const { audio } = sidecar;
  if (audio.source !== "raw" || audio.rate < MIN_RATE) return null;
  const wav = join(folder, day, audio.file);
  if (!(await exists(wav))) return null;
  return {
    id: `${day}/${name.slice(0, -".json".length)}`,
    wav,
    text: sidecar.text,
    words: words.map(({ text, start, end, startMs, endMs }) => ({
      text,
      start,
      end,
      startMs,
      endMs,
    })),
    rate: audio.rate,
  };
}

/** A kept piece's audio: at its own full rate, and at the 16 kHz the model takes. */
export async function readPast(wav: string): Promise<{ full: Wav; audio: Float32Array }> {
  const full = decodeWav(await readFile(wav));
  return { full, audio: resample(full.samples, full.rate, PIECE_RATE) };
}
