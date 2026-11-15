import { v } from "convex/values";
import { query } from "./_generated/server";
import { currentUser } from "./lib/auth";

/** Recent pendant conversations with their utterances, newest first (signed-in users only). */
export const recent = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    const recs = await ctx.db
      .query("recordings")
      .withIndex("by_startedAt")
      .order("desc")
      .take(Math.min(limit ?? 20, 50));
    return Promise.all(
      recs.map(async (r) => ({
        _id: r._id,
        startedAt: r.startedAt,
        durationMs: r.durationMs,
        status: r.status,
        speakers: r.speakers ?? [],
        utterances:
          r.status === "done"
            ? (
                await ctx.db
                  .query("utterances")
                  .withIndex("by_recordingId", (q) => q.eq("recordingId", r._id))
                  .collect()
              ).map((u) => ({
                _id: u._id,
                startAt: u.startAt,
                speaker: u.speakerLabel,
                speakerRaw: u.speakerRaw,
                /** True when the label is a person's name (recognized voice or named by hand). */
                named: !!u.personId,
                hasVoice: !!u.voiceId,
                text: u.text,
              }))
            : [],
      })),
    );
  },
});
