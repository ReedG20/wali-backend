import { v } from "convex/values";
import { action, internalAction, internalMutation, internalQuery, mutation, query, type ActionCtx } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import { currentUser, requireUser } from "./lib/auth";

/**
 * Push notifications: iPhones through Expo's push service (free; it relays to APNs with the push
 * key stored in EAS credentials), browsers through Web Push (pushWeb.ts, VAPID keys in Convex env).
 * Messages wali posts on its own (nudges, approvals, background updates) reach every phone and
 * browser the user turned notifications on for, filtered by their preferences.
 *
 * Optional env: EXPO_ACCESS_TOKEN, only if "enhanced push security" is turned on in Expo.
 */

const EXPO_PUSH = "https://exp.host/--/api/v2/push/send";
export const DEFAULT_NOTIFY = { nudges: true, approvals: true, updates: true };

export type PushKind = "nudge" | "approval" | "update" | "test";

/** Called by the iOS app after the user allows notifications. Re-registering moves the token to this user. */
export const register = mutation({
  args: {
    token: v.string(),
    platform: v.union(v.literal("ios"), v.literal("android")),
    deviceName: v.optional(v.string()),
  },
  handler: async (ctx, { token, platform, deviceName }) => {
    const user = await requireUser(ctx);
    if (!/^Expo(nent)?PushToken\[.+\]$/.test(token)) throw new Error("Not an Expo push token");
    const existing = await ctx.db
      .query("pushTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .collect();
    const [keep, ...dupes] = existing;
    for (const d of dupes) await ctx.db.delete(d._id);
    // Nothing new: don't write. An app build that re-registered in a loop sent this several
    // times a second; each write also re-ran every query that reads pushTokens.
    const fresh = keep && Date.now() - keep.updatedAt < 24 * 60 * 60_000;
    if (fresh && keep.userId === user._id && keep.platform === platform && keep.deviceName === deviceName) return;
    const row = { userId: user._id, token, platform, deviceName, updatedAt: Date.now() };
    if (keep) await ctx.db.patch(keep._id, row);
    else await ctx.db.insert("pushTokens", row);
  },
});

/** Called on sign-out so the phone stops getting this account's notifications. */
export const unregister = mutation({
  args: { token: v.string() },
  handler: async (ctx, { token }) => {
    const user = await currentUser(ctx);
    if (!user) return;
    const rows = await ctx.db
      .query("pushTokens")
      .withIndex("by_token", (q) => q.eq("token", token))
      .collect();
    for (const r of rows) if (r.userId === user._id) await ctx.db.delete(r._id);
  },
});

/** Phones and browsers that get this account's notifications (for settings on web and iOS). */
export const devices = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    const phones = await ctx.db
      .query("pushTokens")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    const browsers = await ctx.db
      .query("webPushSubs")
      .withIndex("by_user", (q) => q.eq("userId", user._id))
      .collect();
    return [
      ...phones.map((r) => ({ _id: r._id as string, platform: r.platform as string, deviceName: r.deviceName ?? null, updatedAt: r.updatedAt })),
      ...browsers.map((r) => ({ _id: r._id as string, platform: "web", deviceName: r.label ?? "Browser", updatedAt: r.updatedAt })),
    ];
  },
});

// --- Web Push (the web app's service worker) -------------------------------------------------

/** The public VAPID key the browser subscribes with; null until VAPID keys are set in Convex env. */
export const webConfig = query({
  args: {},
  handler: async () => ({ publicKey: process.env.VAPID_PUBLIC_KEY?.trim() || null }),
});

/** Called by the web app when this browser allows notifications. Re-registering moves it to this user. */
export const registerWeb = mutation({
  args: { endpoint: v.string(), p256dh: v.string(), auth: v.string(), label: v.optional(v.string()) },
  handler: async (ctx, { endpoint, p256dh, auth, label }) => {
    const user = await requireUser(ctx);
    if (!/^https:\/\//.test(endpoint)) throw new Error("Not a push endpoint");
    const existing = await ctx.db
      .query("webPushSubs")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .collect();
    const [keep, ...dupes] = existing;
    for (const d of dupes) await ctx.db.delete(d._id);
    const row = { userId: user._id, endpoint, p256dh, auth, label, updatedAt: Date.now() };
    if (keep) await ctx.db.patch(keep._id, row);
    else await ctx.db.insert("webPushSubs", row);
  },
});

export const unregisterWeb = mutation({
  args: { endpoint: v.string() },
  handler: async (ctx, { endpoint }) => {
    const user = await currentUser(ctx);
    if (!user) return;
    const rows = await ctx.db
      .query("webPushSubs")
      .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
      .collect();
    for (const r of rows) if (r.userId === user._id) await ctx.db.delete(r._id);
  },
});

export const dropWebSubs = internalMutation({
  args: { endpoints: v.array(v.string()) },
  handler: async (ctx, { endpoints }) => {
    for (const endpoint of endpoints) {
      const rows = await ctx.db
        .query("webPushSubs")
        .withIndex("by_endpoint", (q) => q.eq("endpoint", endpoint))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
  },
});

/** "Send a test" in settings. */
export const sendTest = action({
  args: {},
  handler: async (ctx): Promise<{ sent: number }> => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("Not signed in");
    const user = await ctx.runQuery(internal.agentData.userByClerkId, { clerkId: identity.subject });
    if (!user) throw new Error("User not set up yet");
    return ctx.runAction(internal.push.deliver, {
      userId: user._id,
      kind: "test",
      title: "wali",
      body: "Notifications are on. This is where I'll reach you.",
    });
  },
});

export const targets = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    const tokens = await ctx.db
      .query("pushTokens")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    const web = await ctx.db
      .query("webPushSubs")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect();
    return {
      notify: user?.notify ?? DEFAULT_NOTIFY,
      tokens: tokens.map((t) => t.token),
      web: web.map((w) => ({ endpoint: w.endpoint, p256dh: w.p256dh, auth: w.auth })),
    };
  },
});

export const dropTokens = internalMutation({
  args: { tokens: v.array(v.string()) },
  handler: async (ctx, { tokens }) => {
    for (const token of tokens) {
      const rows = await ctx.db
        .query("pushTokens")
        .withIndex("by_token", (q) => q.eq("token", token))
        .collect();
      for (const r of rows) await ctx.db.delete(r._id);
    }
  },
});

function wanted(kind: PushKind, notify: Doc<"users">["notify"] & {}) {
  if (kind === "test") return true;
  if (kind === "nudge") return notify.nudges;
  if (kind === "approval") return notify.approvals;
  return notify.updates;
}

/** Send one notification to every phone and browser the user has turned notifications on for. */
export const deliver = internalAction({
  args: {
    userId: v.id("users"),
    kind: v.union(v.literal("nudge"), v.literal("approval"), v.literal("update"), v.literal("test")),
    title: v.string(),
    body: v.string(),
    threadId: v.optional(v.id("threads")),
    messageId: v.optional(v.id("messages")),
    approvalId: v.optional(v.id("approvals")),
    /** The thread is the home thread (the app opens the wali tab instead of a chat). */
    home: v.optional(v.boolean()),
  },
  handler: async (ctx, a): Promise<{ sent: number }> => {
    const { notify, tokens, web } = await ctx.runQuery(internal.push.targets, { userId: a.userId });
    if ((!tokens.length && !web.length) || !wanted(a.kind, notify)) return { sent: 0 };

    const data: Record<string, string> = { kind: a.kind };
    if (a.threadId) data.threadId = a.threadId;
    if (a.messageId) data.messageId = a.messageId;
    if (a.approvalId) data.approvalId = a.approvalId;
    if (a.home) data.home = "1";
    const body = a.body.length > 220 ? `${a.body.slice(0, 219).trimEnd()}…` : a.body;

    const [phones, browsers] = await Promise.all([
      tokens.length ? sendExpo(ctx, tokens, a, body, data) : 0,
      web.length
        ? ctx
            .runAction(internal.pushWeb.send, {
              subs: web,
              payload: JSON.stringify({ title: a.title, body, data }),
              urgent: a.kind === "approval",
            })
            .then((r) => r.sent)
        : 0,
    ]);
    return { sent: phones + browsers };
  },
});

async function sendExpo(
  ctx: ActionCtx,
  tokens: string[],
  a: { title: string; kind: PushKind; threadId?: string },
  body: string,
  data: Record<string, string>,
) {
  const messages = tokens.map((to) => ({
    to,
    title: a.title,
    body,
    data,
    sound: "default",
    priority: "high",
    // Long-press actions (Approve / Decline) registered by the app.
    ...(a.kind === "approval" ? { categoryId: "approval" } : {}),
    // iOS groups notifications from the same thread together.
    ...(a.threadId ? { threadId: a.threadId } : {}),
  }));

  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json" };
  const token = process.env.EXPO_ACCESS_TOKEN?.trim();
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(EXPO_PUSH, { method: "POST", headers, body: JSON.stringify(messages) });
  const json = (await res.json().catch(() => null)) as {
    data?: { status: "ok" | "error"; message?: string; details?: { error?: string } }[];
    errors?: { message: string }[];
  } | null;
  if (!res.ok || !json?.data) {
    console.error(`[push] ${res.status}`, JSON.stringify(json?.errors ?? json).slice(0, 500));
    return 0;
  }
  const dead: string[] = [];
  let sent = 0;
  json.data.forEach((t, i) => {
    if (t.status === "ok") sent++;
    else {
      console.warn(`[push] ${t.details?.error ?? "error"}: ${t.message ?? ""}`.slice(0, 300));
      if (t.details?.error === "DeviceNotRegistered") dead.push(tokens[i]!);
    }
  });
  if (dead.length) await ctx.runMutation(internal.push.dropTokens, { tokens: dead });
  return sent;
}

/** Titles in wali's voice; the body is the message itself. */
export function pushTitle(kind: "nudge" | "approval" | "update") {
  return kind === "approval" ? "Waiting for your OK" : "wali";
}
