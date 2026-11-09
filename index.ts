/**
 * The Pronunciation extension: what prifly imports. `activate` fetches the
 * phoneme model and the dictionary the first time, starts the worker that
 * runs the model, and underlines the words of the reader's English
 * dictation said with a German or Swedish accent feature
 * (`pronounce/extension.ts`). The function it returns stops the worker.
 * Types come from `@prifly/extension-api` with `import type`, so nothing of
 * it is loaded at run time.
 */

import type { ExtensionApi } from "@prifly/extension-api";
import { realDeps, start } from "./pronounce/extension";

export function activate(api: ExtensionApi): () => void {
  return start(api, realDeps(api)).stop;
}
