/**
 * The Pronunciation extension: what prifly imports. `activate` fetches the
 * phoneme model and the dictionary the first time, starts the worker that
 * runs the model, and underlines the words of the reader's English
 * dictation said with a German or Swedish accent feature
 * (`pronounce/extension.ts`). The function it returns stops the worker.
 * `panel` answers the "Your accent" window (`pronounce/accent-panel.ts`).
 * Types come from `@prifly/extension-api` with `import type`, so nothing of
 * it is loaded at run time.
 */

import type { ExtensionApi, PanelRequest } from "@prifly/extension-api";
import { ACCENT_PANEL } from "./pronounce/accent-panel";
import { realDeps, type Started, start } from "./pronounce/extension";

let running: Started | null = null;

export function activate(api: ExtensionApi): () => void {
  const started = start(api, realDeps(api));
  running = started;
  return () => {
    started.stop();
    if (running === started) running = null;
  };
}

/** What the "Your accent" window asks for; throws while the extension is not running, which the window shows. */
export function panel(panelId: string, request: PanelRequest): Promise<unknown> {
  const accent = running?.panel;
  if (panelId !== ACCENT_PANEL || accent === null || accent === undefined) {
    return Promise.reject(new Error("Pronunciation is not running"));
  }
  return accent.handle(request);
}
