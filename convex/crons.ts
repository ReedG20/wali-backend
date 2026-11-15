import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const crons = cronJobs();

// Proactive check-in when nothing else has fired (skips users gated in the last 50 min).
crons.interval("mind check-in", { minutes: 60 }, internal.agentNode.scheduledCheck, {});

// Restart voice-identification runs that died, so no transcript is left unlabeled or un-offered.
crons.interval("voices sweep", { minutes: 15 }, internal.voices.sweep, {});

// Mirror Composio's app catalog for the Connections directory.
crons.daily("app catalog", { hourUTC: 9, minuteUTC: 15 }, internal.agentNode.refreshAppCatalog, {});

export default crons;
