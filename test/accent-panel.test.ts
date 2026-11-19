import { expect, test } from "bun:test";
import * as extension from "../index";
import { AccentPanel, collectingLine, type PanelDeps, shareWords } from "../pronounce/accent-panel";
import { AUDIO_GONE, type ExampleAudio } from "../pronounce/coach";
import { NO_BOX, start } from "../pronounce/extension";
import type { NativeStats } from "../pronounce/native";
import { AccentProfile, assess, MIN_EXAMPLES } from "../pronounce/profile";
import { JudgeRequest } from "../pronounce/protocol";
import { much, NOW, natives, WHERE, word, zed } from "./accent-fixtures";
import { fakeDictation, threeTrees } from "./fake-dictation";
import { type FakeWorker, fakeWorker, until } from "./fake-worker";

/** A profile fed `count` pieces of "much" at `lpr` and "is" with its z at `zLpr`, a minute apart. */
async function fedProfile(count: number, stats: NativeStats | null, lpr = -2.5, zLpr = 0) {
  let now = NOW - count * 60_000;
  const profile = new AccentProfile(
    undefined,
    () => stats,
    () => now,
  );
  for (let k = 0; k < count; k++) {
    now += 60_000;
    await profile.add(
      [word(much(lpr - k / 100), k % 2 === 0 ? "much" : "Love"), word(zed(zLpr, 1), "is")],
      { ...WHERE, piece: k },
    );
  }
  return profile;
}

function panelOver(profile: AccentProfile, kept: (one: ExampleAudio) => boolean, box = true) {
  const played: string[] = [];
  const deps: PanelDeps = {
    profile,
    coach: {
      yoursMissing: (one) => (kept(one) ? null : AUDIO_GONE),
      exampleYours: async (one) => {
        played.push(`yours ${one.word}`);
        return "/tmp/yours.wav";
      },
      exampleRight: async (one) => {
        played.push(`right ${one.word}`);
        return "/tmp/right.wav";
      },
    },
    sayRight: () => (box ? null : NO_BOX),
    readFile: async () => new Uint8Array([82, 73, 70, 70]),
  };
  return { panel: new AccentPanel(deps), played };
}

const request = (path: string, query: Record<string, string> = {}) => ({ path, query, body: null });

test("no dictation yet: no sentences, no features, nothing collecting", async () => {
  const { panel } = panelOver(new AccentProfile(undefined, () => natives()), () => true);
  expect(await panel.handle(request("profile"))).toEqual({
    sentences: 0,
    days: 30,
    natives: true,
    sayRight: null,
    features: [],
    collecting: "",
  });
});

test("without native statistics the profile collects and says what it is still collecting", async () => {
  const { panel } = panelOver(await fedProfile(MIN_EXAMPLES + 5, null), () => true, false);
  expect(panel.view()).toMatchObject({
    sentences: MIN_EXAMPLES + 5,
    natives: false,
    sayRight: NO_BOX,
    features: [],
    collecting: "STRUT and KIT vowels; Z sound",
  });
});

test("the confirmed features, furthest first, with their words and the example to play", async () => {
  const profile = await fedProfile(MIN_EXAMPLES, natives(), -2.5, -4);
  const { panel } = panelOver(profile, (one) => one.piece === MIN_EXAMPLES - 1);
  const view = panel.view();
  expect(view.features.map((one) => one.title)).toEqual([
    "The Z in 'zoo' turns into S",
    "The U in 'cup' is too open (like 'cap')",
  ]);
  const cup = view.features[1];
  expect(cup?.distance).toBe("Further from native than 19 in 20 said by native speakers");
  expect(cup?.heardIn).toEqual(["love", "much"]);
  // The furthest-off example whose audio is still kept.
  expect(cup?.example).toMatchObject({ word: "Love", yours: null });
  expect(view.collecting).toBe("");
});

test("an example whose audio is gone keeps its Yours, disabled with the reason", async () => {
  const { panel } = panelOver(await fedProfile(MIN_EXAMPLES, natives()), () => false);
  expect(panel.view().features[0]?.example?.yours).toBe(AUDIO_GONE);
});

test("play answers with the example's wav as a data URL; Say it right needs the voice box", async () => {
  const profile = await fedProfile(MIN_EXAMPLES, natives());
  const { panel, played } = panelOver(profile, () => true);
  const cup = panel.view().features[0];
  const query = { feature: cup?.key ?? "", example: cup?.example?.id ?? "" };
  expect(await panel.handle(request("play", { ...query, which: "yours" }))).toEqual({
    audio: "data:audio/wav;base64,UklGRg==",
  });
  await panel.handle(request("play", { ...query, which: "right" }));
  expect(played).toEqual([`yours ${cup?.example?.word}`, `right ${cup?.example?.word}`]);
  const noBox = panelOver(profile, () => true, false).panel;
  await expect(noBox.handle(request("play", { ...query, which: "right" }))).rejects.toThrow(NO_BOX);
  await expect(
    panel.handle(request("play", { ...query, example: "0-0-0", which: "yours" })),
  ).rejects.toThrow(/no longer in your profile/);
  await expect(panel.handle(request("nope"))).rejects.toThrow(/Unknown request/);
});

test("the distance in words, and the collecting line's names", async () => {
  expect([0.9, 0.94, 0.96, 0.995].map(shareWords)).toEqual([
    "9 in 10",
    "9 in 10",
    "19 in 20",
    "99 in 100",
  ]);
  const profile = await fedProfile(3, null);
  expect(collectingLine(assess({ v: 1, pieces: [], features: {} }, null, NOW))).toBe("");
  expect(collectingLine(profile.assessed())).toBe("STRUT and KIT vowels; Z sound");
});

test("a piece the worker scored reaches the window's profile", async () => {
  const fake = fakeDictation();
  const workers: FakeWorker[] = [];
  const on = start(fake.api, {
    ensure: async () => ({ model: "/m", vocab: "/v", dictionary: "/d", cmudict: "/c" }),
    spawn: () => {
      const worker = fakeWorker();
      worker.write = (line) => {
        const { id } = JudgeRequest.parse(JSON.parse(line));
        queueMicrotask(() =>
          worker.say({ type: "marks", id, marks: [], scores: [much(-2.5)], ms: 3 }),
        );
      };
      workers.push(worker);
      return worker;
    },
    natives: async () => null,
  });
  try {
    await until(() => workers.length === 1);
    workers[0]?.say({ type: "ready" });
    await until(() => on.runner?.state === "ready");
    await fake.heard.piece?.(threeTrees());
    await on.coach?.settled();
    expect(await on.panel?.handle(request("profile"))).toMatchObject({
      sentences: 1,
      natives: false,
      collecting: "STRUT vowel",
    });
  } finally {
    on.stop();
  }
});

test("the module's panel refuses while the extension is not running", async () => {
  await expect(extension.panel("accent", request("profile"))).rejects.toThrow(/not running/);
});
