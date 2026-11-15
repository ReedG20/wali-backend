import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { currentUser, requireUser } from "./lib/auth";
import { internal } from "./_generated/api";

/**
 * Pendants don't carry an owner yet, so "connecting" subscribes this account to the shared pendant
 * stream: every transcribed recording is offered to every connected user's proactive pipeline.
 */

export const mine = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("devices")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .collect();
  },
});

export const connect = mutation({
  args: { name: v.optional(v.string()) },
  handler: async (ctx, { name }) => {
    const user = await requireUser(ctx);
    if (!user.memoryBackfilledAt) {
      await ctx.scheduler.runAfter(0, internal.agentNode.backfillMemory, { userId: user._id });
    }
    const existing = await ctx.db
      .query("devices")
      .withIndex("by_userId", (q) => q.eq("userId", user._id))
      .first();
    if (existing) {
      await ctx.db.patch(existing._id, { status: "connected", connectedAt: Date.now() });
      return existing._id;
    }
    return ctx.db.insert("devices", {
      userId: user._id,
      name: name ?? "wali pendant",
      status: "connected",
      connectedAt: Date.now(),
    });
  },
});

export const disconnect = mutation({
  args: { id: v.id("devices") },
  handler: async (ctx, { id }) => {
    const user = await requireUser(ctx);
    const d = await ctx.db.get(id);
    if (!d || d.userId !== user._id) throw new Error("Not found");
    await ctx.db.patch(id, { status: "disconnected" });
  },
});

/** What the pendant stream is doing: latest recordings, for the "listening" indicator. */
export const stream = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return null;
    const recent = await ctx.db.query("recordings").withIndex("by_startedAt").order("desc").take(1);
    const last = recent[0];
    return last
      ? {
          lastStartedAt: last.startedAt,
          lastEndedAt: last.startedAt + last.durationMs,
          lastStatus: last.status,
          lastPreview: last.preview ?? null,
        }
      : null;
  },
});

export const connectedUserIds = internalQuery({
  args: {},
  handler: async (ctx) => {
    const ds = await ctx.db
      .query("devices")
      .withIndex("by_status", (q) => q.eq("status", "connected"))
      .collect();
    return [...new Set(ds.map((d) => d.userId))];
  },
});
