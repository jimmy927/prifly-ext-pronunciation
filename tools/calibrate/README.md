# Calibration on a rented box

Measures how the extension's phoneme model hears native and learner speech, and writes:

- `pronounce/data/thresholds.json`: each check's cut-offs (`maybe`, `sure`) and whether it ships (`off`).
  The extension reads it at the worker's start (`pronounce/thresholds.ts`).
- `pronounce/data/native-stats.json`: per phone and per vowel, the natives' goodness (LPR)
  percentiles and vowel lengths; the natives' stress margins (length, loudness, pitch).
- `tools/calibrate/report.md`: every number behind both, per check and per corpus.

The steps (`run.py` runs all three, each resumable):

1. `fetch.py`: downloads and converts to 16 kHz mono wavs plus `utts.tsv`:
   LibriSpeech dev-clean + test-clean (openslr 12, capped at 6 h), a British/Irish subset of
   VCTK 0.92 (Edinburgh DataShare, 4 h over 68 speakers; only those files are read out of the
   11.7 GB zip, by HTTP ranges), speechocean762 (openslr 101, CC BY 4.0, with its per-phone
   scores as `labels.jsonl`; the scores come from the corpus's GitHub repository at a pinned
   commit, checked by hash, since only that `scores.json` says which phone was heard
   instead), and with `--l2arctic PATH` a local L2-ARCTIC copy (its annotation TextGrids as
   `labels.jsonl`). Downloads come only from openslr.org, datashare.ed.ac.uk and
   raw.githubusercontent.com; nothing is uploaded.
2. `dump.ts`: the extension's own pinned model (uint8 wav2vec2-lv-60-espeak, through the
   worker's `openPhoneModel`) and dictionaries (Britfone + CMUdict, fetched by
   `pronounce/models.ts` into `WORK/models`), one JSON line per word: chosen pronunciation,
   per-phone goodness, per-vowel stress cues, and the swaps the checks look at.
3. `stats.py`: natives decide each check's cut-off (at most 1 flag per 200 judged words for
   `maybe`, 1 per 1000 for `sure`); learners decide whether it ships (precision ≥ 0.80 on at
   least 20 labelled flags, else `off: true`). Word stress (`stress`) the same way, per cue
   combination on the lead `pronounce/stress.ts` measures, with speechocean762's word stress
   scores as the learner labels; without them (labels.jsonl written before fetch.py kept
   them) it stays `off`. To add them to a finished fetch, delete
   `WORK/corpora/speechocean762/.done` and run the fetch step again (it rereads the kept
   archive and keeps the wavs already converted), then the stats step; the dump need not run again, though a new dump also writes
   `stressAccepts`, without which a lead to another accepted stress counts against natives.

## A fresh Vast.ai box

The model runs on the CPU, as in the extension (the posteriors must be the ones the extension
sees), so the GPU is not used: a CPU box is enough. Pick one with **16+ vCPUs, 16 GB RAM and
30 GB disk**, image `ubuntu:22.04` or any image with Python 3.10+ (e.g. `pytorch/pytorch`).

From the laptop, copy the repository (no `node_modules`, no `.git`):

```
rsync -az --exclude node_modules --exclude .git -e "ssh -p PORT" \
  ~/src/prifly-ext-pronunciation/ root@HOST:/workspace/prifly-ext-pronunciation/
```

On the box:

```
apt-get update && apt-get install -y curl unzip python3-pip
curl -fsSL https://bun.sh/install | bash -s "bun-v1.4.2"
export PATH="$HOME/.bun/bin:$PATH"
cd /workspace/prifly-ext-pronunciation
bun install --production --frozen-lockfile --ignore-scripts
python3 -m pip install -r tools/calibrate/requirements.txt
python3 tools/calibrate/run.py --work /workspace/calibrate 2>&1 | tee /workspace/calibrate.log
```

`--production` leaves out the dev dependencies, one of which (`@prifly/extension-api`) is a
folder on the laptop; the dump needs only onnxruntime-node and zod. `--ignore-scripts` keeps
onnxruntime-node's CPU build, which ships in the package.

With an L2-ARCTIC copy (it needs a request form, so it is never downloaded here), add
`--l2arctic /workspace/l2arctic` after copying it to the box.

Back on the laptop:

```
scp -P PORT root@HOST:/workspace/prifly-ext-pronunciation/pronounce/data/{thresholds,native-stats}.json \
  ~/src/prifly-ext-pronunciation/pronounce/data/
scp -P PORT root@HOST:/workspace/prifly-ext-pronunciation/tools/calibrate/report.md \
  ~/src/prifly-ext-pronunciation/tools/calibrate/
```

## Time and disk

| step  | time on 16 vCPUs                                                                            | disk    |
| ----- | ------------------------------------------------------------------------------------------- | ------- |
| fetch | 15–25 min (1.2 GB of archives, ~0.5 GB of VCTK ranges, conversion)                          | ~4 GB   |
| dump  | 15–30 min: ~16 h of audio at about 55 ms per audio second per 4-thread process, 4 processes | ~0.5 GB |
| stats | 1–2 min                                                                                     | –       |

About an hour all told; the box can go once the three files are copied back.

## Running parts again

- After a change to what a phone was heard as in the labels: the fetch step again (a finished
  speechocean762 whose `labels.jsonl` predates the pinned scores is written again from them,
  its wavs kept; seconds), then the stats step. The dump need not run again.
- After a change to what the dump measures (vowels' cues are over the stretch each vowel owns,
  `pronounce/gop.ts`'s `ownedSpans`, since the dump's vowels got `from`/`to`): the dump step
  again; its output folder must be emptied first, since dump.ts skips utterances already
  there. stats.py says so in a warning, and in the report, when the dump is older.
- Only the statistics, e.g. with another false-alarm budget:
  `python3 tools/calibrate/run.py --work /workspace/calibrate --steps stats`, or `stats.py`
  directly with `--fa-rate`, `--min-precision`, `--min-flags`.
- A quick look at the dump: `bun tools/calibrate/dump.ts --wavs DIR --transcript utts.tsv
  --out /tmp/x.jsonl --limit 5 --data /workspace/calibrate/models`.
- `--provider cuda` (dump.ts and run.py) asks onnxruntime for its CUDA provider, which needs
  `bun node_modules/onnxruntime-node/script/install.js --onnxruntime-node-install=cuda12` and
  CUDA 12 on the box. It is untested, the uint8 model's integer kernels may fall back to the
  CPU, and its posteriors may differ from the CPU's: do not use it for the shipped numbers.

## Tests

`python3 -m unittest discover -s tools/calibrate -p "test_*.py"` (parsing and the cut-off
arithmetic, no downloads); `bun test test/calibrate-features.test.ts` for what dump writes.
