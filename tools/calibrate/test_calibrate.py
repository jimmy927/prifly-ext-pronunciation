"""Unit tests of the calibration scripts' parsing and arithmetic: python -m unittest discover tools/calibrate."""

from __future__ import annotations

import json
import statistics
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
        entry["words"][0]["stress"] = 5
        self.assertEqual(fetch.speechocean_labels("so-1", entry)["words"][0]["stress"], 5)
        self.assertEqual(fetch.speechocean_labels("so-1", entry)["labels"], fetch.SPEECHOCEAN_LABELS)

    def test_speechocean_heard_phones(self):
        # "index" counts from 0; canonical-phone has no stress digit.
        entry = {"text": "X", "words": [{"text": "X", "phones": ["AH0", "R", "Z", "D", "T", "L"],
                                         "phones-accuracy": [0, 0.4, 0.4, 0, 0, 0],
                                         "mispronunciations": [
                                             {"canonical-phone": "AH", "index": 0, "pronounced-phone": "IH R"},
                                             {"canonical-phone": "R", "index": 1, "pronounced-phone": "R*"},
                                             {"canonical-phone": "Z", "index": 2, "pronounced-phone": "S*"},
                                             {"canonical-phone": "D", "index": 3, "pronounced-phone": "<DEL>"},
                                             {"canonical-phone": "T", "index": 4, "pronounced-phone": "<unk>"},
                                             {"canonical-phone": "N", "index": 5, "pronounced-phone": "M"}]}]}  # fmt: skip
        phones = fetch.speechocean_labels("so-2", entry)["words"][0]["phones"]
        self.assertEqual([p["canonical"] for p in phones], ["ə", "ɹ", "z", "d", "t", "l"])
        # Two phones for one; a distorted R is still R; "mostly like S" is s; left out; not recognisable;
        # a block naming another phone than is at its index is not trusted.
        self.assertEqual([p["perceived"] for p in phones], ["ɪ ɹ", None, "s", None, None, None])
        self.assertEqual([p.get("deleted", False) for p in phones], [False, False, False, True, False, False])

    def test_speechocean_relabels_a_finished_fetch(self):
        with tempfile.TemporaryDirectory() as folder:
            work = Path(folder)
            corpus = fetch.Corpus(work, "speechocean762")
            corpus.folder.mkdir(parents=True)
            (corpus.folder / ".done").write_text("{}")
            (corpus.folder / "utts.tsv").write_text("so-000010011\tIS\n")
            old = {"utt": "so-000010011", "corpus": "speechocean762", "words": [{"text": "IS", "phones": []}]}
            (corpus.folder / "labels.jsonl").write_text(json.dumps(old) + "\n")
            self.assertFalse(fetch.speechocean_labels_current(corpus))
            scores = {"000010011": {"text": "IS", "words": [{"text": "IS", "phones": ["IH0", "Z"], "phones-accuracy": [2, 0],
                                                             "mispronunciations": [{"canonical-phone": "Z", "index": 1, "pronounced-phone": "S"}]}]}}  # fmt: skip
            fetch.relabel_speechocean(corpus, scores)
            self.assertTrue(fetch.speechocean_labels_current(corpus))
            row = json.loads((corpus.folder / "labels.jsonl").read_text())
            self.assertEqual(row["words"][0]["phones"][1]["perceived"], "s")

    def test_vctk_speakers(self):
        info = "ID  AGE  GENDER  ACCENTS  REGION COMMENTS\np225  23  F    English    Southern  England\np226 22 M American Ohio\n"
        self.assertEqual(fetch.vctk_speakers(info), ["p225"])


class Stats(unittest.TestCase):
    def test_label_phone_takes_the_same_occurrence(self):
        phones = [{"canonical": c} for c in ["s", "ɪ", "s", "t"]]
        self.assertIs(stats.label_phone(["s", "ɪ", "s", "t"], 2, phones), phones[2])
        self.assertIsNone(stats.label_phone(["z"], 0, phones))

    def test_label_phone_lines_up_another_pronunciation(self):
        # Britfone's "clothes" has a ð the raters' (CMUdict's other one) has not: the z is their 4th phone, our 5th.
        phones = [{"canonical": c} for c in ["k", "l", "oʊ", "z"]]
        self.assertIs(stats.label_phone(["k", "l", "əʊ", "ð", "z"], 4, phones), phones[3])
        self.assertIsNone(stats.label_phone(["k", "l", "əʊ", "ð", "z"], 3, phones))
        # One z more in ours, before theirs: the z lined up is the last one, not the first by rank.
        phones = [{"canonical": c} for c in ["ɪ", "z"]]
        self.assertIs(stats.label_phone(["z", "ɪ", "z"], 2, phones), phones[1])
        self.assertIsNone(stats.label_phone(["z", "ɪ", "z"], 0, phones))
        # Spelling apart, the same phone: r and ɹ, a length mark.
        self.assertEqual(stats.align_phones(["r", "iː"], ["ɹ", "i"]), {0: 0, 1: 1})

    def test_a_speechocean_swap_counts_as_strict(self):
        # As scores.json (the pinned one) has it: CHEESE, Z heard as S, IY as "IH R".
        entry = {"text": "CHEESE", "words": [{
            "text": "CHEESE", "accuracy": 3, "stress": 10, "phones": ["CH", "IY0", "Z"], "phones-accuracy": [2, 0.4, 0.4],
            "mispronunciations": [{"canonical-phone": "IY", "index": 1, "pronounced-phone": "IH R"},
                                  {"canonical-phone": "Z", "index": 2, "pronounced-phone": "S"}]}]}  # fmt: skip
        labels = fetch.speechocean_labels("so-1", entry)
        # Britfone's "cheese", as dump.ts writes it: the final z heard as s.
        records = [{**word(0, "cheese", "tʃ iː z", [candidate(2, "z", "s", "z-s", 0.9, last=True),
                                                     candidate(2, "z", "s", "final-devoicing", 0.9, last=True)]), "utt": "so-1"}]  # fmt: skip
        tally = stats.Tally()
        tally.learners("speechocean762", records, labels)
        for check in ("z-s", "final-devoicing"):
            numbers = stats.learner_numbers(tally.learner[check], 0.5)
            self.assertEqual((numbers["matched"], numbers["precision"], numbers["strict"], numbers["recall"]), (1, 1.0, 1.0, 1.0))
        # Heard as another phone than flagged: right (scored under 1.5), not strict.
        records[0]["candidates"] = [candidate(2, "z", "ʃ", "z-s", 0.9, last=True)]
        tally = stats.Tally()
        tally.learners("speechocean762", records, labels)
        numbers = stats.learner_numbers(tally.learner["z-s"], 0.5)
        self.assertEqual((numbers["precision"], numbers["strict"]), (1.0, 0.0))

    def test_stale_dump_lengths_are_said(self):
        tally = stats.Tally()
        old = {k: v for k, v in vowel(20, -20, None).items() if k not in ("from", "to")}
        tally.native([{**word(0, "of", None, [], judged=False), "vowels": [old]}])
        self.assertTrue(stats.stale_lengths(tally))
        tally = stats.Tally()
        tally.native([{**word(0, "of", None, [], judged=False), "vowels": [vowel(80, -20, None)]}])
        self.assertFalse(stats.stale_lengths(tally))

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
            self.assertIn("learner precision 0.90 on 30 labelled flags", cuts["z-s"]["why"])
            # No learner flags at all: still on, the reader's switch decides; never stricter than 0.70 / 0.88.
            self.assertFalse(cuts["th"]["off"])
            self.assertLessEqual(cuts["th"]["maybe"], 0.70)
            self.assertLessEqual(cuts["th"]["sure"], 0.88)
            self.assertIn("| z-s |", (root / "report.md").read_text())

    def test_deviate_of_mirrors_native_ts(self):
        curve = [(-3.0, -2.3263), (-2.0, -1.6449), (0.0, 0.0)]
        self.assertAlmostEqual(stats.deviate_of(curve, -2.0), -1.6449)
        self.assertAlmostEqual(stats.deviate_of(curve, -1.0), -0.82245)
        # Past the last point the end segment is carried on, as a normal tail.
        self.assertAlmostEqual(stats.deviate_of(curve, -4.0), -3.0077)
        self.assertIsNone(stats.curve_of({"n": 50, "p1": -3.0, "p50": 0.0}))

    def test_deviate_cut_offs_from_natives(self):
        normal = statistics.NormalDist()
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "dump").mkdir()
            (root / "corpora").mkdir()
            # 400 native judged words, each with a j whose goodness spreads as 5 + 2z; the any-sound
            # candidates: 2 words at -1 (about z -3), 2 at -3 (about z -4), the rest at 5.
            records = []
            for i in range(400):
                lpr = 5 + 2 * normal.inv_cdf((i + 1) / 401)
                said = -1.0 if i < 2 else -3.0 if i < 4 else 5.0
                records.append({**word(i, "just", "dʒ ʌ s t", []), "phones": [{"phone": "dʒ", "lpr": lpr, "lp": 0.0}],
                                "anySound": [{"at": 0, "expected": "dʒ", "rival": "j", "lpr": said, "last": False}]})  # fmt: skip
            (root / "dump" / "librispeech.0.jsonl").write_text("\n".join(json.dumps(r) for r in records) + "\n")
            stats.main(["--dump", str(root / "dump"), "--corpora", str(root / "corpora"), "--out", str(root / "out"), "--report", str(root / "report.md")])
            cuts = json.loads((root / "out" / "thresholds.json").read_text())["contrasts"]
            native = json.loads((root / "out" / "native-stats.json").read_text())
            curve = stats.curve_of(native["phones"]["dʒ"]["lpr"])
            # Maybe flags the two at -3 only (2 in 400 = 1 in 200), sure none; never looser than the 0.5th percentile.
            any_sound = cuts["any-sound"]
            self.assertFalse(any_sound["off"])
            self.assertLess(any_sound["maybe"], stats.deviate_of(curve, -1.0))
            self.assertGreaterEqual(any_sound["maybe"], stats.deviate_of(curve, -3.0))
            self.assertLessEqual(any_sound["maybe"], stats.Z_P05)
            self.assertLess(any_sound["sure"], stats.deviate_of(curve, -3.0))
            # No weak-vowel candidates in this dump: the natives' 0.5th / 0.1th percentiles, said why.
            self.assertEqual((cuts["weak-vowels"]["maybe"], cuts["weak-vowels"]["sure"]), (stats.Z_P05, stats.Z_P01))
            self.assertIn("not measured", cuts["weak-vowels"]["why"])
            self.assertIn("## Any other swapped sound and unreduced vowels", (root / "report.md").read_text())


FIXTURE = Path(__file__).resolve().parents[2] / "test" / "fixtures" / "stress-sentence.json"


def vowel(ms, db, hz, at=0, stressed=False):
    return {"at": at, "phone": "ə", "stressed": stressed, "from": 0, "to": ms / 20, "durationMs": ms, "rmsDb": db, "f0Hz": hz}


def stress_utterance(utt, reversed_stress):
    """A filler word of three vowels and a two-vowel content word stressed on its first; `reversed_stress`: said on its second."""
    strong, weak = (160, -18, 210), (60, -27, 170)
    first, second = (weak, strong) if reversed_stress else (strong, weak)
    filler = {**word(0, "of", None, [], judged=False), "utt": utt, "vowels": [vowel(70, -26, 160), vowel(80, -25, 165), vowel(60, -28, 150)]}
    content = {**word(1, "table", "t eɪ b ə l", []), "utt": utt, "stressVowel": 0, "stressAccepts": [0]}
    content["vowels"] = [vowel(*first, at=1, stressed=True), vowel(*second, at=3)]
    return [filler, content]


class Stress(unittest.TestCase):
    def test_readings_match_stress_ts(self):
        fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
        readings = stats.stress_readings(fixture["words"])
        self.assertEqual(len(readings), len(fixture["readings"]))
        for got, want in zip(readings, fixture["readings"]):
            if want is None:
                self.assertIsNone(got)
                continue
            self.assertEqual({k: got[k] for k in ("combo", "stressed", "winner", "accepted")}, {k: want[k] for k in ("combo", "stressed", "winner", "accepted")})
            self.assertAlmostEqual(got["lead"], want["lead"], places=6)

    def run_stats(self, learner_stress):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "dump").mkdir()
            (root / "corpora" / "speechocean762").mkdir(parents=True)
            # 2400 native words read, 5 said the other way round: at most 12 may be marked at maybe, 2 at sure.
            native = [r for n in range(2400) for r in stress_utterance(f"n{n}", n < 5)]
            (root / "dump" / "librispeech.0.jsonl").write_text("\n".join(json.dumps(r) for r in native) + "\n")
            learners, labels = [], []
            for n in range(30):
                learners += stress_utterance(f"so-{n}", True)
                score = (5 if n < 27 else 10) if learner_stress else None
                labels.append({"utt": f"so-{n}", "words": [{"text": "of", "phones": []}, {"text": "table", "stress": score, "phones": []}]})
            (root / "dump" / "speechocean762.0.jsonl").write_text("\n".join(json.dumps(r) for r in learners) + "\n")
            (root / "corpora" / "speechocean762" / "labels.jsonl").write_text("\n".join(json.dumps(r) for r in labels) + "\n")
            stats.main(["--dump", str(root / "dump"), "--corpora", str(root / "corpora"), "--out", str(root / "out"), "--report", str(root / "report.md")])
            cuts = json.loads((root / "out" / "thresholds.json").read_text())["contrasts"]
            natives = json.loads((root / "out" / "native-stats.json").read_text())["stress"]["lead"]
            return cuts["stress"], natives, (root / "report.md").read_text(encoding="utf-8")

    def test_stress_ships_on_learner_stress_scores(self):
        entry, natives, report = self.run_stats(learner_stress=True)
        self.assertFalse(entry["off"])
        cut = entry["cuts"]["dur+rms+f0"]
        self.assertGreater(cut["maybe"], 0)
        self.assertGreaterEqual(cut["sure"], cut["maybe"])
        self.assertEqual(natives["dur+rms+f0"]["n"], 2400)
        self.assertIn("p99.5", natives["dur+rms+f0"])
        self.assertIn("## Word stress", report)

    def test_stress_stays_on_without_learner_stress_scores_and_says_so(self):
        entry, _, report = self.run_stats(learner_stress=False)
        self.assertFalse(entry["off"])
        self.assertIn("no learner stress labels", entry["why"])
        self.assertIn("Bar: no learner stress labels", report)


class Sensitivity(unittest.TestCase):
    def test_a_rate_on_the_curve_is_measured(self):
        curve = [(0.2, 0.15), (0.3, 0.05), (0.4, 0.015), (0.5, 0.004)]
        self.assertEqual(stats.loosened_cut(curve, 1 / 50, 0.5), (0.4, "measured"))
        self.assertEqual(stats.loosened_cut(curve, 1 / 10, 0.4), (0.3, "measured"))
        # Never looser than the step before.
        self.assertEqual(stats.loosened_cut(curve, 1 / 10, 0.25), (0.25, "measured"))

    def test_a_rate_under_the_whole_curve_is_extrapolated_down_to_the_floor(self):
        # Ten times fewer flags every 0.1: 1 in 50 at about 0.40, below the curve's 0.5.
        curve = [(0.5, 0.002), (0.6, 0.0002), (0.7, 0.00002)]
        cut, how = stats.loosened_cut(curve, 1 / 50, 0.5)
        self.assertEqual(how, "extrapolated")
        self.assertAlmostEqual(cut, 0.4, places=3)
        # Flat, or reaching it only below the floor: the floor.
        self.assertEqual(stats.loosened_cut([(0.5, 0.0015), (0.6, 0.0013)], 1 / 50, 0.5), (0.2, "floor"))
        self.assertEqual(stats.loosened_cut([(0.5, 0.0), (0.6, 0.0)], 1 / 10, 0.5), (0.2, "floor"))

    def test_natives_over_the_rate_everywhere_keep_the_step_before(self):
        self.assertEqual(stats.loosened_cut([(0.5, 0.3), (0.9, 0.2)], 1 / 10, 0.5), (0.5, "none"))

    def test_thresholds_json_gets_each_check_its_looser_steps(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "dump").mkdir()
            (root / "corpora").mkdir()
            # 100 native judged words, 10 with a th → t heard at 0.3 and 1 more at 0.6.
            native = [word(i, "thin", "θ ɪ n", [candidate(0, "θ", "t", "th", 0.3 if i < 10 else 0.6)] if i < 11 else []) for i in range(100)]
            (root / "dump" / "librispeech.0.jsonl").write_text("\n".join(json.dumps(r) for r in native) + "\n")
            stats.main(["--dump", str(root / "dump"), "--corpora", str(root / "corpora"), "--out", str(root / "out"), "--report", str(root / "report.md")])
            cuts = json.loads((root / "out" / "thresholds.json").read_text())["contrasts"]
            # 1 in 50 is reached above 0.3 (only the 0.6 one: 1 in 100); 1 in 10 at 0.3 (11 in 100 is over it).
            self.assertEqual(cuts["th"]["looser"]["1/50"], 0.305)
            self.assertEqual(cuts["th"]["looser"]["1/10"], 0.305)
            # No th flag of natives at all elsewhere: the floor, said so.
            self.assertEqual(cuts["w-v"]["looser"], {"1/50": 0.2, "1/10": 0.2})
            self.assertIn("1/50 floor", cuts["w-v"]["why"])
            self.assertEqual(cuts["any-sound"]["looser"], {"1/50": stats.Z_P2, "1/10": stats.Z_P10})
            self.assertIn("| th | ", (root / "report.md").read_text())


if __name__ == "__main__":
    unittest.main()
