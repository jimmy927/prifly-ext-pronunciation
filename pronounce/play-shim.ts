/**
 * A local type shim for prifly's "dictation-mark-audio" feature, which the
 * linked `@prifly/extension-api` does not have yet (prifly's side is not
 * landed). Delete this file once the package carries these types.
 *
 * With the feature, a `DictationMarkAction` may have `kind: "play"`: on a
 * click prifly calls the handler given to `onDictationMarkAction`, and when
 * it returns (or resolves to) `{ audio: "<absolute path of a .wav or .mp3>" }`
 * the card plays that file, with a spinner while the promise is pending.
 */

import type {
  DictationMarkAction,
  DictationMarkClick,
  DictationPiece,
} from "@prifly/extension-api";

/** The piece's audio at the device's own rate (extension-api 0.18, feature "dictation-audio-full"). */
export type AudioFull = { rate: number; samples: Float32Array };

/** A dictation piece as 0.18 hands it over: `audioFull` only when the manifest declares audio and the rate is known. */
export type FullPiece = DictationPiece & { audioFull?: AudioFull };

/** The `api.features` name prifly adds. Without it, no action carries `kind`. */
export const MARK_AUDIO = "dictation-mark-audio";

export type PlayAction = DictationMarkAction & { kind: "play" };

export type PlayResult = { audio: string };

export type PlayHandler = (
  click: DictationMarkClick,
) => undefined | PlayResult | Promise<undefined | PlayResult>;

/** `onDictationMarkAction` as it takes a handler that may answer with audio. */
export type OnMarkAction = (handler: PlayHandler) => void;
