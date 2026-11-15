import { test } from "node:test";
import assert from "node:assert/strict";
import { contentWords, previewText, sameWording, specifics, stripDateStamp } from "../convex/lib/text.ts";

test("the same sentence again is a repeat: only filler, plurals and punctuation may differ", () => {
  assert.equal(
    sameWording("Reed plans to add an approval step before wali acts in apps", "Reed plans to add approval steps before wali acts in his apps."),
    true,
  );
  assert.equal(sameWording("Summarize your Gmail inbox", "Summarize the Gmail inbox"), true);
  assert.equal(sameWording("", ""), false);
});

test("a correction is never a repeat", () => {
  const different: [string, string][] = [
    ["Dentist appointment on Monday at 3pm with Dr. Lee", "Dentist appointment on Friday at 3pm with Dr. Lee"],
    ["Reed owes Ife 20 dollars for lunch", "Reed owes Ife 40 dollars for lunch"],
    ["Reed owes Ife 20 dollars for lunch", "Ife owes Reed 20 dollars for lunch"],
    ["Reed is moving to Chicago from Madison", "Reed is moving to Madison from Chicago"],
    ["Ife can make the demo on the weekend", "Ife can't make the demo on the weekend"],
    ["Ife can make the demo on the weekend", "Ife can\u2019t make the demo on the weekend"],
    ["Reed plans to ship the approval step", "Ife plans to ship the approval step"],
    ["Reed prefers the blue design for the landing page", "Reed prefers the green design for the landing page"],
    ["Reed plans to attend the demo day", "Reed cancelled plans to attend the demo day"],
    ["Ife wants notifications on during class", "Ife wants notifications off during class"],
    ["Reed will pay twenty dollars for the domain", "Reed will pay forty dollars for the domain"],
    ["Finish the report before tonight's deadline", "Finish the report before tomorrow's deadline"],
    ["Reed has no meetings on the calendar", "Reed has meetings on the calendar"],
  ];
  for (const [a, b] of different) assert.equal(sameWording(a, b), false, `${a} | ${b}`);
});

test("browser asks: a different day or task is a different ask", () => {
  assert.equal(sameWording("Check Canvas for what's due today", "Check Canvas for what's due tomorrow"), false);
  assert.equal(sameWording("Check Canvas for today's assignments and report the due dates", "Check Canvas for tomorrow's assignments and report the due dates"), false);
  assert.equal(sameWording("Summarize your Gmail inbox", "Reply to Sam's email saying you're running late"), false);
  assert.equal(sameWording("Summarize your Gmail inbox", "Check Gmail and summarize recent emails"), false);
});

test("specifics pick out numbers, days, names and negation, with or without a possessive", () => {
  assert.deepEqual([...specifics("They plan to meet Sam on Friday at 3pm, not Monday.")].sort(), ["(not)", "3pm", "friday", "monday", "sam"]);
  assert.deepEqual([...specifics("before today's deadline and Sam's review")].sort(), ["sam", "today"]);
  assert.deepEqual([...specifics("Check the inbox for new mail")], []);
});

test("content words drop filler before anything else", () => {
  assert.deepEqual(contentWords("This is the plan for the steps"), ["plan", "step"]);
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
