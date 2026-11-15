import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { agentTables } from "./agentSchema";

export const recordingStatus = v.union(
  v.literal("pending"),
  v.literal("transcribing"),
  v.literal("done"),
  v.literal("empty"),
  v.literal("failed"),
);

export const speakerStat = v.object({
  speakerRaw: v.string(),
  label: v.string(),
  /** Seconds covered by this speaker's words. */
  seconds: v.number(),
  /** Voice this speaker was matched to (set by voiceprint.run; absent if too little clean speech). */
  voiceId: v.optional(v.id("voices")),
  /** Named by hand for this recording only (speaker too short for a voiceprint). */
  personId: v.optional(v.id("people")),
});

export const voiceStatus = v.union(
  v.literal("pending"),
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
);

export default defineSchema({
  recordings: defineTable({
    /** Uuid generated on the phone; makes create idempotent. */
    clientId: v.string(),
    storageId: v.id("_storage"),
    /** Pendant boot id (uint32) the audio was recorded in (best effort for old-boot backfill). */
    boot: v.number(),
    seqStart: v.number(),
    /** Inclusive. */
    seqEnd: v.number(),
    /** Wall-clock ms of the first sample of the WAV. */
    startedAt: v.number(),
    /** True if startedAt is a best-effort guess (frames from a previous boot / unknown clock). */
    timeApprox: v.optional(v.boolean()),
    durationMs: v.number(),
    /** One uint16 LE RMS per 20 ms slot of the WAV (0 = gap-filled silence). Used to skip silent clips. */
    levels: v.bytes(),
    backfill: v.boolean(),
    status: recordingStatus,
    attempts: v.number(),
    /** When the current/last transcription attempt started (detects stuck actions). */
    attemptStartedAt: v.optional(v.number()),
    error: v.optional(v.string()),
    languageCode: v.optional(v.string()),
    speakers: v.optional(v.array(speakerStat)),
    utteranceCount: v.optional(v.number()),
    /** First ~160 chars of the transcript, for list views. */
    preview: v.optional(v.string()),
    createdAt: v.number(),
    transcribedAt: v.optional(v.number()),
    /** Voice identification (voiceprint.run), which runs after transcription. */
    voiceStatus: v.optional(voiceStatus),
    voiceAttempts: v.optional(v.number()),
    voiceAttemptAt: v.optional(v.number()),
    voiceError: v.optional(v.string()),
    /** When this recording was handed to the agent (memory + proactive). Set once. */
    agentOfferedAt: v.optional(v.number()),
  })
    .index("by_clientId", ["clientId"])
    .index("by_startedAt", ["startedAt"])
    .index("by_voiceStatus", ["voiceStatus"]),

  utterances: defineTable({
    recordingId: v.id("recordings"),
    /** Wall-clock ms = recording.startedAt + word time. */
    startAt: v.number(),
    endAt: v.number(),
    /** Scribe speaker id, e.g. "speaker_0". */
    speakerRaw: v.string(),
    /**
     * Display label: the person's name when the voice is known ("Reed", "Mom"), "Background" for
     * ignored voices, else "Speaker 1", "Speaker 2", ... in order of appearance within the recording.
     */
    speakerLabel: v.string(),
    text: v.string(),
    voiceId: v.optional(v.id("voices")),
    personId: v.optional(v.id("people")),
  })
    .index("by_recordingId", ["recordingId", "startAt"])
    .index("by_startAt", ["startAt"])
    .searchIndex("search_text", { searchField: "text" }),

  /** People in the wearer's life, named by the user. Several voices can belong to one person. */
  people: defineTable({
    name: v.string(),
    /** The wearer. At most one. */
    isMe: v.boolean(),
    createdAt: v.number(),
  }).index("by_isMe", ["isMe"]),

  /**
   * A recurring voice: the centroid of every voiceprint matched to it. Starts unnamed; the user
   * names it (personId) or marks it as background (TV, podcasts).
   */
  voices: defineTable({
    /** Unit-length mean of its samples' embeddings (WeSpeaker ResNet34, 256-dim). */
    centroid: v.array(v.float64()),
    sampleCount: v.number(),
    personId: v.optional(v.id("people")),
    ignored: v.optional(v.boolean()),
    /** Derived from voiceSamples (recomputed whenever they change). */
    recordingCount: v.number(),
    multiCount: v.number(),
    loudestCount: v.number(),
    totalSeconds: v.number(),
    firstHeardAt: v.number(),
    lastHeardAt: v.number(),
    /** A few seconds of this voice, for the "play" button. */
    clipStorageId: v.optional(v.id("_storage")),
    clipSeconds: v.optional(v.number()),
    /** Something they said (from the clip's recording), to jog the user's memory. */
    sampleText: v.optional(v.string()),
    /** Close to an existing voice but under the match threshold when it was created. */
    maybeSameAs: v.optional(v.object({ voiceId: v.id("voices"), score: v.number() })),
    /** A name the agent inferred from how others addressed this voice. Never applied unconfirmed. */
    nameSuggestion: v.optional(
      v.object({ name: v.string(), evidence: v.string(), recordingId: v.id("recordings"), at: v.number() }),
    ),
    dismissedNames: v.optional(v.array(v.string())),
    createdAt: v.number(),
  })
    .index("by_personId", ["personId"])
    .index("by_lastHeardAt", ["lastHeardAt"])
    .vectorIndex("by_centroid", { vectorField: "centroid", dimensions: 256 }),

  /** One voiceprint per (recording, speaker). Kept so voices can be recomputed or re-matched. */
  voiceSamples: defineTable({
    recordingId: v.id("recordings"),
    speakerRaw: v.string(),
    /** Absent when the sample looked like two people merged into one speaker. */
    voiceId: v.optional(v.id("voices")),
    embedding: v.array(v.float64()),
    seconds: v.number(),
    levelDb: v.number(),
    /** Loudest voiceprinted speaker in a recording with 2+ of them. */
    loudest: v.boolean(),
    speakersInRecording: v.number(),
    /** Similarity to the voice it was matched to (absent when it started a new voice). */
    score: v.optional(v.number()),
    mixed: v.optional(v.boolean()),
    /** recording.startedAt */
    at: v.number(),
  })
    .index("by_recordingId", ["recordingId"])
    .index("by_voiceId", ["voiceId", "at"]),

  /** Singleton: cached runtime assets (native addon, model) + the pending "is this you?" question. */
  voiceState: defineTable({
    nativeStorageId: v.optional(v.id("_storage")),
    modelStorageId: v.optional(v.id("_storage")),
    meSuggestion: v.optional(v.object({ voiceId: v.id("voices"), at: v.number() })),
    meDismissed: v.optional(v.array(v.id("voices"))),
  }),

  ...agentTables,
});
