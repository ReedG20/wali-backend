import { test } from "node:test";
import assert from "node:assert/strict";
import { policy, type GateScores } from "../convex/lib/gatePolicy.ts";

const free = { quiet: false, overHourCap: false, overDayCap: false, coolingDown: false };
// The midterm moment from 2026-11-14 10:14 PM, with canHelp high.
const midterm: GateScores = { worthActing: 0.45, userAsked: 0.63, canHelp: 0.8, distress: 0.17, badTime: 0.76, urgency: 1.44, kind: "none" };

test("quiet hours deliver silently instead of holding", () => {
  const v = policy(midterm, { ...free, quiet: true });
  assert.equal(v.passed, true);
  assert.equal(v.silent, true);
});

test("wali being able to help passes on its own", () => {
  const v = policy({ ...midterm, userAsked: 0.2, worthActing: 0.3, kind: "action" }, free);
  assert.equal(v.passed, true);
  assert.equal(v.reason.startsWith("wali can help"), true);
});

test("a bad time passes with a timing note for the agent", () => {
  const v = policy(midterm, free);
  assert.equal(v.passed, true);
  assert.ok(v.timing);
  assert.equal(v.silent, undefined);
});

test("chatter still holds", () => {
  const v = policy({ worthActing: 0.3, userAsked: 0.2, canHelp: 0.1, distress: 0.05, badTime: 0.7, urgency: 1, kind: "none" }, free);
  assert.equal(v.passed, false);
});

test("distress always passes and notifies", () => {
  const v = policy({ ...midterm, distress: 0.9 }, { ...free, quiet: true, overDayCap: true });
  assert.equal(v.passed, true);
  assert.equal(v.silent, undefined);
});
