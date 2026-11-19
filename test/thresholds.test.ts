import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contrastId } from "../pronounce/contrasts";
import { cutOf, DEFAULT_CUT, loadThresholds, parseThresholds } from "../pronounce/thresholds";

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
