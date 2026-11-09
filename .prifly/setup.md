---
setup:
  - bun install --frozen-lockfile --production --ignore-scripts
---

The tests run from source and need only the runtime dependencies (zod, onnxruntime-node's
JavaScript). `--ignore-scripts` skips onnxruntime-node's postinstall, which fetches its native
binaries; the tests use fakes and never load onnxruntime.

`--production` leaves the dev dependencies out because `@prifly/extension-api` is still a
`file:` dependency on prifly's `packages/extension-api`, and `bun.lock` records it as a path
relative to the checkout that wrote it, so it cannot be found from any other folder (a gate's
scratch worktree included). Once the v0.16.0 tag is published and the dependency is
`git+ssh://git@github.com/jimmy927/prifly-extension-api.git#v0.16.0`, drop `--production` so the
typecheck and biome can run from this setup too.

What it relies on outside the worktree:
- `bun` on PATH, 1.4.2 (the version that wrote `bun.lock`).
- Network access to the npm registry, or Bun's global cache (`~/.bun/install/cache`).
