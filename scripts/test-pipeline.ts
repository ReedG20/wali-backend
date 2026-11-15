// End-to-end test: upload a WAV like the phone does, register it, wait for the transcript.
//
//   node scripts/test-pipeline.ts scripts/out/two-speakers.wav            # dev (.env.local)
//   CONVEX_URL=https://<prod>.convex.cloud node scripts/test-pipeline.ts x.wav
//   node scripts/test-pipeline.ts x.wav --client-id <id>                    # idempotency check
//   node scripts/test-pipeline.ts x.wav --fake    # no Scribe credits: after the real attempt ends,
//       apply a synthetic Scribe response (speech runs from the levels, alternating speakers) via
//       `npx convex run transcribe:applyResponse` (dev deployment only).
//
// Uses only anyApi (no generated code), the same way the app and future web app do.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const api = anyApi;

function convexUrl(): string {
  if (process.env.CONVEX_URL) return process.env.CONVEX_URL;
  const env = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const m = env.match(/^CONVEX_URL=(\S+)/m);
  if (!m) throw new Error("CONVEX_URL not set and not found in .env.local");
  return m[1];
}

/** Parse a 16 kHz mono s16le WAV, return samples. */
function readWav(buf: Buffer): Int16Array {
  if (buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a WAV");
  }
  let off = 12;
  let fmtOk = false;
  while (off + 8 <= buf.length) {
    const id = buf.toString("ascii", off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    const body = off + 8;
    if (id === "fmt ") {
      const ch = buf.readUInt16LE(body + 2);
      const rate = buf.readUInt32LE(body + 4);
      const bits = buf.readUInt16LE(body + 14);
      if (ch !== 1 || rate !== 16000 || bits !== 16) {
        throw new Error(`need 16 kHz mono 16-bit, got ${rate} Hz ${ch} ch ${bits} bit`);
      }
      fmtOk = true;
    } else if (id === "data") {
      if (!fmtOk) throw new Error("data before fmt");
      const n = Math.floor(Math.min(size, buf.length - body) / 2);
      const out = new Int16Array(n);
      for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(body + i * 2);
      return out;
    }
    off = body + size + (size & 1);
  }
  throw new Error("no data chunk");
}

/** One uint16 RMS per 20 ms (320 samples) slot, same as the pendant's `level`. */
function levels(samples: Int16Array): ArrayBuffer {
  const slots = Math.ceil(samples.length / 320);
  const out = new DataView(new ArrayBuffer(slots * 2));
  for (let s = 0; s < slots; s++) {
    let sum = 0;
    const end = Math.min(samples.length, (s + 1) * 320);
    for (let i = s * 320; i < end; i++) sum += samples[i] * samples[i];
    out.setUint16(s * 2, Math.min(32767, Math.round(Math.sqrt(sum / 320))), true);
  }
  return out.buffer;
}

/** Synthetic Scribe response: each run of speech in the levels is one "utterance", speakers alternate. */
function fakeScribeResponse(lv: ArrayBuffer) {
  const view = new DataView(lv);
  const n = lv.byteLength / 2;
  const runs: [number, number][] = [];
  let start = -1;
  let quiet = 0;
  for (let i = 0; i <= n; i++) {
    const loud = i < n && view.getUint16(i * 2, true) > 30;
    if (loud) {
      if (start < 0) start = i;
      quiet = 0;
    } else if (start >= 0 && (++quiet >= 20 || i === n)) {
      runs.push([start * 0.02, (i - quiet + 1) * 0.02]);
      start = -1;
      quiet = 0;
    }
  }
  const words: object[] = [];
  runs.forEach(([a, b], r) => {
    const speaker_id = `speaker_${r % 2}`;
    const count = Math.max(1, Math.floor((b - a) / 0.4));
    const step = (b - a) / count;
    for (let k = 0; k < count; k++) {
      if (words.length)
        words.push({
          text: " ",
          type: "spacing",
          start: a + k * step,
          end: a + k * step,
          speaker_id,
        });
      words.push({
        text: k ? `w${k}` : `Run${r + 1}`,
        type: "word",
        start: a + k * step,
        end: a + (k + 1) * step - 0.05,
        speaker_id,
        logprob: 0,
      });
    }
  });
  return { language_code: "eng", language_probability: 1, text: "", words };
}

async function main() {
  const args = process.argv.slice(2);
  const file = args.find((a) => !a.startsWith("--"));
  if (!file) throw new Error("usage: node scripts/test-pipeline.ts <file.wav> [--client-id id]");
  const ci = args.indexOf("--client-id");
  const clientId = ci >= 0 ? args[ci + 1] : `script-${randomUUID()}`;
  const fake = args.includes("--fake");

  const url = convexUrl();
  const client = new ConvexHttpClient(url);
  const wav = readFileSync(file);
  const samples = readWav(wav);
  const lv = levels(samples);
  const slots = lv.byteLength / 2;
  console.log(
    `deployment ${url}\nfile ${file}: ${(samples.length / 16000).toFixed(2)} s, ${slots} slots`,
  );

  const uploadUrl: string = await client.mutation(api.recordings.generateUploadUrl, {});
  const up = await fetch(uploadUrl, {
    method: "POST",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
  });
  if (!up.ok) throw new Error(`upload failed ${up.status}`);
  const { storageId } = (await up.json()) as { storageId: string };

  const now = Date.now();
  const res = await client.mutation(api.recordings.create, {
    clientId,
    storageId,
    boot: 0,
    seqStart: 0,
    seqEnd: slots - 1,
    startedAt: now - slots * 20,
    durationMs: slots * 20,
    levels: lv,
    backfill: false,
  });
  console.log(`clientId ${clientId} -> recording ${res.id} (created: ${res.created})`);

  const t0 = Date.now();
  for (;;) {
    const r = await client.query(api.recordings.get, { id: res.id });
    process.stdout.write(
      `\r${((Date.now() - t0) / 1000).toFixed(0)}s status=${r.status} attempts=${r.attempts}   `,
    );
    if (r.status === "done" || r.status === "empty" || r.status === "failed") {
      console.log();
      if (r.error) console.log(`error: ${r.error}`);
      if (fake && r.status === "failed") {
        console.log("--fake: applying synthetic Scribe response via npx convex run");
        const payload = JSON.stringify({ recordingId: res.id, response: fakeScribeResponse(lv) });
        execFileSync("npx", ["convex", "run", "transcribe:applyResponse", payload], {
          stdio: "inherit",
        });
        continue;
      }
      console.log("speakers:", JSON.stringify(r.speakers));
      break;
    }
    if (Date.now() - t0 > 180_000) throw new Error("timed out waiting for transcript");
    await new Promise((s) => setTimeout(s, 1000));
  }

  const utts = await client.query(api.utterances.forRecording, { recordingId: res.id });
  for (const u of utts) {
    const t = ((u.startAt - (now - slots * 20)) / 1000).toFixed(1);
    console.log(`[${t.padStart(5)}s] ${u.speakerLabel.padEnd(10)} ${u.text}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
