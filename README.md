# Mind backend (Convex)

Stores audio segments uploaded by the phone app, transcribes them with ElevenLabs Scribe (batch,
diarized) and stores speaker-labelled utterances. No auth (hackathon test build).

## Deployments

| | Deployment | URL (client) |
|---|---|---|
| Team / project | `reed-grenager` / `mind` | https://dashboard.convex.dev/t/reed-grenager/mind |
| dev | `dapper-retriever-913` | https://dapper-retriever-913.convex.cloud |
| prod | `posh-orca-594` | https://posh-orca-594.convex.cloud |

`.env.local` (gitignored, written by `npx convex dev`) points the CLI at dev.

```bash
npm install
npx convex dev            # watch + push to dev
npx convex deploy -y      # push to prod
npm test                  # unit tests (utterance grouping, speaker labels)
npx tsc -p convex --noEmit
```

## Environment variables (set on BOTH deployments)

| Name | Purpose |
|---|---|
| `ELEVENLABS_API_KEY` | Scribe API key. Only the backend holds it; the app never sees it. |

```bash
npx convex env set ELEVENLABS_API_KEY "$(cat /path/to/keyfile)"          # dev
npx convex env set --prod ELEVENLABS_API_KEY "$(cat /path/to/keyfile)"   # prod
```

## Data model (`convex/schema.ts`)

- `recordings` - one per phone segment (<= 5 min of 16 kHz mono WAV in file storage).
  `clientId` (phone uuid, unique, makes create idempotent), `storageId`, `boot`, `seqStart`,
  `seqEnd`, `startedAt` (wall ms of the first sample), `timeApprox` (true if the phone could only
  guess the time, e.g. backfill from a previous pendant boot), `durationMs`, `levels` (bytes:
  uint16 LE RMS per 20 ms slot, 0 = gap-filled silence; used to skip silent clips without
  calling Scribe), `backfill`, `status`
  (`pending|transcribing|done|empty|failed`), `attempts`, `error`, `languageCode`, `speakers`
  (per-speaker label + seconds of speech), `utteranceCount`, `preview`.
  Indexes: `by_clientId`, `by_startedAt`.
- `utterances` - `recordingId`, `startAt`/`endAt` (wall ms), `speakerRaw` (Scribe id),
  `speakerLabel` (`Speaker 1`, `Speaker 2`, ... in order of appearance), `text`.
  Indexes: `by_recordingId` (+startAt), `by_startAt`.

## Functions

Public (call them with `anyApi` from `convex/server`, e.g. `anyApi.recordings.list`; clients don't
import this repo):

| Function | Kind | |
|---|---|---|
| `recordings.generateUploadUrl` | mutation | upload URL; POST the WAV body, response `{storageId}` |
| `recordings.create` | mutation | register an upload, idempotent on `clientId` (returns `{id, created}`; a duplicate upload blob is deleted); schedules transcription |
| `recordings.retry` | mutation | re-run a `failed` (or stuck >15 min `transcribing`) recording |
| `recordings.list` | query | `{limit?}` newest first by `startedAt`, without `levels` |
| `recordings.get` | query | `{id}` one recording + `audioUrl` |
| `recordings.byClientId` | query | `{clientId}` |
| `utterances.forRecording` | query | `{recordingId}` in time order |
| `utterances.recent` | query | `{limit?}` newest first across recordings |

Internal: `transcribe.run` (the action), `transcribe.applyResponse` (feed a Scribe-shaped
response for testing without credits), `recordings.beginAttempt/markPending/markFailed`,
`utterances.saveTranscript`.

## Transcription (`convex/transcribe.ts`)

1. Recordings shorter than 0.5 s or entirely silent (all levels < 4) are marked `empty` without
   calling Scribe.
2. `POST https://api.elevenlabs.io/v1/speech-to-text` multipart: `model_id=scribe_v3` (current
   batch model; `scribe_v3_live` is the realtime one), `file` (WAV), `diarize=true`,
   `timestamps_granularity=word`, `language_code=en`, `tag_audio_events=false`.
3. Errors: network, 408, 429, 5xx -> retry with exponential backoff (30 s, 60 s, 120 s, 240 s,
   +-20% jitter, honours `Retry-After`), max 5 attempts. 401/402/403, `quota_exceeded`, and other
   4xx (bad audio) -> `failed` immediately, no retry.
4. Words -> utterances (`convex/lib/transcript.ts`): runs of the same `speaker_id`, split when the
   pause between two words exceeds 2 s. Text is rebuilt from word + spacing tokens.
5. Speaker labels start neutral: `Speaker 1`, `Speaker 2`, ... in order of first appearance within
   a recording (Scribe's ids restart per request). Voice identification (below) then replaces them
   with people's names where the voice is known.

## Voice identification (`convex/voiceprint.ts`, `convex/voices.ts`)

Runs after every transcript: `utterances.saveTranscript` → `voiceprint.run` → `agentNode.onRecording`.
ElevenLabs' speaker library is workspace-wide and can't be managed with an API key, so we keep our
own voiceprints.

1. Per Scribe speaker, cut their clean speech (turns minus overlap, edge-trimmed, ≤30 s) from the
   WAV. Under 4 s of clean speech: skipped, stays `Speaker N`.
2. Embed with WeSpeaker ResNet34 (256-dim) via sherpa-onnx, inside the action. The native addon
   and model are downloaded once (hash-pinned in `convex/lib/sherpa.ts`), cached in Convex storage
   (`voiceState`) and unpacked to `/tmp` per cold start; bundling them would exceed Convex's
   module-size limit. Long clips are also split in half and compared: if the halves disagree,
   Scribe probably merged two people and the sample is marked `mixed` and not matched.
3. Match against `voices` centroids (Convex vector search, cosine). ≥0.75 → that voice (one voice
   per speaker per recording; if a voice named as a different person is within 0.03, it's left
   unassigned rather than risk a wrong name); otherwise a new voice, `maybeSameAs` if ≥0.65.
   Thresholds were calibrated on real pendant audio; see `lib/voice.ts`. After changing them,
   `npx convex run voiceprint:recluster '{}'` rebuilds voices from stored voiceprints in seconds.
4. `voices.apply` stores the `voiceSamples`, updates centroids/stats, relabels utterances
   (person name / `Background` / `Speaker N`), and revisits "is this you?": the voice in ≥50% of
   recordings, clearly more common than the next, and usually the loudest (`lib/voice.ts:guessWearer`).
5. Haiku reads the transcript for direct address ("Thanks, Mom") and stores a `nameSuggestion` the
   user confirms on the Voices page. Never applied automatically.

The agent is offered the recording after the first attempt whether or not it succeeded; failed
runs retry (3 attempts) and a 15-min cron (`voices.sweep`) restarts dead ones. Naming a voice
(`voices.nameVoice` / `nameSpeaker`) relabels every recording it's in and re-sends them to
Supermemory (`voiceprint.resyncMemory`). Backfill older recordings with
`npx convex run voiceprint:backfill '{}'`; smoke-test the model with `voiceprint:selfTest`.

## Testing end to end

```bash
npm run test:audio      # scripts/make-test-audio.sh: `say` + ffmpeg -> scripts/out/*.wav
                        #   two-speakers.wav: two voices (Samantha, Daniel) alternating
node scripts/test-pipeline.ts scripts/out/two-speakers.wav      # dev, real Scribe call
CONVEX_URL=https://posh-orca-594.convex.cloud node scripts/test-pipeline.ts scripts/out/one-speaker.wav
node scripts/test-pipeline.ts scripts/out/two-speakers.wav --client-id <existing>  # idempotency
node scripts/test-pipeline.ts scripts/out/two-speakers.wav --fake  # no credits: synthetic Scribe response
```

The script does exactly what the phone does (generateUploadUrl -> POST -> create with levels),
polls the recording, and prints the utterances. Each real run costs ~1 Scribe credit per second
of audio. To re-run a failed recording: `npx convex run recordings:retry '{"id":"..."}'`.
