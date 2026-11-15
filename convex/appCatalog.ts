import { v } from "convex/values";
import { internalMutation, internalQuery, query } from "./_generated/server";
import { appAuth } from "./agentSchema";
import { currentUser } from "./lib/auth";

/**
 * The app directory behind the Connections page. Rows are written by agentNode.refreshAppCatalog
 * (daily cron). The whole catalog (~1.7k rows) goes to the client in one go so search and
 * category filters are instant.
 */
export const list = query({
  args: {},
  handler: async (ctx) => {
    if (!(await currentUser(ctx))) return null;
    const rows = await ctx.db.query("appCatalog").withIndex("by_rank").collect();
    return rows.map((r) => ({
      slug: r.slug,
      name: r.name,
      logo: r.logo ?? null,
      // Cards show two lines; the full text stays in the table.
      description: r.description ? (r.description.length > 120 ? `${r.description.slice(0, 117).trimEnd()}…` : r.description) : null,
      categories: r.categories,
      auth: r.auth,
    }));
  },
});

export const bySlug = internalQuery({
  args: { slug: v.string() },
  handler: async (ctx, { slug }) =>
    ctx.db
      .query("appCatalog")
      .withIndex("by_slug", (q) => q.eq("slug", slug))
      .unique(),
});

export const bySlugs = internalQuery({
  args: { slugs: v.array(v.string()) },
  handler: async (ctx, { slugs }) =>
    Promise.all(
      slugs.map((slug) =>
        ctx.db
          .query("appCatalog")
          .withIndex("by_slug", (q) => q.eq("slug", slug))
          .unique(),
      ),
    ),
});

const row = v.object({
  slug: v.string(),
  name: v.string(),
  logo: v.optional(v.string()),
  description: v.optional(v.string()),
  categories: v.array(v.string()),
  toolsCount: v.optional(v.number()),
  rank: v.number(),
  auth: appAuth,
});

export const upsertBatch = internalMutation({
  args: { rows: v.array(row), syncedAt: v.number() },
  handler: async (ctx, { rows, syncedAt }) => {
    for (const r of rows) {
      const existing = await ctx.db
        .query("appCatalog")
        .withIndex("by_slug", (q) => q.eq("slug", r.slug))
        .unique();
      if (existing) await ctx.db.replace(existing._id, { ...r, syncedAt });
      else await ctx.db.insert("appCatalog", { ...r, syncedAt });
    }
  },
});

/** Drop apps Composio no longer lists (anything not touched by this sync). */
export const pruneBefore = internalMutation({
  args: { syncedAt: v.number() },
  handler: async (ctx, { syncedAt }) => {
    const rows = await ctx.db.query("appCatalog").collect();
    let removed = 0;
    for (const r of rows) {
      if (r.syncedAt < syncedAt) {
        await ctx.db.delete(r._id);
        removed++;
      }
    }
    return removed;
  },
});
