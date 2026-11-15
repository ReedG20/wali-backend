/** The rules around the Jev gate's scores. Pure, so it can be tested without the model. */

export type GateScores = {
  worthActing: number;
  userAsked: number;
  /** Absent on events logged before this question existed. */
  canHelp?: number;
  distress: number;
  badTime: number;
  urgency: number;
  kind: string;
};

export const THRESHOLDS = {
  distress: Number(process.env.MIND_GATE_DISTRESS ?? "0.6"),
  userAsked: Number(process.env.MIND_GATE_USER_ASKED ?? "0.6"),
  canHelp: Number(process.env.MIND_GATE_CAN_HELP ?? "0.6"),
  worthActing: Number(process.env.MIND_GATE_WORTH ?? "0.6"),
  badTime: Number(process.env.MIND_GATE_BAD_TIME ?? "0.7"),
};

/** Urgency (0-3) at or above this ignores quiet hours and bad timing. */
const URGENT = 2.5;

export type Verdict = {
  passed: boolean;
  reason: string;
  /** Post to the thread without a notification (quiet hours). */
  silent?: boolean;
  /** Timing context for the agent, which makes the final call (it can choose follow_up). */
  timing?: string;
};

/**
 * Policy on top of the scores. Distress always passes. Quiet hours and bad timing never stop wali
 * from thinking: they turn off the notification or tell the agent to consider waiting.
 */
export function policy(
  s: GateScores,
  rules: { quiet: boolean; overHourCap: boolean; overDayCap: boolean; coolingDown: boolean },
): Verdict {
  if (s.distress >= THRESHOLDS.distress) return { passed: true, reason: "Signs of distress" };
  const asked = s.userAsked >= THRESHOLDS.userAsked;
  const canHelp = (s.canHelp ?? 0) >= THRESHOLDS.canHelp;
  const worth = s.worthActing >= THRESHOLDS.worthActing;
  if (!asked && !canHelp && !worth) return { passed: false, reason: "Not worth acting on" };
  if (s.kind === "none" && !asked && !canHelp) return { passed: false, reason: "Gate chose to keep listening" };
  if (rules.overDayCap) return { passed: false, reason: "Daily nudge cap reached" };
  if (rules.overHourCap && !asked) return { passed: false, reason: "Hourly nudge cap reached" };
  if (rules.coolingDown && !asked) return { passed: false, reason: "Cooling down after a dismissal" };

  const reason = asked ? "User asked for something" : canHelp ? "wali can help with this" : "Worth acting on";
  const urgent = s.urgency >= URGENT;
  if (rules.quiet && !urgent) {
    return {
      passed: true,
      reason: `${reason} (quiet hours: no notification)`,
      silent: true,
      timing:
        "It is the user's quiet hours. Anything you post goes to their thread without a notification, and they will see it when they next open wali. Prefer follow_up for the morning if it only matters then.",
    };
  }
  if (s.badTime >= THRESHOLDS.badTime && !urgent) {
    return {
      passed: true,
      reason: `${reason} (may be a bad time)`,
      timing: "The gate thinks this may be a bad moment to interrupt. If it can wait, choose follow_up instead of a nudge.",
    };
  }
  return { passed: true, reason };
}
