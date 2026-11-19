"""The human labels of learner speech, shared by fetch.py (which writes them) and stats.py (which reads them).

labels.jsonl, one utterance per line:
  {"utt": "so-000010011", "corpus": "speechocean762",
   "words": [{"text": "WE", "accuracy": 10,
              "phones": [{"canonical": "w", "perceived": null, "score": 2.0}, ...]}]}

`canonical` and `perceived` are in the extension's espeak IPA (the same table as
pronounce/dictionary.ts's ARPABET); `perceived` is null when the raters did not
say what was heard instead (or it was the canonical phone). `score` is
speechocean762's per-phone accuracy (2 right, 1 accented, 0 wrong; averaged
over raters where it says so); L2-ARCTIC's annotated errors get 0 and its
other phones 2.
"""

from __future__ import annotations

import re

# ARPAbet in the model's espeak IPA, as pronounce/dictionary.ts maps it.
ARPABET_IPA = {
    "AA": "ɑː", "AE": "æ", "AH": "ʌ", "AO": "ɔː", "AW": "aʊ", "AY": "aɪ", "EH": "ɛ", "ER": "ɜː",
    "EY": "eɪ", "IH": "ɪ", "IY": "iː", "OW": "oʊ", "OY": "ɔɪ", "UH": "ʊ", "UW": "uː",
    "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "ɡ", "HH": "h", "JH": "dʒ",
    "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ", "P": "p", "R": "ɹ", "S": "s",
    "SH": "ʃ", "T": "t", "TH": "θ", "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ",
}  # fmt: skip

# Below this mean per-phone score a speechocean762 phone counts as said wrong (2 is right).
ERROR_SCORE = 1.5


def arpabet_to_ipa(symbol: str | None) -> str | None:
    """One ARPAbet phone ("AH0", "z", "ER1*") in IPA; None for one that is not ARPAbet."""
    if not symbol:
        return None
    found = re.fullmatch(r"([A-Za-z]+)([012])?\**", symbol.strip())
    if found is None:
        return None
    base, digit = found.group(1).upper(), found.group(2)
    ipa = ARPABET_IPA.get(base)
    if ipa is None:
        return None
    if digit == "0" and base == "AH":
        return "ə"
    if digit == "0" and base == "ER":
        return "ɚ"
    return ipa


def is_error(phone: dict, cut: float = ERROR_SCORE) -> bool:
    """Whether the raters judged the phone said wrong: a score under `cut`."""
    score = phone.get("score")
    return score is not None and score < cut
