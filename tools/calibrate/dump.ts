/**
 * Runs the extension's phoneme model over a folder of 16 kHz mono wavs and
 * writes, per word, what `features.ts` measures, one JSON line each. The
 * model, Britfone and CMUdict are the extension's own pinned files, fetched
 * by its own code (`pronounce/models.ts`) into `--data`, and the model runs
 * through the worker's own `openPhoneModel` with the same input scaling
 * (`normalised`), so the posteriors are the ones the extension sees.
 *
 *   bun tools/calibrate/dump.ts --wavs DIR --transcript utts.tsv --out words.jsonl
 *
 * The transcript is `utt id<TAB>text` per line, the audio `DIR/<utt id>.wav`.
 * An utterance already in `--out` is skipped, so a stopped run goes on where
 * it was; `--shard i/n` takes every n-th utterance from the i-th (0-based),
 * for n processes side by side.
 */

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { posteriors } from "../../pronounce/ctc";
import { mergeDictionaries, parseCmudict, parseDictionary } from "../../pronounce/dictionary";
import { cpuSessionOptions } from "../../pronounce/engine";
import { vocabFrom } from "../../pronounce/judge";
import { ensurePronounce, priflyDataDir } from "../../pronounce/models";
import { openPhoneModel } from "../../pronounce/phone-model";
import { normalised } from "../../pronounce/serve";
import { decodeWav } from "../../pronounce/wav";
import { utteranceRecords } from "./features";

const HELP = `Usage: bun tools/calibrate/dump.ts --wavs DIR --transcript FILE --out FILE [options]

  --wavs DIR          16 kHz mono wavs, DIR/<utt id>.wav
  --transcript FILE   one "utt id<TAB>text" per line
  --out FILE          JSON lines, one per word; appended to, utterances in it skipped
  --shard i/n         only every n-th utterance, from the i-th (0-based); default 0/1
  --threads N         onnxruntime intra-op threads; default 4
  --provider P        cpu (default) or cuda (needs onnxruntime-node's CUDA files)
  --data DIR          where the pinned model and dictionaries go; default prifly's data folder
  --limit N           at most N utterances (after sharding); for a quick look
  --fetch-only        fetch the pinned files into --data and stop
`;

type Options = {
  fetchOnly: boolean;
  wavs: string;
  transcript: string;
  out: string;
  shard: [number, number];
  threads: number;
  provider: "cpu" | "cuda";
  data: string;
  limit: number;
};

function options(argv: string[]): Options | null {
  const { values } = parseArgs({
    args: argv,
    options: {
      wavs: { type: "string" },
      transcript: { type: "string" },
      out: { type: "string" },
      shard: { type: "string", default: "0/1" },
      threads: { type: "string", default: "4" },
      provider: { type: "string", default: "cpu" },
      data: { type: "string" },
      limit: { type: "string", default: "0" },
      help: { type: "boolean", default: false },
      "fetch-only": { type: "boolean", default: false },
    },
  });
  const fetchOnly = values["fetch-only"] ?? false;
  if (values.help || (!fetchOnly && (!values.wavs || !values.transcript || !values.out))) {
    return null;
  }
  const [index = 0, count = 1] = (values.shard ?? "0/1").split("/").map(Number);
  if (!(count >= 1 && index >= 0 && index < count)) throw new Error(`bad --shard ${values.shard}`);
  if (values.provider !== "cpu" && values.provider !== "cuda") {
    throw new Error(`--provider is cpu or cuda, not ${values.provider}`);
  }
  const home = process.env["HOME"] ?? "";
  return {
    fetchOnly,
    wavs: values.wavs ?? "",
    transcript: values.transcript ?? "",
    out: values.out ?? "",
    shard: [index, count],
    threads: Number(values.threads),
    provider: values.provider,
    data: values.data ?? priflyDataDir(process.platform, process.env, home),
    limit: Number(values.limit),
  };
}

/** The transcript's `[id, text]` pairs of this shard. */
function utterances(path: string, [index, count]: [number, number]): [string, string][] {
  return readFileSync(path, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.split("\t"))
    .filter((cells): cells is [string, string] => cells.length >= 2 && cells[0] !== "")
    .map(([id, text]): [string, string] => [id, text])
    .filter((_, at) => at % count === index);
}

/** The utterance ids already in `out`. */
function doneIn(out: string): Set<string> {
  const done = new Set<string>();
  if (!existsSync(out)) return done;
  for (const line of readFileSync(out, "utf8").split("\n")) {
    const found = /^\{"utt":"((?:[^"\\]|\\.)*)"/u.exec(line);
    if (found?.[1] !== undefined) done.add(JSON.parse(`"${found[1]}"`) as string);
  }
  return done;
}

async function main(): Promise<void> {
  const opts = options(Bun.argv.slice(2));
  if (opts === null) {
    process.stdout.write(HELP);
    return;
  }
  const files = await ensurePronounce(opts.data, (at) => {
    if (at.done === 0) process.stderr.write(`fetching ${at.what}: ${at.file}\n`);
  });
  if (opts.fetchOnly) return;
  const vocab = vocabFrom((await Bun.file(files.vocab).json()) as Record<string, number>);
  const dictionary = mergeDictionaries(
    parseDictionary(await Bun.file(files.dictionary).text()),
    parseCmudict(await Bun.file(files.cmudict).text()),
  );
  const session =
    opts.provider === "cuda"
      ? { ...cpuSessionOptions(opts.threads), executionProviders: ["cuda", "cpu"] }
      : cpuSessionOptions(opts.threads);
  const model = await openPhoneModel(files.model, opts.threads, session);
  process.stderr.write(`model on ${opts.provider}, ${opts.threads} threads\n`);
  const done = doneIn(opts.out);
  let todo = utterances(opts.transcript, opts.shard).filter(([id]) => !done.has(id));
  if (opts.limit > 0) todo = todo.slice(0, opts.limit);
  const started = performance.now();
  let audioSeconds = 0;
  for (const [count, [utt, text]] of todo.entries()) {
    let lines: string;
    try {
      const wav = decodeWav(readFileSync(join(opts.wavs, `${utt}.wav`)));
      if (wav.rate !== 16_000) throw new Error(`${wav.rate} Hz, not 16 kHz`);
      audioSeconds += wav.samples.length / 16_000;
      const out = await model.logits(normalised(wav.samples));
      const post = posteriors(out.data, out.frames, out.size);
      const records = utteranceRecords(utt, text, wav.samples, post, vocab, dictionary);
      lines = (Array.isArray(records) ? records : [records])
        .map((r) => JSON.stringify(r))
        .join("\n");
    } catch (caught) {
      lines = JSON.stringify({ utt, error: String(caught) });
    }
    appendFileSync(opts.out, `${lines}\n`);
    if ((count + 1) % 25 === 0 || count === todo.length - 1) {
      const seconds = (performance.now() - started) / 1000;
      process.stderr.write(
        `${count + 1}/${todo.length} utterances, ${audioSeconds.toFixed(0)} s of audio in ` +
          `${seconds.toFixed(1)} s (${(audioSeconds / seconds).toFixed(1)}x real time)\n`,
      );
    }
  }
}

await main();
// onnxruntime's thread pool would keep the process alive.
process.exit(0);
