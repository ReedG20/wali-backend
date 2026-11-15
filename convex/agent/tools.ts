"use node";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { ActionCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { internal } from "../_generated/api";
import * as composio from "./composio";
import * as browserUse from "./browserUse";
import * as memory from "./memory";
import { classifyBrowser, DEFAULT_PERMISSION_MODE, needsApproval } from "../lib/permissions";

type Line = { at: number; speaker: string; text: string };

export function fmtTime(ms: number, tz?: string) {
  return new Date(ms).toLocaleString("en-US", {
    timeZone: tz || "America/Chicago",
    weekday: "short",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function fmtLines(lines: Line[], tz?: string, max = 12000) {
  const out = lines.map((l) => `[${fmtTime(l.at, tz)}] ${l.speaker}: ${l.text}`).join("\n");
  return out.length > max ? `…${out.slice(-max)}` : out;
}

function clip(value: unknown, max = 8000) {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s && s.length > max ? `${s.slice(0, max)}… [truncated]` : s;
}

/** Start a Browser Use run for the user and poll it in the background. */
export async function startBrowserTask(
  ctx: ActionCtx,
  user: Doc<"users">,
  threadId: Id<"threads">,
  task: string,
) {
  const taskId = await ctx.runMutation(internal.agentData.createBrowserTask, {
    userId: user._id,
    threadId,
    task,
  });
  try {
    let profileId = user.browserProfileId;
    if (!profileId) {
      profileId = (await browserUse.createProfile(user.opaqueId)).id;
      await ctx.runMutation(internal.agentData.setBrowserProfile, { userId: user._id, profileId });
    }
    const run = await browserUse.startRun(task, profileId);
    await ctx.runMutation(internal.agentData.patchBrowserTask, {
      id: taskId,
      runId: run.id,
      sessionId: run.sessionId,
      status: "running",
    });
    await ctx.scheduler.runAfter(5000, internal.agentNode.pollBrowserTask, { taskId });
    return { taskId, status: "running" as const };
  } catch (e) {
    const error = String(e instanceof Error ? e.message : e).slice(0, 300);
    await ctx.runMutation(internal.agentData.patchBrowserTask, { id: taskId, status: "failed", error });
    return { taskId, status: "failed" as const, error };
  }
}

/** All of wali's tools, bound to one user and the thread where approvals and updates appear. */
export function buildTools(ctx: ActionCtx, user: Doc<"users">, threadId: Id<"threads">) {
  const tz = user.timezone;
  const mode = user.permissions ?? DEFAULT_PERMISSION_MODE;

  const search_memory = createTool({
    id: "search_memory",
    description:
      "Semantic search over everything wali has learned about the user (Supermemory: facts, people, commitments, past conversations, saved notes). Use focused queries: a person's name, a topic, a promise. Run a few in parallel when needed.",
    inputSchema: z.object({ query: z.string().min(2) }),
    execute: async ({ query }) => {
      if (!memory.memoryEnabled()) {
        const hits = await ctx.runQuery(internal.agentData.searchUtterances, { query, limit: 15 });
        return { transcript: hits.length ? fmtLines(hits, tz) : "No matches." };
      }
      try {
        const hits = await memory.search(user, query, { limit: 8 });
        return hits.length
          ? { memories: hits.map((h) => `${h.date ? `[${h.date.slice(0, 10)}] ` : ""}${h.text}`) }
          : { memories: [], note: "Nothing relevant in long-term memory. Try search_transcripts for exact words." };
      } catch (e) {
        return { error: String(e instanceof Error ? e.message : e).slice(0, 300) };
      }
    },
  });

  const search_transcripts = createTool({
    id: "search_transcripts",
    description:
      "Exact keyword search over raw pendant transcripts. Use for verbatim words or quotes; prefer search_memory for meaning.",
    inputSchema: z.object({ query: z.string().min(2) }),
    execute: async ({ query }) => {
      const hits = await ctx.runQuery(internal.agentData.searchUtterances, { query, limit: 15 });
      return { transcript: hits.length ? fmtLines(hits, tz) : "No matching transcript lines." };
    },
  });

  const recent_conversations = createTool({
    id: "recent_conversations",
    description: "Transcript of what the pendant heard in the last N hours (default 3, max 24).",
    inputSchema: z.object({ hours: z.number().min(0.25).max(24).optional() }),
    execute: async ({ hours }) => {
      const since = Date.now() - (hours ?? 3) * 3600_000;
      const lines = await ctx.runQuery(internal.agentData.recentUtterances, { sinceMs: since, limit: 400 });
      return { transcript: lines.length ? fmtLines(lines, tz) : "Nothing was transcribed in that window." };
    },
  });

  const save_note = createTool({
    id: "save_note",
    description: "Save a short note to the user's memory (a fact, a promise they made, something to revisit).",
    inputSchema: z.object({ text: z.string().min(2).max(2000) }),
    execute: async ({ text }) => {
      const id = await ctx.runMutation(internal.agentData.saveNote, { userId: user._id, text });
      if (memory.memoryEnabled()) {
        try {
          await memory.addNote(user, { id, text, at: Date.now() });
        } catch {
          // The note is still in Convex; a later backfill can resend it.
        }
      }
      return { saved: true };
    },
  });

  const schedule_followup = createTool({
    id: "schedule_followup",
    description:
      "Wake yourself up later to check in about something (e.g. after a meeting). The note is what you'll want to remember then.",
    inputSchema: z.object({
      minutesFromNow: z.number().min(1).max(60 * 24 * 7),
      note: z.string().min(2).max(500),
    }),
    execute: async ({ minutesFromNow, note }) => {
      const runAt = Date.now() + minutesFromNow * 60_000;
      await ctx.runMutation(internal.agentData.scheduleFollowup, { userId: user._id, note, runAt });
      return { scheduledFor: fmtTime(runAt, tz) };
    },
  });

  const tools: Record<string, any> = {
    search_memory,
    search_transcripts,
    recent_conversations,
    save_note,
    schedule_followup,
  };

  if (composio.composioEnabled()) {
    tools.find_app_actions = createTool({
      id: "find_app_actions",
      description:
        "Find Composio actions for a task in any of ~1,700 apps (Gmail, Calendar, Slack, Notion, Linear, HubSpot, Airtable...). Returns tool slugs, input schemas and whether the app is connected.",
      inputSchema: z.object({
        query: z.string().describe("What you want to do, e.g. 'list today's calendar events'"),
        toolkits: z.array(z.string()).optional().describe("Optional toolkit slugs to search, e.g. ['gmail']"),
      }),
      execute: async ({ query, toolkits }) => {
        try {
          return { result: clip(await composio.search(user.opaqueId, query, toolkits), 12000) };
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e).slice(0, 300) };
        }
      },
    });

    tools.run_app_action = createTool({
      id: "run_app_action",
      description:
        "Run one Composio action by slug. Depending on the user's permission setting it runs now or waits for their OK; the result says which.",
      inputSchema: z.object({
        toolSlug: z.string(),
        arguments: z.record(z.string(), z.any()),
        summary: z
          .string()
          .describe("One plain sentence for the user describing exactly what this will do, e.g. 'Email Sam: running 10 min late'"),
      }),
      execute: async ({ toolSlug, arguments: args, summary }) => {
        const r = await composio.risk(toolSlug, args);
        if (needsApproval(mode, r)) {
          await ctx.runMutation(internal.agentData.createApproval, {
            userId: user._id,
            threadId,
            channel: "composio",
            title: toolSlug,
            summary,
            toolSlug,
            args,
            risk: r,
          });
          return {
            status: "awaiting_approval",
            note:
              r === "read"
                ? "The user sees an approval card. Once they approve, the result comes back to you and you can continue."
                : "The user sees an approval card. Do not say it's done.",
          };
        }
        try {
          const res = await composio.execute(user.opaqueId, toolSlug, args);
          return { status: "done", result: clip(res, 10000) };
        } catch (e) {
          return { status: "error", error: String(e instanceof Error ? e.message : e).slice(0, 400) };
        }
      },
    });

    tools.connect_app = createTool({
      id: "connect_app",
      description:
        "Give the user a button to connect an app (toolkit slug like 'gmail', 'linear' or 'hubspot'). Works for any app in the Composio catalog.",
      inputSchema: z.object({ toolkit: z.string() }),
      execute: async ({ toolkit }) => {
        const slug = toolkit.toLowerCase();
        const app = await ctx.runQuery(internal.appCatalog.bySlug, { slug });
        if (app?.auth === "none") return { toolkit, note: `${app.name} needs no sign-in. Use its actions directly.` };
        if (app?.auth === "unavailable")
          return { toolkit, error: `${app.name} can't be connected through Composio yet. Offer the browser instead if it's a website.` };
        try {
          const { redirectUrl } = await composio.authorize(user.opaqueId, slug);
          return { toolkit, connectUrl: redirectUrl, note: "A connect button is shown to the user." };
        } catch (e) {
          return { error: String(e instanceof Error ? e.message : e).slice(0, 300) };
        }
      },
    });
  }

  if (browserUse.browserUseEnabled()) {
    tools.browser_task = createTool({
      id: "browser_task",
      description:
        "Hand a website task to a cloud browser agent (for sites without an API). Runs in the background and reports back in this thread. Set usesAccount when it acts on the user's own accounts. Depending on the user's permission setting it may wait for their OK first.",
      inputSchema: z.object({
        task: z.string().describe("Complete, self-contained instructions including the site and what to report back."),
        usesAccount: z.boolean(),
        summary: z.string().describe("One sentence for the user describing what the browser will do."),
      }),
      execute: async ({ task, usesAccount, summary }) => {
        const r = classifyBrowser(usesAccount);
        if (needsApproval(mode, r)) {
          await ctx.runMutation(internal.agentData.createApproval, {
            userId: user._id,
            threadId,
            channel: "browser",
            title: "Browser task",
            summary,
            args: { task },
            risk: r,
          });
          return { status: "awaiting_approval" };
        }
        return startBrowserTask(ctx, user, threadId, task);
      },
    });
  }

  return tools;
}
