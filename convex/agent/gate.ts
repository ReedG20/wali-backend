"use node";
import { Classifier } from "@mastra/core/classifier";
import { gateModel } from "./models";

/**
 * The Jev gate: TypeSafe's decision model answers typed questions about the moment in parallel.
 * It returns probabilities, not text; our code (below) turns them into a decision, so thresholds
 * can be tuned from the logged scores without touching prompts.
 */

const URGENCY = ["Can wait until tomorrow", "Sometime today", "Within the hour", "Right now"] as const;

let classifier: Classifier<any> | null = null;

function gate() {
  classifier ??= new Classifier({
    id: "mind-gate",
    // OpenRouter's Decisions API model (Jev). Its spec version may trail Mastra's type, hence the cast.
    model: gateModel() as never,
    questions: {
      worthActing: {
        type: "boolean",
        instructions:
          "Would a short, well-timed message or small action from a personal companion clearly help the wearer, given this conversation and context? Stress, worry or friction the wearer mentions about their own life (school, work, plans, people) counts. Routine chatter, small talk and things already handled are false.",
      },
      userAsked: {
        type: "boolean",
        instructions:
          "Did the wearer ask for help, ask to be reminded, say they need to do something, make a promise or commitment, or say they wish they knew or had something (\"I wish I knew...\", \"I keep forgetting...\", \"it'd be nice if...\")? Judge only what is said in `conversation`; `previousConversation` is background that was already judged. Filler, exclamations and rhetorical remarks with nothing to act on (\"I have no idea.\", \"Oh my God\", \"who knows\") are false.",
      },
      canHelp: {
        type: "boolean",
        instructions:
          "Could wali concretely answer or take care of something the wearer needs, worries about or wishes for, using its abilities (listed in walisAbilities): looking things up in their connected apps or on the web, checking their calendar or email, saving notes, setting reminders and follow-ups? True even if they didn't ask wali directly.",
      },
      distress: {
        type: "boolean",
        instructions: "Does the wearer show clear signs of emotional distress, crisis, panic, or risk of self-harm?",
      },
      badTime: {
        type: "boolean",
        instructions:
          "Is right now a bad moment to interrupt the wearer (they are mid-conversation, in a meeting, presenting, or it is late at night)?",
      },
      urgency: {
        type: "score",
        instructions:
          "How soon would wali need to act on something in `conversation` for it to be useful? If there is nothing in it to act on, the answer is that it can wait.",
        criteria: [...URGENCY],
      },
      kind: {
        type: "choice",
        instructions: "What kind of response, if any, fits best?",
        criteria: {
          none: "Nothing; keep listening.",
          nudge: "A gentle observation or one small next step.",
          reminder: "A reminder about a promise, task or plan mentioned.",
          action: "Doing something in the user's apps or on the web for them.",
          support: "Emotional support and resources.",
        },
      },
    },
  });
  return classifier;
}

export type { GateScores, Verdict } from "../lib/gatePolicy";
export { policy, THRESHOLDS } from "../lib/gatePolicy";
import type { GateScores } from "../lib/gatePolicy";

function prob(a: any): number {
  return a && a.type !== "refusal" && typeof a.probability === "number" ? a.probability : 0;
}

export async function runGate(state: Record<string, unknown>): Promise<{ scores: GateScores; costUsd?: number }> {
  const res: any = await gate().decide({ state: state as any });
  const a = res.answers ?? {};
  const scores: GateScores = {
    worthActing: prob(a.worthActing),
    userAsked: prob(a.userAsked),
    canHelp: prob(a.canHelp),
    distress: prob(a.distress),
    badTime: prob(a.badTime),
    urgency: a.urgency && a.urgency.type !== "refusal" ? Number(a.urgency.score ?? 0) : 0,
    kind: a.kind && a.kind.type !== "refusal" ? String(a.kind.choice ?? "none") : "none",
  };
  const cost = res.usage?.cost ?? res.providerMetadata?.openrouter?.usage?.cost;
  return { scores, costUsd: typeof cost === "number" ? cost : undefined };
}
