import { expect, test } from "bun:test";
import type { Posteriors } from "../pronounce/ctc";
import { forceAlign, PhoneSet } from "../pronounce/force-align";

const TOKENS = ["<pad>", "<s>", "</s>", "<unk>", "k", "æ", "t", "s", "ɪ", "d", "ɑː", "oʊ", "əl"];
const set = new PhoneSet(TOKENS);

/** Frames, each a few tokens' probabilities, the rest the blank's; `[row, n]` holds a row for n frames. */
function framesOf(...runs: [Record<string, number>, number][]): Posteriors {
  const rows = runs.flatMap(([row, count]) => Array.from({ length: count }, () => row));
  const size = TOKENS.length;
  const probs = new Float32Array(rows.length * size);
  rows.forEach((row, t) => {
    let left = 1;
    for (const [token, p] of Object.entries(row)) {
      probs[t * size + TOKENS.indexOf(token)] = p;
      left -= p;
    }
    probs[t * size] = Math.max(0, left);
  });
  return { frames: rows.length, size, probs };
}

const spans = (phones: readonly { phone: string; from: number; to: number }[] | undefined) =>
  phones?.map(({ phone, from, to }) => `${phone}${from}-${to}`);

test("each word and each phone of a sentence gets the frames it was said in", () => {
  // "cat sit": k 1-2, æ 3-6, t 7, pause, s 11-13, ɪ 14-16, t 17.
  const post = framesOf(
    [{}, 1],
    [{ k: 0.9 }, 2],
    [{ æ: 0.9 }, 4],
    [{ t: 0.9 }, 1],
    [{}, 3],
    [{ s: 0.9 }, 3],
    [{ ɪ: 0.9 }, 3],
    [{ t: 0.9 }, 1],
    [{}, 2],
  );
  const aligned = forceAlign(post, set, [
    { variants: [["k", "æ", "t"]] },
    { variants: [["s", "ɪ", "t"]] },
  ]);
  expect(spans(aligned?.words[0]?.phones)).toEqual(["k1-3", "æ3-7", "t7-8"]);
  expect(spans(aligned?.words[1]?.phones)).toEqual(["s11-14", "ɪ14-17", "t17-18"]);
  expect(aligned?.words[1]).toMatchObject({ from: 11, to: 18 });
});

test("a word's pronunciation is the one the audio fits best", () => {
  const post = framesOf([{ k: 0.9 }, 2], [{ ɑː: 0.9 }, 4], [{ t: 0.9 }, 2], [{}, 2]);
  const aligned = forceAlign(post, set, [
    {
      variants: [
        ["k", "æ", "t"],
        ["k", "ɑː", "t"],
      ],
    },
  ]);
  expect(aligned?.words[0]?.variant).toBe(1);
  expect(spans(aligned?.words[0]?.phones)).toEqual(["k0-2", "ɑː2-6", "t6-8"]);
});

test("a phone not said at all still gets one frame, between its neighbours", () => {
  // "cat" said "ca": the t is not there.
  const post = framesOf([{ k: 0.9 }, 2], [{ æ: 0.9 }, 4], [{}, 3]);
  const [word] = forceAlign(post, set, [{ variants: [["k", "æ", "t"]] }])?.words ?? [];
  const [k, ae, t] = word?.phones ?? [];
  expect(t?.to).toBe((t?.from ?? 0) + 1);
  expect(k?.from).toBe(0);
  expect(ae?.to).toBe(t?.from);
});

test("a word with no pronunciation is a filler: no phones, and its neighbours stay in place", () => {
  const post = framesOf(
    [{ k: 0.9 }, 2],
    [{ æ: 0.9 }, 3],
    [{ t: 0.9 }, 1],
    [{ d: 0.9 }, 3],
    [{ oʊ: 0.9 }, 3],
    [{ s: 0.9 }, 2],
    [{ ɪ: 0.9 }, 3],
    [{ t: 0.9 }, 1],
  );
  const aligned = forceAlign(post, set, [
    { variants: [["k", "æ", "t"]] },
    { variants: [] },
    { variants: [["s", "ɪ", "t"]] },
  ]);
  expect(aligned?.words[1]).toBeNull();
  expect(spans(aligned?.words[0]?.phones)).toEqual(["k0-2", "æ2-5", "t5-6"]);
  expect(spans(aligned?.words[2]?.phones)).toEqual(["s12-14", "ɪ14-17", "t17-18"]);
});

test("speech before the first word is taken by the filler, not by the word", () => {
  const post = framesOf(
    [{ d: 0.9 }, 3],
    [{ oʊ: 0.9 }, 4],
    [{}, 2],
    [{ s: 0.9 }, 2],
    [{ ɪ: 0.9 }, 2],
    [{ t: 0.9 }, 2],
  );
  const [word] = forceAlign(post, set, [{ variants: [["s", "ɪ", "t"]] }])?.words ?? [];
  expect(spans(word?.phones)).toEqual(["s9-11", "ɪ11-13", "t13-15"]);
});

test("a word keeps to its time ± 30 frames, and its time is dropped when no path fits it", () => {
  // Two "cat"s 60 frames apart; times that say the first is the second hold it there.
  const cat = (): [Record<string, number>, number][] => [
    [{ k: 0.9 }, 2],
    [{ æ: 0.9 }, 3],
    [{ t: 0.9 }, 1],
  ];
  const post = framesOf(...cat(), [{}, 60], ...cat());
  const late = forceAlign(post, set, [{ variants: [["k", "æ", "t"]], from: 66, to: 72 }]);
  expect(late?.words[0]?.from).toBe(66);
  const early = forceAlign(post, set, [{ variants: [["k", "æ", "t"]], from: 0, to: 6 }]);
  expect(early?.words[0]?.from).toBe(0);
  // "cat ... sit" with the two words' times swapped fits no path: the whole piece is searched instead.
  const sit: [Record<string, number>, number][] = [
    [{ s: 0.9 }, 2],
    [{ ɪ: 0.9 }, 3],
    [{ t: 0.9 }, 1],
  ];
  const swapped = forceAlign(framesOf(...cat(), [{}, 60], ...sit), set, [
    { variants: [["k", "æ", "t"]], from: 66, to: 72 },
    { variants: [["s", "ɪ", "t"]], from: 0, to: 6 },
  ]);
  expect(swapped?.words.map((word) => word?.from)).toEqual([0, 66]);
});

test("a token the model writes as two phones counts for each of them", () => {
  // "əl" is one token for ə and l: with no ə alone in the vocabulary it still places the ə.
  expect([...set.idsOf("ə")]).toEqual([TOKENS.indexOf("əl")]);
  expect([...set.idsOf("t")]).toEqual([TOKENS.indexOf("t")]);
});

test("fewer frames than phones, or none, align nothing", () => {
  expect(forceAlign(framesOf([{ k: 0.9 }, 2]), set, [{ variants: [["k", "æ", "t"]] }])).toBeNull();
  expect(forceAlign(framesOf(), set, [{ variants: [["k"]] }])).toBeNull();
});
