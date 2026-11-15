import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Tables for the web app and wali's agent layer (chat, proactive gate, approvals, connections).
 * The pendant pipeline (recordings, utterances) lives in schema.ts.
 */

export const appAuth = v.union(v.literal("oauth"), v.literal("key"), v.literal("none"), v.literal("unavailable"));

export const toolPart = v.object({
  toolCallId: v.string(),
  toolName: v.string(),
  args: v.optional(v.any()),
  result: v.optional(v.any()),
  state: v.union(v.literal("running"), v.literal("done"), v.literal("error")),
});

export const triggerKind = v.union(
  v.literal("transcript"),
  v.literal("schedule"),
  v.literal("followup"),
  v.literal("manual"),
  v.literal("simulated"),
);

export const messageKind = v.union(
  v.literal("text"),
  /** wali speaking first, from the proactive pipeline. */
  v.literal("nudge"),
  /** An action that is waiting for the user's OK. */
  v.literal("approval"),
  /** Background work reporting back (browser task finished, approved action ran). */
  v.literal("update"),
);

/** lib/permissions.ts: how much wali may do without asking. */
export const permissionMode = v.union(v.literal("ask"), v.literal("balanced"), v.literal("auto"));
export const risk = v.union(v.literal("read"), v.literal("low"), v.literal("high"));
/** What an "Always allow" covers (lib/permissions.ts grantFor): one site to read, or one app action. */
export const grantScope = v.object({
  kind: v.union(v.literal("browser"), v.literal("app")),
  key: v.string(),
  label: v.string(),
});

/** Which messages also go to the user's phone as push notifications. */
export const notifyPrefs = v.object({
  /** wali speaking first. */
  nudges: v.boolean(),
  /** Something waiting for the user's OK. */
  approvals: v.boolean(),
  /** Background work finished (an approved action ran, a browser task reported back). */
  updates: v.boolean(),
});

export const approvalStatus = v.union(
  v.literal("pending"),
  v.literal("approved"),
  v.literal("declined"),
  v.literal("running"),
  v.literal("done"),
  v.literal("failed"),
);

export const agentTables = {
  users: defineTable({
    /** Clerk user id (identity.subject). */
    clerkId: v.string(),
    name: v.optional(v.string()),
    email: v.optional(v.string()),
    imageUrl: v.optional(v.string()),
    /** Random id we hand to third parties (Composio user_id, Browser Use profile) instead of Clerk's. */
    opaqueId: v.string(),
    timezone: v.optional(v.string()),
    browserProfileId: v.optional(v.string()),
    /** Supermemory: when the pendant history was first sent to this user's namespace. */
    memoryBackfilledAt: v.optional(v.number()),
    memoryBackfillCount: v.optional(v.number()),
    /** Proactive settings. */
    proactive: v.optional(
      v.object({
        enabled: v.boolean(),
        /** Unset means on. Off: wali may notify at any hour. */
        quietEnabled: v.optional(v.boolean()),
        quietStartHour: v.number(),
        quietEndHour: v.number(),
        maxPerHour: v.number(),
        maxPerDay: v.number(),
      }),
    ),
    /** Permission mode; unset means "balanced". */
    permissions: v.optional(permissionMode),
    /** "Always allow" choices made on an approval; these stop asking in any mode. Never high-risk. */
    alwaysAllow: v.optional(
      v.array(
        v.object({
          kind: v.union(v.literal("browser"), v.literal("app")),
          key: v.string(),
          label: v.string(),
          createdAt: v.number(),
        }),
      ),
    ),
    /** Push notification preferences; unset means all on. */
    notify: v.optional(notifyPrefs),
    createdAt: v.number(),
  })
    .index("by_clerkId", ["clerkId"])
    .index("by_opaqueId", ["opaqueId"]),

  /** "Connecting" a pendant subscribes this user to the shared pendant stream (any device for now). */
  devices: defineTable({
    userId: v.id("users"),
    name: v.string(),
    status: v.union(v.literal("connected"), v.literal("disconnected")),
    connectedAt: v.number(),
  })
    .index("by_userId", ["userId"])
    .index("by_status", ["status"]),

  threads: defineTable({
    userId: v.id("users"),
    title: v.string(),
    /** "home" is the one thread where wali's proactive nudges arrive. */
    kind: v.union(v.literal("home"), v.literal("chat")),
    updatedAt: v.number(),
    preview: v.optional(v.string()),
  }).index("by_user_updated", ["userId", "updatedAt"]),

  messages: defineTable({
    threadId: v.id("threads"),
    userId: v.id("users"),
    role: v.union(v.literal("user"), v.literal("assistant")),
    kind: messageKind,
    status: v.union(v.literal("streaming"), v.literal("done"), v.literal("error")),
    text: v.string(),
    tools: v.optional(v.array(toolPart)),
    /** The model's visible reasoning while it thinks, and how long it thought. */
    reasoning: v.optional(v.string()),
    thinkingMs: v.optional(v.number()),
    approvalId: v.optional(v.id("approvals")),
    browserTaskId: v.optional(v.id("browserTasks")),
    /** For nudges: what woke wali up, and how the user responded. */
    trigger: v.optional(v.object({ kind: triggerKind, recordingId: v.optional(v.id("recordings")) })),
    actions: v.optional(v.array(v.string())),
    response: v.optional(v.union(v.literal("helpful"), v.literal("dismissed"))),
    /** For nudges: which of `actions` the user tapped (sent back to wali as their reply). */
    chosenAction: v.optional(v.string()),
    error: v.optional(v.string()),
    createdAt: v.number(),
  })
    .index("by_thread", ["threadId", "createdAt"])
    .index("by_user_kind", ["userId", "kind", "createdAt"]),

  /** Ask-first actions. Approval runs exactly this stored action (no model in between). */
  approvals: defineTable({
    userId: v.id("users"),
    threadId: v.id("threads"),
    channel: v.union(v.literal("composio"), v.literal("browser")),
    title: v.string(),
    summary: v.string(),
    toolSlug: v.optional(v.string()),
    args: v.any(),
    /** Why it asked. A read hands its result back to wali so it can finish the answer. */
    risk: v.optional(risk),
    /** Set when this can be allowed for good; absent for high-risk actions. */
    scope: v.optional(grantScope),
    status: approvalStatus,
    result: v.optional(v.any()),
    error: v.optional(v.string()),
    createdAt: v.number(),
    decidedAt: v.optional(v.number()),
  }).index("by_user_status", ["userId", "status", "createdAt"]),

  /** Expo push tokens, one per installed app. A token moves to whoever signed in last on that phone. */
  pushTokens: defineTable({
    userId: v.id("users"),
    token: v.string(),
    platform: v.union(v.literal("ios"), v.literal("android")),
    deviceName: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_token", ["token"]),

  /** Web Push subscriptions (the web app's service worker), one per browser profile. */
  webPushSubs: defineTable({
    userId: v.id("users"),
    endpoint: v.string(),
    p256dh: v.string(),
    auth: v.string(),
    /** "Chrome on macOS" etc., for the settings list. */
    label: v.optional(v.string()),
    updatedAt: v.number(),
  })
    .index("by_user", ["userId"])
    .index("by_endpoint", ["endpoint"]),

  browserTasks: defineTable({
    userId: v.id("users"),
    threadId: v.id("threads"),
    task: v.string(),
    /** One plain sentence for the user; the full task is what the browser agent was told. */
    summary: v.optional(v.string()),
    runId: v.optional(v.string()),
    sessionId: v.optional(v.string()),
    /** Live view of the run's browser. Set once it is up, cleared when the run ends. */
    liveUrl: v.optional(v.string()),
    status: v.union(
      v.literal("starting"),
      v.literal("running"),
      v.literal("completed"),
      v.literal("failed"),
      v.literal("cancelled"),
    ),
    result: v.optional(v.string()),
    error: v.optional(v.string()),
    polls: v.number(),
    createdAt: v.number(),
  }).index("by_user", ["userId", "createdAt"]),

  /** Every Jev gate decision, so thresholds can be tuned. */
  gateEvents: defineTable({
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
    /** The agent's final decision when the gate passed. */
    decision: v.optional(v.string()),
    messageId: v.optional(v.id("messages")),
    costUsd: v.optional(v.number()),
    createdAt: v.number(),
  })
    .index("by_user", ["userId", "createdAt"])
    .index("by_recording", ["trigger.recordingId"]),

  notes: defineTable({
    userId: v.id("users"),
    text: v.string(),
    createdAt: v.number(),
  }).index("by_user", ["userId", "createdAt"]),

  followups: defineTable({
    userId: v.id("users"),
    note: v.string(),
    runAt: v.number(),
    status: v.union(v.literal("scheduled"), v.literal("fired"), v.literal("cancelled")),
    scheduledId: v.optional(v.id("_scheduled_functions")),
    createdAt: v.number(),
  }).index("by_user", ["userId", "runAt"]),

  /**
   * Composio's toolkit catalog, mirrored by agentNode.refreshAppCatalog (daily cron) so the
   * Connections directory loads instantly. Not per-user; connection state comes from Composio.
   */
  appCatalog: defineTable({
    slug: v.string(),
    name: v.string(),
    logo: v.optional(v.string()),
    description: v.optional(v.string()),
    categories: v.array(v.string()),
    toolsCount: v.optional(v.number()),
    /** Position in Composio's usage ranking (0 = most used). */
    rank: v.number(),
    /** How connecting works: oauth = sign in, key = paste a key/login, none = always on, unavailable = needs our own OAuth app. */
    auth: appAuth,
    syncedAt: v.number(),
  })
    .index("by_slug", ["slug"])
    .index("by_rank", ["rank"]),
};
