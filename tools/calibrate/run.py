"""Fetch the corpora, dump the phoneme model's view of every word, and calibrate: fetch -> dump -> stats.

Every step can be stopped and run again: fetch skips a corpus marked done and
resumes downloads, dump.ts skips the utterances already in its output, and
stats reads whatever the dump holds. The results land in the repository this
script sits in: pronounce/data/thresholds.json, pronounce/data/native-stats.json
and tools/calibrate/report.md.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
CORPORA = ["librispeech", "vctk", "speechocean762"]


def log(message: str) -> None:
    print(f"[run {time.strftime('%H:%M:%S')}] {message}", file=sys.stderr, flush=True)


def bun() -> str:
    found = shutil.which("bun") or str(Path.home() / ".bun" / "bin" / "bun")
    if not Path(found).exists():
        sys.exit("run: bun is not installed (see tools/calibrate/README.md)")
    return found


def fetch(args) -> None:
    command = [sys.executable, str(HERE / "fetch.py"), "--work", str(args.work), "--corpora", ",".join(args.corpora)]
    command += ["--librispeech-hours", str(args.librispeech_hours), "--vctk-hours", str(args.vctk_hours)]
    if args.l2arctic:
        command += ["--l2arctic", str(args.l2arctic)]
    subprocess.run(command, check=True)


def dump(args) -> None:
    if not (REPO / "node_modules" / "onnxruntime-node").exists():
        sys.exit("run: no node_modules; run `bun install --production --frozen-lockfile --ignore-scripts` in the repo first")
    out = args.work / "dump"
    out.mkdir(parents=True, exist_ok=True)
    corpora = list(args.corpora) + (["l2arctic"] if args.l2arctic else [])
    # The model and the dictionaries once, before the shards that all read them.
    subprocess.run(
        [bun(), str(REPO / "tools" / "calibrate" / "dump.ts"), "--fetch-only", "--data", str(args.work / "models")],
        cwd=REPO,
        check=True,
    )
    for corpus in corpora:
        folder = args.work / "corpora" / corpus
        if not (folder / ".done").exists():
            sys.exit(f"run: {corpus} is not fetched yet")
        started = time.time()
        jobs = []
        for shard in range(args.jobs):
            command = [
                bun(), str(REPO / "tools" / "calibrate" / "dump.ts"),
                "--wavs", str(folder / "wav"),
                "--transcript", str(folder / "utts.tsv"),
                "--out", str(out / f"{corpus}.{shard}.jsonl"),
                "--shard", f"{shard}/{args.jobs}",
                "--threads", str(args.threads),
                "--provider", args.provider,
                "--data", str(args.work / "models"),
            ]  # fmt: skip
            jobs.append(subprocess.Popen(command, cwd=REPO))
        failed = [job.args for job in jobs if job.wait() != 0]
        if failed:
            sys.exit(f"run: {len(failed)} dump shard(s) of {corpus} failed")
        log(f"dumped {corpus} in {time.time() - started:.0f} s")


def stats(args) -> None:
    subprocess.run(
        [
            sys.executable, str(HERE / "stats.py"),
            "--dump", str(args.work / "dump"),
            "--corpora", str(args.work / "corpora"),
            "--out", str(REPO / "pronounce" / "data"),
            "--report", str(HERE / "report.md"),
        ],  # fmt: skip
        check=True,
    )


def main(argv: list[str] | None = None) -> None:
    cores = os.cpu_count() or 4
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--work", type=Path, default=Path("/workspace/calibrate"), help="downloads, corpora, models, dump")
    parser.add_argument("--steps", default="fetch,dump,stats", help="which steps, comma-separated")
    parser.add_argument("--corpora", default=",".join(CORPORA), help=f"comma-separated, of {', '.join(CORPORA)}")
    parser.add_argument("--l2arctic", type=Path, help="a local L2-ARCTIC copy to add as learners")
    parser.add_argument("--librispeech-hours", type=float, default=6.0)
    parser.add_argument("--vctk-hours", type=float, default=4.0)
    parser.add_argument("--threads", type=int, default=4, help="onnxruntime threads per dump process (default 4)")
    parser.add_argument("--jobs", type=int, default=max(1, cores // 4), help=f"dump processes side by side (default {max(1, cores // 4)})")
    parser.add_argument("--provider", choices=["cpu", "cuda"], default="cpu", help="where the model runs (default cpu)")
    args = parser.parse_args(argv)
    args.corpora = [name.strip() for name in args.corpora.split(",") if name.strip()]
    args.work = args.work.resolve()
    steps = {step.strip() for step in args.steps.split(",")}
    for step, run in [("fetch", fetch), ("dump", dump), ("stats", stats)]:
        if step in steps:
            log(f"{step} ...")
            run(args)
    log("done")


if __name__ == "__main__":
    main()
