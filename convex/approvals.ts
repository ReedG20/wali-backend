import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { internal } from "./_generated/api";
import { currentUser, requireUser } from "./lib/auth";

export const pending = query({
  args: {},
  handler: async (ctx) => {
    const user = await currentUser(ctx);
    if (!user) return [];
    return ctx.db
      .query("approvals")
      .withIndex("by_user_status", (q) => q.eq("userId", user._id).eq("status", "pending"))
      .order("desc")
      .take(20);
  },
});

/**
 * Approve or decline an ask-first action. Approving runs exactly the stored action
 * (optionally with the user's edited arguments); no model sits between the OK and the call.
 */
export const decide = mutation({
  args: {
    id: v.id("approvals"),
    decision: v.union(v.literal("approve"), v.literal("decline")),
    editedArgs: v.optional(v.any()),
    /** With approve: also stop asking for this scope from now on. Ignored if it has none. */
    always: v.optional(v.boolean()),
  },
  handler: async (ctx, { id, decision, editedArgs, always }) => {
    const user = await requireUser(ctx);
    const a = await ctx.db.get(id);
    if (!a || a.userId !== user._id) throw new Error("Not found");
    if (a.status !== "pending") throw new Error(`Already ${a.status}`);
    if (decision === "decline") {
      await ctx.db.patch(id, { status: "declined", decidedAt: Date.now() });
      return;
    }
    if (always && a.scope) {
      const scope = a.scope;
      const kept = (user.alwaysAllow ?? []).filter((g) => !(g.kind === scope.kind && g.key === scope.key));
      await ctx.db.patch(user._id, { alwaysAllow: [...kept, { ...scope, createdAt: Date.now() }] });
    }
    await ctx.db.patch(id, {
      status: "approved",
      decidedAt: Date.now(),
      ...(editedArgs !== undefined ? { args: editedArgs } : {}),
    });
    await ctx.scheduler.runAfter(0, internal.agentNode.executeApproval, { approvalId: id });
  },
});
