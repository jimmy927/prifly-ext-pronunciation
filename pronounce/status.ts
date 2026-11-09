/**
 * The extension's one line in Settings → Extensions (`api.status`): the
 * download file by file, the model loading, ready, or why it failed. ""
 * while it is off, and the description shows instead.
 */

import type { PronounceRunner } from "./runner";

/** `n` bytes as whole MB. */
const mb = (n: number) => `${Math.round(n / 1e6)} MB`;

export function statusLine(runner: Pick<PronounceRunner, "state" | "fetching" | "error">): string {
  switch (runner.state) {
    case "off":
      return "";
    case "downloading": {
      const at = runner.fetching;
      if (at === null) return "Downloading the phoneme model and the dictionary";
      const amount =
        at.total > 0
          ? `${Math.floor((at.done / at.total) * 100)}% of ${mb(at.total)}`
          : `${mb(at.done)} so far`;
      return `Downloading ${at.what}: ${at.file}, ${amount}`;
    }
    case "loading":
      return "Loading the phoneme model";
    case "ready":
      return "Ready: underlines accent features in your English dictation";
    case "failed":
      return `Error: ${runner.error}`;
  }
}
