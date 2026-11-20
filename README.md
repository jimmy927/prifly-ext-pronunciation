# prifly-ext-pronunciation

![A dictated message in prifly with the word "three" underlined in red and its card open: "You said TREE", "Say THREE", the fix, and the Yours and Say it right buttons](docs/screenshot.png)

_A sent message with two marked words, and the card that opens on one of them (invented sentence)._

A prifly extension that listens to your English dictation and puts a wavy
underline under words said with an accent feature: nine checks, every one on,
each with its own switch. With the caret in one, the hint under the message box
says how to fix it. Pointing at the word in a sent message opens a card: the
word, "Sure · 94%", "You said" the struck-through TREE, "Say THREE" and the
card's line, whose first words name the check:

> **three** TH said as T. Tongue tip between the teeth, let the air through.

The respellings (`pronounce/respell.ts`) are plain English, not IPA: the
stressed syllable in capitals, syllables joined by "-", and the swapped sound
doubled where it stands alone after a vowel (BROW-sser to BROW-zzer, THEESS to
THEEZZ). A mark is "sure" when natives get it on at most 1 word in 1000, and
"not sure" up to 1 in 200 (`pronounce/data/thresholds.json`, from
`tools/calibrate`; see "What ships now").

Settings → Extensions → Pronunciation → Underline picks which are drawn:
"Sure and not sure" (the default), "Sure mistakes only", or "Off" (nothing is
judged then). A "Sure mistakes only" picked before this default is read as
"Sure and not sure" once, on the first start after the update (remembered in
`api.state`, `pronounce/drawn.ts`), until you pick an Underline yourself. An
extension cannot write its settings, so the form keeps saying "Sure mistakes
only" meanwhile: pick another and back to make it yours.

Sensitivity, below it, says how readily a word is underlined: "Like 1 in 200
natives" (the default, the cut-offs above), "Like 1 in 50 natives" or "Like 1
in 10 natives". Each step finds more, and also more words a native speaker
says the same way: every check's "not sure" moves to where natives get it on 1
word (or sound) in 50, or 1 in 10, and "sure" stays one step stricter, at the
step before's "not sure" (`pronounce/sensitivity.ts`; the steps are each
check's `looser` in `pronounce/data/thresholds.json`, see "What ships now").
"Check your flags" names the step in use.

Below Sensitivity, one switch per check (see "What it marks"): turn off what
does not work for you. A change to any of these applies at once, to the marks
already given too, and nothing switches a check off by itself.

Listen is prifly's own. "Not a mistake" keeps that word with what was heard
in it, in `api.state`, and the pair is never marked again; it also counts as a
Wrong on that check in "Check your flags", and switches nothing. A dictated word you
correct by hand is judged again as the corrected word. Pieces in other
languages are ignored, and dictation never waits on the extension: work runs
after the words are in the box, and while one request runs only the newest one
waits.

Settings → Extensions shows it as "Hears your dictation (with audio)".

## Yours and Say it right

With a prifly that has the feature "dictation-mark-audio" (not landed in prifly
yet; an older prifly gets no such buttons), a mark's card has two buttons under
"Say": **Yours** plays your own word, cut from the piece audio the extension
keeps for corrections, and **Say it right** plays your sentence said correctly
in your own voice, at your own speed. Both are 44.1 kHz wavs; nothing at 22
kHz or below is made or played. The card shows its spinner while the clip is
made; a clip is made on the first click and kept in `<prifly data>/pronunciation/voice/`.

Say it right is made like the research run's variant B (`pronounce/voice.ts`):

1. The sentence (the corrected word, for a correction) read by Edge TTS
   en-GB-RyanNeural, kept at its native 24 kHz.
2. Time-matched to you: Seed-VC's `--length-adjust` is your clip's length over
   the reading's (kept between 0.4 and 2.5).
3. Seed-VC `inference.py` with `--f0-condition True --auto-f0-adjust True
   --diffusion-steps 100 --inference-cfg-rate 0.7`, the 44.1 kHz model.
4. Your voice reference: the wav in "Your voice sample", or, when empty, your
   cleanest recent full-rate pieces (about 20 s).

Seed-VC needs a GPU, and prifly's extension api cannot rent one for an
extension on demand (`api.onRent` answers only the New session dialog's rent
row; `api.machines.report` only lists boxes), so the box is a setting: **Voice
box (ssh)** (`root@ssh2.vast.ai`), **Voice box port** and **Voice box key
file**. The first click puts `pronounce/box/runner.py` there and has it install
Seed-VC, edge-tts and ffmpeg (minutes, once); each clip after that is a few ssh
calls (`pronounce/box.ts`). The box costs money while it runs: stop it when
you are done.

Full-rate audio: prifly's piece audio is 16 kHz, and this extension never
plays that, nor that resampled up. It needs the piece's audio at the device's
own rate (`audioFull`, 48 kHz say; the feature "dictation-audio-full", extension
api 0.18, not landed yet). **Yours** is cut from it and played at that rate, and
without it there is no Yours button. The voice reference is made only from
full-rate pieces (or the wav in "Your voice sample"); with neither, Say it right
says it has no reference. `pronounce/play-shim.ts` holds the types of
"dictation-mark-audio" and `audioFull` until the package has them.

## What it marks

Nine checks (`pronounce/checks.ts`), each with its switch in Settings →
Extensions → Pronunciation, all on by default. Every card starts with the
check's name, says what was off and how to fix it, under 300 characters, with
the "You said" and "Say" respellings:

| Switch                  | What it underlines                                                                                   | The card starts      |
| ----------------------- | ---------------------------------------------------------------------------------------------------- | -------------------- |
| Z said as S             | please, these, was: a Z (or the ZH of measure) heard as S, at the end of a word too                  | "Z said as S."       |
| Final D said as T       | did, need, could: a final B, D, G, V or TH gone voiceless                                            | "Final D said as T." |
| TH said as T, D, S or F | three, this, think                                                                                   | "TH said as T."      |
| W and V swapped         | we, very, wave                                                                                       | "W said as V."       |
| SH, CH and J swapped    | shop, chip, job                                                                                      | "SH said as CH."     |
| Any other swapped sound | any other consonant heard as another: the J in just said as Y, an R as an L                          | "Swapped sound."     |
| Word stress             | DEV-eloper for de-VEL-oper: the wrong syllable stressed                                              | "Word stress."       |
| Vowels                  | much said like match, a gliding vowel held still: a stressed vowel natives almost never say that way | "Vowel."             |
| Unreduced vowels        | the A in about or the O in today said full instead of a weak uh                                      | "Unreduced vowel."   |

The piece's words are first aligned over the model's output as one sentence
(`pronounce/force-align.ts`, a CTC forced alignment), each as the pronunciation
the audio fits best, so Parakeet's word times, off by up to 440 ms, only bound
where a word may go. Only words Britfone has are judged, never a function word,
and a way of saying a word that another accepted pronunciation has (Britfone's
British, CMUdict's American) is never a mistake.

- **The five named swaps** (`pronounce/judge.ts`, `contrasts.ts`): a phone the
  model heard as such a swap with a posterior from its check's cut-off up, the
  expected phone not heard there too.
- **Any other swapped sound** (`pronounce/any-sound.ts`): a consonant whose
  goodness (the model's log posterior for it against its best competitor,
  `gop.ts`) sits past the natives' 0.5th percentile for that consonant, lost to
  another English consonant that is none of the five named swaps and not the
  sound beside it. The noisiest check.
- **Word stress** (`pronounce/stress.ts`): a word of two or more vowels where
  another syllable is louder, longer and higher than the stressed one, each cue
  scaled by the whole sentence's, by more than natives do (the `stress` entry
  of `thresholds.json` and the natives' leads in `native-stats.json`).
- **Vowels** (`pronounce/vowels.ts`): a word's stressed full vowel, gliding ones
  included, past the natives' 0.5th percentile for it and heard as a vowel of
  another kind. Not sure, unless the accent profile has confirmed that very
  pattern (`pronounce/confirmed.ts`): then sure, in any syllable, with the
  pattern's card ("Your U in 'cup' tends to open…").
- **Unreduced vowels** (`pronounce/weak-vowels.ts`): an unstressed schwa past
  the natives' 0.5th percentile for schwa, heard as a full vowel.

A word several checks mark shows the first switched on, in the table's order;
switch that one off and the next shows. Left-out and added sounds are never
marked. The five named swaps come from a benchmark on 13 Speech Accent Archive
speakers (5 German, 5 Swedish, 3 native English).

### What ships now

Everything is on, one switch per check, so you can judge each in your own
dictation and switch off what does not work for you. Expect many underlines:
on speechocean762's Mandarin learners most flags were rated wrong. The cut-offs
are the natives' (LibriSpeech and VCTK, `tools/calibrate`): a check marks "not
sure" from where natives would get it on 1 word in 200, and "sure" from 1 in
1000, never stricter than the 0.70 / 0.88 posterior the extension had before.
Any other swapped sound and unreduced vowels are not measured per word yet:
they mark from the natives' 0.5th (not sure) and 0.1th (sure) percentile of
each sound until a calibration measures them. The full run is in
[`tools/calibrate/report.md`](tools/calibrate/report.md).

The looser Sensitivity steps, from the same natives:

| check                               | 1 in 200 (default) | 1 in 50        | 1 in 10         |
| ----------------------------------- | ------------------ | -------------- | --------------- |
| the five contrasts (posterior)      | 0.50               | 0.20           | 0.20            |
| word stress (lead, with / no pitch) | 1.15 / 1.25        | 0.90           | 0.30            |
| vowels, any other sound, unreduced  | 0.5th percentile   | 2nd percentile | 10th percentile |

Natives get a contrast on at most 0.15% of words even at 0.50, the lowest
posterior the calibration measured, so 1 in 50 and 1 in 10 are not reached on
its curve: `stats.py` (`loosened_cut`) carries the curve on below and stops at
a floor of 0.20, which both steps hit; the next calibration measures the
natives down to 0.20. Word stress's steps are the natives' lead percentiles 98
and 90 (`native-stats.json`), rounded up to `stats.py`'s grid.
`tools/calibrate/rescore.ts` re-scores a dump of your own dictation at every
step from its numbers, without the model.

| check                   | learner precision                   | native flags per word at 0.70 | ships                       |
| ----------------------- | ----------------------------------- | ----------------------------- | --------------------------- |
| Z/S                     | 55% (22 flags)                      | 0.07%                         | on (0.50 maybe, 0.50 sure)  |
| final devoicing         | 17%                                 | 0.11%                         | on (0.50 maybe, 0.725 sure) |
| th                      | 15%                                 | 0.06%                         | on (0.50 maybe, 0.50 sure)  |
| w/v                     | 9%                                  | 0.00%                         | on (0.50 maybe, 0.50 sure)  |
| sh/ch                   | 13% (16 flags, under the 20 needed) | 0.04%                         | on (0.50 maybe, 0.50 sure)  |
| word stress             | 19%                                 | not tabulated                 | on (lead 1.15–1.25 maybe)   |
| vowels                  | not measured per word               | not tabulated                 | on (natives' 0.5th pct.)    |
| any other swapped sound | not measured yet                    | not measured yet              | on (natives' 0.5th pct.)    |
| unreduced vowels        | not measured yet                    | not measured yet              | on (natives' 0.5th pct.)    |

### Check your flags

The second tab of "Your accent", "Check your flags", helps you decide which
switch to turn off. "Score my last 200 sentences" takes the newest 200 English
pieces of prifly's dictation recordings (Settings, Dictation, "Keep recordings
of my dictation"; only pieces with the microphone's full-rate audio) and scores
them in the background on a worker of its own, two threads, one piece at a
time, with a progress line and Cancel. Every candidate of every check is
listed, the ones switched off included, at loose cut-offs: a contrast from
posterior 0.5, word stress from its `maybe` lead, a vowel past the natives' 5th
percentile, the other two from their cut-offs. Each row plays your own word
("Yours"), says it right, and takes a Right or Wrong.

Per check the tab shows how often you found it wrong, here and with "Not a
mistake" in the session ("9 of 14 not a mistake"), and the name of the switch
that turns it off. The marks switch nothing themselves (`pronounce/personal.ts`,
kept in `api.state` as `flag-marks`). "Reset marks" clears them.

prifly's extension api has no call for past dictation; the recordings are read
where prifly's host writes them, `<prifly data>/dictation-recordings/`
(`pronounce/past-pieces.ts`).

## Your accent

Vowels cannot be judged one word at a time, so they are measured over all your
dictation instead. After each judged piece the goodness of every content word's
vowels and checked consonants (`pronounce/scores.ts`) goes into a profile kept
in prifly's state on this machine (`pronounce/profile.ts`: the last 30 days, at
most 150 scores per sound). Once a sound has 40 examples and your median sits
below native speakers' 10th percentile (`pronounce/data/native-stats.json`, from
`tools/calibrate`), it is confirmed. The "Your accent" button in the status bar
(`panel/`) shows the three confirmed sounds furthest from native, the words they
were heard in, and Yours and Say it right for one of them.

A confirmed vowel also makes the Vowels check sure (`pronounce/confirmed.ts`): a
later word with that vowel is marked "sure" when its vowel sits below the
natives' 0.5th percentile (at most 1 native word in 200) and sounds like the
pattern's (the A in "cap" for the U in "cup"), stressed or not. Without
`native-stats.json` the profile only collects: the panel says so, nothing is
compared, and the Vowels check marks nothing.

## What it downloads

On first enable, into `<prifly data>/models/` (no account or key needed):

| What                                                                | Source                                                                                          | Size       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------- |
| Phoneme model, wav2vec2-lv-60-espeak-cv-ft, uint8 (Apache-2.0)      | `onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX`, `onnx/model_quantized.onnx` and `vocab.json` | 318 MB     |
| Britfone 3.0.1 pronouncing dictionary (MIT), with its `LICENSE.txt` | `JoseLlarena/Britfone` on GitHub                                                                | under 1 MB |
| CMUdict, American pronunciations (BSD-2-Clause), with its `LICENSE` | `cmusphinx/cmudict` on GitHub                                                                   | 3.6 MB     |

Each file is pinned to a revision and a sha256 (`pronounce/models.ts`) and only
gets its name once the hash matched. The status line in Settings → Extensions
shows each file's percent, then "Loading the phoneme model", then "Ready", or
an `Error:` line saying the download failed, the sha256 did not match, or the
worker crashed. After an error, disable and enable the extension to try again.

The model runs in a process of its own (`pronounce/worker.ts`), started on
enable and stopped on disable: onnxruntime on the CPU only, never the GPU, 4
threads, low priority (nice 19; "below normal" on Windows, whose lowest class
would starve it), about 1.1 GB of memory.

## Install

prifly's host loads extensions from the data folder of the OS it runs on, and
reads only files of that OS: a clone on a WSL disk, or a link into one, is
never seen by a host running natively on Windows. Install on the OS that runs
the host.

### Windows

The host runs natively and loads `%LOCALAPPDATA%\prifly\host\extensions`. In
PowerShell, with [git](https://git-scm.com) and [Bun](https://bun.sh) for
Windows installed:

```powershell
git clone https://github.com/jimmy927/prifly-ext-pronunciation.git "$env:LOCALAPPDATA\prifly\host\extensions\prifly-ext-pronunciation"
cd "$env:LOCALAPPDATA\prifly\host\extensions\prifly-ext-pronunciation"
bun install --frozen-lockfile --production --ignore-scripts
```

Then open Settings → Extensions and enable "Pronunciation" (the folder's name
does not matter; the manifest's `id` does). The first enable downloads the
model; the status line shows its progress.

The same install without a terminal: Settings → Extensions → Install from URL
with the repository's URL. prifly clones it into the extensions folder under
the repository's name and runs the same `bun install` behind it, and the
extension is left disabled until you enable it.

`--production --ignore-scripts` is what prifly runs itself on a clone: the
runtime packages only (`zod`, `onnxruntime-node`), no install scripts. Update
with `git pull` in the folder (or Settings → Extensions), then disable and
enable the extension.

### Linux and macOS

The same, with the host's data folder: `~/.local/share/prifly/extensions` on
Linux (`$XDG_DATA_HOME/prifly/extensions` when that is set),
`~/Library/Application Support/prifly/extensions` on macOS.

```sh
git clone https://github.com/jimmy927/prifly-ext-pronunciation.git ~/.local/share/prifly/extensions/prifly-ext-pronunciation
cd ~/.local/share/prifly/extensions/prifly-ext-pronunciation
bun install --frozen-lockfile --production --ignore-scripts
```

A host that runs inside WSL uses the Linux folder inside WSL; a host that runs
on Windows uses the Windows one. They are two installs, each from its own
clone.

## Develop

Work in a clone of your own, and link it into the extensions folder of the OS
you work on (a link there is your checkout: prifly never updates or installs
into it). On Windows, a junction needs no administrator rights:

```powershell
bun install --ignore-scripts
New-Item -ItemType Junction -Path "$env:LOCALAPPDATA\prifly\host\extensions\pronunciation" -Target $PWD
```

On Linux and macOS: `ln -s "$PWD" ~/.local/share/prifly/extensions/pronunciation`.

`@prifly/extension-api` 0.16.0 is a `file:` dependency on a prifly checkout for
now, types only. Once that version is published it becomes
`git+ssh://git@github.com/jimmy927/prifly-extension-api.git#v0.16.0` in
`package.json`, and `bun.lock` is regenerated. Until then its path is a prifly
checkout's on the machine that wrote it, so a development install (with the dev
dependencies) elsewhere, a Windows machine included, needs `package.json`
pointed at a local prifly checkout's `packages/extension-api`; the install of
the extension (above) leaves the dev dependencies out and does not care.

`onnxruntime-node`'s install script only fetches GPU providers, which this
extension does not use: its CPU library ships in the package, for Windows too
(x64 and arm64, beside a DirectML library that is never loaded: the session
names the CPU provider only, `cpuSessionOptions` in `pronounce/engine.ts`), and
prifly's `--ignore-scripts` install is enough.

## Checks

`bun run test`, `bun run typecheck`, `bun run check` (biome: 500 lines per
file, 120 per function, cognitive complexity 15, no `any`, no `!`).

Tests use a fake worker, a fake model and a fake `fetch`: none loads or
downloads the real model. What differs on Windows (the data folder, the
worker's argument and priority, moving a download into place, how a worker
learns its host is gone) takes the system as an argument and is tested for
Windows on any system (`test/windows.test.ts`).

## Checking it on Windows

What the tests cannot show, on a Windows machine with the extension installed
as above:

1. Settings → Extensions lists "Pronunciation"; enable it. The status line
   goes from the download's percent per file to "Loading the phoneme model" to
   "Ready", and the files are under
   `%LOCALAPPDATA%\prifly\host\models\wav2vec2-lv-60-espeak-3d1479b5` and
   `britfone-59f197e9`.
2. Task Manager → Details: one `bun.exe` (or the host's own name) running
   `worker.ts`, at "Below normal" priority, with no console window opened, and
   no GPU use in the Performance tab while a sentence is judged.
3. Disable the extension: that process is gone within a second. Kill the host
   instead: the worker is gone within a few seconds (it asks whether its
   parent still runs).
4. The Extensions dialog shows no `Error:` line, and `extension_status` shows
   no `could not stop the worker`, `could not write to the worker` or
   `priority not lowered` log lines.

## Checking the real model

No automated test does this. It downloads 318 MB and uses about 1.1 GB of
memory and 4 cores, so run it deliberately, on a machine with room:

1. Install and enable the extension (above), and wait for the status line to say "Ready".
2. Dictate an English sentence with "three" said as "tree", or a final "d" said
   as "t".
3. The word gets its underline within a second or so, and the hint reads as
   above. `mcp__prifly__extension_status` shows the last error, if any.
4. Switch "TH said as T, D, S or F" off in Settings → Extensions →
   Pronunciation: the "three" underline goes at once; switch it on and it comes back.

## What is where

| File                                                                                                        | What it is                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `prifly-extension.json`                                                                                     | The manifest, with `"dictation": { "audio": true }`                                                                          |
| `index.ts`                                                                                                  | `activate`: the extension with its real dependencies; `panel`                                                                |
| `pronounce/extension.ts`                                                                                    | Puts the runner and the coach together on the api                                                                            |
| `pronounce/coach.ts`, `drawn.ts`, `checks.ts`                                                               | Dictation handlers, marks, "Not a mistake", the busy rule; which marks the settings draw, the nine checks and their switches |
| `pronounce/voice.ts`, `box.ts`, `box/runner.py`, `wav.ts`, `play-shim.ts`                                   | Yours and Say it right: the clips, the GPU box, the box's script                                                             |
| `pronounce/runner.ts`, `status.ts`                                                                          | The worker's life (fetch, start, restart, stop) and the status line                                                          |
| `pronounce/download.ts`, `models.ts`                                                                        | The sha256-pinned downloader and what it fetches                                                                             |
| `pronounce/worker.ts`, `serve.ts`, `phone-model.ts`, `engine.ts`, `lifetime.ts`                             | The worker process                                                                                                           |
| `pronounce/worker-pipe.ts`, `calls.ts`, `protocol.ts`, `pcm.ts`                                             | How the extension and the worker talk                                                                                        |
| `pronounce/judge.ts`, `contrasts.ts`, `align.ts`, `ctc.ts`, `phones.ts`, `dictionary.ts`, `not-mistakes.ts` | The judging                                                                                                                  |
| `pronounce/force-align.ts`, `thresholds.ts`, `gop.ts`, `pitch.ts`                                           | Sentence alignment, the checks' cut-offs, phone goodness and pitch                                                           |
| `pronounce/stress.ts`                                                                                       | Word stress: the sentence-scaled cues, the lead, the stress mark                                                             |
| `pronounce/any-sound.ts`, `weak-vowels.ts`, `vowels.ts`                                                     | Any other swapped sound, unreduced vowels, and the Vowels check                                                              |
| `pronounce/scores.ts`, `profile.ts`, `native.ts`, `confirmed.ts`, `accent-words.ts`                         | The accent profile, its confirmed patterns, the cards' plain words                                                           |
| `pronounce/accent-panel.ts`, `panel/`                                                                       | The "Your accent" window: its data and its page                                                                              |
| `pronounce/flag-check.ts`, `flags.ts`, `scan-worker.ts`, `past-pieces.ts`, `resample.ts`, `personal.ts`     | Check your flags: the job, its flags, the reader's verdicts per check                                                        |
| `tools/calibrate/`                                                                                          | Measures natives and learners on a rented box (its `README.md`)                                                              |
| `test/`                                                                                                     | Tests over fakes                                                                                                             |
