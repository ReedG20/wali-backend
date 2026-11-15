"use node";
import { Composio } from "@composio/core";
import { classifyComposio, type Risk } from "../lib/permissions";

/**
 * Composio through Tool Router sessions (search -> execute), scoped to the user's opaque id.
 * Which calls wait for the user's OK depends on their permission mode (lib/permissions.ts).
 */

export const CURATED_TOOLKITS = (process.env.COMPOSIO_TOOLKITS ?? "gmail,googlecalendar,slack,notion,todoist,github")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export function composioEnabled() {
  return !!process.env.COMPOSIO_API_KEY?.trim();
}

function client() {
  const apiKey = process.env.COMPOSIO_API_KEY?.trim();
  if (!apiKey) throw new Error("COMPOSIO_API_KEY is not set in Convex env");
  return new Composio({ apiKey });
}

export async function session(opaqueId: string) {
  return client().create(opaqueId, { manageConnections: false } as never);
}

type SessionToolkit = {
  slug: string;
  name: string;
  logo?: string | null;
  connection?: { isActive?: boolean; connectedAccount?: { id?: string; status?: string } | null } | null;
};

function shapeToolkit(t: SessionToolkit) {
  return {
    slug: t.slug,
    name: t.name,
    logo: t.logo ?? null,
    connected: !!t.connection?.isActive,
    accountId: t.connection?.connectedAccount?.id ?? null,
    status: t.connection?.connectedAccount?.status ?? null,
  };
}

/** Connection state for specific toolkits (the curated row, or one app before disconnecting). */
export async function listToolkits(opaqueId: string, toolkits: string[] = CURATED_TOOLKITS) {
  const s = await session(opaqueId);
  const res = await s.toolkits({ toolkits, limit: Math.min(Math.max(toolkits.length, 1), 50) } as never);
  return (res.items as SessionToolkit[]).map(shapeToolkit);
}

/** Every toolkit the user has connected, across the whole catalog. */
export async function connectedToolkits(opaqueId: string) {
  const s = await session(opaqueId);
  const out: ReturnType<typeof shapeToolkit>[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await s.toolkits({ isConnected: true, limit: 50, ...(cursor ? { cursor } : {}) } as never);
    out.push(...(res.items as SessionToolkit[]).map(shapeToolkit).filter((t) => t.connected));
    cursor = (res as { nextCursor?: string | null }).nextCursor ?? undefined;
    if (!cursor) break;
  }
  return out;
}

// --- Catalog ----------------------------------------------------------------------------------

export type AppAuth = "oauth" | "key" | "none" | "unavailable";

/**
 * What connecting looks like, checked against the live API (2026-11-14): Composio-managed OAuth
 * and DCR OAuth open a normal sign-in; API key / basic / bearer schemes open Composio's hosted page
 * where the user pastes their own credentials. OAuth-only toolkits without Composio-managed
 * credentials (Shopify, Snowflake, X...) need an auth config with our own OAuth app first.
 */
export function classifyAuth(t: { no_auth?: boolean; auth_schemes?: string[]; composio_managed_auth_schemes?: string[] }): AppAuth {
  if (t.no_auth) return "none";
  const schemes = t.auth_schemes ?? [];
  if ((t.composio_managed_auth_schemes ?? []).length || schemes.includes("DCR_OAUTH")) return "oauth";
  if (schemes.some((s) => s === "API_KEY" || s === "BEARER_TOKEN" || s.startsWith("BASIC"))) return "key";
  return "unavailable";
}

const HIDDEN = new Set(["composio"]); // Composio's own meta toolkit

/** The full toolkit catalog, most used first. */
export async function fetchCatalog() {
  const raw = client().getClient() as unknown as {
    toolkits: { list: (q: Record<string, unknown>) => Promise<{ items: RawToolkit[]; next_cursor?: string | null }> };
  };
  const rows: CatalogRow[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 20; page++) {
    const res = await raw.toolkits.list({ limit: 1000, sort_by: "usage", ...(cursor ? { cursor } : {}) });
    for (const t of res.items) {
      if (t.is_local_toolkit || HIDDEN.has(t.slug)) continue;
      const desc = t.meta?.description?.trim();
      rows.push({
        slug: t.slug,
        name: t.name,
        ...(t.meta?.logo ? { logo: t.meta.logo } : {}),
        ...(desc ? { description: desc.length > 220 ? `${desc.slice(0, 217).trimEnd()}…` : desc } : {}),
        categories: (t.meta?.categories ?? []).map((c) => c.name.toLowerCase()).slice(0, 4),
        ...(typeof t.meta?.tools_count === "number" ? { toolsCount: t.meta.tools_count } : {}),
        rank: rows.length,
        auth: classifyAuth(t),
      });
    }
    cursor = res.next_cursor ?? undefined;
    if (!cursor) break;
  }
  return rows;
}

type RawToolkit = {
  slug: string;
  name: string;
  is_local_toolkit?: boolean;
  no_auth?: boolean;
  auth_schemes?: string[];
  composio_managed_auth_schemes?: string[];
  meta?: { description?: string; logo?: string; tools_count?: number; categories?: { slug: string; name: string }[] };
};

export type CatalogRow = {
  slug: string;
  name: string;
  logo?: string;
  description?: string;
  categories: string[];
  toolsCount?: number;
  rank: number;
  auth: AppAuth;
};

export async function authorize(opaqueId: string, toolkit: string, callbackUrl?: string) {
  const s = await session(opaqueId);
  const req = await s.authorize(toolkit, callbackUrl ? { callbackUrl } : undefined);
  return { redirectUrl: req.redirectUrl ?? null, id: req.id };
}

export async function disconnect(accountId: string) {
  await client().connectedAccounts.delete(accountId);
}

export async function search(opaqueId: string, query: string, toolkits?: string[]) {
  const s = await session(opaqueId);
  return s.search({ query, ...(toolkits?.length ? { toolkits } : {}) });
}

export async function execute(opaqueId: string, slug: string, args: Record<string, unknown>) {
  const s = await session(opaqueId);
  return s.execute(slug, args);
}

// --- Risk -------------------------------------------------------------------------------------

/** Composio's tool hints, cached per warm action (they're static metadata, free on every plan). */
const tagCache = new Map<string, string[] | null>();

async function toolTags(slug: string): Promise<string[] | null> {
  const key = slug.trim().toUpperCase();
  if (tagCache.has(key)) return tagCache.get(key)!;
  try {
    const tool = (await client().tools.getRawComposioToolBySlug(key)) as { tags?: string[] };
    const tags = Array.isArray(tool.tags) ? tool.tags : null;
    tagCache.set(key, tags);
    return tags;
  } catch {
    return null; // fall back to the slug and arguments
  }
}

/**
 * How risky one call is: Composio's hints (readOnlyHint, destructiveHint...) plus the slug and
 * arguments. COMPOSIO_READ_ONLY_TOOLS lists slugs a person reviewed as reads.
 */
export async function risk(slug: string, args?: Record<string, unknown>): Promise<Risk> {
  const reviewedReads = (process.env.COMPOSIO_READ_ONLY_TOOLS ?? "").split(",").filter((x) => x.trim());
  return classifyComposio(slug, { tags: await toolTags(slug), args, reviewedReads });
}
