---
setup:
  - bun install --frozen-lockfile --ignore-scripts
---

The tests, the typecheck and biome run from source after one install. `--ignore-scripts` skips
onnxruntime-node's postinstall, which fetches its native binaries; the tests use fakes and never
load onnxruntime.

`@prifly/extension-api` is still a `file:` dependency on prifly's `packages/extension-api`. Bun
writes it into `bun.lock` as a path relative to the checkout that ran the install, which no other
folder (a gate's scratch worktree included) can find, so its entry in `bun.lock` was set to the
absolute path by hand. An install without `--frozen-lockfile` may write it relative again. Once
the v0.16.0 tag is published, the dependency becomes
`git+ssh://git@github.com/jimmy927/prifly-extension-api.git#v0.16.0` and this goes away.

What it relies on outside the worktree:
- `bun` on PATH, 1.4.2 (the version that wrote `bun.lock`).
- Network access to the npm registry, or Bun's global cache (`~/.bun/install/cache`).
