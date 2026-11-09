/**
 * What the hint line under the box says about a sound said as another: a
 * short label ("th → t") and one line on how to say it. Only the accent
 * features in `ACCENT_SWAPS` and `FINAL_DEVOICING` are underlined at all
 * (`accentContrast`). A benchmark of 13 Speech Accent Archive speakers (5
 * German, 5 Swedish, 3 native English) found every other kind of edit as
 * common in natives as in learners (about 6.7 per 100 content words each),
 * while these separated them (per 100 content words, native / German /
 * Swedish: z to s 0.9 / 12.3 / 8.7; final b, d, g to p, t, k 0.9 / 10.3 /
 * 4.1; th to t, s, f, d 0 / 5.1 / 2.6).
 */

export type Contrast = { sound: string; how: string };

/** How a phone is named in a label: its spelling where that is plainer than the IPA. */
const NAMES: Record<string, string> = {
  θ: "th",
  ð: "th",
  ʃ: "sh",
  tʃ: "ch",
  dʒ: "j",
  ʒ: "zh",
};

export function phoneName(phone: string): string {
  return NAMES[phone] ?? phone;
}

/** A phone named for a label that sets it beside its voiceless twin: ð is "voiced th", since θ is "th" too. */
function labelName(phone: string): string {
  return phone === "ð" ? "voiced th" : phoneName(phone);
}

const TH_GAP = "tongue tip between the teeth, let the air through";
const TH_VOICED = "tongue tip between the teeth, voice on, let the air through";
const BUZZ = "buzz it: keep the voice on, not a hiss";
const SIBILANT = "listen to where the tongue goes and say it after the word";

/**
 * The accent features underlined anywhere in a word, as "expected>heard",
 * each with its line on how to say the expected sound: z to s (and zh to
 * sh), th for t, s, f, d or z, w and v for each other, and the sh, ch, j, zh
 * sounds for one another.
 */
const ACCENT_SWAPS: Record<string, string> = {
  "z>s": BUZZ,
  "ʒ>ʃ": BUZZ,
  "θ>t": TH_GAP,
  "θ>s": "tongue tip between the teeth, not behind them",
  "θ>f": "tongue tip between the teeth; the lip stays off the teeth",
  "θ>d": TH_GAP,
  "ð>d": TH_VOICED,
  "ð>z": "tongue tip between the teeth, not behind them, voice on",
  "ð>t": TH_VOICED,
  "w>v": "round the lips; the teeth stay off the lip",
  "v>w": "top teeth on the bottom lip",
  "ʃ>tʃ": "no stop: let the air flow from the start",
  "ʃ>dʒ": "no stop, no voice: let the air flow from the start",
  "ʃ>ʒ": "no voice: a hush, not a buzz",
  "tʃ>ʃ": "start with the tongue touching, as for t",
  "tʃ>dʒ": "no voice: start with the tongue touching, as for t",
  "tʃ>ʒ": SIBILANT,
  "dʒ>ʃ": SIBILANT,
  "dʒ>tʃ": "voice it: start with the tongue touching, as for d",
  "dʒ>ʒ": "start with the tongue touching, as for d",
  "ʒ>tʃ": SIBILANT,
  "ʒ>dʒ": SIBILANT,
};

/** Voiced consonants and the voiceless one each turns into at a word's end: the final devoicing of German and Swedish speakers. */
const FINAL_DEVOICING: Record<string, string> = {
  b: "p",
  d: "t",
  ɡ: "k",
  v: "f",
  z: "s",
  ð: "θ",
};

const FINAL_HOW = "keep the voice on to the end of the word";

/**
 * The label and how-to when `expected` heard as `heard` is one of the accent
 * features (`last`: it is the word's last phone, where final devoicing
 * lives); null for every other swap, vowels included.
 */
export function accentContrast(expected: string, heard: string, last: boolean): Contrast | null {
  if (last && FINAL_DEVOICING[expected] === heard) {
    return { sound: `final ${labelName(expected)} → ${phoneName(heard)}`, how: FINAL_HOW };
  }
  const how = ACCENT_SWAPS[`${expected}>${heard}`];
  if (how === undefined) return null;
  return { sound: `${phoneName(expected)} → ${phoneName(heard)}`, how };
}
