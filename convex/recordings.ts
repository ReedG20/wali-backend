import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc } from "./_generated/dataModel";

/** An attempt that has been "transcribing" this long is considered dead (action crashed/timed out). */
const STUCK_MS = 15 * 60 * 1000;
/** Upper bound for one recording (the phone closes segments at 5 min). */
const MAX_DURATION_MS = 30 * 60 * 1000;

/** Recording without the (large) levels blob, for list views. */
function summary(r: Doc<"recordings">) {
  const { levels: _levels, ...rest } = r;
  return rest;
}

export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => ctx.storage.generateUploadUrl(),
});

/**
 * Register an uploaded WAV. Idempotent on clientId: calling again returns the existing id and
 * deletes the duplicate upload, so the phone can blindly retry.
 */
export const create = mutation({
  args: {
    clientId: v.string(),
    storageId: v.id("_storage"),
    boot: v.number(),
    seqStart: v.number(),
    seqEnd: v.number(),
    startedAt: v.number(),
    timeApprox: v.optional(v.boolean()),
    durationMs: v.number(),
    levels: v.bytes(),
    backfill: v.boolean(),
  },
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("recordings")
      .withIndex("by_clientId", (q) => q.eq("clientId", args.clientId))
      .unique();
    if (existing) {
      if (existing.storageId !== args.storageId) {
        const meta = await ctx.db.system.get(args.storageId);
        if (meta) await ctx.storage.delete(args.storageId);
      }
      return { id: existing._id, created: false };
    }
    if (!(args.durationMs > 0 && args.durationMs <= MAX_DURATION_MS)) {
      throw new Error(`durationMs out of range: ${args.durationMs}`);
    }
    if (args.seqEnd < args.seqStart) throw new Error("seqEnd < seqStart");
    const meta = await ctx.db.system.get(args.storageId);
    if (!meta) throw new Error("storageId not found (upload missing)");

    const id = await ctx.db.insert("recordings", {
      ...args,
      status: "pending",
      attempts: 0,
      createdAt: Date.now(),
    });
    await ctx.scheduler.runAfter(0, internal.transcribe.run, { recordingId: id });
    return { id, created: true };
  },
});

/** Re-run transcription for a failed (or stuck) recording. */
export const retry = mutation({
  args: { id: v.id("recordings") },
  handler: async (ctx, { id }) => {
    const r = await ctx.db.get(id);
    if (!r) throw new Error("recording not found");
    const stuck = r.status === "transcribing" && (r.attemptStartedAt ?? 0) < Date.now() - STUCK_MS;
    if (r.status !== "failed" && !stuck) {
      throw new Error(`cannot retry a recording in status ${r.status}`);
    }
    await ctx.db.patch(id, { status: "pending", attempts: 0, error: undefined });
    await ctx.scheduler.runAfter(0, internal.transcribe.run, { recordingId: id });
    return null;
  },
});

/** Most recent recordings first (by wall-clock start). */
export const list = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const rows = await ctx.db
      .query("recordings")
      .withIndex("by_startedAt")
      .order("desc")
      .take(Math.min(Math.max(limit ?? 50, 1), 200));
    return rows.map(summary);
  },
});

/** One recording (without levels) plus a URL to its WAV. */
export const get = query({
  args: { id: v.id("recordings") },
  handler: async (ctx, { id }) => {
    const r = await ctx.db.get(id);
    if (!r) return null;
    return { ...summary(r), audioUrl: await ctx.storage.getUrl(r.storageId) };
  },
});

export const byClientId = query({
  args: { clientId: v.string() },
  handler: async (ctx, { clientId }) => {
    const r = await ctx.db
      .query("recordings")
      .withIndex("by_clientId", (q) => q.eq("clientId", clientId))
      .unique();
    return r ? summary(r) : null;
  },
});

// ---- internal, used by transcribe.run ----

export const getInternal = internalQuery({
  args: { id: v.id("recordings") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

/** Claim the recording for a transcription attempt. Returns the attempt number, or null to skip. */
export const beginAttempt = internalMutation({
  args: { id: v.id("recordings") },
  handler: async (ctx, { id }) => {
    const r = await ctx.db.get(id);
    if (!r || r.status !== "pending") return null;
    const attempts = r.attempts + 1;
    await ctx.db.patch(id, { status: "transcribing", attempts, attemptStartedAt: Date.now() });
    return attempts;
  },
});

export const markPending = internalMutation({
  args: { id: v.id("recordings"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    await ctx.db.patch(id, { status: "pending", error });
  },
});

export const markFailed = internalMutation({
  args: { id: v.id("recordings"), error: v.string() },
  handler: async (ctx, { id, error }) => {
    await ctx.db.patch(id, { status: "failed", error });
  },
});
