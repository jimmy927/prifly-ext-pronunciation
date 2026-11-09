# prifly-ext-template

A minimal prifly extension to start a plugin from. A plugin is a toolbox
for sessions — no launcher boards, no chips: you ask any session in plain
words and it answers through the plugin's tools. This one has a read tool
that uses a connected account, a write tool the reader confirms on a card
first, a status line, and tests of each against a fake `api`.

## Start a plugin from it

1. Copy the folder to a repository of its own, beside your prifly checkout:

   ```sh
   cp -r ~/src/prifly/templates/prifly-ext-template ~/src/prifly-ext-<name>
   cd ~/src/prifly-ext-<name> && git init -b main
   ```

2. Rename it: `id`, `name` and `description` in `prifly-extension.json`,
   `name` in `package.json`, and the tools' `template_` prefix in
   `whoami-tool.ts` and `note-tool.ts` (a tool name must be unique across
   every extension).

3. Get the types. They come from `@prifly/extension-api`, prifly's
   `packages/extension-api`, which is not on npm: `package.json` points at
   a tag of its public mirror repository, so a plain install fetches it (no
   GitHub login or ssh key needed):

   ```sh
   bun install
   ```

   Publishing is automatic: prifly's CI, on every push to master after the
   tests pass, pushes `packages/extension-api`'s current version to the
   mirror as a `v<version>` tag, and does nothing when the mirror already has
   it. Change the `#v0.6.0` in `package.json` to move to a newer tag (0.6.0 is
   the first with `api.confirm` and `api.status`). Versions that were skipped
   while publishing was by hand (0.9 to 0.13) are not backfilled: only the
   version master has when the job first runs gets a tag.

   One-time setup, in prifly's GitHub repository: create a fine-grained
   personal access token limited to `jimmy927/prifly-extension-api` with
   Contents: read and write, and save it as the repository secret
   `EXTENSION_API_MIRROR_TOKEN`. Without it the job fails with a line naming
   the secret. As a fallback, `bun run publish:extension-api [--dry-run]` in
   the prifly checkout does the same by hand, with your own git credentials.

4. Commit `bun.lock`. prifly installs a cloned extension's dependencies
   itself, with `bun install --frozen-lockfile --production --ignore-scripts`,
   when it clones it and when an update moves it: what the code imports at
   run time goes under `dependencies`, tooling under `devDependencies`, and
   the lock must match `package.json`. Install scripts (`postinstall` and the
   like, yours and your dependencies') are never run, so pick dependencies
   that work without them.

5. Try it in prifly: link the folder into the extensions folder and enable it
   in the Extensions dialog.

   ```sh
   ln -s ~/src/prifly-ext-<name> ~/.local/share/prifly/extensions/<name>
   ```

   A linked extension is your own checkout: prifly never updates it or
   installs into it.

6. See which code runs: a session's `mcp__prifly__extension_status` gives,
   per installed extension, the commit its real folder (the link resolved)
   was on when the host started it and whether the tree had changes then,
   when its `activate` returned, its last error, and whether a reload is
   pending. A change is live once `commit.sha` is the checkout's HEAD; the
   host records it, so the extension logs no sha of its own.

## Every write asks first

A tool that changes anything — sends, posts, edits, deletes, creates —
calls `api.confirm` before it does, and does nothing unless it answers
true. The reader sees a card over the session whose tool call asked, with
`summary` large and `details` exactly as written (the text, the recipients,
a diff, the API request), and Confirm or Cancel. It answers false on
Cancel, on closing the card, when the call or its session goes away, or
when there is no session to ask over; it never times out. Tell the session
plainly that nothing was done, so it does not try another way:

```ts
const yes = await api.confirm?.({
  title: "Send an email",
  summary: `Send "${subject}" to ${to}`,
  details: `To: ${to}\nSubject: ${subject}\n\n${body}`,
});
if (yes !== true) return "Not done: you cancelled.";
```

The card has a feedback box. When the reader sends a note instead of
Confirm, `api.confirm` still answers false, but prifly replaces what the
tool returns with an answer that gives the note verbatim and tells the
session to answer it first, and to call the tool again only if the note asks
for a change. Return the plain cancel text; the note is not yours to handle.

Reads run at once. `note-tool.ts` is the pattern; on a prifly without
`api.confirm` (no `"confirm"` in `api.features`) a write tool refuses.

## Its status line, no status bar, no panels

`api.status(text)` is the one line the plugin says about itself —
"Connected as ada@example.com · 41 unread" — shown in Settings → Extensions
in place of its description while it is not empty; `""` clears it, and it
is cleared when the extension stops. Refresh it when what it says changes,
at most every few minutes for anything polled. Where `api.features` has
`"status"`.

The status bar (`statusBar` in `api.show`) and manifest `panels` are for
prifly-wide tools (Vast.ai spend, disk space, perf). A service plugin (Gmail,
Outlook, Azure, AWS, WhatsApp, LinkedIn) puts nothing in either: its state
(sign-in missing, consent, keys) goes in its status line.

## Hearing dictation, marking words

A plugin that works on what the reader dictates — a pronunciation coach, a
grammar check — declares it in its manifest:

    "dictation": { "audio": true }

Settings → Extensions then shows it as "Hears your dictation (with audio)",
or "(text only)" without `audio`. Without `dictation`, the calls below are
not there.

- `"dictation-pieces"` in `api.features`: `api.onDictationPiece(handler)`
  hears each finished piece once its words are in the box — `sessionId`,
  `dict` (the dictation), `piece`, `language`, `text`, `words` (each with
  its character offsets in `text` and its `startMs`/`endMs`; `[]` for a
  Whisper piece) and, with `audio`, `audio` (16 kHz mono `Float32Array`,
  your own copy). Keep the audio yourself if you need it later:
  `api.onDictationCorrection(handler)` tells you when the reader replaced a
  dictated word by hand (`heard`, `word`, and its `start`/`end` in the box)
  and carries none.
- `"dictation-marks"`: `api.markDictation({ sessionId, dict, piece, marks })`
  underlines word ranges of that piece in the box, each with a `label`
  (bold), a `detail` and up to four `actions`; marking the piece again
  replaces them, `marks: []` takes them away. Pass `at` (a correction's
  `start`) to place marks from there in the box. The window adds Listen
  itself; a click on one of your actions reaches
  `api.onDictationMarkAction(handler)` with the mark as you gave it. Your
  marks are cleared when the extension stops.

## Checks

`bun test`, `bun run typecheck` and `bun run check` (biome: 500 lines per
file, 120 per function, cognitive complexity 15, no `any`, no `!`).

Every child process passes `windowsHide: true`, and `test/spawn-hidden.test.ts`
fails on a `Bun.spawn`, or a node `spawn`, `execFile`, `exec` or `fork`, that
does not name it. On Windows prifly's host has no console, so a console
program started without it opens a terminal window over the reader's screen,
one per call. The host makes `true` the default at run time, but a spawn
through a named import of `node:child_process` cannot ask for a window there,
and an extension that runs under an older prifly gets no default at all. A
child that should show a window passes `windowsHide: false` to `Bun.spawn`.

## What is where

| File                                              | What it is                                                                                                                                                                                                    |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prifly-extension.json`                           | The manifest: `connections`, the accounts it uses and why                                                                                                                                                     |
| `index.ts`                                        | What prifly imports: `activate(api)` registers the tools                                                                                                                                                      |
| `whoami-tool.ts`                                  | A read, `mcp__prifly__template_whoami`: calls Microsoft Graph through `api.connections.fetch`, so prifly holds the token                                                                                      |
| `note-tool.ts`                                    | A write, `mcp__prifly__template_save_note`: asks with `api.confirm`, saves in `api.state` only on Confirm, then sets `api.status`                                                                             |
| `test/fake-api.ts`                                | A fake `api` that records what the extension shows, logs, registers, confirms and says as its status, keeps `api.state` in memory, and a fake `api.connections` over a fake token endpoint — copy it as it is |
| `test/index.test.ts`                              | Tests of both tools against the fakes, a confirmed write and a cancelled one                                                                                                                                  |
| `test/spawn-hidden.test.ts`, `test/spawn-scan.ts` | Fails on a spawn without `windowsHide`; the scan is a copy of prifly's own (`apps/desktop-host/src/spawn-scan.ts`)                                                                                            |

Import prifly's types with `import type`: they are erased, so the host never
needs the package to run the extension. Everything added to the api after
its first version is optional (`api.tools?.register`, `api.connections?.list`):
call it that way, and the extension still loads on an older prifly.

## Credentials from the vault

List the vault entries the extension may use under `vault` in the manifest,
by name. Each works only while the entry is at level 1 where the extension
lives: level 2 and 4 ask the reader on a session's card, which an extension
has none of, and level 3 is a fence. Every use is in the vault's audit, as
session `ext:<id>`.

- `api.vault?.read(name)` — an `api-token` entry's token, or null.
- `api.vault?.ssh?.(name, argv, { cwd, timeoutMs })` — where `api.features`
  has `"vault-ssh"`: runs `ssh`, `scp`, `sftp` or `rsync` with an `ssh-key`
  entry handed over, and resolves to `{ ok: true, exitCode, timedOut,
  stdout, stderr }` with every form of the key replaced by
  `[vault:<name>]`, or `{ ok: false, message }` when nothing ran. The key
  never reaches the extension. On Linux and macOS a throwaway `ssh-agent`
  holds it; on Windows it is a file only the user can read, given to `ssh`,
  `scp` and `sftp` as `-i <file> -o IdentitiesOnly=yes` and to an `rsync`
  with no `-e` of its own as one, also named in `PRIFLY_SSH_KEY_FILE` and
  `GIT_SSH_COMMAND`, and deleted when the command ends. Pass no `-i` of
  your own.

```ts
const ran = await api.vault?.ssh?.("vast-key", [
  "ssh",
  "-p",
  "32618",
  "root@ssh7.vast.ai",
  "nvidia-smi",
]);
if (ran?.ok && ran.exitCode === 0) use(ran.stdout);
```

### An extension's own login

An extension that logs in by itself — a personal token the reader pastes
into it, or one a site issues after the reader approves the extension —
keeps that token in the vault, never in a file in its folder: the vault
moves with prifly's data (`prifly-move`), a file in a checkout does not.
Where `api.features` has `"vault-file"`:

- `api.vault?.file?.(name, { token, label?, host?, why })` — asks the reader
  to file `token` as the `api-token` entry `name`, which the manifest's
  `vault` list must name. Every window shows the reader a card, whichever
  session is open: which extension asks, `why`, the entry's name, whether it
  adds the entry or replaces the token an entry already holds, and the token
  as its length and last four characters. It starts at level 1, the one
  level `read` reads; the reader may pick another. Resolves once they answer
  (or after an hour) with `{ outcome: "accepted", level }`, `{ outcome:
  "declined" }`, `{ outcome: "timed out" }`, or `{ outcome: "refused",
  message }` when no card was shown (a name the manifest does not list, an
  entry of another kind, a fenced one). The token never comes back. A new
  entry records the extension as its owner; replacing one keeps its owner.
- `api.vault?.forget?.(name)` — "Log out": removes the entry, but only one
  this extension filed; resolves true when it did. No card — the extension
  takes back what the reader let it put there, on the reader's own click —
  and the vault's audit keeps a row of it.

Read the token back with `api.vault.read(name)` each time it is needed, and
ask again (`file`) when it reads as null: the reader declined, logged out,
or set another level.

```ts
const filed = await api.vault?.file?.("sentry", {
  token: pasted,
  label: "Sentry",
  host: "sentry.io",
  why: "Sentry's issues in the sidebar",
});
// prifly tells the reader how it went; the extension only acts on it.
const loggedIn = filed?.outcome === "accepted";
// Log out
await api.vault?.forget?.("sentry");
```

## Keeping state

Keep what the extension must remember in `api.state`, never in files in its
own folder: the folder is often a git checkout, and it does not move when
prifly's data moves to another host (`prifly-move`); prifly's database does.
Where `api.features` includes `"state"`:

- `get(name)`, `set(name, value)`, `delete(name)`, `list()`: JSON documents
  under names of the extension's own (`A-Z a-z 0-9 . _ -`, up to 128), each
  replaced whole on a write and at most 1 MB as JSON.
- `update(name, (current) => next)`: read-modify-write. Writes to one name
  run one at a time, in call order, even when the function awaits, so two
  updates never lose each other's change. Return the value to keep;
  undefined is refused.
- `importOnce(name, () => value)`: brings old state in once — for files kept
  before `api.state` — and returns what is stored. `make` runs only when the
  document does not exist; undefined from it stores nothing.
- `append(name, entry)` and `read(name, { after, since, limit })`: an
  append-only log, such as an events log, read back oldest first. A log keeps
  its newest 10,000 entries of up to 64 KB each.

A value that is not plain JSON, or over its cap, is refused with an error
naming it, and nothing is written. The full contract is
`packages/extension-api/src/state.ts` in prifly.

```ts
const leases = await api.state?.importOnce("leases", () => readOldLeasesFile());
await api.state?.update<Leases>("leases", (current) => ({ ...current, [box]: lease }));
await api.state?.append("events", { kind: "rented", box, at: Date.now() });
```

## Credentials from the vault

List the vault entries the extension may use under `vault` in the manifest,
by name. Each works only while the entry is at level 1 where the extension
lives: level 2 and 4 ask the reader on a session's card, which an extension
has none of, and level 3 is a fence. Every use is in the vault's audit, as
session `ext:<id>`.

- `api.vault?.read(name)` — an `api-token` entry's token, or null.
- `api.vault?.ssh?.(name, argv, { cwd, timeoutMs })` — where `api.features`
  has `"vault-ssh"`: runs `ssh`, `scp`, `sftp` or `rsync` with an `ssh-key`
  entry handed over, and resolves to `{ ok: true, exitCode, timedOut,
  stdout, stderr }` with every form of the key replaced by
  `[vault:<name>]`, or `{ ok: false, message }` when nothing ran. The key
  never reaches the extension. A throwaway `ssh-agent` holds it and
  is stopped when the command ends. Pass no `-i` of your own.

```ts
const ran = await api.vault?.ssh?.("vast-key", [
  "ssh",
  "-p",
  "32618",
  "root@ssh7.vast.ai",
  "nvidia-smi",
]);
if (ran?.ok && ran.exitCode === 0) use(ran.stdout);
```

### An extension's own login

An extension that logs in by itself — a personal token the reader pastes
into it, or one a site issues after the reader approves the extension —
keeps that token in the vault, never in a file in its folder: the vault
moves with prifly's data (`prifly-move`), a file in a checkout does not.
Where `api.features` has `"vault-file"`:

- `api.vault?.file?.(name, { token, label?, host?, why })` — asks the reader
  to file `token` as the `api-token` entry `name`, which the manifest's
  `vault` list must name. Every window shows the reader a card, whichever
  session is open: which extension asks, `why`, the entry's name, whether it
  adds the entry or replaces the token an entry already holds, and the token
  as its length and last four characters. It starts at level 1, the one
  level `read` reads; the reader may pick another. Resolves once they answer
  (or after an hour) with `{ outcome: "accepted", level }`, `{ outcome:
  "declined" }`, `{ outcome: "timed out" }`, or `{ outcome: "refused",
  message }` when no card was shown (a name the manifest does not list, an
  entry of another kind, a fenced one). The token never comes back. A new
  entry records the extension as its owner; replacing one keeps its owner.
- `api.vault?.forget?.(name)` — "Log out": removes the entry, but only one
  this extension filed; resolves true when it did. No card — the extension
  takes back what the reader let it put there, on the reader's own click —
  and the vault's audit keeps a row of it.

Read the token back with `api.vault.read(name)` each time it is needed, and
ask again (`file`) when it reads as null: the reader declined, logged out,
or set another level.

```ts
const filed = await api.vault?.file?.("sentry", {
  token: pasted,
  label: "Sentry",
  host: "sentry.io",
  why: "Sentry's issues in the sidebar",
});
// prifly tells the reader how it went; the extension only acts on it.
const loggedIn = filed?.outcome === "accepted";
// Log out
await api.vault?.forget?.("sentry");
```
