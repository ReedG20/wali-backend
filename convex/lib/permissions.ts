/**
 * How much wali may do without asking. Pure (no Convex or SDK imports) so tests and the agent share it.
 *
 * - "ask":      every action outside wali (any app action, any browser task) waits for the user's OK,
 *               reads included. wali's own memory (notes, follow-ups, search) never asks.
 * - "balanced": reads and small private changes (a draft, a label, a task for yourself) run on
 *               their own. Anything that reaches other people, spends money, deletes, or acts on
 *               your accounts through the browser waits for the user.
 * - "auto":     everything runs straight away.
 */
export type PermissionMode = "ask" | "balanced" | "auto";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "balanced";

/** read: changes nothing. low: a private, reversible change. high: reaches people, money, deletes. */
export type Risk = "read" | "low" | "high";

export function needsApproval(mode: PermissionMode | undefined, risk: Risk): boolean {
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

/** Browser tasks: anything signed in as the user is high; public lookups only read. */
export function classifyBrowser(usesAccount: boolean): Risk {
  return usesAccount ? "high" : "read";
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
