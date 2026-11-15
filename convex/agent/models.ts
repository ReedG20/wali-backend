"use node";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

/** Every model call goes through OpenRouter, with one key: OPENROUTER_API_KEY (Convex env). */

export const AGENT_MODEL = process.env.MIND_AGENT_MODEL ?? "anthropic/claude-sonnet-5.5";
/** Jev, TypeSafe's decision model, served by OpenRouter's Decisions API. */
export const GATE_MODEL = process.env.MIND_GATE_MODEL ?? "~typesafe/jev-latest";

export function openRouterKey(): string | null {
  const key = process.env.OPENROUTER_API_KEY?.trim();
  return key ? key : null;
}

export function openrouter() {
  const apiKey = openRouterKey();
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is not set in Convex env");
  return createOpenRouter({
    apiKey,
    headers: { "HTTP-Referer": "https://wali.local", "X-Title": "wali" },
  });
}

type Effort = "xhigh" | "high" | "medium" | "low" | "minimal" | "none";
const effort = (v: string | undefined, fallback: Effort): Effort =>
  (["xhigh", "high", "medium", "low", "minimal", "none"] as const).includes(v as Effort) ? (v as Effort) : fallback;

/** Chat replies: little up-front thinking so the first words arrive quickly. */
export const CHAT_REASONING = effort(process.env.MIND_CHAT_REASONING, "low");
/** Background decisions (proactive runs): nobody is waiting, so think more. */
export const BACKGROUND_REASONING = effort(process.env.MIND_BACKGROUND_REASONING, "medium");

export function agentModel(reasoning: Effort = BACKGROUND_REASONING) {
  return openrouter()(AGENT_MODEL, { reasoning: { effort: reasoning } });
}

export function gateModel() {
  return openrouter().evaluationModel(GATE_MODEL);
}
