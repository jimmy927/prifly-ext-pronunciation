/**
 * A sentence read aloud by Edge's online voices, on this machine: the native readings the
 * native check judges (`native-control.ts`). The same service and voice "Say it right" reads
 * with on the GPU box (`box/runner.py`, through the edge-tts package); here it is asked
 * directly over its websocket, as edge-tts 7.3.1 does (`edge-token.ts` makes its token), so no
 * box is needed. Only the sentence's text is sent.
 *
 * Edge answers only in compressed formats (mp3 or webm opus; every PCM and wav format is
 * refused with "Unsupported Edge output format"), so the mp3 is decoded by `ffmpeg` on the PATH
 * to 16-bit samples at its native 24 kHz.
 */

import { randomUUID } from "node:crypto";
import { secMsGec, TRUSTED_CLIENT_TOKEN } from "./edge-token";
import { READING_RATE } from "./voice";
import type { Wav } from "./wav";

const CHROMIUM = "143.0.3650.75";
const MAJOR = CHROMIUM.split(".")[0];
const URL_BASE =
  "wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1" +
  `?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}`;
const HEADERS = {
  Pragma: "no-cache",
  "Cache-Control": "no-cache",
  Origin: "chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold",
  "User-Agent": `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${MAJOR}.0.0.0 Safari/537.36 Edg/${MAJOR}.0.0.0`,
  "Accept-Language": "en-US,en;q=0.9",
};
/** The only 24 kHz format Edge gives that ffmpeg reads everywhere. */
export const EDGE_FORMAT = "audio-24khz-48kbitrate-mono-mp3";
/** How long a reading may take before it counts as failed. */
export const EDGE_TIMEOUT_MS = 15_000;

const uuid = () => randomUUID().replaceAll("-", "");

/** `text` safe inside the SSML. */
export function escapeXml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** The two messages that ask for `text` in `voice`: the format, then the SSML. */
export function edgeMessages(text: string, voice: string, date = new Date()): [string, string] {
  const stamp = date.toString();
  const config =
    `X-Timestamp:${stamp}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
    `{"context":{"synthesis":{"audio":{"metadataoptions":{"sentenceBoundaryEnabled":"false","wordBoundaryEnabled":"false"},"outputFormat":"${EDGE_FORMAT}"}}}}`;
  const ssml =
    `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${stamp}Z\r\nPath:ssml\r\n\r\n` +
    `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='${escapeXml(voice)}'>` +
    `<prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escapeXml(text)}</prosody></voice></speak>`;
  return [config, ssml];
}

/** The audio of one binary message: after its two-byte header length and the header, when the header says `Path:audio`. */
export function audioOf(message: Uint8Array): Uint8Array | null {
  if (message.length < 2) return null;
  const length = ((message[0] ?? 0) << 8) | (message[1] ?? 0);
  const header = new TextDecoder().decode(message.subarray(2, 2 + length));
  return header.includes("Path:audio") ? message.subarray(2 + length) : null;
}

/** `text` read by Edge in `voice`, as the mp3 it sends. */
export function edgeMp3(
  text: string,
  voice: string,
  timeoutMs: number = EDGE_TIMEOUT_MS,
): Promise<Uint8Array> {
  const url = `${URL_BASE}&ConnectionId=${uuid()}&Sec-MS-GEC=${secMsGec()}&Sec-MS-GEC-Version=2-${CHROMIUM}`;
  const headers = { ...HEADERS, Cookie: `muid=${uuid().toUpperCase()};` };
  // Bun's WebSocket takes headers; the DOM type does not know them.
  const socket = new WebSocket(url, { headers } as unknown as string[]);
  socket.binaryType = "arraybuffer";
  const parts: Uint8Array[] = [];
  return new Promise<Uint8Array>((resolve, reject) => {
    let ended = false;
    const end = (error: Error | null) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      socket.close();
      if (error !== null) reject(error);
      else if (parts.length === 0) reject(new Error("Edge sent no audio"));
      else resolve(Buffer.concat(parts));
    };
    const timer = setTimeout(
      () => end(new Error(`Edge did not finish within ${timeoutMs} ms`)),
      timeoutMs,
    );
    socket.onopen = () => {
      for (const message of edgeMessages(text, voice)) socket.send(message);
    };
    socket.onmessage = (event) => {
      if (typeof event.data === "string") {
        if (event.data.includes("Path:turn.end")) end(null);
        return;
      }
      const audio = audioOf(new Uint8Array(event.data as ArrayBuffer));
      if (audio !== null && audio.length > 0) parts.push(audio);
    };
    socket.onerror = () => end(new Error("Edge could not be reached"));
    socket.onclose = (event) =>
      end(
        new Error(
          `Edge closed the connection (${event.code}${event.reason ? `: ${event.reason}` : ""})`,
        ),
      );
  });
}

/** 16-bit little-endian samples as floats. */
export function floatsOfS16(bytes: Uint8Array): Float32Array {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(Math.floor(bytes.byteLength / 2));
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/** An mp3 decoded by `ffmpeg` on the PATH, at 24 kHz; a console program, so its window is hidden on Windows. */
export async function decodeMp3(mp3: Uint8Array): Promise<Wav> {
  const ffmpeg = Bun.which("ffmpeg");
  if (ffmpeg === null) throw new Error("No ffmpeg on the PATH to decode Edge's mp3");
  const child = Bun.spawn(
    [
      ffmpeg,
      "-hide_banner",
      "-loglevel",
      "error",
      "-i",
      "pipe:0",
      "-ac",
      "1",
      "-ar",
      String(READING_RATE),
      "-f",
      "s16le",
      "pipe:1",
    ],
    { stdin: mp3, stdout: "pipe", stderr: "pipe", windowsHide: true },
  );
  const [out, err, code] = await Promise.all([
    new Response(child.stdout).arrayBuffer(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`ffmpeg failed (exit ${code}): ${err.trim().slice(-300)}`);
  return { rate: READING_RATE, samples: floatsOfS16(new Uint8Array(out)) };
}

/** `text` read by Edge in `voice`, at 24 kHz. */
export async function edgeRead(text: string, voice: string): Promise<Wav> {
  return decodeMp3(await edgeMp3(text, voice));
}
