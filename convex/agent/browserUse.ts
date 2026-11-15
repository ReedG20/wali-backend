"use node";

/** Browser Use Cloud API v4: hosted browser agent runs on a per-user profile (keeps sign-ins). */

const BASE = process.env.BROWSER_USE_BASE_URL ?? "https://api.browser-use.com/api/v4";

export function browserUseEnabled() {
  return !!process.env.BROWSER_USE_API_KEY?.trim();
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const key = process.env.BROWSER_USE_API_KEY?.trim();
  if (!key) throw new Error("BROWSER_USE_API_KEY is not set in Convex env");
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { "X-Browser-Use-API-Key": key, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "error",
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`Browser Use ${method} ${path.split("/")[1]} failed: ${res.status} ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function createProfile(opaqueId: string) {
  return call<{ id: string }>("POST", "/profiles", { name: `mind-${opaqueId.slice(-8)}`, userId: opaqueId });
}

export async function startRun(task: string, profileId?: string) {
  return call<{ id: string; status: string; sessionId: string }>("POST", "/runs", {
    task,
    model: process.env.BROWSER_USE_MODEL ?? "bu-fast",
    ...(profileId ? { browserSettings: { profileId } } : {}),
    maxCostUsd: Number(process.env.BROWSER_USE_MAX_COST_USD ?? "1"),
  });
}

export async function runStatus(runId: string) {
  return call<{ status: string }>("GET", `/runs/${runId}/status`);
}

export async function getRun(runId: string) {
  return call<{ status: string; result: string | null; error: string | null; totalCostUsd?: string }>(
    "GET",
    `/runs/${runId}`,
  );
}

/** A live browser on the user's profile, so they can sign in to sites the agent will use. */
export async function startSignInBrowser(profileId: string) {
  return call<{ id: string; liveUrl: string | null; status: string }>("POST", "/browsers", {
    profileId,
    timeout: 15,
  });
}

export async function stopBrowser(browserId: string) {
  return call<unknown>("PATCH", `/browsers/${browserId}`, { action: "stop" });
}

export const TERMINAL = new Set(["completed", "failed", "cancelled", "stopped", "error", "timed_out"]);
