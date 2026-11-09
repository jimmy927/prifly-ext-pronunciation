# prifly-ext-pronunciation

A prifly extension that listens to your English dictation and puts a wavy
underline under words said with a German or Swedish accent feature. With the
caret in one, the hint under the message box says what was heard and how to
say it:

> **three** heard /triː/, the word is /θriː/ · th → t: tongue tip between the
> teeth, let the air through

Listen is prifly's own. "Not a mistake" keeps that word with what was heard
in it, in `api.state`, and the pair is never marked again. A dictated word you
correct by hand is judged again as the corrected word. Pieces in other
languages are ignored, and dictation never waits on the extension: work runs
after the words are in the box, and while one request runs only the newest one
waits.

Settings → Extensions shows it as "Hears your dictation (with audio)".

## What it marks

Only substitutions that are accent features: z to s, a final voiced consonant
gone voiceless, th said as t, s, f, d or z, w and v for each other, and sh, ch,
j, zh for one another. A word is marked only if every dictionary pronunciation
has such a substitution and the model gave the heard phone a posterior of at
least 0.7. Vowel differences, left-out and added sounds and a list of function
words are never marked.

These rules come from a benchmark on 13 Speech Accent Archive speakers (5
German, 5 Swedish, 3 native English), where every other kind of edit was as
common in natives as in learners. Do not retune them without rerunning it.

## What it downloads

On first enable, into `<prifly data>/models/` (no account or key needed):

| What                                                                | Source                                                                                          | Size       |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------- |
| Phoneme model, wav2vec2-lv-60-espeak-cv-ft, uint8 (Apache-2.0)      | `onnx-community/wav2vec2-lv-60-espeak-cv-ft-ONNX`, `onnx/model_quantized.onnx` and `vocab.json` | 318 MB     |
| Britfone 3.0.1 pronouncing dictionary (MIT), with its `LICENSE.txt` | `JoseLlarena/Britfone` on GitHub                                                                | under 1 MB |

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

## What is where

| File                                                                                                        | What it is                                                          |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `prifly-extension.json`                                                                                     | The manifest, with `"dictation": { "audio": true }`                 |
| `index.ts`                                                                                                  | `activate`: the extension with its real dependencies                |
| `pronounce/extension.ts`                                                                                    | Puts the runner and the coach together on the api                   |
| `pronounce/coach.ts`                                                                                        | Dictation handlers, marks, "Not a mistake", the busy rule           |
| `pronounce/runner.ts`, `status.ts`                                                                          | The worker's life (fetch, start, restart, stop) and the status line |
| `pronounce/download.ts`, `models.ts`                                                                        | The sha256-pinned downloader and what it fetches                    |
| `pronounce/worker.ts`, `serve.ts`, `phone-model.ts`, `engine.ts`, `lifetime.ts`                             | The worker process                                                  |
| `pronounce/worker-pipe.ts`, `calls.ts`, `protocol.ts`, `pcm.ts`                                             | How the extension and the worker talk                               |
| `pronounce/judge.ts`, `contrasts.ts`, `align.ts`, `ctc.ts`, `phones.ts`, `dictionary.ts`, `not-mistakes.ts` | The judging, unchanged in its rules                                 |
| `test/`                                                                                                     | Tests over fakes                                                    |
