import type { QueryCtx, MutationCtx } from "../_generated/server";
import type { Doc } from "../_generated/dataModel";

/** The signed-in user's row, or null (not signed in, or `users.ensure` hasn't run yet). */
export async function currentUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users"> | null> {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) return null;
  return ctx.db
    .query("users")
    .withIndex("by_clerkId", (q) => q.eq("clerkId", identity.subject))
    .unique();
}

export async function requireUser(ctx: QueryCtx | MutationCtx): Promise<Doc<"users">> {
  const user = await currentUser(ctx);
  if (!user) throw new Error("Not signed in");
  return user;
}

export const DEFAULT_PROACTIVE = {
  enabled: true,
  quietEnabled: true,
  quietStartHour: 22,
  quietEndHour: 8,
  maxPerHour: 6,
  maxPerDay: 40,
};

/** Steppers in both apps use these bounds; the mutation clamps to them too. */
export const PROACTIVE_LIMITS = { maxPerHour: 20, maxPerDay: 100 };

export const DEFAULT_NOTIFY = { nudges: true, approvals: true, updates: true };
