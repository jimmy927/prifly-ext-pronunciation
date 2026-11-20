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
export const FINAL_DEVOICING: Record<string, string> = {
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

/**
 * The five checks, as `pronounce/data/thresholds.json` names them: each has
 * its own posterior cut-offs, measured on native speech (`thresholds.ts`).
 */
export const CONTRAST_IDS = ["z-s", "final-devoicing", "th", "w-v", "sh-ch"] as const;
export type ContrastId = (typeof CONTRAST_IDS)[number];

/** Which check `expected` heard as `heard` belongs to (`last`: the word's last phone); null when it is none. */
export function contrastId(expected: string, heard: string, last: boolean): ContrastId | null {
  if (last && FINAL_DEVOICING[expected] === heard) return "final-devoicing";
  if (ACCENT_SWAPS[`${expected}>${heard}`] === undefined) return null;
  if (expected === "z" || expected === "ʒ") return heard === "s" || heard === "ʃ" ? "z-s" : "sh-ch";
  if (expected === "θ" || expected === "ð") return "th";
  if (expected === "w" || expected === "v") return "w-v";
  return "sh-ch";
}

/** Every phone `expected` may be heard as that is one of the accent features. */
export function swapsFrom(expected: string, last: boolean): string[] {
  const heard = Object.keys(ACCENT_SWAPS)
    .filter((key) => key.startsWith(`${expected}>`))
    .map((key) => key.slice(expected.length + 1));
  const devoiced = FINAL_DEVOICING[expected];
  if (last && devoiced !== undefined && !heard.includes(devoiced)) heard.push(devoiced);
  return heard;
}

/** A consonant as a plain reader names it: its letters, "TH" for both th sounds, "Y" for the y of "yes". */
const NAMES_PLAIN: Record<string, string> = {
  θ: "TH",
  ð: "TH",
  ʃ: "SH",
  tʃ: "CH",
  dʒ: "J",
  ʒ: "ZH",
  ŋ: "NG",
  ɡ: "G",
  ɹ: "R",
  j: "Y",
};

/** `phone` as a plain reader names it: "TH", "SH", "Y", "D". */
export function soundName(phone: string): string {
  return NAMES_PLAIN[phone] ?? phone.toUpperCase();
}

/** The sound heard, as named after "came out as": an article and its name, "an S", "a Y". */
export function cameOutAs(phone: string): string {
  const name = soundName(phone);
  return `${"FHLMNRSX".includes(name.slice(0, 1)) ? "an" : "a"} ${name}`;
}

/** A final voiced sound that went voiceless: keep buzzing for the buzzing ones, keep the voice on for the stops. */
function finalFix(expected: string): string {
  const name = soundName(expected);
  return "zvð".includes(expected)
    ? `Keep buzzing through the ${name} at the end.`
    : `Keep your voice on through the ${name} at the end.`;
}

/** The first letter of `how` capitalised, and a full stop at its end. */
function sentence(how: string): string {
  return `${how.slice(0, 1).toUpperCase()}${how.slice(1)}.`;
}

/**
 * The card's first words, which name the check as its switch does: "Z said as S.", "TH said
 * as T.", "Final D said as T."; a final Z is "Z said as S." (`checks.ts`'s `checkOfSwap`), and
 * a final TH that only lost its voice "Final TH lost its voice.".
 */
export function swapHead(expected: string, heard: string, last: boolean): string {
  const final = last && FINAL_DEVOICING[expected] === heard && expected !== "z" ? "Final " : "";
  const from = soundName(expected);
  const to = soundName(heard);
  return from === to ? `${final}${from} lost its voice.` : `${final}${from} said as ${to}.`;
}

/**
 * The card the reader sees, in plain words, no IPA: the check and what came out ("TH said as
 * T.") and what to do ("Tongue tip between the teeth, let the air through."), from the same
 * swaps as `accentContrast`; null for every other swap.
 */
export function plainFix(expected: string, heard: string, last: boolean): string | null {
  const head = swapHead(expected, heard, last);
  if (last && FINAL_DEVOICING[expected] === heard) return `${head} ${finalFix(expected)}`;
  const how = ACCENT_SWAPS[`${expected}>${heard}`];
  if (how === undefined) return null;
  return `${head} ${sentence(how)}`;
}
