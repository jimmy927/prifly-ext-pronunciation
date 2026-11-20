import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contrastId } from "../pronounce/contrasts";
import { type Candidate, marks } from "../pronounce/judge";
import {
  cutOf,
  DEFAULT_CUT,
  loadThresholds,
  loadVowelPatterns,
  parseThresholds,
  parseVowelPatterns,
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

test("the vowel-patterns entry turns the vowel underlines on only with off: false; the contrasts do not read it", async () => {
  expect(parseVowelPatterns({ contrasts: {} })).toBe(false);
  expect(parseVowelPatterns({ contrasts: { "vowel-patterns": { off: true, why: "x" } } })).toBe(
    false,
  );
  expect(parseVowelPatterns({ contrasts: { "vowel-patterns": {} } })).toBe(false);
  expect(parseVowelPatterns({ contrasts: { "vowel-patterns": { off: false } } })).toBe(true);
  expect(() => parseVowelPatterns({ contrasts: { "vowel-patterns": { off: "no" } } })).toThrow();
  const cuts = parseThresholds({ contrasts: { "vowel-patterns": { off: false } } });
  expect([...cuts.keys()]).toEqual([]);
  // No file, or a broken one, is off.
  const folder = await mkdtemp(join(tmpdir(), "thresholds-"));
  expect(await loadVowelPatterns(join(folder, "none.json"))).toBe(false);
  await writeFile(join(folder, "bad.json"), "{ not json");
  expect(await loadVowelPatterns(join(folder, "bad.json"))).toBe(false);
});

test("the shipped file has the vowel underlines off and Z/S on at 0.70 / 0.88, everything else off", async () => {
  expect(await loadVowelPatterns(THRESHOLDS_PATH)).toBe(false);
  const shipped = await loadThresholds(THRESHOLDS_PATH);
  expect(cutOf(shipped, "z-s")).toEqual({ maybe: 0.7, sure: 0.88, off: false });
  for (const id of ["final-devoicing", "th", "w-v", "sh-ch"] as const)
    expect(cutOf(shipped, id).off).toBe(true);
  const heard = (posterior: number): Candidate => ({
    at: 1,
    expected: "z",
    heard: "s",
    id: "z-s",
    last: false,
    posterior,
    wasHeard: true,
    expectedHeard: false,
    variantAccepts: false,
  });
  expect(marks(heard(0.69), shipped)).toBe(false);
  expect(marks(heard(0.7), shipped)).toBe(true);
  expect(marks({ ...heard(0.99), id: "th" }, shipped)).toBe(false);
});
