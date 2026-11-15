import { test } from "node:test";
import assert from "node:assert/strict";
import { overlap, previewText, stripDateStamp } from "../convex/lib/text.ts";

test("reworded asks for the same thing overlap; different tasks on the same site don't", () => {
  const first = "Summarize your Gmail inbox";
  assert.ok(overlap(first, "Get a summary of your Gmail inbox") >= 0.3);
  assert.ok(overlap(first, "Check Gmail and summarize recent emails") >= 0.3);
  assert.ok(overlap(first, "Reply to Sam's email saying you're running late") < 0.3);
  assert.ok(overlap(first, "Check Gmail for the Canvas due date email") < 0.3);
});

test("near-duplicate notes overlap strongly; unrelated notes don't", () => {
  const a = "Reed plans to add an approval step before wali acts in apps";
  assert.ok(overlap(a, "Reed plans to add approval steps before wali acts in his apps") >= 0.6);
  assert.ok(overlap(a, "Ife wants push notifications for nudges") < 0.6);
  assert.equal(overlap("", a), 0);
});

test("date stamps come off the front of memory text only", () => {
  assert.equal(stripDateStamp("[2026-11-15] They plan to ask Ife."), "They plan to ask Ife.");
  assert.equal(stripDateStamp("[recent] [2026-11-15] Plan to ask Ife."), "Plan to ask Ife.");
  assert.equal(stripDateStamp("Meet on [2026-11-15] at noon"), "Meet on [2026-11-15] at noon");
});

test("previews join a speaker's consecutive pieces", () => {
  assert.equal(
    previewText([
      { label: "Speaker 1", text: "so I was going" },
      { label: "Speaker 1", text: "to," },
      { label: "Speaker 1", text: "uh" },
      { label: "Ife", text: "yeah" },
    ]),
    "Speaker 1: so I was going to, uh Ife: yeah",
  );
});
