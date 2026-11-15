import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { currentUser, DEFAULT_NOTIFY, DEFAULT_PROACTIVE, PROACTIVE_LIMITS, requireUser } from "./lib/auth";
import { notifyPrefs, permissionMode } from "./agentSchema";

function randomId(bytes = 12) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Called by the web app after sign-in: creates the user row and their home thread. */
export const ensure = mutation({
  args: { timezone: v.optional(v.string()) },
  handler: async (ctx, { timezone }) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not signed in");
    const existing = await ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
      .unique();
    const profile = {
      name: identity.name ?? identity.givenName ?? undefined,
      email: identity.email ?? undefined,
      imageUrl: identity.pictureUrl ?? undefined,
    };
    if (existing) {
      await ctx.db.patch(existing._id, { ...profile, ...(timezone ? { timezone } : {}) });
      return existing._id;
    }
    const now = Date.now();
    const userId = await ctx.db.insert("users", {
      clerkId: identity.subject,
      ...profile,
      opaqueId: `mind_${randomId()}`,
      timezone,
      proactive: DEFAULT_PROACTIVE,
      createdAt: now,
    });
    const threadId = await ctx.db.insert("threads", {
      userId,
      title: "wali",
      kind: "home",
      updatedAt: now,
    });
    await ctx.db.insert("messages", {
      threadId,
      userId,
      role: "assistant",
      kind: "text",
      status: "done",
      text:
        "Hi, I'm wali. Connect your pendant and I'll listen through your day. When something is worth a word, I'll say it here. You can also just talk to me.",
      createdAt: now,
    });
    return userId;
  },
});

/** The signed-in user, with every setting filled in so both apps render the same defaults. */
export const me = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return null;
    return {
      ...user,
      proactive: { ...DEFAULT_PROACTIVE, ...user.proactive },
      notify: user.notify ?? DEFAULT_NOTIFY,
      permissions: user.permissions ?? "balanced",
    };
  },
});

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export const updateProactive = mutation({
  args: {
    enabled: v.boolean(),
    quietEnabled: v.optional(v.boolean()),
    quietStartHour: v.number(),
    quietEndHour: v.number(),
    maxPerHour: v.number(),
    maxPerDay: v.number(),
  },
  handler: async (ctx, s) => {
    const user = await requireUser(ctx);
    await ctx.db.patch(user._id, {
      proactive: {
        enabled: s.enabled,
        quietEnabled: s.quietEnabled ?? user.proactive?.quietEnabled ?? true,
        quietStartHour: clamp(s.quietStartHour, 0, 23),
        quietEndHour: clamp(s.quietEndHour, 0, 23),
        maxPerHour: clamp(s.maxPerHour, 0, PROACTIVE_LIMITS.maxPerHour),
        maxPerDay: clamp(s.maxPerDay, 0, PROACTIVE_LIMITS.maxPerDay),
      },
    });
  },
});

/** How much wali may do without asking (lib/permissions.ts). */
export const updatePermissions = mutation({
  args: { mode: permissionMode },
  handler: async (ctx, { mode }) => {
    const user = await requireUser(ctx);
    await ctx.db.patch(user._id, { permissions: mode });
  },
});

/** Take back an "Always allow": wali asks about it again from now on. */
export const removeAlwaysAllow = mutation({
  args: { kind: v.union(v.literal("browser"), v.literal("app")), key: v.string() },
  handler: async (ctx, { kind, key }) => {
    const user = await requireUser(ctx);
    await ctx.db.patch(user._id, {
      alwaysAllow: (user.alwaysAllow ?? []).filter((g) => !(g.kind === kind && g.key === key)),
    });
  },
});

/** Which of wali's messages also reach the user's phone. */
export const updateNotify = mutation({
  args: notifyPrefs.fields,
  handler: async (ctx, notify) => {
    const user = await requireUser(ctx);
    await ctx.db.patch(user._id, { notify });
  },
});

export const getInternal = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => ctx.db.get(userId),
});

/** Admin: reset someone's proactive settings to the defaults, with overrides (`npx convex run`). */
export const resetProactive = internalMutation({
  args: { userId: v.id("users"), quietEnabled: v.optional(v.boolean()) },
  handler: async (ctx, { userId, quietEnabled }) => {
    const user = await ctx.db.get(userId);
    if (!user) throw new Error("Not found");
    await ctx.db.patch(userId, {
      proactive: { ...DEFAULT_PROACTIVE, enabled: user.proactive?.enabled ?? true, ...(quietEnabled === undefined ? {} : { quietEnabled }) },
    });
  },
});
