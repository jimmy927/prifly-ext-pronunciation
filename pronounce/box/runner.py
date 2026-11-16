"""Runs on the voice box (a rented GPU machine), driven over ssh by pronounce/box.ts.

  setup                   install Seed-VC, edge-tts and ffmpeg where missing; prints "ready"
  read                    text on stdin -> a mono 24 kHz wav on stdout (Edge TTS en-GB-RyanNeural)
  put-ref KEY             a wav on stdin kept as the voice reference KEY
  convert KEY -- ARGS...  a wav on stdin converted by Seed-VC's inference.py with ARGS into the
                          reference KEY's voice; the converted wav (44.1 kHz) on stdout. Exit 3 when
                          the reference KEY is not on the box yet.

Progress and errors go to stderr; stdout is the audio only.
"""
import asyncio
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HOME = Path.home() / "prifly-voice"
SEED = HOME / "seed-vc"
REFS = HOME / "refs"
VOICE = "en-GB-RyanNeural"


def run(cmd, **kw):
    subprocess.run(cmd, check=True, stdout=sys.stderr, **kw)


def setup():
    HOME.mkdir(parents=True, exist_ok=True)
    if shutil.which("ffmpeg") is None:
        run(["apt-get", "install", "-y", "ffmpeg"])
    if not SEED.exists():
        run(["git", "clone", "--depth", "1", "https://github.com/Plachtaa/seed-vc", str(SEED)])
        run([sys.executable, "-m", "pip", "install", "-r", "requirements.txt"], cwd=SEED)
    try:
        import edge_tts  # noqa: F401
    except ImportError:
        run([sys.executable, "-m", "pip", "install", "edge-tts"])
    print("ready")


def read():
    import edge_tts

    text = sys.stdin.buffer.read().decode("utf-8")
    with tempfile.TemporaryDirectory() as tmp:
        mp3, wav = Path(tmp) / "r.mp3", Path(tmp) / "r.wav"
        asyncio.run(edge_tts.Communicate(text, VOICE).save(str(mp3)))
        # Edge's native rate, 24 kHz: never downsampled.
        run(["ffmpeg", "-y", "-i", str(mp3), "-ar", "24000", "-ac", "1", "-c:a", "pcm_s16le", str(wav)])
        sys.stdout.buffer.write(wav.read_bytes())


def put_ref(key):
    REFS.mkdir(parents=True, exist_ok=True)
    (REFS / f"{key}.wav").write_bytes(sys.stdin.buffer.read())


def convert(key, args):
    ref = REFS / f"{key}.wav"
    if not ref.exists():
        sys.exit(3)
    with tempfile.TemporaryDirectory() as tmp:
        src, out = Path(tmp) / "source.wav", Path(tmp) / "out"
        out.mkdir()
        src.write_bytes(sys.stdin.buffer.read())
        run(
            [sys.executable, "inference.py", "--source", str(src), "--target", str(ref), "--output", str(out), *args],
            cwd=SEED,
        )
        made = sorted(out.glob("*.wav"), key=lambda p: p.stat().st_mtime)[-1]
        sys.stdout.buffer.write(made.read_bytes())


if __name__ == "__main__":
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command == "setup":
        setup()
    elif command == "read":
        read()
    elif command == "put-ref":
        put_ref(sys.argv[2])
    elif command == "convert":
        convert(sys.argv[2], sys.argv[4:] if sys.argv[3:4] == ["--"] else [])
    else:
        sys.exit(f"unknown command {command!r}")
