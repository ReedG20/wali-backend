import { v } from "convex/values";
import { internalAction, type ActionCtx } from "./_generated/server";
import type { Doc } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { parseLevels, processWords, type ScribeWord } from "./lib/transcript";

const SCRIBE_URL = "https://api.elevenlabs.io/v1/speech-to-text";
/** Current ElevenLabs batch STT model (successor to scribe_v2; scribe_v3_live is the realtime one). */
const SCRIBE_MODEL = "scribe_v3";
const MAX_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 30_000;
const REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
/** Shorter recordings are marked empty without calling Scribe (its minimum is 100 ms). */
const MIN_DURATION_MS = 500;
/** If every 20 ms slot is below this RMS (~-80 dBFS) the recording is silence: mark empty. */
const SILENT_LEVEL = 4;

type ScribeResponse = {
  language_code?: string;
  text?: string;
  words?: ScribeWord[];
};

/** Error that must not be retried (bad key, quota, unprocessable audio). */
class PermanentError extends Error {}
class TransientError extends Error {
  constructor(
    msg: string,
    readonly retryAfterMs?: number,
  ) {
    super(msg);
  }
}

async function callScribe(apiKey: string, wav: Blob): Promise<ScribeResponse> {
  const form = new FormData();
  form.append("model_id", SCRIBE_MODEL);
  form.append("file", wav, "audio.wav");
  form.append("diarize", "true");
  form.append("timestamps_granularity", "word");
  form.append("language_code", "en");
  form.append("tag_audio_events", "false");

  let res: Response;
  try {
    res = await fetch(SCRIBE_URL, {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (e) {
    throw new TransientError(`network: ${(e as Error).message}`);
  }
  if (res.ok) return (await res.json()) as ScribeResponse;

  const body = (await res.text().catch(() => "")).slice(0, 300);
  const msg = `scribe ${res.status}: ${body}`;
  const quota = /quota_exceeded|insufficient|payment/i.test(body);
  if (res.status === 401 || res.status === 402 || res.status === 403 || quota) {
    throw new PermanentError(msg);
  }
  if (res.status === 429 || res.status === 408 || res.status >= 500) {
    const ra = Number(res.headers.get("retry-after"));
    throw new TransientError(msg, Number.isFinite(ra) && ra > 0 ? ra * 1000 : undefined);
  }
  throw new PermanentError(msg); // 400/413/415/422 etc: retrying the same file won't help
}

/**
 * Turn a Scribe response into utterances for a recording. Split out from `run` so the
 * post-processing can be exercised without spending Scribe credits:
 *   npx convex run transcribe:applyResponse '{"recordingId": "...", "response": {...}}'
 */
export const applyResponse = internalAction({
  args: { recordingId: v.id("recordings"), response: v.any() },
  handler: async (ctx, { recordingId, response }) => {
    const rec = await ctx.runQuery(internal.recordings.getInternal, { id: recordingId });
    if (!rec) throw new Error("recording not found");
    await saveResult(ctx, rec, response as ScribeResponse);
  },
});

async function saveResult(ctx: ActionCtx, rec: Doc<"recordings">, result: ScribeResponse) {
  const recordingId = rec._id;
  const { utterances, speakers } = processWords(result.words ?? []);
  await ctx.runMutation(internal.utterances.saveTranscript, {
    recordingId,
    languageCode: result.language_code,
    speakers,
    utterances: utterances.map((u) => ({
      startAt: Math.round(rec.startedAt + u.startSec * 1000),
      endAt: Math.round(rec.startedAt + u.endSec * 1000),
      speakerRaw: u.speakerRaw,
      speakerLabel: u.speakerLabel,
      text: u.text,
    })),
  });
}

export const run = internalAction({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, { recordingId }) => {
    const attempt = await ctx.runMutation(internal.recordings.beginAttempt, { id: recordingId });
    if (attempt === null) return; // already done / claimed by another run

    try {
      const rec = await ctx.runQuery(internal.recordings.getInternal, { id: recordingId });
      if (!rec) return;
      // Don't spend Scribe credits on audio that can't contain speech.
      const levels = parseLevels(rec.levels);
      if (rec.durationMs < MIN_DURATION_MS || levels.every((l) => l < SILENT_LEVEL)) {
        await saveResult(ctx, rec, { words: [] });
        return;
      }
      const apiKey = process.env.ELEVENLABS_API_KEY;
      if (!apiKey) throw new PermanentError("ELEVENLABS_API_KEY is not set on this deployment");
      const wav = await ctx.storage.get(rec.storageId);
      if (!wav) throw new PermanentError("audio file missing from storage");

      const result = await callScribe(apiKey, wav);
      await saveResult(ctx, rec, result);
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      const transient = !(e instanceof PermanentError);
      if (transient && attempt < MAX_ATTEMPTS) {
        const backoff = BASE_BACKOFF_MS * 2 ** (attempt - 1) * (0.8 + Math.random() * 0.4);
        const delay = Math.max(backoff, e instanceof TransientError ? (e.retryAfterMs ?? 0) : 0);
        await ctx.runMutation(internal.recordings.markPending, {
          id: recordingId,
          error: `attempt ${attempt}: ${error}`,
        });
        await ctx.scheduler.runAfter(delay, internal.transcribe.run, { recordingId });
        console.warn(
          `transcribe ${recordingId} attempt ${attempt} failed, retry in ${delay}ms`,
          error,
        );
      } else {
        await ctx.runMutation(internal.recordings.markFailed, {
          id: recordingId,
          error: `attempt ${attempt}: ${error}`,
        });
        console.error(`transcribe ${recordingId} failed permanently`, error);
      }
    }
  },
});
