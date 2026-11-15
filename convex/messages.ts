import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import type { Doc, Id } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";
import { currentUser, requireUser } from "./lib/auth";
import { pushTitle } from "./push";
import { messageKind, toolPart, triggerKind } from "./agentSchema";

export const list = query({
  args: { threadId: v.id("threads") },
  handler: async (ctx, { threadId }) => {
    const user = await currentUser(ctx);
    const t = await ctx.db.get(threadId);
    if (!user || !t || t.userId !== user._id) return [];
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .take(200);
    msgs.reverse();
    // Attach approval + browser task state so the UI can render cards from one query.
    return Promise.all(
      msgs.map(async (m) => ({
        ...m,
        approval: m.approvalId ? await ctx.db.get(m.approvalId) : null,
        browserTask: m.browserTaskId ? await ctx.db.get(m.browserTaskId) : null,
      })),
    );
  },
});

/** Store the user's turn, add a streaming assistant placeholder, and start the agent. */
async function startTurn(ctx: MutationCtx, user: Doc<"users">, threadId: Id<"threads">, text: string) {
  const t = await ctx.db.get(threadId);
  if (!t || t.userId !== user._id) throw new Error("Not found");
  const body = text.trim();
  if (!body) throw new Error("Empty message");
  const busy = await ctx.db
    .query("messages")
    .withIndex("by_thread", (q) => q.eq("threadId", threadId))
    .order("desc")
    .first();
  if (busy && busy.status === "streaming") throw new Error("wali is still answering");

  const now = Date.now();
  await ctx.db.insert("messages", {
    threadId,
    userId: user._id,
    role: "user",
    kind: "text",
    status: "done",
    text: body,
    createdAt: now,
  });
  const assistantId = await ctx.db.insert("messages", {
    threadId,
    userId: user._id,
    role: "assistant",
    kind: "text",
    status: "streaming",
    text: "",
    createdAt: now + 1,
  });
  await ctx.db.patch(threadId, {
    updatedAt: now,
    preview: body.slice(0, 120),
    ...(t.kind === "chat" && t.title === "New chat" ? { title: titleFrom(body) } : {}),
  });
  await ctx.scheduler.runAfter(0, internal.agentNode.respond, { messageId: assistantId });
  return assistantId;
}

/** User sends a message. */
export const send = mutation({
  args: { threadId: v.id("threads"), text: v.string() },
  handler: async (ctx, { threadId, text }) => startTurn(ctx, await requireUser(ctx), threadId, text),
});

/**
 * User taps one of a nudge's action pills. The label goes back to wali as the user's reply (the
 * nudge is right above it in the history), and the card remembers the choice.
 */
export const act = mutation({
  args: { id: v.id("messages"), action: v.string() },
  handler: async (ctx, { id, action }) => {
    const user = await requireUser(ctx);
    const m = await ctx.db.get(id);
    if (!m || m.userId !== user._id || m.kind !== "nudge") throw new Error("Not found");
    if (!(m.actions ?? []).includes(action)) throw new Error("That option isn't on this card");
    if (m.chosenAction) throw new Error(`You already chose "${m.chosenAction}"`);
    const replyId = await startTurn(ctx, user, m.threadId, action);
    await ctx.db.patch(id, { chosenAction: action });
    return replyId;
  },
});

function titleFrom(text: string) {
  const first = text.split(/[.?!\n]/)[0]!.trim();
  return first.length > 48 ? `${first.slice(0, 47)}…` : first || "New chat";
}

/** Thumbs on a nudge: tracked so the gate can back off after dismissals. */
export const respond = mutation({
  args: { id: v.id("messages"), response: v.union(v.literal("helpful"), v.literal("dismissed")) },
  handler: async (ctx, { id, response }) => {
    const user = await requireUser(ctx);
    const m = await ctx.db.get(id);
    if (!m || m.userId !== user._id) throw new Error("Not found");
    await ctx.db.patch(id, { response });
  },
});

// ---------------------------------------------------------------------------------------------
// Internal: used by the agent actions.

export const getInternal = internalQuery({
  args: { id: v.id("messages") },
  handler: async (ctx, { id }) => ctx.db.get(id),
});

/** Conversation history for the model (oldest first), excluding the placeholder being written. */
export const history = internalQuery({
  args: { threadId: v.id("threads"), before: v.number(), limit: v.optional(v.number()) },
  handler: async (ctx, { threadId, before, limit }) => {
    const msgs = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId).lt("createdAt", before))
      .order("desc")
      .take(limit ?? 30);
    return msgs.reverse();
  },
});

export const patchStream = internalMutation({
  args: {
    id: v.id("messages"),
    text: v.optional(v.string()),
    tools: v.optional(v.array(toolPart)),
    reasoning: v.optional(v.string()),
    thinkingMs: v.optional(v.number()),
    status: v.optional(v.union(v.literal("streaming"), v.literal("done"), v.literal("error"))),
    error: v.optional(v.string()),
  },
  handler: async (ctx, { id, ...patch }) => {
    const m = await ctx.db.get(id);
    if (!m || m.status !== "streaming") return; // never overwrite a finished message with a late write
    await ctx.db.patch(id, patch);
    if (patch.status === "done" && patch.text) {
      await ctx.db.patch(m.threadId, { updatedAt: Date.now(), preview: patch.text.slice(0, 120) });
    }
  },
});

export async function postMessage(
  ctx: MutationCtx,
  m: {
    threadId: Id<"threads">;
    userId: Id<"users">;
    kind: "text" | "nudge" | "approval" | "update";
    text: string;
    approvalId?: Id<"approvals">;
    browserTaskId?: Id<"browserTasks">;
    trigger?: { kind: "transcript" | "schedule" | "followup" | "manual" | "simulated"; recordingId?: Id<"recordings"> };
    actions?: string[];
  },
  opts: { push?: boolean } = {},
) {
  const now = Date.now();
  const id = await ctx.db.insert("messages", {
    ...m,
    role: "assistant",
    status: "done",
    createdAt: now,
  });
  const thread = await ctx.db.get(m.threadId);
  await ctx.db.patch(m.threadId, { updatedAt: now, preview: m.text.slice(0, 120) });
  // wali speaking on its own also reaches the user's phone (filtered by their preferences).
  if (m.kind !== "text" && opts.push !== false) {
    await ctx.scheduler.runAfter(0, internal.push.deliver, {
      userId: m.userId,
      kind: m.kind,
      title: pushTitle(m.kind),
      body: m.text,
      threadId: m.threadId,
      messageId: id,
      home: thread?.kind === "home",
      ...(m.approvalId ? { approvalId: m.approvalId } : {}),
    });
  }
  return id;
}

/**
 * Start an assistant reply that isn't answering a new user message (wali picking up after an
 * approved read). Returns null if wali is already answering in that thread.
 */
export const startReply = internalMutation({
  args: { threadId: v.id("threads"), userId: v.id("users") },
  handler: async (ctx, { threadId, userId }) => {
    const last = await ctx.db
      .query("messages")
      .withIndex("by_thread", (q) => q.eq("threadId", threadId))
      .order("desc")
      .first();
    if (last?.status === "streaming") return null;
    return ctx.db.insert("messages", {
      threadId,
      userId,
      role: "assistant",
      kind: "text",
      status: "streaming",
      text: "",
      createdAt: Date.now(),
    });
  },
});

export const post = internalMutation({
  args: {
    threadId: v.id("threads"),
    userId: v.id("users"),
    kind: messageKind,
    text: v.string(),
    approvalId: v.optional(v.id("approvals")),
    browserTaskId: v.optional(v.id("browserTasks")),
    trigger: v.optional(v.object({ kind: triggerKind, recordingId: v.optional(v.id("recordings")) })),
    actions: v.optional(v.array(v.string())),
    /** false: post to the thread without a notification (quiet hours). */
    push: v.optional(v.boolean()),
  },
  handler: async (ctx, { push, ...args }) => postMessage(ctx, args, { push }),
});
