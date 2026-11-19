/**
 * The accent profile's features in plain words, for the "Your accent" panel
 * and the confirmed-pattern cards: no phonetic letters, only English words
 * and the letters that spell the sound in them.
 *
 * A vowel feature is named by its keyword ("the U in 'cup'") and its lexical
 * set (STRUT) as Wells named them. What the reader's vowel tends towards is
 * the one the model most often heard instead (the competitor of `gop.ts`),
 * and which way that lies from the expected one, by where each sits in the
 * mouth (`height`: 1 close to 4 open; `back`: 1 front to 3 back), says what to
 * do about it.
 */

import { CONTRAST_IDS, type ContrastId } from "./contrasts";
import { samePhone } from "./phones";

type Vowel = {
  set: string;
  keyword: string;
  letters: string;
  height: number;
  back: number;
  long: boolean;
  glides: boolean;
};

const v = (
  set: string,
  keyword: string,
  letters: string,
  height: number,
  back: number,
  long = false,
  glides = false,
): Vowel => ({ set, keyword, letters, height, back, long, glides });

/** Vowels by the phone the dictionary or the model writes for them; the first spelling of each is the dictionary's. */
const VOWELS: ReadonlyArray<readonly [string, Vowel]> = [
  ["iː", v("FLEECE", "see", "EE", 1, 1, true)],
  ["ɪ", v("KIT", "sit", "I", 1.5, 1.2)],
  ["e", v("DRESS", "bed", "E", 2.5, 1)],
  ["ɛ", v("DRESS", "bed", "E", 2.5, 1)],
  ["æ", v("TRAP", "cap", "A", 3.5, 1)],
  ["a", v("TRAP", "cap", "A", 3.5, 1.2)],
  ["ʌ", v("STRUT", "cup", "U", 3, 2.5)],
  ["ɐ", v("STRUT", "cup", "U", 3, 2.2)],
  ["ɑː", v("PALM", "car", "A", 4, 3, true)],
  ["ɑ", v("PALM", "car", "A", 4, 3, true)],
  ["ɒ", v("LOT", "hot", "O", 3.8, 3)],
  ["ɔː", v("THOUGHT", "caught", "AU", 2.8, 3, true)],
  ["ɔ", v("THOUGHT", "caught", "AU", 2.8, 3, true)],
  ["ʊ", v("FOOT", "book", "OO", 1.5, 2.8)],
  ["uː", v("GOOSE", "boot", "OO", 1, 3, true)],
  ["u", v("GOOSE", "boot", "OO", 1, 3, true)],
  ["ɜː", v("NURSE", "bird", "IR", 2.5, 2, true)],
  ["ɜ", v("NURSE", "bird", "IR", 2.5, 2, true)],
  ["ɚ", v("NURSE", "bird", "IR", 2.5, 2, true)],
  ["ə", v("schwa", "about", "A", 2.5, 2)],
  ["eɪ", v("FACE", "day", "AY", 2.5, 1, true, true)],
  ["aɪ", v("PRICE", "my", "Y", 4, 2, true, true)],
  ["ɔɪ", v("CHOICE", "boy", "OY", 2.8, 3, true, true)],
  ["əʊ", v("GOAT", "go", "O", 2.5, 2, true, true)],
  ["oʊ", v("GOAT", "go", "O", 2.5, 3, true, true)],
  ["aʊ", v("MOUTH", "now", "OW", 4, 2, true, true)],
  ["ɪə", v("NEAR", "here", "ERE", 1.5, 1.2, true, true)],
  ["eə", v("SQUARE", "hair", "AIR", 2.5, 1, true, true)],
  ["ɛə", v("SQUARE", "hair", "AIR", 2.5, 1, true, true)],
  ["ʊə", v("CURE", "tour", "OUR", 1.5, 2.8, true, true)],
];

/** The vowel `phone` is: its own entry, else the first that is the same sound (`samePhone`); null for a consonant or an unknown token. */
function vowelOf(phone: string): Vowel | null {
  const exact = VOWELS.find(([one]) => one === phone);
  if (exact !== undefined) return exact[1];
  return VOWELS.find(([one]) => samePhone(one, phone))?.[1] ?? null;
}

/** Which way the reader's vowel lies from the expected one. */
export type Direction = "open" | "close" | "front" | "back" | "long" | "short" | "glide" | "flat";

/** The way from `expected` to `rival`; null when they are one sound to this table, or either is no vowel it knows. */
export function directionOf(expected: string, rival: string): Direction | null {
  const want = vowelOf(expected);
  const got = vowelOf(rival);
  if (want === null || got === null || want.set === got.set) return null;
  const height = got.height - want.height;
  const back = got.back - want.back;
  if (Math.abs(height) >= 0.5) return height > 0 ? "open" : "close";
  if (Math.abs(back) >= 0.5) return back > 0 ? "back" : "front";
  if (want.glides !== got.glides) return got.glides ? "glide" : "flat";
  if (want.long !== got.long) return got.long ? "long" : "short";
  return null;
}

const TOO: Record<Direction, string> = {
  open: "too open",
  close: "too closed",
  front: "too far forward",
  back: "too far back",
  long: "too long",
  short: "too short",
  glide: "gliding",
  flat: "not gliding",
};

const TENDS: Record<Direction, string> = {
  open: "open",
  close: "close up",
  front: "go forward",
  back: "go back",
  long: "come out long",
  short: "come out short",
  glide: "glide",
  flat: "stay flat",
};

const FIX: Record<Direction, string> = {
  open: "Drop your jaw less.",
  close: "Open your jaw a little more.",
  front: "Pull your tongue back a little.",
  back: "Bring your tongue forward a little.",
  long: "Keep it short.",
  short: "Hold it a little longer.",
  glide: "Hold one position, no glide.",
  flat: "Let it glide to its end.",
};

/** The consonant features, by `<check>/<expected phone>`: how the panel names each, and the word it is heard in. */
const CONSONANTS: Record<string, { name: string; title: string }> = {
  "z-s/z": { name: "Z", title: "The Z in 'zoo' turns into S" },
  "z-s/ʒ": { name: "ZH", title: "The ZH in 'measure' turns into SH" },
  "final-devoicing/b": { name: "final B", title: "A final B goes voiceless (like P)" },
  "final-devoicing/d": { name: "final D", title: "A final D goes voiceless (like T)" },
  "final-devoicing/ɡ": { name: "final G", title: "A final G goes voiceless (like K)" },
  "final-devoicing/v": { name: "final V", title: "A final V goes voiceless (like F)" },
  "final-devoicing/z": { name: "final Z", title: "A final Z goes voiceless (like S)" },
  "final-devoicing/ð": { name: "final TH", title: "A final TH as in 'with' goes voiceless" },
  "th/θ": { name: "TH in 'thin'", title: "The TH in 'thin' is off (like T, S or F)" },
  "th/ð": { name: "TH in 'this'", title: "The TH in 'this' is off (like D or Z)" },
  "w-v/w": { name: "W", title: "The W in 'wine' sounds like V" },
  "w-v/v": { name: "V", title: "The V in 'vine' sounds like W" },
  "sh-ch/ʃ": { name: "SH", title: "The SH in 'ship' is off" },
  "sh-ch/tʃ": { name: "CH", title: "The CH in 'chip' is off" },
  "sh-ch/dʒ": { name: "J", title: "The J in 'jam' is off" },
  "sh-ch/ʒ": { name: "ZH", title: "The ZH in 'measure' is off" },
};

/** A feature's key in the profile: `vowel/<phone>`, or `<check>/<phone>` for a consonant check. */
export type FeatureKey = string;

export const vowelKey = (phone: string): FeatureKey => `vowel/${phone}`;
export const contrastKey = (id: ContrastId, phone: string): FeatureKey => `${id}/${phone}`;

/** What a key names: a vowel, or a consonant check, and the phone. */
export function parseKey(key: FeatureKey): { kind: "vowel" | ContrastId; phone: string } | null {
  const slash = key.indexOf("/");
  const kind = key.slice(0, slash);
  const phone = key.slice(slash + 1);
  if (slash <= 0 || phone === "") return null;
  if (kind === "vowel") return { kind, phone };
  const id = CONTRAST_IDS.find((one) => one === kind);
  return id === undefined ? null : { kind: id, phone };
}

/** How the "Not enough yet" line names a feature: "STRUT" for a vowel (said as "… vowels"), "final D" for a consonant. */
export function shortName(key: FeatureKey): string {
  const parsed = parseKey(key);
  if (parsed?.kind === "vowel") return vowelOf(parsed.phone)?.set ?? parsed.phone;
  return CONSONANTS[key]?.name ?? key;
}

/** The panel's title for a feature: "The U in 'cup' is too open (like 'cap')". */
export function titleOf(key: FeatureKey, rival: string | null): string {
  const parsed = parseKey(key);
  if (parsed?.kind !== "vowel")
    return CONSONANTS[key]?.title ?? `The ${shortName(key)} sound is off`;
  const want = vowelOf(parsed.phone);
  if (want === null) return "A vowel is off";
  const the = `The ${want.letters} in '${want.keyword}'`;
  const got = rival === null ? null : vowelOf(rival);
  const way = rival === null ? null : directionOf(parsed.phone, rival);
  if (got === null) return `${the} is off`;
  return way === null
    ? `${the} sounds like '${got.keyword}'`
    : `${the} is ${TOO[way]} (like '${got.keyword}')`;
}

/**
 * The card of a confirmed vowel pattern: where it comes from, what it sounds
 * like and the fix, e.g. "Your U in 'cup' tends to open, like the A in 'cap';
 * here too. Drop your jaw less." Null when `rival` is no vowel this knows.
 */
export function patternCard(phone: string, rival: string): string | null {
  const want = vowelOf(phone);
  const got = vowelOf(rival);
  if (want === null || got === null || want.set === got.set) return null;
  const way = directionOf(phone, rival);
  const like = `the ${got.letters} in '${got.keyword}'`;
  const head = `Your ${want.letters} in '${want.keyword}'`;
  return way === null
    ? `${head} tends to sound like ${like}; here too.`
    : `${head} tends to ${TENDS[way]}, like ${like}; here too. ${FIX[way]}`;
}

/** The sound's label on a confirmed card: "U (cup) → A (cap)". */
export function soundOf(phone: string, rival: string): string {
  const want = vowelOf(phone);
  const got = vowelOf(rival);
  const name = (one: Vowel | null, fallback: string) =>
    one === null ? fallback : `${one.letters} (${one.keyword})`;
  return `${name(want, phone)} → ${name(got, rival)}`;
}

/** "A, B and C". */
export function listed(names: readonly string[]): string {
  if (names.length <= 1) return names.join("");
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
