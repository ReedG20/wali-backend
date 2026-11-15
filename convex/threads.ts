import { v } from "convex/values";
import { internalQuery, mutation, query } from "./_generated/server";
import { currentUser, requireUser } from "./lib/auth";

export const list = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("threads")
      .withIndex("by_user_updated", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(100);
  },
});

export const get = query({
  args: { id: v.id("threads") },
  handler: async (ctx, { id }) => {
    const user = await currentUser(ctx);
    const t = await ctx.db.get(id);
    if (!user || !t || t.userId !== user._id) return null;
    return t;
  },
});

export const home = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return null;
    const threads = await ctx.db
      .query("threads")
      .withIndex("by_user_updated", (q) => q.eq("userId", user._id))
      .collect();
    return threads.find((t) => t.kind === "home") ?? null;
  },
});

export const create = mutation({
  args: {},
  handler: async (ctx) => {
    const user = await requireUser(ctx);
    // Reuse an untouched "New chat" instead of piling up empty threads.
    const recent = await ctx.db
      .query("threads")
      .withIndex("by_user_updated", (q) => q.eq("userId", user._id))
      .order("desc")
      .take(20);
    for (const t of recent) {
      if (t.kind !== "chat" || t.title !== "New chat") continue;
      const any = await ctx.db
        .query("messages")
        .withIndex("by_thread", (q) => q.eq("threadId", t._id))
        .first();
      if (!any) return t._id;
    }
    return ctx.db.insert("threads", {
      userId: user._id,
      title: "New chat",
      kind: "chat",
      updatedAt: Date.now(),
    });
  },
});

export const rename = mutation({
  args: { id: v.id("threads"), title: v.string() },
  handler: async (ctx, { id, title }) => {
    const user = await requireUser(ctx);
    const t = await ctx.db.get(id);
    if (!t || t.userId !== user._id) throw new Error("Not found");
    await ctx.db.patch(id, { title: title.trim().slice(0, 80) || t.title });
  },
});

export const remove = mutation({
  args: { id: v.id("threads") },
  handler: async (ctx, { id }) => {
    const user = await requireUser(ctx);
    const t = await ctx.db.get(id);
    if (!t || t.userId !== user._id) throw new Error("Not found");
    if (t.kind === "home") throw new Error("The wali thread can't be deleted");
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", id))
      .collect();
    for (const m of msgs) await ctx.db.delete(m._id);
    await ctx.db.delete(id);
  },
});

export const kindOf = internalQuery({
  args: { id: v.id("threads") },
  handler: async (ctx, { id }) => (await ctx.db.get(id))?.kind ?? null,
});
