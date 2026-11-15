import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyBrowser, classifyComposio, grantFor, isGranted, needsApproval, siteKey } from "../convex/lib/permissions.ts";

// Tags below are copied from Composio's live tools API (2026-11-14).
const c = (slug: string, tags: string[] | null, args?: Record<string, unknown>) => classifyComposio(slug, { tags, args });

test("reads run on their own", () => {
  assert.equal(c("GMAIL_FETCH_EMAILS", ["important", "openWorldHint", "readOnlyHint"]), "read");
  assert.equal(c("GOOGLECALENDAR_EVENTS_LIST", ["readOnlyHint", "openWorldHint"]), "read");
  // No hints at all: the verb decides, even when the noun is MESSAGE.
  assert.equal(c("SLACK_FETCH_MESSAGE_HISTORY", null), "read");
  assert.equal(c("NOTION_SEARCH_PAGES", []), "read");
});

test("anything that reaches people, deletes or spends is high", () => {
  assert.equal(c("GMAIL_SEND_EMAIL", ["important", "openWorldHint"]), "high");
  assert.equal(c("GMAIL_REPLY_TO_THREAD", ["important", "openWorldHint"]), "high");
  assert.equal(c("GMAIL_MOVE_TO_TRASH", ["destructiveHint", "important", "openWorldHint"]), "high");
  assert.equal(c("GMAIL_REMOVE_LABEL", ["destructiveHint", "openWorldHint"]), "high");
  assert.equal(c("SLACK_SENDS_A_MESSAGE_TO_A_SLACK_CHANNEL", ["openWorldHint"]), "high");
  assert.equal(c("STRIPE_CREATE_PAYMENT_INTENT", ["openWorldHint"]), "high");
  assert.equal(c("COMPOSIO_REMOTE_WORKBENCH", null), "high");
});

test("small private changes are low", () => {
  assert.equal(c("GMAIL_CREATE_LABEL", ["openWorldHint"]), "low");
  assert.equal(c("GMAIL_ADD_LABEL_TO_EMAIL", ["idempotentHint", "openWorldHint"]), "low");
  assert.equal(c("TODOIST_CREATE_TASK", ["openWorldHint"]), "low");
  // A draft addressed to someone still isn't sent.
  assert.equal(c("GMAIL_CREATE_EMAIL_DRAFT", ["important", "openWorldHint"], { recipient_email: "sam@example.com" }), "low");
});

test("a calendar event is high only when it invites someone", () => {
  const tags = ["idempotentHint", "openWorldHint", "updateHint"];
  assert.equal(c("GOOGLECALENDAR_CREATE_EVENT", tags, { summary: "Focus" }), "low");
  assert.equal(c("GOOGLECALENDAR_CREATE_EVENT", tags, { summary: "Sync", attendees: ["sam@example.com"] }), "high");
  assert.equal(c("GOOGLECALENDAR_CREATE_EVENT", tags, { summary: "Sync", attendees: [] }), "low");
});

test("reviewed slugs count as reads", () => {
  assert.equal(classifyComposio("ACME_DO_THING", { reviewedReads: ["acme_do_thing"] }), "read");
});

test("each mode gates the right risks", () => {
  for (const r of ["read", "low", "high"] as const) {
    assert.equal(needsApproval("ask", r), true);
    assert.equal(needsApproval("auto", r), false);
  }
  assert.equal(needsApproval("balanced", "read"), false);
  assert.equal(needsApproval("balanced", "low"), false);
  assert.equal(needsApproval("balanced", "high"), true);
  assert.equal(needsApproval(undefined, "high"), true, "defaults to balanced");
});

test("browser tasks", () => {
  assert.equal(classifyBrowser(true), "read", "a lookup is a read, signed in or not");
  assert.equal(classifyBrowser(false), "high", "anything that changes something asks");
});

test("always allow", () => {
  assert.equal(siteKey("https://www.Canvas.wisc.edu/courses/1?x=1"), "canvas.wisc.edu");
  assert.equal(siteKey("canvas"), null);
  assert.equal(siteKey(undefined), null);

  const site = grantFor("browser", "read", { site: "canvas.wisc.edu" });
  assert.deepEqual(site, { kind: "browser", key: "canvas.wisc.edu", label: "Reading canvas.wisc.edu" });
  assert.equal(grantFor("browser", "high", { site: "canvas.wisc.edu" }), null, "changes can't be granted");
  assert.equal(grantFor("composio", "high", { toolSlug: "GMAIL_SEND_EMAIL" }), null);
  assert.equal(grantFor("composio", "read", { toolSlug: "gmail_fetch_emails" })?.key, "GMAIL_FETCH_EMAILS");

  const grants = [{ kind: "browser" as const, key: "canvas.wisc.edu" }];
  assert.equal(isGranted(grants, site), true);
  assert.equal(isGranted(grants, grantFor("browser", "read", { site: "bank.com" })), false);
  assert.equal(isGranted(undefined, site), false);

  assert.equal(needsApproval("ask", "read", true), false, "a grant lets a read through in ask mode");
  assert.equal(needsApproval("ask", "read", false), true);
  assert.equal(needsApproval("ask", "high", true), true, "a grant never covers high");
});

test("app grant labels use the app's real name", async () => {
  const { actionLabel } = await import("../convex/lib/permissions.ts");
  assert.equal(actionLabel("GOOGLECALENDAR_EVENTS_LIST"), "Google Calendar: events list");
  assert.equal(actionLabel("GMAIL_FETCH_EMAILS"), "Gmail: fetch emails");
  assert.equal(actionLabel("ZOHO_GET_RECORDS"), "Zoho: get records");
});
