"""Turn dump.ts's per-word JSON lines into the extension's cut-offs and native statistics.

Reads DUMP/<corpus>.<shard>.jsonl (natives: librispeech, vctk; learners:
speechocean762, l2arctic, with CORPORA/<corpus>/labels.jsonl from fetch.py) and writes

  OUT/thresholds.json    per check: the lowest posterior cut-off ("maybe") at which
                         natives get at most 1 flag per 200 judged words, "sure" at 1 per
                         1000, never stricter than the 0.70 / 0.88 the extension had before
                         a calibration; and the same for word stress ("stress": per cue
                         combination the lead cut-offs, natives at 1 per 200 and 1 per 1000
                         read words, `decide_stress`), and for any other swapped sound and
                         unreduced vowels ("any-sound", "weak-vowels": the native deviate a
                         word's worst sound must reach, never looser than the natives' 0.5th
                         percentile, `decide_deviate`). Each also gets "looser": its maybe for
                         the Sensitivity setting's steps, natives at 1 per 50 and 1 per 10
                         (`LOOSER_RATES`; a contrast never below a posterior of 0.2,
                         `loosened_cut`). Every check is written "off": false:
                         whether one is drawn is the reader's switch in Settings; how often
                         learners' flags are right (the 80% bar) is said in "why" and the report
  OUT/native-stats.json  per phone and per vowel the natives' LPR percentiles, per vowel
                         the length percentiles, and the natives' stress margins (per cue,
                         and the leads pronounce/stress.ts measures, per cue combination)
  REPORT                 every number above, readable

A flag here is exactly what pronounce/judge.ts marks (`marks`): a candidate swap the
greedy reading heard, without the expected phone heard there too, that no other
accepted pronunciation explains, at or over the cut-off.
"""

from __future__ import annotations

import argparse
import bisect
import difflib
import json
import math
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

from labels import ERROR_SCORE, is_error

NATIVE = {"librispeech", "vctk"}
LEARNER = {"speechocean762", "l2arctic"}
CHECKS = ["z-s", "final-devoicing", "th", "w-v", "sh-ch"]
# 0.5: the confirmed-pattern underlines' cut-off (pronounce/confirmed.ts), at most 1 native word in 200.
PERCENTILES = [0.5, 1, 5, 10, 25, 50, 75, 90, 95, 99]
# The cut-offs tried, 0.500 to 0.995: below a half the heard phone was barely the likeliest at all.
GRID = [round(0.50 + 0.005 * step, 3) for step in range(100)]
TODAY = 0.70
# The cut-offs the extension had before any calibration (pronounce/thresholds.ts): never stricter.
DEFAULT_MAYBE, DEFAULT_SURE = 0.70, 0.88

# The Sensitivity setting's looser steps (pronounce/sensitivity.ts): each check's "maybe" where natives get a flag
# on 1 judged word in 50, and 1 in 10 (thresholds.json's "looser"); "sure" stays one step stricter, the step before's.
LOOSER_RATES = {"1/50": 1 / 50, "1/10": 1 / 10}
# A contrast is never marked below this posterior, whatever the natives' rate: the heard phone was barely in the running.
POSTERIOR_FLOOR = 0.2
# The posterior cut-offs the looser steps try: from the floor up, 0.005 apart.
LOOSE_GRID = [round(POSTERIOR_FLOOR + 0.005 * step, 3) for step in range(160)]

# Any other swapped sound and unreduced vowels (pronounce/any-sound.ts, weak-vowels.ts): a word is
# flagged when its worst candidate's native deviate (pronounce/native.ts) is at or below the cut-off.
DEVIATE_CHECKS = {"any-sound": "anySound", "weak-vowels": "weakVowels"}
# native.ts's normal deviates of the percentiles, and its least natives for a curve.
Z_OF = {0.5: -2.5758, 1: -2.3263, 5: -1.6449, 10: -1.2816, 25: -0.6745, 50: 0.0, 75: 0.6745, 90: 1.2816, 95: 1.6449, 99: 2.3263}
MIN_NATIVE = 100
Z_P05, Z_P01 = -2.5758, -3.0902
# The deviate cut-offs tried: from the natives' 0.5th percentile (never looser) down, 0.05 apart.
DEVIATE_GRID = [round(Z_P05 - 0.05 * step, 4) for step in range(120)]
# The Sensitivity steps' (LOOSER_RATES): their natives' 2nd and 10th percentile until a dump measures the rate per
# word, then the loosest deviate from the 10th percentile down at which natives stay under the step's rate.
Z_P2, Z_P10 = -2.0537, -1.2816
DEVIATE_LOOSER = {"1/50": Z_P2, "1/10": Z_P10}
DEVIATE_LOOSE_GRID = [round(Z_P10 - 0.05 * step, 4) for step in range(26)]

# Word stress, as pronounce/stress.ts reads it (test/fixtures/stress-sentence.json holds both to the same numbers).
STRESS = "stress"
COMBOS = ["dur+rms+f0", "dur+rms"]
MIN_POOL = 4
FLOOR = {"duration": 0.1, "rms": 1.0, "pitch": 0.5}
# The lead cut-offs tried, 0.05 to 6.00: at zero the other syllable only ties with the stressed one.
LEAD_GRID = [round(0.05 * step, 2) for step in range(1, 121)]
LEAD_PERCENTILES = [1, 5, 10, 25, 50, 75, 90, 95, 99, 99.5, 99.9]
# speechocean762 scores a word's stress 10 (right, or one syllable) or 5 (wrong); under this it was wrong.
STRESS_WRONG = 7.5


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    at = (len(ordered) - 1) * p / 100
    low, high = math.floor(at), math.ceil(at)
    return ordered[low] + (ordered[high] - ordered[low]) * (at - low)


def summary(values: list[float]) -> dict:
    ordered = sorted(values)
    out: dict = {"n": len(ordered)}
    for p in PERCENTILES:
        value = percentile(ordered, p)
        out[f"p{p}"] = None if value is None else round(value, 4)
    return out


def _scale(values: list[float], floor: float) -> tuple[float, float] | None:
    if len(values) < MIN_POOL:
        return None
    mean = sum(values) / len(values)
    variance = sum((v - mean) ** 2 for v in values) / len(values)
    return mean, max(floor, math.sqrt(variance))


def _voiced(vowel: dict) -> bool:
    return vowel["f0Hz"] is not None and vowel["f0Hz"] > 0


def _reading(word: dict, scales: dict) -> dict | None:
    vowels, stressed = word["vowels"], word["stressed"]
    if stressed < 0 or stressed >= len(vowels) or len(vowels) < 2:
        return None
    if scales["duration"] is None or scales["rms"] is None or any(v["durationMs"] <= 0 for v in vowels):
        return None
    combo = "dur+rms+f0" if all(_voiced(v) for v in vowels) and scales["pitch"] is not None else "dur+rms"

    def prominence(v: dict) -> float:
        (dm, ds), (rm, rs) = scales["duration"], scales["rms"]
        parts = [(math.log(max(1, v["durationMs"])) - dm) / ds, (v["rmsDb"] - rm) / rs]
        if combo == "dur+rms+f0":
            pm, ps = scales["pitch"]
            parts.append((12 * math.log2(v["f0Hz"]) - pm) / ps)
        return sum(parts) / len(parts)

    scores = [prominence(v) for v in vowels]
    winner, lead = -1, -math.inf
    for at, score in enumerate(scores):
        if at != stressed and score - scores[stressed] > lead:
            winner, lead = at, score - scores[stressed]
    return {"combo": combo, "stressed": stressed, "winner": winner, "lead": lead, "accepted": winner in word["accepts"]}


def stress_readings(words: list[dict]) -> list[dict | None]:
    """pronounce/stress.ts's `stressReadings`: each word's lead, its cues scaled by the whole sentence's."""
    vowels = [v for word in words for v in word["vowels"] if v["durationMs"] > 0]
    scales = {
        "duration": _scale([math.log(max(1, v["durationMs"])) for v in vowels], FLOOR["duration"]),
        "rms": _scale([v["rmsDb"] for v in vowels], FLOOR["rms"]),
        "pitch": _scale([12 * math.log2(v["f0Hz"]) for v in vowels if _voiced(v)], FLOOR["pitch"]),
    }
    return [_reading(word, scales) for word in words]


def record_readings(records: list[dict]) -> list[dict | None]:
    """An utterance's dump records as stress readings; a dump from before `stressAccepts` accepts no other stress."""
    return stress_readings(
        [
            {
                "vowels": record["vowels"],
                "stressed": record.get("stressVowel", -1) if record["judged"] else -1,
                "accepts": record.get("stressAccepts", []),
            }
            for record in records
        ]
    )


def eligible(candidate: dict) -> bool:
    """judge.ts's conditions for a mark, the posterior aside."""
    return candidate["wasHeard"] and not candidate["expectedHeard"] and not candidate["variantAccepts"]


def utterances(dump: Path):
    """(corpus, utt, [word records]) per utterance, an utterance's lines being written together."""
    for path in sorted(dump.glob("*.jsonl")):
        corpus = path.name.split(".")[0]
        current: list[dict] = []
        utt = None
        with open(path, encoding="utf-8") as lines:
            for line in lines:
                if not line.strip():
                    continue
                record = json.loads(line)
                if record["utt"] != utt and current:
                    yield corpus, utt, current
                    current = []
                utt = record["utt"]
                current.append(record)
        if current:
            yield corpus, utt, current


def norm(word: str) -> str:
    return re.sub(r"^[^\w']+|[^\w]+$", "", word.lower().replace("’", "'"))


def match_words(records: list[dict], labelled: list[dict]) -> dict[int, dict]:
    """Dump word index -> its labelled word, by the two word sequences lined up."""
    ours = [record["key"] for record in records]
    theirs = [norm(word["text"]) for word in labelled]
    matched = {}
    for block in difflib.SequenceMatcher(a=ours, b=theirs, autojunk=False).get_matching_blocks():
        for k in range(block.size):
            matched[records[block.a + k]["i"]] = labelled[block.b + k]
    return matched


# pronounce/phones.ts's isVowel.
VOWEL = re.compile(r"[aeiouyæɑɒɔəɛɜɪʊʌɐɚᵻøœɨʉɵɤɯ]")


def phone_key(phone: str | None) -> str:
    """A phone as either side may write it: no length mark, "ɹ" for r, "ɡ" for g."""
    bare = (phone or "").replace("ː", "")
    return {"r": "ɹ", "g": "ɡ"}.get(bare, bare)


def align_phones(ours: list[str], theirs: list[str]) -> dict[int, int]:
    """Our phone index -> the labelled phone's, the two pronunciations lined up with the fewest edits.

    The chosen pronunciation need not be the raters' (another dictionary, a phone more or
    less), so phones are matched by place, not by index. A vowel never stands for a consonant.
    """

    def cost(a: str, b: str) -> int:
        if phone_key(a) == phone_key(b):
            return 0
        return 1 if bool(VOWEL.search(a)) == bool(VOWEL.search(b)) else 3

    n, m = len(ours), len(theirs)
    table = [[0] * (m + 1) for _ in range(n + 1)]
    for i in range(n + 1):
        for j in range(m + 1):
            if i == 0 or j == 0:
                table[i][j] = i + j
            else:
                table[i][j] = min(
                    table[i - 1][j - 1] + cost(ours[i - 1], theirs[j - 1]), table[i - 1][j] + 1, table[i][j - 1] + 1
                )
    pairs: dict[int, int] = {}
    i, j = n, m
    while i > 0 and j > 0:
        if table[i][j] == table[i - 1][j - 1] + cost(ours[i - 1], theirs[j - 1]):
            pairs[i - 1] = j - 1
            i, j = i - 1, j - 1
        elif table[i][j] == table[i - 1][j] + 1:
            i -= 1
        else:
            j -= 1
    return pairs


def label_phone(variant: list[str], at: int, phones: list[dict]) -> dict | None:
    """The labelled phone for phone `at` of our pronunciation: the one lined up with it, when it is the same phone."""
    theirs = [phone.get("canonical") or "" for phone in phones]
    j = align_phones(variant, theirs).get(at)
    if j is None or phone_key(theirs[j]) != phone_key(variant[at]):
        return None
    return phones[j]


class Tally:
    def __init__(self) -> None:
        self.corpora: dict[str, dict] = defaultdict(lambda: {"utterances": 0, "failed": 0, "words": 0, "judged": 0})
        self.phone_lpr: dict[str, list[float]] = defaultdict(list)
        self.phone_lp: dict[str, list[float]] = defaultdict(list)
        self.vowel_lpr: dict[str, list[float]] = defaultdict(list)
        self.vowel_ms: dict[str, list[float]] = defaultdict(list)
        self.margins: dict[str, list[float]] = defaultdict(list)
        self.wins: dict[str, list[int]] = defaultdict(list)
        self.native_judged = 0
        # Per check, per native judged word with an eligible candidate: its highest posterior.
        self.native_peaks: dict[str, list[float]] = defaultdict(list)
        # Per check, learner rows: (corpus, posterior, eligible, matched, error, heard-as-flagged).
        self.learner: dict[str, list[tuple]] = defaultdict(list)
        # Word stress, per read word: natives (combo, lead, accepted); learners (corpus, combo, lead, accepted,
        # the raters' stress score or None).
        self.stress_native: list[tuple] = []
        self.stress_learner: list[tuple] = []
        # Vowels of a dump from before dump.ts measured them over the stretch they own (no "from"):
        # their length is the aligned frames', 20 ms nearly always.
        self.unspanned = 0
        # Any other swapped sound and unreduced vowels, per native judged word of a dump that has
        # them: its candidates as (expected phone, LPR); words of a dump from before them are not counted.
        self.native_deviate: dict[str, list[list[tuple[str, float]]]] = defaultdict(list)

    def count_unspanned(self, records: list[dict]) -> None:
        self.unspanned += sum(1 for record in records for vowel in record["vowels"] if "from" not in vowel)

    def native(self, records: list[dict]) -> None:
        self.count_unspanned(records)
        for reading in record_readings(records):
            if reading is not None:
                self.stress_native.append((reading["combo"], reading["lead"], reading["accepted"]))
        for record in records:
            for phone in record["phones"]:
                self.phone_lpr[phone["phone"]].append(phone["lpr"])
                self.phone_lp[phone["phone"]].append(phone["lp"])
            for vowel in record["vowels"]:
                lpr = record["phones"][vowel["at"]]["lpr"] if vowel["at"] < len(record["phones"]) else None
                if lpr is not None:
                    self.vowel_lpr[vowel["phone"]].append(lpr)
                self.vowel_ms[vowel["phone"]].append(vowel["durationMs"])
            self.stress(record)
            if not record["judged"]:
                continue
            self.native_judged += 1
            for check, field in DEVIATE_CHECKS.items():
                if field in record:
                    found = [(c.get("expected", "ə"), c["lpr"]) for c in record[field]]
                    self.native_deviate[check].append(found)
            peaks: dict[str, float] = {}
            for candidate in record["candidates"]:
                if eligible(candidate):
                    peaks[candidate["id"]] = max(peaks.get(candidate["id"], 0.0), candidate["posterior"])
            for check, peak in peaks.items():
                self.native_peaks[check].append(peak)

    def stress(self, record: dict) -> None:
        vowels = record["vowels"]
        stressed = next((v for v in vowels if v["stressed"]), None)
        others = [v for v in vowels if not v["stressed"]]
        if stressed is None or not others:
            return
        longest = max(v["durationMs"] for v in others)
        self.margins["durationLogRatio"].append(math.log(max(1, stressed["durationMs"]) / max(1, longest)))
        self.wins["longest"].append(int(stressed["durationMs"] > longest))
        loudest = max(v["rmsDb"] for v in others)
        self.margins["rmsDb"].append(stressed["rmsDb"] - loudest)
        self.wins["loudest"].append(int(stressed["rmsDb"] > loudest))
        pitched = [v["f0Hz"] for v in others if v["f0Hz"]]
        if stressed["f0Hz"] and pitched:
            self.margins["f0Semitones"].append(12 * math.log2(stressed["f0Hz"] / max(pitched)))
            self.wins["highest"].append(int(stressed["f0Hz"] > max(pitched)))

    def learners(self, corpus: str, records: list[dict], labels: dict | None) -> None:
        self.count_unspanned(records)
        matched = match_words(records, labels["words"]) if labels else {}
        for record, reading in zip(records, record_readings(records)):
            if reading is not None:
                score = (matched.get(record["i"]) or {}).get("stress")
                self.stress_learner.append((corpus, reading["combo"], reading["lead"], reading["accepted"], score))
        for record in records:
            if not record["judged"] or record["variant"] is None:
                continue
            variant = record["variant"].split(" ")
            word = matched.get(record["i"])
            for candidate in record["candidates"]:
                phone = None if word is None else label_phone(variant, candidate["at"], word["phones"])
                perceived = None if phone is None else phone.get("perceived")
                heard_right = perceived is not None and phone_key(perceived) == phone_key(candidate["heard"])
                self.learner[candidate["id"]].append(
                    (corpus, candidate["posterior"], eligible(candidate), phone is not None,
                     phone is not None and is_error(phone), heard_right)
                )  # fmt: skip


def native_rate(tally: Tally, check: str, cut: float) -> float:
    if tally.native_judged == 0:
        return math.inf
    return sum(1 for peak in tally.native_peaks[check] if peak >= cut) / tally.native_judged


def lowest_cut(tally: Tally, check: str, rate: float) -> float | None:
    return next((cut for cut in GRID if native_rate(tally, check, cut) <= rate), None)


def loosened_cut(curve: list[tuple[float, float]], rate: float, stricter: float, floor: float = POSTERIOR_FLOOR) -> tuple[float, str]:
    """The lowest posterior cut-off at which natives get at most `rate` flags per judged word, never stricter than
    `stricter` (the step before's) nor below `floor`, and how it was found: "measured", "extrapolated", "floor", or
    "none" (natives pass `rate` all along the curve, so the step stays at `stricter`).

    `curve` holds (cut-off, native rate) points. Where the natives' rate is under `rate` already at the curve's
    lowest cut-off, the rate cannot be reached on it: the curve is carried on below, straight in log rate through
    its lowest point and the next one whose rate is lower (both above 0), down to the cut-off where it would
    reach `rate`; where the curve does not fall that way, or would reach it only below the floor, the floor."""
    points = sorted(curve)
    low_cut, low_rate = points[0]
    if low_rate > rate:
        found = next((cut for cut, r in points if r <= rate), None)
        return (stricter, "none") if found is None else (min(found, stricter), "measured")
    lower = next(((cut, r) for cut, r in points[1:] if 0 < r < low_rate), None)
    if low_rate <= 0 or lower is None:
        return min(floor, stricter), "floor"
    slope = (math.log(lower[1]) - math.log(low_rate)) / (lower[0] - low_cut)
    cut = low_cut + (math.log(rate) - math.log(low_rate)) / slope
    if cut <= floor:
        return min(floor, stricter), "floor"
    return min(round(cut, 3), stricter), "extrapolated"


def looser_contrast(curve: list[tuple[float, float]], maybe: float) -> tuple[dict, str]:
    """A contrast's "looser" from the natives' `curve`, and what to say of it where a step was not measured."""
    looser, said, stricter = {}, [], maybe
    for step, rate in LOOSER_RATES.items():
        cut, how = loosened_cut(curve, rate, stricter)
        looser[step] = stricter = cut
        if how != "measured":
            said.append(f"{step} {how} ({cut:.3f})")
    return looser, ("" if not said else "looser steps not reached on the natives' curve: " + ", ".join(said))


def learner_numbers(rows: list[tuple], cut: float | None, corpus: str | None = None) -> dict:
    rows = [row for row in rows if corpus is None or row[0] == corpus]
    if cut is None:
        return {"flags": 0, "matched": 0, "right": 0, "precision": None, "strict": None, "recall": None}
    flags = [row for row in rows if row[2] and row[1] >= cut]
    matched = [row for row in flags if row[3]]
    right = sum(1 for row in matched if row[4])
    strict = sum(1 for row in matched if row[5])
    heard = [row for row in rows if row[5]]
    found = sum(1 for row in heard if row[2] and row[1] >= cut)
    return {
        "flags": len(flags),
        "matched": len(matched),
        "right": right,
        "precision": right / len(matched) if matched else None,
        "strict": strict / len(matched) if matched else None,
        "recall": found / len(heard) if heard else None,
        "labelledSwaps": len(heard),
    }


def decide(tally: Tally, args) -> dict:
    """Each contrast's cut-offs from natives, never stricter than the defaults; `bar`: why learners' flags miss the ship bar, "" when they meet it."""
    out = {}
    for check in CHECKS:
        maybe = min(lowest_cut(tally, check, args.fa_rate) or DEFAULT_MAYBE, DEFAULT_MAYBE)
        sure = min(lowest_cut(tally, check, args.sure_fa_rate) or DEFAULT_SURE, DEFAULT_SURE)
        sure = max(sure, maybe)
        learners = learner_numbers(tally.learner[check], maybe)
        if learners["matched"] < args.min_flags:
            bar = f"only {learners['matched']} labelled learner flags (need {args.min_flags})"
        elif learners["precision"] < args.min_precision:
            bar = f"precision {learners['precision']:.2f} under {args.min_precision:.2f}"
        else:
            bar = ""
        precision = "–" if learners["precision"] is None else f"{learners['precision']:.2f}"
        curve = [(cut, native_rate(tally, check, cut)) for cut in LOOSE_GRID]
        looser, unreached = looser_contrast(curve, maybe)
        why = (
            f"natives: {native_rate(tally, check, maybe):.2%} of words at {maybe:.3f}; "
            f"learner precision {precision} on {learners['matched']} labelled flags"
        ) + (f"; {unreached}" if unreached else "")
        out[check] = {"maybe": maybe, "sure": sure, "looser": looser, "learners": learners, "off": False, "bar": bar, "why": why}
    return out


def curve_of(summary_: dict) -> list[tuple[float, float]] | None:
    """pronounce/native.ts's curve of a summary: (value, z) points in rising order; None for too few natives."""
    points = [(summary_[f"p{p}"], z) for p, z in Z_OF.items() if summary_.get(f"p{p}") is not None]
    rising = all(b[0] >= a[0] for a, b in zip(points, points[1:]))
    return points if summary_["n"] >= MIN_NATIVE and len(points) >= 2 and rising else None


def deviate_of(curve: list[tuple[float, float]], lpr: float) -> float:
    """pronounce/native.ts's `deviateOf`: `lpr` read off the line between the two points around it, the end ones carried on."""
    at = 1
    while at < len(curve) - 1 and curve[at][0] < lpr:
        at += 1
    (ax, az), (bx, bz) = curve[at - 1], curve[at]
    return az if bx == ax else az + (lpr - ax) * (bz - az) / (bx - ax)


class NativeWorst:
    """A natives'-scale check's native judged words: each one's worst candidate deviate (None: no candidate)."""

    def __init__(self, tally: Tally, check: str) -> None:
        curves = (
            {"ə": curve_of(summary(tally.vowel_lpr["ə"]))}
            if check == "weak-vowels"
            else {phone: curve_of(summary(values)) for phone, values in tally.phone_lpr.items()}
        )
        self.n = len(tally.native_deviate[check])
        self.worst = sorted(
            min(deviates)
            for found in tally.native_deviate[check]
            if (deviates := [deviate_of(c, lpr) for phone, lpr in found if (c := curves.get(phone)) is not None])
        )

    def rate(self, cut: float) -> float:
        """Native judged words flagged at deviate `cut`, per word."""
        return math.inf if self.n == 0 else bisect.bisect_right(self.worst, cut) / self.n

    def loosest(self, rate: float, grid: list[float] = DEVIATE_GRID) -> float | None:
        return next((cut for cut in grid if self.rate(cut) <= rate), None)


def decide_deviate(tally: Tally, args) -> dict:
    """Any other swapped sound and unreduced vowels: natives set the deviate a word's worst sound must reach."""
    out = {}
    for check in DEVIATE_CHECKS:
        natives = NativeWorst(tally, check)
        maybe = natives.loosest(args.fa_rate) if natives.n else None
        sure = natives.loosest(args.sure_fa_rate) if natives.n else None
        if natives.n == 0:
            why = "not measured: the dump predates these candidates; run the dump step again"
        elif maybe is None or sure is None:
            why = f"no cut-off down to {DEVIATE_GRID[-1]} keeps natives under the false-alarm rate"
        else:
            why = f"natives: {natives.rate(maybe):.2%} of {natives.n} judged words at {maybe}"
        maybe = Z_P05 if maybe is None else maybe
        sure = min(maybe, Z_P01 if sure is None else sure)
        at_p05 = natives.rate(Z_P05) if natives.n else None
        looser, stricter = {}, maybe
        for step, rate in LOOSER_RATES.items():
            found = natives.loosest(rate, DEVIATE_LOOSE_GRID) if natives.n else DEVIATE_LOOSER[step]
            looser[step] = stricter = max(stricter, stricter if found is None else found)
        out[check] = {"n": natives.n, "maybe": maybe, "sure": sure, "looser": looser, "rateAtP05": at_p05, "off": False, "why": why}
    return out


class NativeLeads:
    """The natives' words of one cue combination read for stress: how many, and the leads the extension could mark."""

    def __init__(self, rows: list[tuple], combo: str) -> None:
        read = [row for row in rows if row[0] == combo]
        self.n = len(read)
        self.markable = sorted(lead for _, lead, accepted in read if not accepted)

    def rate(self, cut: float) -> float:
        """Words marked at lead `cut`, per word read."""
        if self.n == 0:
            return math.inf
        return (len(self.markable) - bisect.bisect_left(self.markable, cut)) / self.n

    def lowest(self, rate: float) -> float | None:
        return next((cut for cut in LEAD_GRID if self.rate(cut) <= rate), None)


def stress_learner_numbers(rows: list[tuple], cuts: dict, corpus: str | None = None) -> dict:
    """Learner flags at `cuts` (combo -> maybe), how many the raters scored, how many of those had the stress wrong."""
    def flagged(row: tuple) -> bool:
        return row[1] in cuts and not row[3] and row[2] >= cuts[row[1]]

    def said_wrong(row: tuple) -> bool:
        return row[4] is not None and row[4] < STRESS_WRONG

    rows = [row for row in rows if corpus is None or row[0] == corpus]
    flags = [row for row in rows if flagged(row)]
    labelled = [row for row in flags if row[4] is not None]
    right = sum(1 for row in labelled if said_wrong(row))
    wrong = [row for row in rows if said_wrong(row)]
    found = sum(1 for row in wrong if flagged(row))
    return {
        "flags": len(flags),
        "matched": len(labelled),
        "right": right,
        "precision": right / len(labelled) if labelled else None,
        "recall": found / len(wrong) if wrong else None,
        "labelledWords": sum(1 for row in rows if row[4] is not None),
        "labelledWrong": len(wrong),
    }


def decide_stress(tally: Tally, args) -> dict:
    """Word stress: natives set each combination's lead cut-offs; `bar` says whether learners' flags meet the ship bar. It is never written off: the reader's switch decides."""
    combos = {}
    for combo in COMBOS:
        natives = NativeLeads(tally.stress_native, combo)
        maybe = sure = None
        looser: dict = {}
        if natives.n >= args.min_stress_words:
            maybe, sure = natives.lowest(args.fa_rate), natives.lowest(args.sure_fa_rate)
            if maybe is not None and sure is not None:
                sure = max(sure, maybe)
                stricter = maybe
                for step, rate in LOOSER_RATES.items():
                    found = natives.lowest(rate)
                    looser[step] = stricter = stricter if found is None else min(found, stricter)
        combos[combo] = {
            "n": natives.n,
            "maybe": maybe,
            "sure": sure,
            "looser": looser,
            "rateAtMaybe": None if maybe is None else natives.rate(maybe),
            "rateAtZero": natives.rate(LEAD_GRID[0]) if natives.n else None,
        }
    cuts = {combo: c["maybe"] for combo, c in combos.items() if c["maybe"] is not None and c["sure"] is not None}
    learners = stress_learner_numbers(tally.stress_learner, cuts)
    if not cuts:
        bar = f"no cut-off keeps natives under the false-alarm rate on at least {args.min_stress_words} native words"
    elif learners["labelledWords"] == 0:
        bar = "no learner stress labels: natives alone cannot show the flags are right"
    elif learners["matched"] < args.min_flags:
        bar = f"only {learners['matched']} labelled learner flags (need {args.min_flags})"
    elif learners["precision"] < args.min_precision:
        bar = f"precision {learners['precision']:.2f} under {args.min_precision:.2f}"
    else:
        bar = ""
    precision = "–" if learners["precision"] is None else f"{learners['precision']:.2f}"
    why = f"learner precision {precision} on {learners['matched']} scored flags" + (f" ({bar})" if bar else "")
    return {"combos": combos, "learners": learners, "off": False, "bar": bar, "why": why}


def thresholds_json(decided: dict, source: str, stress: dict | None = None, deviate: dict | None = None) -> dict:
    contrasts = {}
    for check, d in [*decided.items(), *(deviate or {}).items()]:
        entry: dict = {"off": d["off"]}
        if d["maybe"] is not None:
            entry["maybe"] = d["maybe"]
        if d["sure"] is not None:
            entry["sure"] = d["sure"]
        if d.get("looser"):
            entry["looser"] = d["looser"]
        if d["why"]:
            entry["why"] = d["why"]
        contrasts[check] = entry
    if stress is not None:
        cuts = {
            combo: {"maybe": c["maybe"], "sure": c["sure"], **({"looser": c["looser"]} if c.get("looser") else {})}
            for combo, c in stress["combos"].items()
            if c["maybe"] is not None and c["sure"] is not None
        }
        contrasts[STRESS] = {"off": stress["off"], "cuts": cuts, **({"why": stress["why"]} if stress["why"] else {})}
    return {"generated": time.strftime("%Y-%m-%d"), "source": source, "contrasts": contrasts}


def lead_summary(values: list[float]) -> dict:
    out: dict = {"n": len(values)}
    for p in LEAD_PERCENTILES:
        value = percentile(values, p)
        out[f"p{p}"] = None if value is None else round(value, 4)
    return out


def native_stats(tally: Tally) -> dict:
    return {
        "generated": time.strftime("%Y-%m-%d"),
        "phones": {
            phone: {"lpr": summary(tally.phone_lpr[phone]), "lp": summary(tally.phone_lp[phone])}
            for phone in sorted(tally.phone_lpr)
        },
        "vowels": {
            vowel: {"lpr": summary(tally.vowel_lpr[vowel]), "durationMs": summary(tally.vowel_ms[vowel])}
            for vowel in sorted(tally.vowel_ms)
        },
        "stress": {
            **{cue: summary(values) for cue, values in tally.margins.items()},
            **{f"stressed_{cue}": round(sum(v) / len(v), 4) for cue, v in tally.wins.items() if v},
            "lead": {
                combo: lead_summary([row[1] for row in tally.stress_native if row[0] == combo])
                for combo in COMBOS
                if any(row[0] == combo for row in tally.stress_native)
            },
        },
    }


def fmt(value, digits: int = 3) -> str:
    if value is None:
        return "–"
    if isinstance(value, float):
        return f"{value:.{digits}f}"
    return str(value)


STALE_LENGTHS = (
    "This dump's vowel lengths, loudness and pitch are over the aligned frames only (dump.ts before owned "
    "stretches): lengths are nearly all 20 ms and word stress's numbers mean little. Run the dump step again."
)


def stale_lengths(tally: Tally) -> bool:
    return tally.unspanned > 0


def deviate_report(deviate: dict, args) -> list[str]:
    lines = [
        "",
        "## Any other swapped sound and unreduced vowels",
        "",
        "How they are judged (pronounce/any-sound.ts, weak-vowels.ts; the candidates written by dump.ts): a "
        "content word's consonant that lost to another English consonant (none of the five named swaps, not its "
        "neighbour), or its unstressed schwa that lost to a full vowel, placed among the natives' goodness for "
        "that phone (native-stats.json) as a normal deviate. Natives set the cut-off: the loosest deviate, from "
        f"their 0.5th percentile ({Z_P05}) down, at which at most {args.fa_rate:.4f} of their judged words "
        f"would be marked (`maybe`), {args.sure_fa_rate:.4f} (`sure`). No learner labels are read for these. "
        "The Sensitivity steps' maybe: the loosest deviate from their 10th percentile down at which at most 1 in "
        "50 and 1 in 10 of their judged words would be marked; without measured words, their 2nd and 10th percentile.",
        "",
        "| check | native judged words | native rate at the 0.5th percentile | maybe | sure | 1 in 50 | 1 in 10 | |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for check, d in deviate.items():
        looser = d.get("looser", {})
        lines.append(
            f"| {check} | {d['n']} | {fmt(d['rateAtP05'], 4)} | {fmt(d['maybe'])} | {fmt(d['sure'])} | "
            f"{fmt(looser.get('1/50'))} | {fmt(looser.get('1/10'))} | {d['why']} |"
        )
    return lines


def report(tally: Tally, decided: dict, stress: dict, args, deviate: dict | None = None) -> str:
    lines = [
        "# Calibration report",
        "",
        f"Generated {time.strftime('%Y-%m-%d %H:%M')} by tools/calibrate/stats.py from {args.dump}.",
        "",
        "## Data",
        "",
        "| corpus | kind | utterances | failed | words | judged words |",
        "|---|---|---|---|---|---|",
    ]
    for corpus, c in sorted(tally.corpora.items()):
        kind = "native" if corpus in NATIVE else "learner" if corpus in LEARNER else "other"
        lines.append(f"| {corpus} | {kind} | {c['utterances']} | {c['failed']} | {c['words']} | {c['judged']} |")
    lines += [
        "",
        "## Checks",
        "",
        f"Native false-alarm budget: {args.fa_rate:.4f} per judged word for maybe, "
        f"{args.sure_fa_rate:.4f} for sure, never stricter than {DEFAULT_MAYBE:.2f} / {DEFAULT_SURE:.2f}; "
        "every check ships on, and the reader switches off in Settings what they find wrong. The bar column "
        f"says whether learners' flags meet precision ≥ {args.min_precision:.2f} on at least "
        f"{args.min_flags} labelled learner flags. A learner flag is right when the raters scored that phone "
        f"under {ERROR_SCORE} (speechocean762, 0 to 2 per phone) or annotated it as an error (L2-ARCTIC); strict "
        "also needs the perceived phone to be the one flagged (speechocean762 names it only for phones scored "
        "under 0.5, so strict sits well under precision there). The flagged phone is looked up by lining up our "
        "pronunciation with the raters' phones. Recall counts the labelled swaps of that kind found.",
        "",
        "| check | native flags/word at 0.70 | maybe | native rate at maybe | sure | learner flags | labelled | "
        "precision | strict | recall | bar |",
        "|---|---|---|---|---|---|---|---|---|---|---|",
    ]
    for check, d in decided.items():
        learners = d["learners"]
        at_maybe = None if d["maybe"] is None else native_rate(tally, check, d["maybe"])
        lines.append(
            f"| {check} | {fmt(native_rate(tally, check, TODAY), 4)} | {fmt(d['maybe'])} | {fmt(at_maybe, 4)} | "
            f"{fmt(d['sure'])} | {learners['flags']} | {learners['matched']} | {fmt(learners['precision'])} | "
            f"{fmt(learners['strict'])} | {fmt(learners['recall'])} | {d['bar'] or 'meets it'} |"
        )
    lines += ["", "Per learner corpus, at each check's maybe cut-off:", ""]
    lines += ["| check | corpus | flags | labelled | precision | strict | recall |", "|---|---|---|---|---|---|---|"]
    for check, d in decided.items():
        for corpus in sorted(LEARNER):
            n = learner_numbers(tally.learner[check], d["maybe"], corpus)
            lines.append(
                f"| {check} | {corpus} | {n['flags']} | {n['matched']} | {fmt(n['precision'])} | "
                f"{fmt(n['strict'])} | {fmt(n['recall'])} |"
            )
    lines += ["", "Native flags per judged word by cut-off:", ""]
    cuts = [0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.88, 0.9, 0.95, 0.99]
    lines += ["| check | " + " | ".join(str(c) for c in cuts) + " |", "|---" * (len(cuts) + 1) + "|"]
    for check in CHECKS:
        lines.append(f"| {check} | " + " | ".join(fmt(native_rate(tally, check, c), 4) for c in cuts) + " |")
    lines += [
        "",
        "Sensitivity steps (pronounce/sensitivity.ts): each contrast's maybe where natives get a flag on 1 judged "
        f"word in 200 (the maybe above), 50 and 10, never below {POSTERIOR_FLOOR}; sure is one step stricter.",
        "",
        "| check | 1 in 200 | 1 in 50 | 1 in 10 | |",
        "|---|---|---|---|---|",
    ]
    for check, d in decided.items():
        looser = d.get("looser", {})
        lines.append(f"| {check} | {fmt(d['maybe'])} | {fmt(looser.get('1/50'))} | {fmt(looser.get('1/10'))} | {d['why']} |")
    lines += ["", "## Native phones (LPR: log posterior of the phone minus its best competitor)", ""]
    lines += ["| phone | n | p1 | p5 | p10 | p50 | p90 |", "|---|---|---|---|---|---|---|"]
    for phone in sorted(tally.phone_lpr):
        s = summary(tally.phone_lpr[phone])
        lines.append(f"| {phone} | {s['n']} | {fmt(s['p1'])} | {fmt(s['p5'])} | {fmt(s['p10'])} | {fmt(s['p50'])} | {fmt(s['p90'])} |")
    lines += ["", "## Native vowels", ""]
    if stale_lengths(tally):
        lines += [f"**{STALE_LENGTHS}**", ""]
    lines += ["| vowel | n | LPR p5 | LPR p50 | ms p10 | ms p50 | ms p90 |", "|---|---|---|---|---|---|---|"]
    for vowel in sorted(tally.vowel_ms):
        lpr, ms = summary(tally.vowel_lpr[vowel]), summary(tally.vowel_ms[vowel])
        lines.append(f"| {vowel} | {ms['n']} | {fmt(lpr['p5'])} | {fmt(lpr['p50'])} | {fmt(ms['p10'])} | {fmt(ms['p50'])} | {fmt(ms['p90'])} |")
    lines += [
        "",
        "## Native stress margins",
        "",
        "Stressed vowel minus the strongest other vowel of the same word (words of 2+ vowels with a "
        "dictionary stress): length as a log ratio, loudness in dB, pitch in semitones.",
        "",
        "| cue | n | p5 | p10 | p25 | p50 | p75 | stressed one wins |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for cue, win in [("durationLogRatio", "longest"), ("rmsDb", "loudest"), ("f0Semitones", "highest")]:
        s = summary(tally.margins[cue])
        wins = tally.wins[win]
        share = sum(wins) / len(wins) if wins else None
        lines.append(f"| {cue} | {s['n']} | {fmt(s['p5'])} | {fmt(s['p10'])} | {fmt(s['p25'])} | {fmt(s['p50'])} | {fmt(s['p75'])} | {fmt(share)} |")
    lines += stress_report(tally, stress, args)
    if deviate is not None:
        lines += deviate_report(deviate, args)
    return "\n".join(lines) + "\n"


def stress_report(tally: Tally, stress: dict, args) -> list[str]:
    learners = stress["learners"]
    lines = [
        "",
        "## Word stress",
        "",
        "How it is judged (pronounce/stress.ts, mirrored by `stress_readings` here): a word is read when it "
        "is no function word, Britfone has it, and its chosen pronunciation has 2+ vowels and a stress. Each "
        "vowel's length (log ms), loudness (dB) and pitch (semitones) is scaled by the mean and spread of all "
        "the sentence's vowels, so the speaker's rate, level and voice cancel out; a vowel's prominence is "
        "the mean of its scaled cues (pitch only when every vowel of the word is voiced: `dur+rms+f0`, else "
        "`dur+rms`). The word's lead is the most prominent other vowel's prominence minus the stressed "
        "one's; a lead to a syllable another accepted pronunciation stresses is never a flag.",
        "",
        f"Natives set the cut-offs per combination: the lowest lead at which at most {args.fa_rate:.4f} of "
        f"their read words would be marked (`maybe`), {args.sure_fa_rate:.4f} (`sure`), on at least "
        f"{args.min_stress_words} native words. It ships on, as every check; the bar says whether learners' "
        f"flags are right at least {args.min_precision:.0%} of the time on at least {args.min_flags} flags the "
        f"raters scored: a flag is right when speechocean762 scored the word's stress under {STRESS_WRONG} "
        "(5: wrong; 10: right). L2-ARCTIC has no stress labels; without learner stress scores a native "
        "false-alarm cap alone says how rarely natives are flagged, not how often a learner's flag is right.",
        "",
        "| combination | native words read | native rate at lead 0.05 | maybe | native rate at maybe | sure | "
        "maybe at 1 in 50 | maybe at 1 in 10 |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for combo, c in stress["combos"].items():
        looser = c.get("looser", {})
        lines.append(
            f"| {combo} | {c['n']} | {fmt(c['rateAtZero'], 4)} | {fmt(c['maybe'])} | {fmt(c['rateAtMaybe'], 4)} | {fmt(c['sure'])} | "
            f"{fmt(looser.get('1/50'))} | {fmt(looser.get('1/10'))} |"
        )
    cuts = {combo: c["maybe"] for combo, c in stress["combos"].items() if c["maybe"] is not None}
    lines += [
        "",
        "| learners | words read | scored | scored wrong | flags | scored flags | precision | recall |",
        "|---|---|---|---|---|---|---|---|",
    ]
    for corpus in sorted(LEARNER):
        n = stress_learner_numbers(tally.stress_learner, cuts, corpus)
        read = sum(1 for row in tally.stress_learner if row[0] == corpus)
        lines.append(
            f"| {corpus} | {read} | {n['labelledWords']} | {n['labelledWrong']} | {n['flags']} | {n['matched']} | "
            f"{fmt(n['precision'])} | {fmt(n['recall'])} |"
        )
    verdict = stress["bar"] or "meets it"
    lines += ["", f"Bar: {verdict} (all learners: {learners['matched']} scored flags, precision {fmt(learners['precision'])})."]
    return lines


def load_labels(corpora: Path) -> dict[str, dict]:
    labels = {}
    for path in corpora.glob("*/labels.jsonl"):
        with open(path, encoding="utf-8") as lines:
            for line in lines:
                if line.strip():
                    row = json.loads(line)
                    labels[row["utt"]] = row
    return labels


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dump", type=Path, required=True, help="folder of <corpus>.<shard>.jsonl from dump.ts")
    parser.add_argument("--corpora", type=Path, required=True, help="fetch.py's corpora folder (for labels.jsonl)")
    parser.add_argument("--out", type=Path, required=True, help="where thresholds.json and native-stats.json go")
    parser.add_argument("--report", type=Path, required=True, help="the markdown report")
    parser.add_argument("--fa-rate", type=float, default=1 / 200, help="native flags per judged word for maybe")
    parser.add_argument("--sure-fa-rate", type=float, default=1 / 1000, help="native flags per judged word for sure")
    parser.add_argument("--min-precision", type=float, default=0.80)
    parser.add_argument("--min-flags", type=int, default=20, help="labelled learner flags needed to judge precision")
    parser.add_argument(
        "--min-stress-words", type=int, default=2000, help="native words read for stress needed to set its cut-offs"
    )
    args = parser.parse_args(argv)
    labels = load_labels(args.corpora)
    tally = Tally()
    for corpus, utt, records in utterances(args.dump):
        counts = tally.corpora[corpus]
        counts["utterances"] += 1
        if "error" in records[0]:
            counts["failed"] += 1
            continue
        counts["words"] += len(records)
        counts["judged"] += sum(1 for record in records if record["judged"])
        if corpus in NATIVE:
            tally.native(records)
        elif corpus in LEARNER:
            tally.learners(corpus, records, labels.get(utt))
    if tally.native_judged == 0:
        sys.exit("stats: no native words in the dump; nothing to calibrate against")
    if stale_lengths(tally):
        print(f"stats: warning: {STALE_LENGTHS}", file=sys.stderr)
    if any(row.get("corpus") == "speechocean762" and "labels" not in row for row in labels.values()):
        print(
            "stats: warning: speechocean762's labels.jsonl has no perceived phones (openslr's scores), so strict "
            "is 0; run the fetch step again, which writes it from the pinned scores",
            file=sys.stderr,
        )
    decided = decide(tally, args)
    stress = decide_stress(tally, args)
    deviate = decide_deviate(tally, args)
    args.out.mkdir(parents=True, exist_ok=True)
    source = ", ".join(f"{name} {c['utterances']}" for name, c in sorted(tally.corpora.items()))
    thresholds = thresholds_json(decided, source, stress, deviate)
    (args.out / "thresholds.json").write_text(json.dumps(thresholds, indent=2) + "\n")
    (args.out / "native-stats.json").write_text(json.dumps(native_stats(tally), ensure_ascii=False, indent=1) + "\n")
    args.report.write_text(report(tally, decided, stress, args, deviate), encoding="utf-8")
    print(f"stats: wrote {args.out / 'thresholds.json'}, {args.out / 'native-stats.json'}, {args.report}")


if __name__ == "__main__":
    main()
