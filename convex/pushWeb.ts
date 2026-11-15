"use node";
import { v } from "convex/values";
import webpush from "web-push";
import { internalAction } from "./_generated/server";
import { internal } from "./_generated/api";

/**
 * Web Push to the web app's service worker (web/apps/app/public/sw.js). Same notifications as the
 * iPhone gets. Needs VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Convex env; VAPID_SUBJECT is
 * optional (a mailto: or https: contact for push services).
 */

export const send = internalAction({
  args: {
    subs: v.array(v.object({ endpoint: v.string(), p256dh: v.string(), auth: v.string() })),
    payload: v.string(),
    urgent: v.boolean(),
  },
  handler: async (ctx, { subs, payload, urgent }): Promise<{ sent: number }> => {
    const pub = process.env.VAPID_PUBLIC_KEY?.trim();
    const priv = process.env.VAPID_PRIVATE_KEY?.trim();
    if (!pub || !priv) return { sent: 0 };
    const subject = process.env.VAPID_SUBJECT?.trim() || process.env.CONVEX_SITE_URL || "https://convex.dev";
    webpush.setVapidDetails(subject, pub, priv);

    const dead: string[] = [];
    let sent = 0;
    await Promise.all(
      subs.map(async (s) => {
        try {
          await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, {
            TTL: 60 * 60 * 24,
            urgency: urgent ? "high" : "normal",
          });
          sent++;
        } catch (e) {
          const status = (e as { statusCode?: number }).statusCode;
          // Gone or unknown: the browser dropped the subscription.
          if (status === 404 || status === 410) dead.push(s.endpoint);
          else console.warn(`[push:web] ${status ?? ""} ${String((e as Error).message ?? e).slice(0, 200)}`);
        }
      }),
    );
    if (dead.length) await ctx.runMutation(internal.push.dropWebSubs, { endpoints: dead });
    return { sent };
  },
});
