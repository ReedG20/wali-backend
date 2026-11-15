/**
 * How much wali may do without asking. Pure (no Convex or SDK imports) so tests and the agent share it.
 *
 * - "ask":      every action outside wali (any app action, any browser task) waits for the user's OK,
 *               reads included. wali's own memory (notes, follow-ups, search) never asks.
 * - "balanced": reads and small private changes (a draft, a label, a task for yourself) run on
 *               their own, and so does a browser task that only looks something up. Anything that
 *               reaches other people, spends money, deletes, or changes something through the
 *               browser waits for the user.
 * - "auto":     everything runs straight away.
 */
export type PermissionMode = "ask" | "balanced" | "auto";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "balanced";

/** read: changes nothing. low: a private, reversible change. high: reaches people, money, deletes. */
export type Risk = "read" | "low" | "high";

/** `granted`: the user chose "Always allow" for exactly this (see grantFor). It never covers high. */
export function needsApproval(mode: PermissionMode | undefined, risk: Risk, granted = false): boolean {
  if (granted && risk !== "high") return false;
  switch (mode ?? DEFAULT_PERMISSION_MODE) {
    case "auto":
      return false;
    case "ask":
      return true;
    case "balanced":
      return risk === "high";
  }
}

const READ_VERBS = new Set([
  "GET", "LIST", "FETCH", "SEARCH", "FIND", "READ", "RETRIEVE", "VIEW", "DESCRIBE", "LOOKUP", "COUNT", "SHOW", "QUERY", "CHECK", "EXPORT",
]);

/** Any of these in a slug means the call changes something. */
const MUTATING = new Set([
  "SEND", "CREATE", "DELETE", "REMOVE", "UPDATE", "MODIFY", "EDIT", "PATCH", "PUT", "ADD", "INSERT", "UPSERT", "REPLACE",
  "MOVE", "ARCHIVE", "TRASH", "REPLY", "FORWARD", "INVITE", "PUBLISH", "SUBMIT", "PURCHASE", "BUY", "PAY", "CANCEL",
  "APPROVE", "ACCEPT", "DECLINE", "MERGE", "EXECUTE", "RUN", "TRIGGER", "UPLOAD", "WRITE", "ENABLE", "DISABLE", "REVOKE",
  "SHARE", "POST", "BOOK", "RESERVE", "CONFIRM", "MARK", "STAR", "LABEL", "COMMENT", "DRAFT", "SET", "CLEAR", "RENAME",
]);

/**
 * Words that put an action in front of other people, spend money, or can't be taken back.
 * Composio's hints don't separate these from harmless creates (GMAIL_SEND_EMAIL and
 * GMAIL_CREATE_LABEL carry the same tags), so the slug decides.
 */
const HIGH = new Set([
  "SEND", "REPLY", "FORWARD", "POST", "PUBLISH", "INVITE", "SHARE", "MESSAGE", "TWEET", "SMS", "CALL", "COMMENT", "REACT",
  "PAY", "PAYMENT", "PURCHASE", "BUY", "ORDER", "CHECKOUT", "TRANSFER", "CHARGE", "REFUND", "INVOICE", "SUBSCRIBE",
  "DELETE", "REMOVE", "TRASH", "DESTROY", "PURGE", "EMPTY", "CANCEL", "REVOKE", "BAN", "KICK", "BLOCK",
  "MERGE", "DEPLOY", "RELEASE", "EXECUTE", "RUN", "TRIGGER", "DISPATCH",
  "BOOK", "RESERVE", "SUBMIT", "APPROVE", "ACCEPT", "DECLINE", "RSVP", "SIGN",
  // Who can see or touch something.
  "SHARING", "PUBLIC", "VISIBILITY", "ACL", "ACCESS", "PERMISSION", "COLLABORATOR", "MEMBER", "MEMBERSHIP", "ROLE",
  "SECRET", "PASSWORD", "COMMIT", "DEPLOYMENT",
]);

/**
 * Team and social spaces: every change there is seen by other people, so no write is "small".
 * Personal tools (Gmail, Calendar, Drive, Todoist, Notion...) are judged action by action.
 */
const SHARED_SPACES = new Set([
  "SLACK", "DISCORD", "MICROSOFT", "MSTEAMS", "TEAMS", "GITHUB", "GITLAB", "BITBUCKET", "LINEAR", "JIRA", "ASANA",
  "CLICKUP", "TRELLO", "CONFLUENCE", "FIGMA", "TWITTER", "LINKEDIN", "REDDIT", "FACEBOOK", "INSTAGRAM", "YOUTUBE",
  "TIKTOK", "THREADS", "MASTODON", "BLUESKY", "TELEGRAM", "WHATSAPP", "TWILIO", "MAILCHIMP", "SENDGRID", "INTERCOM",
  "ZENDESK", "HUBSPOT", "SALESFORCE", "WORDPRESS", "SHOPIFY", "STRIPE",
]);

/** Argument names that mean someone else will get something. */
const RECIPIENT_KEYS = /^(to|cc|bcc|recipient|recipients|recipient_email|attendees|invitees|guests|participants|phone|phone_number|to_number|emails?)$/i;

function tokens(slug: string) {
  // TOOLKIT_VERB_NOUN: drop the toolkit and allow plural verbs (SLACK_SENDS_A_MESSAGE).
  return slug
    .trim()
    .toUpperCase()
    .split("_")
    .slice(1)
    .flatMap((t) => (t.length > 3 && t.endsWith("S") ? [t, t.slice(0, -1)] : [t]));
}

function hasRecipients(args: Record<string, unknown> | undefined) {
  if (!args) return false;
  return Object.entries(args).some(([k, v]) => {
    if (!RECIPIENT_KEYS.test(k)) return false;
    if (Array.isArray(v)) return v.length > 0;
    return v !== null && v !== undefined && String(v).trim() !== "";
  });
}

/**
 * Risk of one Composio action, from Composio's tool hints (free metadata on every tool:
 * readOnlyHint, createHint, updateHint, destructiveHint) plus the slug and the arguments.
 * `reviewedReads` are slugs a person checked by hand (COMPOSIO_READ_ONLY_TOOLS).
 */
export function classifyComposio(
  slug: string,
  opts: { tags?: string[] | null; args?: Record<string, unknown>; reviewedReads?: string[] } = {},
): Risk {
  const s = slug.trim().toUpperCase();
  if (opts.reviewedReads?.some((r) => r.trim().toUpperCase() === s)) return "read";
  // Composio's meta tools (remote workbench, bash, multi-execute) can do anything.
  if (s.startsWith("COMPOSIO_")) return "high";

  const tags = new Set(opts.tags ?? []);
  const t = tokens(s);

  if (tags.has("destructiveHint")) return "high";
  if (tags.has("readOnlyHint")) return "read";
  // Without a write hint, a read verb and no mutating word is a read (SLACK_FETCH_MESSAGE).
  const writeHint = tags.has("createHint") || tags.has("updateHint");
  if (!writeHint && t.some((x) => READ_VERBS.has(x)) && !t.some((x) => MUTATING.has(x))) return "read";

  // A draft stays with the user until it's sent, whoever it's addressed to.
  const draftOnly = t.includes("DRAFT") && !t.includes("SEND");
  if (t.some((x) => HIGH.has(x))) return "high";
  if (SHARED_SPACES.has(s.split("_")[0]!)) return "high";
  if (!draftOnly && hasRecipients(opts.args)) return "high";
  return "low";
}

/**
 * Browser tasks: one that only looks something up is a read, signed in or not (the user asked
 * for it, and nothing changes). Anything that submits, sends, buys, books or edits is high.
 */
export function classifyBrowser(readOnly: boolean): Risk {
  return readOnly ? "read" : "high";
}

/**
 * What "Always allow" covers: reading one site in the browser, or one app action by slug.
 * High-risk actions (sending, paying, deleting...) can't be granted; they ask every time.
 */
export type Grant = { kind: "browser" | "app"; key: string };

/** "https://www.Canvas.wisc.edu/courses" -> "canvas.wisc.edu"; null if it isn't a hostname. */
export function siteKey(site: string | undefined | null): string | null {
  const host = String(site ?? "")
    .trim()
    .toLowerCase()
    .replace(/^[a-z]+:\/\//, "")
    .replace(/^www\./, "")
    .split(/[/?#:]/)[0]!;
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** Display names for toolkit slugs, so a grant reads "Google Calendar: list events", not "Googlecalendar: …". */
const APP_NAMES: Record<string, string> = {
  gmail: "Gmail",
  googlecalendar: "Google Calendar",
  googledrive: "Google Drive",
  googledocs: "Google Docs",
  googlesheets: "Google Sheets",
  googletasks: "Google Tasks",
  slack: "Slack",
  notion: "Notion",
  todoist: "Todoist",
  github: "GitHub",
  linear: "Linear",
  hubspot: "HubSpot",
  airtable: "Airtable",
  outlook: "Outlook",
  onedrive: "OneDrive",
};

/** "GOOGLECALENDAR_EVENTS_LIST" -> "Google Calendar: events list". */
export function actionLabel(toolSlug: string): string {
  const [app = "", ...rest] = toolSlug.trim().toLowerCase().split("_");
  const name = APP_NAMES[app] ?? (app ? app[0]!.toUpperCase() + app.slice(1) : "App");
  return rest.length ? `${name}: ${rest.join(" ")}` : name;
}

export function grantFor(
  channel: "browser" | "composio",
  risk: Risk,
  target: { site?: string | null; toolSlug?: string | null },
): (Grant & { label: string }) | null {
  if (risk === "high") return null;
  if (channel === "browser") {
    const key = siteKey(target.site);
    return key ? { kind: "browser", key, label: `Reading ${key}` } : null;
  }
  const key = String(target.toolSlug ?? "").trim().toUpperCase();
  if (!key) return null;
  return { kind: "app", key, label: actionLabel(key) };
}

export function isGranted(grants: Grant[] | undefined | null, g: Grant | null): boolean {
  return !!g && !!grants?.some((x) => x.kind === g.kind && x.key === g.key);
}

/** Copy shared by the web and iOS settings, so both describe the modes the same way. */
export const PERMISSION_MODES: { id: PermissionMode; title: string; summary: string }[] = [
  {
    id: "ask",
    title: "Ask every time",
    summary: "wali asks before it does anything in your apps or on the web, even reading.",
  },
  {
    id: "balanced",
    title: "Ask for what matters",
    summary:
      "Reading and small private changes happen on their own. Anything that reaches other people, spends money or deletes waits for you.",
  },
  {
    id: "auto",
    title: "Don't ask",
    summary: "wali acts on its own and tells you what it did.",
  },
];
