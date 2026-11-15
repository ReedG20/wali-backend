import { v } from "convex/values";
import { internalMutation, internalQuery } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Id } from "./_generated/dataModel";
import { risk, triggerKind, grantScope } from "./agentSchema";
import { postMessage } from "./messages";
import { overlap, stripDateStamp } from "./lib/text";

/** Internal reads and writes used by the agent actions in agentNode.ts. */

const HOUR = 60 * 60 * 1000;

export const homeThread = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const ts = await ctx.db
      .query("threads")
      .withIndex("by_user_updated", (q) => q.eq("userId", userId))
      .collect();
    return ts.find((t) => t.kind === "home") ?? null;
  },
});

/** Everything the context pack needs about the user, in one round trip. */
export const contextPack = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const user = await ctx.db.get(userId);
    const now = Date.now();
    const nudges = await ctx.db
      .query("messages")
      .withIndex("by_user_kind", (q) => q.eq("userId", userId).eq("kind", "nudge"))
      .order("desc")
      .take(8);
    const pending = await ctx.db
      .query("approvals")
      .withIndex("by_user_status", (q) => q.eq("userId", userId).eq("status", "pending"))
      .take(10);
    const followups = (
      await ctx.db
        .query("followups")
        .withIndex("by_user", (q) => q.eq("userId", userId).gte("runAt", now))
        .take(10)
    ).filter((f) => f.status === "scheduled");
    const notes = await ctx.db
      .query("notes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(10);
    return {
      user,
      recentNudges: nudges.map((n) => ({
        at: n.createdAt,
        text: n.text,
        response: n.response ?? "no response",
      })),
      pendingApprovals: pending.map((a) => ({ title: a.title, summary: a.summary, at: a.createdAt })),
      followups: followups.map((f) => ({ note: f.note, runAt: f.runAt })),
      notes: notes.map((n) => ({ text: n.text, at: n.createdAt })),
    };
  },
});

/** Counts for the rules that sit around the Jev gate. */
export const nudgeStats = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => {
    const now = Date.now();
    const recent = await ctx.db
      .query("messages")
      .withIndex("by_user_kind", (q) =>
        q.eq("userId", userId).eq("kind", "nudge").gte("createdAt", now - 24 * HOUR),
      )
      .collect();
    const lastDismissed = recent
      .filter((m) => m.response === "dismissed")
      .reduce((max, m) => Math.max(max, m.createdAt), 0);
    const lastGate = await ctx.db
      .query("gateEvents")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .first();
    return {
      lastHour: recent.filter((m) => m.createdAt > now - HOUR).length,
      lastDay: recent.length,
      lastDismissedAt: lastDismissed || null,
      lastGateAt: lastGate?.createdAt ?? null,
    };
  },
});

export const alreadyGated = internalQuery({
  args: { userId: v.id("users"), recordingId: v.id("recordings") },
  handler: async (ctx, { userId, recordingId }) => {
    const evs = await ctx.db
      .query("gateEvents")
      .withIndex("by_recording", (q) => q.eq("trigger.recordingId", recordingId))
      .collect();
    return evs.some((e) => e.userId === userId);
  },
});

type Line = { at: number; speaker: string; text: string };

/** A recording's transcript plus the one before it (the "current and previous slices"). */
export const slice = internalQuery({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, { recordingId }) => {
    const rec = await ctx.db.get(recordingId);
    if (!rec) return null;
    const lines = async (id: Id<"recordings">): Promise<Line[]> =>
      (
        await ctx.db
          .query("utterances")
          .withIndex("by_recordingId", (q) => q.eq("recordingId", id))
          .collect()
      ).map((u) => ({ at: u.startAt, speaker: u.speakerLabel, text: u.text }));
    const prev = await ctx.db
      .query("recordings")
      .withIndex("by_startedAt", (q) => q.lt("startedAt", rec.startedAt))
      .order("desc")
      .first();
    return {
      startedAt: rec.startedAt,
      durationMs: rec.durationMs,
      current: await lines(recordingId),
      previous: prev && prev.status === "done" ? await lines(prev._id) : [],
      previousStartedAt: prev?.startedAt ?? null,
    };
  },
});

export const recentUtterances = internalQuery({
  args: { sinceMs: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { sinceMs, limit }) => {
    const us = await ctx.db
      .query("utterances")
      .withIndex("by_startAt", (q) => q.gte("startAt", sinceMs))
      .order("desc")
      .take(limit ?? 200);
    return us.reverse().map((u) => ({ at: u.startAt, speaker: u.speakerLabel, text: u.text }));
  },
});

export const searchUtterances = internalQuery({
  args: { query: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, { query, limit }) => {
    const hits = await ctx.db
      .query("utterances")
      .withSearchIndex("search_text", (q) => q.search("text", query))
      .take(limit ?? 12);
    return hits.map((u) => ({ at: u.startAt, speaker: u.speakerLabel, text: u.text }));
  },
});

export const logGate = internalMutation({
  args: {
    userId: v.id("users"),
    trigger: v.object({ kind: triggerKind, recordingId: v.optional(v.id("recordings")) }),
    excerpt: v.string(),
    passed: v.boolean(),
    reason: v.string(),
    scores: v.optional(
      v.object({
        worthActing: v.number(),
        userAsked: v.number(),
        canHelp: v.optional(v.number()),
        distress: v.number(),
        badTime: v.number(),
        urgency: v.number(),
        kind: v.string(),
      }),
    ),
    costUsd: v.optional(v.number()),
  },
  handler: async (ctx, args) => ctx.db.insert("gateEvents", { ...args, createdAt: Date.now() }),
});

export const finishGate = internalMutation({
  args: { id: v.id("gateEvents"), decision: v.string(), messageId: v.optional(v.id("messages")) },
  handler: async (ctx, { id, ...patch }) => ctx.db.patch(id, patch),
});

/** Two notes that share this much of their wording say the same thing. */
const SAME_NOTE = 0.6;

/**
 * Returns the note's id and whether it was new. The background agent runs after every
 * conversation and kept saving the same fact again in slightly different words (the approval plan
 * showed up three times), so a note that says what a recent one already says isn't stored twice.
 */
export const saveNote = internalMutation({
  args: { userId: v.id("users"), text: v.string() },
  handler: async (ctx, { userId, text }) => {
    const clean = stripDateStamp(text).slice(0, 2000);
    const recent = await ctx.db
      .query("notes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .order("desc")
      .take(50);
    const same = recent.find((n) => overlap(n.text, clean) >= SAME_NOTE);
    if (same) return { id: same._id, saved: false };
    const id = await ctx.db.insert("notes", { userId, text: clean, createdAt: Date.now() });
    return { id, saved: true };
  },
});

export const scheduleFollowup = internalMutation({
  args: { userId: v.id("users"), note: v.string(), runAt: v.number() },
  handler: async (ctx, { userId, note, runAt }) => {
    const id = await ctx.db.insert("followups", {
      userId,
      note: note.slice(0, 500),
      runAt,
      status: "scheduled",
      createdAt: Date.now(),
    });
    const scheduledId = await ctx.scheduler.runAt(runAt, internal.agentNode.runFollowup, { followupId: id });
    await ctx.db.patch(id, { scheduledId });
    return id;
  },
});

export const getFollowup = internalQuery({
  args: { id: v.id("followups") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const markFollowupFired = internalMutation({
  args: { id: v.id("followups") },
  handler: async (ctx, { id }) => ctx.db.patch(id, { status: "fired" }),
});

const SAME_ASK_WINDOW_MS = 30 * 60_000;
/** Reworded summaries of one browser task share at least this much wording; different tasks on the same site don't. */
const SAME_ASK = 0.3;

type Ask = { channel: "composio" | "browser"; toolSlug?: string; summary: string; args?: unknown };

function sameAsk(a: Ask, b: Ask): boolean {
  if (a.channel !== b.channel) return false;
  // An app action is the same ask only if it's the same call with the same arguments.
  if (a.channel === "composio") return a.toolSlug === b.toolSlug && JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null);
  // A browser task is free text: same site and substantially the same request.
  const site = (x: Ask) => String((x.args as { site?: string } | undefined)?.site ?? "").toLowerCase().replace(/^www\./, "");
  return site(a) === site(b) && overlap(a.summary, b.summary) >= SAME_ASK;
}

export const createApproval = internalMutation({
  args: {
    userId: v.id("users"),
    threadId: v.id("threads"),
    channel: v.union(v.literal("composio"), v.literal("browser")),
    title: v.string(),
    summary: v.string(),
    toolSlug: v.optional(v.string()),
    args: v.any(),
    risk: v.optional(risk),
    scope: v.optional(grantScope),
  },
  handler: async (ctx, a) => {
    // One ask per thing. The agent runs again after every conversation and re-proposed the same
    // action in new words while the first ask was still waiting: three "Waiting for your OK"
    // notifications for one Gmail summary in five minutes. If the same thing is already pending,
    // that ask stands and nothing new is posted.
    const pending = await ctx.db
      .query("approvals")
      .withIndex("by_user_status", (q) => q.eq("userId", a.userId).eq("status", "pending"))
      .order("desc")
      .take(20);
    const now = Date.now();
    const same = pending.find((p) => now - p.createdAt < SAME_ASK_WINDOW_MS && sameAsk(p, a));
    if (same) return same._id;

    const approvalId = await ctx.db.insert("approvals", {
      ...a,
      status: "pending",
      createdAt: now,
    });
    await postMessage(ctx, {
      threadId: a.threadId,
      userId: a.userId,
      kind: "approval",
      text: a.summary,
      approvalId,
    });
    return approvalId;
  },
});

export const getApproval = internalQuery({
  args: { id: v.id("approvals") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const setApproval = internalMutation({
  args: {
    id: v.id("approvals"),
    status: v.union(v.literal("running"), v.literal("done"), v.literal("failed")),
    result: v.optional(v.any()),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...patch }) => ctx.db.patch(id, patch),
});

export const setBrowserProfile = internalMutation({
  args: { userId: v.id("users"), profileId: v.string() },
  handler: async (ctx, { userId, profileId }) => ctx.db.patch(userId, { browserProfileId: profileId }),
});

export const createBrowserTask = internalMutation({
  args: {
    userId: v.id("users"),
    threadId: v.id("threads"),
    task: v.string(),
    summary: v.optional(v.string()),
    /** The approval this run came from: its message becomes the task's row instead of a new one. */
    approvalId: v.optional(v.id("approvals")),
  },
  handler: async (ctx, { approvalId, ...a }) => {
    const id = await ctx.db.insert("browserTasks", {
      ...a,
      status: "starting",
      polls: 0,
      createdAt: Date.now(),
    });
    if (approvalId) {
      const recent = await ctx.db
        .query("messages")
        .withIndex("by_thread", (q) => q.eq("threadId", a.threadId))
        .order("desc")
        .take(200);
      const asked = recent.find((m) => m.approvalId === approvalId);
      if (asked) {
        await ctx.db.patch(asked._id, { browserTaskId: id });
        return id;
      }
    }
    await postMessage(ctx, {
      threadId: a.threadId,
      userId: a.userId,
      kind: "update",
      // The one-line summary is what the user reads; the full task stays on the browserTasks row.
      // Never the task itself: it's the brief written for the browser agent ("Log in with the
      // user's existing session… if login requires MFA, stop"), not something to show a person.
      text: a.summary?.trim() || "Working on it in the browser.",
      browserTaskId: id,
    }, { push: false });
    return id;
  },
});

export const getBrowserTask = internalQuery({
  args: { id: v.id("browserTasks") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

export const patchBrowserTask = internalMutation({
  args: {
    id: v.id("browserTasks"),
    runId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    status: v.optional(
      v.union(
        v.literal("starting"),
        v.literal("running"),
        v.literal("completed"),
        v.literal("failed"),
        v.literal("cancelled"),
      ),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    polls: v.optional(v.number()),
    /** null clears it (the run is over, so the live view is gone). */
    liveUrl: v.optional(v.union(v.string(), v.null())),
  },
  handler: async (ctx, { id, liveUrl, ...patch }) =>
    ctx.db.patch(id, liveUrl === undefined ? patch : { ...patch, liveUrl: liveUrl ?? undefined }),
});

export const userByClerkId = internalQuery({
  args: { clerkId: v.string() },
  handler: async (ctx, { clerkId }) =>
    ctx.db
      .query("users")
      .withIndex("by_clerkId", (q) => q.eq("clerkId", clerkId))
      .unique(),
});

export const doneRecordingIds = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("recordings").withIndex("by_startedAt").collect())
      .filter((r) => r.status === "done")
      .map((r) => r._id),
});

export const notesForUser = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) =>
    ctx.db
      .query("notes")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .collect(),
});

export const markMemoryBackfilled = internalMutation({
  args: { userId: v.id("users"), count: v.number() },
  handler: async (ctx, { userId, count }) =>
    ctx.db.patch(userId, { memoryBackfilledAt: Date.now(), memoryBackfillCount: count }),
});
