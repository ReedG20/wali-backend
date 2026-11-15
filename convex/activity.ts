import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { currentUser, requireUser } from "./lib/auth";

/** The Jev gate log: every time wali considered speaking, with the scores. */
export const gateEvents = query({
  args: { limit: v.optional(v.number()) },
  handler: async (ctx, { limit }) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("gateEvents")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(Math.min(limit ?? 50, 200));
  },
});

export const notes = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("notes")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);
  },
});

export const followups = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("followups")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(50);
  },
});

export const cancelFollowup = mutation({
  args: { id: v.id("followups") },
  handler: async (ctx, { id }) => {
    const user = await requireUser(ctx);
    const f = await ctx.db.get(id);
    if (!f || f.userId !== user._id) throw new Error("Not found");
    if (f.scheduledId) await ctx.scheduler.cancel(f.scheduledId);
    await ctx.db.patch(id, { status: "cancelled" });
  },
});
