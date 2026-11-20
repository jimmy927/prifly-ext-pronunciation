import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTRAST_IDS, contrastId } from "../pronounce/contrasts";
import { type Candidate, marks } from "../pronounce/judge";
import { Z_P01, Z_P05 } from "../pronounce/native";
import { loadStressCheck } from "../pronounce/stress";
import {
  cutOf,
  DEFAULT_CUT,
  DEFAULT_DEVIATE_CUT,
  deviateCutOf,
  deviateLevel,
  loadDeviateCuts,
  loadThresholds,
  parseDeviateCuts,
  parseThresholds,
  THRESHOLDS_PATH,
} from "../pronounce/thresholds";

test("no file keeps every check at 0.70 / 0.88", async () => {
  const folder = await mkdtemp(join(tmpdir(), "thresholds-"));
  const none = await loadThresholds(join(folder, "thresholds.json"));
  expect(cutOf(none, "z-s")).toEqual({ maybe: 0.7, sure: 0.88, off: false });
  await writeFile(
    join(folder, "thresholds.json"),
    JSON.stringify({ contrasts: { th: { maybe: 0.8 } } }),
  );
  const some = await loadThresholds(join(folder, "thresholds.json"));
  expect(cutOf(some, "th")).toEqual({ maybe: 0.8, sure: 0.88, off: false });
  expect(cutOf(some, "w-v")).toEqual(DEFAULT_CUT);
  // A broken file leaves every check at the defaults rather than stopping the worker.
  await writeFile(join(folder, "thresholds.json"), "{ not json");
  const broken = await loadThresholds(join(folder, "thresholds.json"));
  expect(cutOf(broken, "th")).toEqual(DEFAULT_CUT);
});

test("an id that is no check is left out, a sure below its maybe is raised to it, other keys ignored", () => {
  const cuts = parseThresholds({
    source: "stats.py",
    contrasts: {
      "x-y": { maybe: 0.1 },
      "sh-ch": { maybe: 0.9, sure: 0.5 },
      "final-devoicing": { off: true },
      "any-sound": { maybe: -3 },
    },
  });
  expect([...cuts.keys()].sort()).toEqual(["final-devoicing", "sh-ch"]);
  expect(cutOf(cuts, "sh-ch")).toEqual({ maybe: 0.9, sure: 0.9, off: false });
  expect(cutOf(cuts, "final-devoicing").off).toBe(true);
  expect(() => parseThresholds({ contrasts: { th: { maybe: 2 } } })).toThrow();
});

test("each swap belongs to one of the five checks", () => {
  expect(contrastId("z", "s", false)).toBe("z-s");
  expect(contrastId("z", "s", true)).toBe("final-devoicing");
  expect(contrastId("d", "t", true)).toBe("final-devoicing");
  expect(contrastId("d", "t", false)).toBeNull();
  expect(contrastId("ð", "d", false)).toBe("th");
  expect(contrastId("v", "w", false)).toBe("w-v");
  expect(contrastId("ʒ", "ʃ", false)).toBe("z-s");
  expect(contrastId("ʒ", "dʒ", false)).toBe("sh-ch");
  expect(contrastId("tʃ", "ʃ", false)).toBe("sh-ch");
});

test("the shipped file has every contrast on at the natives' cut-offs, never stricter than 0.70 / 0.88", async () => {
  const shipped = await loadThresholds(THRESHOLDS_PATH);
  for (const id of CONTRAST_IDS) {
    const cut = cutOf(shipped, id);
    expect(cut.off).toBe(false);
    expect(cut.maybe).toBeLessThanOrEqual(0.7);
    expect(cut.sure).toBeLessThanOrEqual(0.88);
  }
  // The looser Sensitivity steps sit at the 0.20 floor: natives never reach 1 in 50 on the measured curve.
  expect(cutOf(shipped, "z-s")).toEqual({ maybe: 0.5, sure: 0.5, off: false, looser: [0.2, 0.2] });
  expect(cutOf(shipped, "final-devoicing")).toEqual({
    maybe: 0.5,
    sure: 0.725,
    off: false,
    looser: [0.2, 0.2],
  });
  const heard = (posterior: number, id: Candidate["id"] = "z-s"): Candidate => ({
    at: 1,
    expected: "z",
    heard: "s",
    id,
    last: false,
    posterior,
    wasHeard: true,
    expectedHeard: false,
    variantAccepts: false,
  });
  expect(marks(heard(0.49), shipped)).toBe(false);
  for (const id of CONTRAST_IDS) expect(marks(heard(0.5, id), shipped)).toBe(true);
});

test("the shipped file has word stress on, and the natives'-scale checks at their 0.5th / 0.1th percentile", async () => {
  expect(await loadStressCheck(THRESHOLDS_PATH)).not.toBeNull();
  const cuts = await loadDeviateCuts(THRESHOLDS_PATH);
  for (const id of ["any-sound", "weak-vowels"] as const) {
    const cut = deviateCutOf(cuts, id);
    expect(cut.off).toBe(false);
    expect(cut.maybe).toBeCloseTo(Z_P05, 3);
    expect(cut.sure).toBeCloseTo(Z_P01, 3);
  }
});

test("the natives'-scale cut-offs: the file's, a sure looser than its maybe pulled to it, the defaults without", async () => {
  const cuts = parseDeviateCuts({
    contrasts: { "any-sound": { maybe: -3, sure: -2 }, th: { maybe: 0.5 } },
  });
  expect(deviateCutOf(cuts, "any-sound")).toEqual({ maybe: -3, sure: -3, off: false });
  expect(deviateCutOf(cuts, "weak-vowels")).toEqual(DEFAULT_DEVIATE_CUT);
  expect(() => parseDeviateCuts({ contrasts: { "weak-vowels": { maybe: 1 } } })).toThrow();
  expect(deviateLevel(-3.2, DEFAULT_DEVIATE_CUT)).toBe("sure");
  expect(deviateLevel(-2.8, DEFAULT_DEVIATE_CUT)).toBe("maybe");
  const folder = await mkdtemp(join(tmpdir(), "thresholds-"));
  expect((await loadDeviateCuts(join(folder, "none.json"))).size).toBe(0);
  await writeFile(join(folder, "bad.json"), "{ not json");
  expect((await loadDeviateCuts(join(folder, "bad.json"))).size).toBe(0);
});
