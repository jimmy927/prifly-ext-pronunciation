/** `fakeApi` with prifly's dictation calls: the handlers the extension gave, and every `markDictation`. */

import type {
  DictationCorrection,
  DictationMarkAudio,
  DictationMarkClick,
  DictationMarks,
  DictationPiece,
  SettingValues,
} from "@prifly/extension-api";
import { type FakeApi, fakeApi } from "./fake-api";

export type FakeDictation = FakeApi & {
  marks: DictationMarks[];
  heard: {
    piece?: (piece: DictationPiece) => void | Promise<void>;
    correction?: (correction: DictationCorrection) => void | Promise<void>;
    action?: (
      click: DictationMarkClick,
    ) => void | DictationMarkAudio | Promise<void | DictationMarkAudio>;
  };
};

export function fakeDictation(settings?: SettingValues): FakeDictation {
  const fake = fakeApi(settings === undefined ? {} : { settings });
  const marks: DictationMarks[] = [];
  const heard: FakeDictation["heard"] = {};
  fake.api.features = [
    ...(fake.api.features ?? []),
    "dictation-pieces",
    "dictation-marks",
    "dictation-mark-levels",
  ];
  fake.api.onDictationPiece = (handler) => {
    heard.piece = handler;
  };
  fake.api.onDictationCorrection = (handler) => {
    heard.correction = handler;
  };
  fake.api.onDictationMarkAction = (handler) => {
    heard.action = handler;
  };
  fake.api.markDictation = (given) => void marks.push(given);
  return { ...fake, marks, heard };
}

/** An English piece saying "Three trees.": the first word 100 to 500 ms into a second of audio. */
export function threeTrees(patch: Partial<DictationPiece> = {}): DictationPiece {
  return {
    sessionId: "s1",
    dict: "d1",
    piece: 0,
    language: "en",
    text: "Three trees.",
    words: [
      { text: "Three", start: 0, end: 5, startMs: 100, endMs: 500 },
      { text: "trees", start: 6, end: 11, startMs: 500, endMs: 900 },
    ],
    audio: new Float32Array(16_000),
    ...patch,
  };
}

export const THREE_DETAIL =
  "The TH (as in thin) came out as a T. Tongue tip between the teeth, let the air through.";

/** What the judge says of "three" said with a t. */
export const THREE_AS_TREE = {
  index: 0,
  word: "Three",
  heard: "triː",
  expected: "θriː",
  sound: "th → t",
  how: "tongue tip between the teeth, let the air through",
  posterior: 0.95,
  said: "TREE",
  say: "THREE",
  fix: THREE_DETAIL,
};
