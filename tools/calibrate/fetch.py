"""Download the calibration corpora and convert them to 16 kHz mono wavs plus a transcript.

Each corpus ends up as WORK/corpora/<name>/ with
  wav/<utt>.wav     16 kHz, mono, 16-bit
  utts.tsv          "<utt>\t<text>" per line
  labels.jsonl      learners only: per word, per phone, the human judgement
  .done             written last; a corpus with it is skipped on the next run

Natives: LibriSpeech dev-clean and test-clean (openslr 12, CC BY 4.0) and a
British/Irish subset of VCTK 0.92 (Edinburgh DataShare, CC BY 4.0). Learners:
speechocean762 (openslr 101, CC BY 4.0, Mandarin speakers, per-phone scores)
and, from a local copy only, L2-ARCTIC (its annotation TextGrids give the
perceived phone). Downloads come only from openslr.org and datashare.ed.ac.uk
and resume where they stopped; nothing is uploaded anywhere.
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sys
import tarfile
import time
import urllib.request
import zipfile
from math import gcd
from pathlib import Path

from labels import arpabet_to_ipa

LIBRISPEECH = {
    "dev-clean": "https://www.openslr.org/resources/12/dev-clean.tar.gz",
    "test-clean": "https://www.openslr.org/resources/12/test-clean.tar.gz",
}
SPEECHOCEAN = "https://www.openslr.org/resources/101/speechocean762.tar.gz"
VCTK = "https://datashare.ed.ac.uk/bitstream/handle/10283/3443/VCTK-Corpus-0.92.zip"
# VCTK speakers whose accent is from Britain or Ireland.
VCTK_ACCENTS = {"English", "Scottish", "Irish", "NorthernIrish", "Welsh"}
RATE = 16_000
USER_AGENT = "calibrate-fetch/1.0"


def log(message: str) -> None:
    print(f"[fetch {time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def download(url: str, target: Path) -> Path:
    """`url` to `target`, resuming a partial `.part` with an HTTP range; skipped when done."""
    if target.exists():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    part = target.with_suffix(target.suffix + ".part")
    for attempt in range(8):
        have = part.stat().st_size if part.exists() else 0
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        if have:
            request.add_header("Range", f"bytes={have}-")
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                if have and response.status != 206:
                    have = 0  # The server ignored the range: start over.
                total = response.headers.get("Content-Length")
                log(f"{url}: from byte {have}, {total or '?'} more")
                with open(part, "ab" if have else "wb") as out:
                    while chunk := response.read(1 << 20):
                        out.write(chunk)
            part.rename(target)
            return target
        except OSError as error:
            log(f"{url}: {error}; retrying ({attempt + 1}/8)")
            time.sleep(min(60, 2**attempt))
    raise RuntimeError(f"could not download {url}")


def to_16k(samples, rate: int):
    """Mono float samples at `rate` resampled to 16 kHz."""
    import numpy as np
    from scipy.signal import resample_poly

    data = np.asarray(samples, dtype=np.float32)
    if data.ndim == 2:
        data = data.mean(axis=1)
    if rate == RATE:
        return data
    common = gcd(rate, RATE)
    return resample_poly(data, RATE // common, rate // common).astype(np.float32)


def write_wav(path: Path, audio_bytes: bytes) -> float:
    """Any soundfile-readable audio as a 16 kHz mono 16-bit wav; its seconds."""
    import soundfile as sf

    data, rate = sf.read(io.BytesIO(audio_bytes), dtype="float32", always_2d=False)
    audio = to_16k(data, rate)
    path.parent.mkdir(parents=True, exist_ok=True)
    sf.write(str(path), audio, RATE, subtype="PCM_16")
    return len(audio) / RATE


class Corpus:
    """The output folder of one corpus, written as it goes and marked done at the end."""

    def __init__(self, work: Path, name: str):
        self.name = name
        self.folder = work / "corpora" / name
        self.wav = self.folder / "wav"
        self.rows: list[tuple[str, str]] = []
        self.labels: list[dict] = []
        self.seconds = 0.0

    @property
    def done(self) -> bool:
        return (self.folder / ".done").exists()

    def add(self, utt: str, text: str, audio_bytes: bytes | None) -> None:
        """One utterance: its audio converted unless a wav is already there."""
        path = self.wav / f"{utt}.wav"
        if audio_bytes is not None and not path.exists():
            self.seconds += write_wav(path, audio_bytes)
        elif path.exists():
            self.seconds += max(0, path.stat().st_size - 44) / (2 * RATE)
        self.rows.append((utt, " ".join(text.split())))

    def finish(self, source: str) -> None:
        self.folder.mkdir(parents=True, exist_ok=True)
        rows = [(utt, text) for utt, text in self.rows if (self.wav / f"{utt}.wav").exists()]
        with open(self.folder / "utts.tsv", "w", encoding="utf-8") as out:
            out.writelines(f"{utt}\t{text}\n" for utt, text in rows)
        if self.labels:
            with open(self.folder / "labels.jsonl", "w", encoding="utf-8") as out:
                out.writelines(json.dumps(row, ensure_ascii=False) + "\n" for row in self.labels)
        info = {"corpus": self.name, "source": source, "utterances": len(rows), "hours": round(self.seconds / 3600, 2)}
        (self.folder / ".done").write_text(json.dumps(info))
        log(f"{self.name}: {len(rows)} utterances, {self.seconds / 3600:.2f} h")


def fetch_librispeech(work: Path, max_hours: float) -> None:
    corpus = Corpus(work, "librispeech")
    if corpus.done:
        return
    texts: dict[str, str] = {}
    for part, url in LIBRISPEECH.items():
        archive = download(url, work / "raw" / f"librispeech-{part}.tar.gz")
        with tarfile.open(archive, "r:gz") as tar:
            for member in tar:
                name = Path(member.name).name
                if name.endswith(".trans.txt"):
                    for line in tar.extractfile(member).read().decode("utf-8").splitlines():
                        utt, _, text = line.partition(" ")
                        texts[f"ls-{utt}"] = text
                elif name.endswith(".flac") and corpus.seconds < max_hours * 3600:
                    utt = f"ls-{name[:-5]}"
                    path = corpus.wav / f"{utt}.wav"
                    corpus.add(utt, "", None if path.exists() else tar.extractfile(member).read())
    corpus.rows = [(utt, texts[utt]) for utt, _ in corpus.rows if utt in texts]
    corpus.finish("openslr 12: dev-clean, test-clean")


class RangeFile(io.RawIOBase):
    """A remote file read by HTTP ranges in 4 MB blocks, so zipfile can take single members of a large zip."""

    BLOCK = 4 << 20

    def __init__(self, url: str):
        self.url = url
        request = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Range": "bytes=0-0"})
        with urllib.request.urlopen(request, timeout=60) as response:
            self.url = response.geturl()
            self.size = int(response.headers["Content-Range"].split("/")[-1])
        self.position = 0
        self.blocks: dict[int, bytes] = {}

    def readable(self) -> bool:
        return True

    def seekable(self) -> bool:
        return True

    def tell(self) -> int:
        return self.position

    def seek(self, offset: int, whence: int = 0) -> int:
        base = {0: 0, 1: self.position, 2: self.size}[whence]
        self.position = base + offset
        return self.position

    def block(self, index: int) -> bytes:
        if index not in self.blocks:
            start = index * self.BLOCK
            end = min(self.size, start + self.BLOCK) - 1
            for attempt in range(8):
                try:
                    request = urllib.request.Request(
                        self.url, headers={"User-Agent": USER_AGENT, "Range": f"bytes={start}-{end}"}
                    )
                    with urllib.request.urlopen(request, timeout=120) as response:
                        data = response.read()
                    break
                except OSError as error:
                    log(f"VCTK range {start}: {error}; retrying")
                    time.sleep(min(60, 2**attempt))
            else:
                raise RuntimeError(f"could not read {self.url} at {start}")
            if len(self.blocks) > 16:
                self.blocks.pop(next(iter(self.blocks)))
            self.blocks[index] = data
        return self.blocks[index]

    def read(self, size: int = -1) -> bytes:
        if size < 0:
            size = self.size - self.position
        size = max(0, min(size, self.size - self.position))
        out = bytearray()
        while len(out) < size:
            index, offset = divmod(self.position, self.BLOCK)
            chunk = self.block(index)[offset : offset + size - len(out)]
            out += chunk
            self.position += len(chunk)
        return bytes(out)

    def readinto(self, buffer) -> int:
        data = self.read(len(buffer))
        buffer[: len(data)] = data
        return len(data)


def vctk_speakers(info: str) -> list[str]:
    """The VCTK speakers (`p225`) whose accent is British or Irish."""
    chosen = []
    for line in info.splitlines()[1:]:
        cells = line.split()
        if len(cells) >= 4 and cells[3] in VCTK_ACCENTS:
            chosen.append(cells[0] if cells[0].startswith("p") else f"p{cells[0]}")
    return chosen


def fetch_vctk(work: Path, max_hours: float) -> None:
    corpus = Corpus(work, "vctk")
    if corpus.done:
        return
    archive = zipfile.ZipFile(io.BufferedReader(RangeFile(VCTK), buffer_size=1 << 20))
    names = archive.namelist()
    info_name = next(name for name in names if name.endswith("speaker-info.txt"))
    speakers = vctk_speakers(archive.read(info_name).decode("utf-8", "replace"))
    flacs: dict[str, list[str]] = {}
    for name in names:
        found = re.search(r"wav48_silence_trimmed/(p\d+)/(p\d+_\d+)_mic1\.flac$", name)
        if found and found.group(1) in speakers:
            flacs.setdefault(found.group(1), []).append(name)
    texts = {Path(name).stem: name for name in names if re.search(r"txt/p\d+/p\d+_\d+\.txt$", name)}
    # About 3 s an utterance: an even share of the hours for each speaker.
    per_speaker = max(1, int(max_hours * 3600 / 3 / max(1, len(flacs))))
    log(f"VCTK: {len(flacs)} British/Irish speakers, up to {per_speaker} utterances each")
    for speaker in sorted(flacs):
        for name in sorted(flacs[speaker])[:per_speaker]:
            stem = Path(name).stem.removesuffix("_mic1")
            if stem not in texts or corpus.seconds >= max_hours * 3600:
                continue
            utt = f"vctk-{stem}"
            path = corpus.wav / f"{utt}.wav"
            text = archive.read(texts[stem]).decode("utf-8", "replace")
            corpus.add(utt, text, None if path.exists() else archive.read(name))
    corpus.finish(f"VCTK 0.92 mic1, accents {sorted(VCTK_ACCENTS)}")


def speechocean_labels(utt: str, entry: dict) -> dict:
    """speechocean762's scores of one utterance in the shared labels format (`labels.py`)."""
    words = []
    for word in entry.get("words", []):
        wrong = {item.get("index"): item.get("pronounced-phone") for item in word.get("mispronunciations", [])}
        phones = []
        for at, (phone, score) in enumerate(zip(word.get("phones", []), word.get("phones-accuracy", []))):
            perceived = wrong.get(at)
            phones.append(
                {
                    "canonical": arpabet_to_ipa(phone),
                    "perceived": arpabet_to_ipa(perceived) if perceived else None,
                    "score": score,
                }
            )
        words.append(
            {
                "text": word.get("text", ""),
                "accuracy": word.get("accuracy"),
                "stress": word.get("stress"),
                "phones": phones,
            }
        )
    return {"utt": utt, "corpus": "speechocean762", "words": words}


def fetch_speechocean(work: Path) -> None:
    corpus = Corpus(work, "speechocean762")
    if corpus.done:
        return
    archive = download(SPEECHOCEAN, work / "raw" / "speechocean762.tar.gz")
    scores: dict = {}
    seen: list[str] = []
    with tarfile.open(archive, "r:gz") as tar:
        for member in tar:
            name = member.name
            if name.endswith("resource/scores.json"):
                scores = json.loads(tar.extractfile(member).read().decode("utf-8"))
            elif name.upper().endswith(".WAV") and "/WAVE/" in name.upper():
                utt = f"so-{Path(name).stem}"
                path = corpus.wav / f"{utt}.wav"
                if not path.exists():
                    corpus.seconds += write_wav(path, tar.extractfile(member).read())
                seen.append(utt)
    if not scores:
        raise RuntimeError("speechocean762: no resource/scores.json in the archive")
    for utt in seen:
        entry = scores.get(utt.removeprefix("so-"))
        if entry is None:
            continue
        corpus.rows.append((utt, entry["text"]))
        corpus.labels.append(speechocean_labels(utt, entry))
    corpus.finish("openslr 101")


def textgrid_tiers(text: str) -> dict[str, list[tuple[float, float, str]]]:
    """The interval tiers of a long-format Praat TextGrid, by name."""
    tiers: dict[str, list[tuple[float, float, str]]] = {}
    for block in re.split(r"item \[\d+\]:", text)[1:]:
        name = re.search(r'name = "([^"]*)"', block)
        if name is None:
            continue
        intervals = re.findall(r'xmin = ([\d.]+)\s+xmax = ([\d.]+)\s+text = "([^"]*)"', block)
        tiers[name.group(1).lower()] = [(float(a), float(b), label) for a, b, label in intervals]
    return tiers


def l2arctic_labels(utt: str, grid: str) -> dict:
    """An L2-ARCTIC annotation as labels: "Z,S,s" is Z heard as S; "AH,sil,d" is AH left out."""
    tiers = textgrid_tiers(grid)
    words = [(a, b, w) for a, b, w in tiers.get("words", []) if w.strip() and w.strip().lower() not in {"sil", "sp"}]
    phones = [(a, b, p) for a, b, p in tiers.get("phones", []) if p.strip() and p.strip().lower() not in {"sil", "sp", ""}]
    out = []
    for start, end, word in words:
        items = []
        for a, b, label in phones:
            if a < start - 1e-3 or b > end + 1e-3:
                continue
            parts = [part.strip() for part in label.split(",")]
            if len(parts) >= 3:
                canonical, perceived, kind = parts[0], parts[1], parts[2].lower()
                if kind == "a":
                    continue  # An added sound has no canonical phone.
                items.append(
                    {
                        "canonical": arpabet_to_ipa(canonical),
                        "perceived": None if kind == "d" else arpabet_to_ipa(perceived.rstrip("*")),
                        "score": 0.0,
                        "deleted": kind == "d",
                    }
                )
            else:
                items.append({"canonical": arpabet_to_ipa(parts[0]), "perceived": None, "score": 2.0})
        out.append({"text": word, "accuracy": None, "phones": items})
    return {"utt": utt, "corpus": "l2arctic", "words": out}


def fetch_l2arctic(work: Path, root: Path) -> None:
    corpus = Corpus(work, "l2arctic")
    if corpus.done:
        return
    for grid_path in sorted(root.glob("*/annotation/*.TextGrid")):
        speaker = grid_path.parent.parent.name
        stem = grid_path.stem
        wav_path = grid_path.parent.parent / "wav" / f"{stem}.wav"
        text_path = grid_path.parent.parent / "transcript" / f"{stem}.txt"
        if not wav_path.exists() or not text_path.exists():
            continue
        raw = grid_path.read_bytes()
        grid = raw.decode("utf-16") if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else raw.decode("utf-8", "replace")
        utt = f"l2-{speaker}-{stem}"
        path = corpus.wav / f"{utt}.wav"
        corpus.add(utt, text_path.read_text(encoding="utf-8", errors="replace"), None if path.exists() else wav_path.read_bytes())
        corpus.labels.append(l2arctic_labels(utt, grid))
    if not corpus.rows:
        raise RuntimeError(f"L2-ARCTIC: no <speaker>/annotation/*.TextGrid with its wav and transcript under {root}")
    corpus.finish(f"local L2-ARCTIC copy at {root}")


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", type=Path, required=True, help="working folder: raw/ downloads, corpora/ output")
    parser.add_argument(
        "--corpora",
        default="librispeech,vctk,speechocean762",
        help="comma-separated: librispeech, vctk, speechocean762 (l2arctic comes from --l2arctic)",
    )
    parser.add_argument("--librispeech-hours", type=float, default=6.0, help="cap on LibriSpeech audio (default 6)")
    parser.add_argument("--vctk-hours", type=float, default=4.0, help="cap on VCTK audio (default 4)")
    parser.add_argument("--l2arctic", type=Path, help="a local L2-ARCTIC copy: <root>/<SPEAKER>/{wav,transcript,annotation}")
    args = parser.parse_args(argv)
    wanted = {name.strip() for name in args.corpora.split(",") if name.strip()}
    unknown = wanted - {"librispeech", "vctk", "speechocean762"}
    if unknown:
        parser.error(f"unknown corpora: {sorted(unknown)}")
    if "librispeech" in wanted:
        fetch_librispeech(args.work, args.librispeech_hours)
    if "vctk" in wanted:
        fetch_vctk(args.work, args.vctk_hours)
    if "speechocean762" in wanted:
        fetch_speechocean(args.work)
    if args.l2arctic is not None:
        fetch_l2arctic(args.work, args.l2arctic)


if __name__ == "__main__":
    main()
