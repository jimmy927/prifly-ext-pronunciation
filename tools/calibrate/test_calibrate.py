"""Unit tests of the calibration scripts' parsing and arithmetic: python -m unittest discover tools/calibrate."""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import fetch  # noqa: E402
import stats  # noqa: E402
from labels import arpabet_to_ipa, is_error  # noqa: E402

GRID = '''File type = "ooTextFile"
Object class = "TextGrid"
xmin = 0
xmax = 1.0
tiers? <exists>
size = 2
item []:
    item [1]:
        class = "IntervalTier"
        name = "words"
        xmin = 0
        xmax = 1.0
        intervals: size = 2
        intervals [1]:
            xmin = 0
            xmax = 0.5
            text = "is"
        intervals [2]:
            xmin = 0.5
            xmax = 1.0
            text = "this"
    item [2]:
        class = "IntervalTier"
        name = "phones"
        xmin = 0
        xmax = 1.0
        intervals: size = 4
        intervals [1]:
            xmin = 0
            xmax = 0.2
            text = "IH1"
        intervals [2]:
            xmin = 0.2
            xmax = 0.5
            text = "Z,S,s"
        intervals [3]:
            xmin = 0.5
            xmax = 0.7
            text = "DH,D,s"
        intervals [4]:
            xmin = 0.7
            xmax = 1.0
            text = "IH,sil,d"
'''


def word(i, key, variant, candidates, judged=True):
    return {"utt": "u", "i": i, "key": key, "judged": judged, "variant": variant, "phones": [], "vowels": [], "candidates": candidates}


def candidate(at, expected, heard, check, posterior, last=False, **flags):
    return {
        "at": at, "expected": expected, "heard": heard, "id": check, "last": last, "posterior": posterior,
        "wasHeard": flags.get("wasHeard", True), "expectedHeard": flags.get("expectedHeard", False),
        "variantAccepts": flags.get("variantAccepts", False),
    }  # fmt: skip


class Labels(unittest.TestCase):
    def test_arpabet(self):
        self.assertEqual(arpabet_to_ipa("AH0"), "ə")
        self.assertEqual(arpabet_to_ipa("ah1"), "ʌ")
        self.assertEqual(arpabet_to_ipa("ER0"), "ɚ")
        self.assertEqual(arpabet_to_ipa("Z*"), "z")
        self.assertIsNone(arpabet_to_ipa("err"))
        self.assertIsNone(arpabet_to_ipa(None))

    def test_error_cut(self):
        self.assertTrue(is_error({"score": 1.0}))
        self.assertFalse(is_error({"score": 1.8}))
        self.assertFalse(is_error({"score": None}))

    def test_l2arctic(self):
        labels = fetch.l2arctic_labels("l2-x", GRID)
        self.assertEqual([w["text"] for w in labels["words"]], ["is", "this"])
        z = labels["words"][0]["phones"][1]
        self.assertEqual((z["canonical"], z["perceived"], z["score"]), ("z", "s", 0.0))
        dropped = labels["words"][1]["phones"][1]
        self.assertTrue(dropped["deleted"])
        self.assertIsNone(dropped["perceived"])

    def test_speechocean(self):
        entry = {"text": "IS", "words": [{"text": "IS", "accuracy": 6, "phones": ["IH0", "Z"],
                                          "phones-accuracy": [2.0, 0.4],
                                          "mispronunciations": [{"canonical-phone": "Z", "index": 1, "pronounced-phone": "S"}]}]}  # fmt: skip
        phones = fetch.speechocean_labels("so-1", entry)["words"][0]["phones"]
        self.assertEqual(phones[1], {"canonical": "z", "perceived": "s", "score": 0.4})
        self.assertIsNone(phones[0]["perceived"])

    def test_vctk_speakers(self):
        info = "ID  AGE  GENDER  ACCENTS  REGION COMMENTS\np225  23  F    English    Southern  England\np226 22 M American Ohio\n"
        self.assertEqual(fetch.vctk_speakers(info), ["p225"])


class Stats(unittest.TestCase):
    def test_label_phone_takes_the_same_occurrence(self):
        phones = [{"canonical": c} for c in ["s", "ɪ", "s", "t"]]
        self.assertIs(stats.label_phone(["s", "ɪ", "s", "t"], 2, False, phones), phones[2])
        self.assertIsNone(stats.label_phone(["z"], 0, False, phones))

    def test_words_matched_across_punctuation(self):
        records = [word(0, "author", "", []), word(1, "of", "", [])]
        matched = stats.match_words(records, [{"text": "Author,"}, {"text": "of"}])
        self.assertEqual(matched[1]["text"], "of")

    def test_cut_offs_and_precision(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "dump").mkdir()
            (root / "corpora" / "speechocean762").mkdir(parents=True)
            # 400 native judged words, 3 with a z → s heard at 0.6, 1 at 0.8: at most 2 may flag.
            native = [word(i, "is", "ɪ z", [candidate(1, "z", "s", "z-s", 0.6 if i < 3 else 0.8)] if i < 4 else []) for i in range(400)]
            (root / "dump" / "librispeech.0.jsonl").write_text("\n".join(json.dumps(r) for r in native) + "\n")
            learners, labels = [], []
            for n in range(30):
                learners.append({**word(0, "is", "ɪ z", [candidate(1, "z", "s", "z-s", 0.9, last=True)]), "utt": f"so-{n}"})
                score = 0.0 if n < 27 else 2.0
                labels.append({"utt": f"so-{n}", "words": [{"text": "is", "phones": [{"canonical": "ɪ", "score": 2.0}, {"canonical": "z", "perceived": "s", "score": score}]}]})
            (root / "dump" / "speechocean762.0.jsonl").write_text("\n".join(json.dumps(r) for r in learners) + "\n")
            (root / "corpora" / "speechocean762" / "labels.jsonl").write_text("\n".join(json.dumps(r) for r in labels) + "\n")
            stats.main(["--dump", str(root / "dump"), "--corpora", str(root / "corpora"), "--out", str(root / "out"), "--report", str(root / "report.md")])
            cuts = json.loads((root / "out" / "thresholds.json").read_text())["contrasts"]
            self.assertEqual(cuts["z-s"]["maybe"], 0.605)
            self.assertFalse(cuts["z-s"]["off"])
            self.assertTrue(cuts["th"]["off"])
            self.assertIn("| z-s |", (root / "report.md").read_text())


if __name__ == "__main__":
    unittest.main()
