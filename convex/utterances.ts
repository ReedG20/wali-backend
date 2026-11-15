import { v } from "convex/values";
import { internalMutation, query } from "./_generated/server";
import { speakerStat } from "./schema";
import { internal } from "./_generated/api";
import { previewText } from "./lib/text";

export const forRecording = query({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, { recordingId }) =>
    ctx.db
      .query("utterances")
      .withIndex("by_recordingId", (q) => q.eq("recordingId", recordingId))
      .collect(),
});

/** Latest utterances across all recordings, newest first. */
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) =>
    ctx.db
      .query("utterances")
      .withIndex("by_startAt")
      .order("desc")
      .take(Math.min(Math.max(limit ?? 100, 1), 500)),
});

/** Replace a recording's utterances with a fresh transcript and set its final status. */
export const saveTranscript = internalMutation({
  args: {
    recordingId: v.id("recordings"),
    languageCode: v.optional(v.string()),
    speakers: v.array(speakerStat),
    utterances: v.array(
      v.object({
        startAt: v.number(),
        endAt: v.number(),
        speakerRaw: v.string(),
        speakerLabel: v.string(),
        text: v.string(),
      }),
    ),
  },
  handler: async (ctx, { recordingId, languageCode, speakers, utterances }) => {
    const old = await ctx.db
      .query("utterances")
      .withIndex("by_recordingId", (q) => q.eq("recordingId", recordingId))
      .collect();
    for (const u of old) await ctx.db.delete(u._id);
    for (const u of utterances) await ctx.db.insert("utterances", { recordingId, ...u });

    const preview = previewText(utterances.map((u) => ({ label: u.speakerLabel, text: u.text })));
    await ctx.db.patch(recordingId, {
      status: utterances.length ? "done" : "empty",
      error: undefined,
      languageCode,
      speakers,
      utteranceCount: utterances.length,
      preview: preview || undefined,
      transcribedAt: Date.now(),
      voiceStatus: utterances.length ? "pending" : undefined,
      voiceAttempts: 0,
      voiceAttemptAt: undefined,
      voiceError: undefined,
    });
    // Put names on the speakers (voiceprint.run), which then offers the conversation to wali's
    // proactive pipeline (agentNode.onRecording). Voice ID never blocks the agent; see voiceprint.ts.
    if (utterances.length) {
      await ctx.scheduler.runAfter(0, internal.voiceprint.run, { recordingId, offerToAgent: true, force: true });
    }
  },
});
