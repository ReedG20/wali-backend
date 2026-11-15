/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as activity from "../activity.js";
import type * as agent_browserUse from "../agent/browserUse.js";
import type * as agent_composio from "../agent/composio.js";
import type * as agent_gate from "../agent/gate.js";
import type * as agent_memory from "../agent/memory.js";
import type * as agent_models from "../agent/models.js";
import type * as agent_prompts from "../agent/prompts.js";
import type * as agent_tools from "../agent/tools.js";
import type * as agentData from "../agentData.js";
import type * as agentNode from "../agentNode.js";
import type * as agentSchema from "../agentSchema.js";
import type * as appCatalog from "../appCatalog.js";
import type * as approvals from "../approvals.js";
import type * as crons from "../crons.js";
import type * as devices from "../devices.js";
import type * as lib_auth from "../lib/auth.js";
import type * as lib_gatePolicy from "../lib/gatePolicy.js";
import type * as lib_permissions from "../lib/permissions.js";
import type * as lib_sherpa from "../lib/sherpa.js";
import type * as lib_text from "../lib/text.js";
import type * as lib_transcript from "../lib/transcript.js";
import type * as lib_voice from "../lib/voice.js";
import type * as messages from "../messages.js";
import type * as push from "../push.js";
import type * as pushWeb from "../pushWeb.js";
import type * as recordings from "../recordings.js";
import type * as threads from "../threads.js";
import type * as transcribe from "../transcribe.js";
import type * as transcripts from "../transcripts.js";
import type * as users from "../users.js";
import type * as utterances from "../utterances.js";
import type * as voiceprint from "../voiceprint.js";
import type * as voices from "../voices.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  activity: typeof activity;
  "agent/browserUse": typeof agent_browserUse;
  "agent/composio": typeof agent_composio;
  "agent/gate": typeof agent_gate;
  "agent/memory": typeof agent_memory;
  "agent/models": typeof agent_models;
  "agent/prompts": typeof agent_prompts;
  "agent/tools": typeof agent_tools;
  agentData: typeof agentData;
  agentNode: typeof agentNode;
  agentSchema: typeof agentSchema;
  appCatalog: typeof appCatalog;
  approvals: typeof approvals;
  crons: typeof crons;
  devices: typeof devices;
  "lib/auth": typeof lib_auth;
  "lib/gatePolicy": typeof lib_gatePolicy;
  "lib/permissions": typeof lib_permissions;
  "lib/sherpa": typeof lib_sherpa;
  "lib/text": typeof lib_text;
  "lib/transcript": typeof lib_transcript;
  "lib/voice": typeof lib_voice;
  messages: typeof messages;
  push: typeof push;
  pushWeb: typeof pushWeb;
  recordings: typeof recordings;
  threads: typeof threads;
  transcribe: typeof transcribe;
  transcripts: typeof transcripts;
  users: typeof users;
  utterances: typeof utterances;
  voiceprint: typeof voiceprint;
  voices: typeof voices;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
