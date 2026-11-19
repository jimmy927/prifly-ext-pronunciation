/**
 * The "Your accent" window's data (`panel/` in the manifest): what its page
 * asks for at `api/<path>`, answered by the module's `panel` export.
 *
 * - `profile`: the accent profile as the page shows it (`ProfileView`): how
 *   many sentences it is from, the confirmed features furthest from native
 *   (at most `TOP`), each with its example words and the one to play, and the
 *   features still collecting.
 * - `play?feature=<key>&example=<id>&which=yours|right`: that example's word,
 *   the reader's own or said right, as a `data:` URL of the wav.
 *
 * A play button never disappears: what cannot play says why (`yours`,
 * `sayRight` hold the reason, null when it can), and the page disables it
 * with that as its tooltip.
 */

import type { PanelRequest } from "@prifly/extension-api";
import { type FeatureKey, listed, parseKey, shortName, titleOf } from "./accent-words";
import type { Coach, ExampleAudio } from "./coach";
import { deviateOf, Z_P10 } from "./native";
import {
  type AccentProfile,
  type Assessed,
  curveOfKey,
  type Example,
  MIN_EXAMPLES,
  WINDOW_DAYS,
} from "./profile";

/** The panel's id in `prifly-extension.json`. */
export const ACCENT_PANEL = "accent";
/** Confirmed features shown, furthest from native first. */
export const TOP = 3;
/** Example words listed per feature, and features named on the "Not enough yet" line. */
const HEARD_IN = 5;
const COLLECTING = 6;

export type FeatureView = {
  key: FeatureKey;
  title: string;
  distance: string;
  heardIn: string[];
  /** The example the play buttons play; null when none is kept. */
  example: { id: string; word: string; yours: string | null } | null;
};

export type ProfileView = {
  sentences: number;
  days: number;
  /** Whether native statistics are installed; without them nothing is compared. */
  natives: boolean;
  /** Why "Say it right" cannot play (no voice box set); null when it can. */
  sayRight: string | null;
  features: FeatureView[];
  /** The features still short of examples, named: "GOAT and GOOSE vowels; Z sound"; "" for none. */
  collecting: string;
};

export type PanelDeps = {
  profile: Pick<AccentProfile, "assessed" | "pieces" | "nativeStats">;
  coach: Pick<Coach, "yoursMissing" | "exampleYours" | "exampleRight">;
  /** Why "Say it right" cannot be made now; null when a voice box is set. */
  sayRight: () => string | null;
  readFile?: (path: string) => Promise<Uint8Array>;
};

/** "9 in 10", "19 in 20", "99 in 100": how many native ones are closer to native than the reader's usual one. */
export function shareWords(nativeBetter: number): string {
  if (nativeBetter >= 0.99) return "99 in 100";
  if (nativeBetter >= 0.95) return "19 in 20";
  return `${Math.max(1, Math.floor(nativeBetter * 10))} in 10`;
}

const idOf = (example: Example) => `${example.t}-${example.piece}-${example.from}`;

const audioOf = (example: Example): ExampleAudio => ({
  sessionId: example.sessionId,
  dict: example.dict,
  piece: example.piece,
  word: example.word,
  from: example.from,
  to: example.to,
});

export class AccentPanel {
  private readonly deps: PanelDeps;

  constructor(deps: PanelDeps) {
    this.deps = deps;
  }

  /** What the page asked for. Throws on an unknown path, which the page shows. */
  async handle(request: PanelRequest): Promise<unknown> {
    if (request.path === "profile") return this.view();
    if (request.path === "play") return this.play(request.query);
    throw new Error(`Unknown request: ${request.path}`);
  }

  /** The profile as the page shows it. */
  view(): ProfileView {
    const assessed = this.deps.profile.assessed();
    const natives = this.deps.profile.nativeStats() !== null;
    return {
      sentences: this.deps.profile.pieces(),
      days: WINDOW_DAYS,
      natives,
      sayRight: this.deps.sayRight(),
      features: assessed
        .filter((one) => one.confirmed)
        .slice(0, TOP)
        .map((one) => this.featureView(one)),
      collecting: collectingLine(
        assessed.filter((one) => !one.confirmed && (one.n < MIN_EXAMPLES || one.deviate === null)),
      ),
    };
  }

  /** The clear examples of `feature`, furthest off first. */
  private examples(feature: Assessed): Example[] {
    const curve = curveOfKey(this.deps.profile.nativeStats(), feature.key);
    return feature.examples
      .filter((one) => curve === null || deviateOf(curve, one.lpr) <= Z_P10)
      .sort((a, b) => a.lpr - b.lpr);
  }

  private featureView(feature: Assessed): FeatureView {
    const examples = this.examples(feature);
    const missing = examples.map((one) => this.deps.coach.yoursMissing(audioOf(one)));
    const at = Math.max(0, missing.indexOf(null));
    const chosen = examples[at];
    const words = [...new Set(examples.map((one) => one.word.toLowerCase()))];
    return {
      key: feature.key,
      title: titleOf(feature.key, feature.rival === "" ? null : feature.rival),
      distance: `Further from native than ${shareWords(feature.nativeBetter ?? 0)} said by native speakers`,
      heardIn: words.slice(0, HEARD_IN),
      example:
        chosen === undefined
          ? null
          : { id: idOf(chosen), word: chosen.word, yours: missing[at] ?? null },
    };
  }

  private async play(query: Record<string, string>): Promise<{ audio: string }> {
    const feature = this.deps.profile.assessed().find((one) => one.key === query["feature"]);
    const example = feature?.examples.find((one) => idOf(one) === query["example"]);
    if (example === undefined) throw new Error("That example is no longer in your profile");
    const which = query["which"];
    if (which !== "yours" && which !== "right") throw new Error(`Unknown play: ${which}`);
    const why = which === "right" ? this.deps.sayRight() : null;
    if (why !== null) throw new Error(why);
    const path =
      which === "yours"
        ? await this.deps.coach.exampleYours(audioOf(example))
        : await this.deps.coach.exampleRight(audioOf(example));
    const read = this.deps.readFile ?? (async (file: string) => Bun.file(file).bytes());
    const bytes = await read(path);
    return { audio: `data:audio/wav;base64,${Buffer.from(bytes).toString("base64")}` };
  }
}

/** The "Not enough yet" line's names: the vowels together, then the consonants, the commonest first. */
export function collectingLine(features: readonly Assessed[]): string {
  const all = [...features].sort((a, b) => b.n - a.n);
  const names = (vowel: boolean) => [
    ...new Set(
      all
        .filter((one) => (parseKey(one.key)?.kind === "vowel") === vowel)
        .map((one) => shortName(one.key)),
    ),
  ];
  const vowels = names(true).slice(0, COLLECTING);
  const others = names(false).slice(0, Math.max(0, COLLECTING - vowels.length));
  const more = names(true).length + names(false).length - vowels.length - others.length;
  const parts = [
    vowels.length === 0 ? "" : `${listed(vowels)} vowel${vowels.length === 1 ? "" : "s"}`,
    others.length === 0 ? "" : `${listed(others)} sound${others.length === 1 ? "" : "s"}`,
  ].filter((part) => part !== "");
  return parts.join("; ") + (more > 0 ? `; and ${more} more` : "");
}
