import { v } from "convex/values";
import { internalMutation, internalQuery, mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server";
import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import { requireUser, currentUser } from "./lib/auth";
import { CENTROID_MAX_WEIGHT, guessWearer, meanUnit, updateCentroid, type VoiceStats } from "./lib/voice";
import { previewText } from "./lib/text";

/**
 * Who said what, across conversations. voiceprint.run (Node) embeds each speaker's clean speech and
 * matches it against `voices`; this file holds the bookkeeping: applying matches, relabeling
 * utterances with people's names, the "is this you?" question, and the naming mutations the web
 * app calls. Recordings are one shared pendant stream (no owner yet), so voices and people are too.
 */

/** A "running" claim older than this is considered dead (action crashed or timed out). */
const RUN_STALE_MS = 10 * 60 * 1000;
/** A voice must recur this many times before it's worth asking the user about. */
const RECURRING_MIN = 2;
const BACKGROUND_LABEL = "Background";

// ---------------------------------------------------------------------------------------------
// Labels

async function getState(ctx: QueryCtx) {
  return ctx.db.query("voiceState").first();
}

async function ensureState(ctx: MutationCtx) {
  const s = await ctx.db.query("voiceState").first();
  if (s) return s;
  const id = await ctx.db.insert("voiceState", {});
  return (await ctx.db.get(id))!;
}

/** Recompute display labels for one recording's utterances. Returns true if any label changed. */
async function relabelRecording(ctx: MutationCtx, recordingId: Id<"recordings">): Promise<boolean> {
  const rec = await ctx.db.get(recordingId);
  if (!rec?.speakers) return false;
  const resolved = new Map<string, { label: string; voiceId?: Id<"voices">; personId?: Id<"people"> }>();
  for (const sp of rec.speakers) {
    const voice = sp.voiceId ? await ctx.db.get(sp.voiceId) : null;
    const personId = sp.personId ?? voice?.personId;
    const person = personId ? await ctx.db.get(personId) : null;
    const label = person ? person.name : voice?.ignored ? BACKGROUND_LABEL : sp.label;
    resolved.set(sp.speakerRaw, { label, voiceId: voice?._id, personId: person?._id });
  }
  const utterances = await ctx.db
    .query("utterances")
    .withIndex("by_recordingId", (q) => q.eq("recordingId", recordingId))
    .collect();
  let changed = false;
  for (const u of utterances) {
    const r = resolved.get(u.speakerRaw);
    if (!r) continue;
    if (u.speakerLabel !== r.label || u.voiceId !== r.voiceId || u.personId !== r.personId) {
      await ctx.db.patch(u._id, { speakerLabel: r.label, voiceId: r.voiceId, personId: r.personId });
      changed = true;
    }
  }
  if (changed) {
    const preview = previewText(utterances.map((u) => ({ label: resolved.get(u.speakerRaw)?.label ?? u.speakerLabel, text: u.text })));
    await ctx.db.patch(recordingId, { preview: preview || undefined });
  }
  return changed;
}

/** Relabel every recording a voice appears in, and re-send the changed ones to memory. */
async function relabelVoice(ctx: MutationCtx, voiceId: Id<"voices">) {
  const samples = await ctx.db
    .query("voiceSamples")
    .withIndex("by_voiceId", (q) => q.eq("voiceId", voiceId))
    .collect();
  const changed: Id<"recordings">[] = [];
  for (const recordingId of new Set(samples.map((s) => s.recordingId))) {
    if (await relabelRecording(ctx, recordingId)) changed.push(recordingId);
  }
  await resyncMemory(ctx, changed);
  return changed.length;
}

/** Re-send relabeled conversations to Supermemory (stable ids, so it updates rather than duplicates). */
async function resyncMemory(ctx: MutationCtx, recordingIds: Id<"recordings">[]) {
  if (recordingIds.length) await ctx.scheduler.runAfter(0, internal.voiceprint.resyncMemory, { recordingIds });
}

async function recomputeStats(ctx: MutationCtx, voiceId: Id<"voices">) {
  const voice = await ctx.db.get(voiceId);
  if (!voice) return;
  const samples = await ctx.db
    .query("voiceSamples")
    .withIndex("by_voiceId", (q) => q.eq("voiceId", voiceId))
    .collect();
  if (!samples.length) {
    await ctx.db.patch(voiceId, { recordingCount: 0, multiCount: 0, loudestCount: 0, totalSeconds: 0 });
    return;
  }
  await ctx.db.patch(voiceId, {
    // Exact centroid from the latest samples (not a running average), so a corrected or
    // re-processed sample stops pulling on it.
    centroid: meanUnit(samples.slice(-CENTROID_MAX_WEIGHT).map((s) => s.embedding)),
    sampleCount: samples.length,
    recordingCount: new Set(samples.map((s) => s.recordingId)).size,
    multiCount: samples.filter((s) => s.speakersInRecording >= 2).length,
    loudestCount: samples.filter((s) => s.loudest).length,
    totalSeconds: Math.round(samples.reduce((a, s) => a + s.seconds, 0)),
    firstHeardAt: Math.min(...samples.map((s) => s.at)),
    lastHeardAt: Math.max(...samples.map((s) => s.at)),
  });
}

/** Ask "is this you?" once the wearer's voice is clear (in most recordings, usually loudest). */
async function refreshMeSuggestion(ctx: MutationCtx) {
  const state = await ensureState(ctx);
  const me = await ctx.db
    .query("people")
    .withIndex("by_isMe", (q) => q.eq("isMe", true))
    .first();
  if (me) {
    if (state.meSuggestion) await ctx.db.patch(state._id, { meSuggestion: undefined });
    return;
  }
  const voices = (await ctx.db.query("voices").collect()).filter((v) => !v.ignored && !v.personId);
  const stats: VoiceStats[] = voices.map((v) => ({
    voiceId: v._id,
    recordings: v.recordingCount,
    multi: v.multiCount,
    loudest: v.loudestCount,
  }));
  const voiced = (
    await ctx.db
      .query("recordings")
      .withIndex("by_voiceStatus", (q) => q.eq("voiceStatus", "done"))
      .collect()
  ).filter((r) => r.speakers?.some((s) => s.voiceId)).length;
  const guess = guessWearer(stats, voiced) as Id<"voices"> | null;
  if (!guess || state.meDismissed?.includes(guess) || state.meSuggestion?.voiceId === guess) return;
  await ctx.db.patch(state._id, { meSuggestion: { voiceId: guess, at: Date.now() } });
}

async function findOrCreatePerson(ctx: MutationCtx, rawName: string): Promise<Id<"people">> {
  const name = rawName.trim().replace(/\s+/g, " ").slice(0, 60);
  if (!name) throw new Error("Name can't be empty");
  if (name.toLowerCase() === BACKGROUND_LABEL.toLowerCase()) throw new Error(`"${name}" is reserved`);
  const people = await ctx.db.query("people").collect();
  const hit = people.find((p) => p.name.toLowerCase() === name.toLowerCase());
  if (hit) return hit._id;
  return ctx.db.insert("people", { name, isMe: false, createdAt: Date.now() });
}

async function meName(ctx: MutationCtx) {
  const user = await requireUser(ctx);
  return user.name?.trim().split(/\s+/)[0] || "Me";
}

async function findOrCreateMe(ctx: MutationCtx): Promise<Id<"people">> {
  const me = await ctx.db
    .query("people")
    .withIndex("by_isMe", (q) => q.eq("isMe", true))
    .first();
  if (me) return me._id;
  const name = await meName(ctx);
  const sameName = (await ctx.db.query("people").collect()).find(
    (p) => p.name.toLowerCase() === name.toLowerCase(),
  );
  if (sameName) {
    await ctx.db.patch(sameName._id, { isMe: true });
    return sameName._id;
  }
  return ctx.db.insert("people", { name, isMe: true, createdAt: Date.now() });
}

async function assignVoice(ctx: MutationCtx, voiceId: Id<"voices">, personId: Id<"people"> | undefined) {
  const voice = await ctx.db.get(voiceId);
  if (!voice) throw new Error("Voice not found");
  await ctx.db.patch(voiceId, { personId, ignored: personId ? false : voice.ignored, nameSuggestion: undefined });
  const relabeled = await relabelVoice(ctx, voiceId);
  await refreshMeSuggestion(ctx);
  return relabeled;
}

/** Who to assign: an existing person, a (new or existing) name, or the wearer. */
const target = {
  personId: v.optional(v.id("people")),
  name: v.optional(v.string()),
  me: v.optional(v.boolean()),
};

async function resolveTarget(
  ctx: MutationCtx,
  t: { personId?: Id<"people">; name?: string; me?: boolean },
): Promise<Id<"people">> {
  if (t.me) return findOrCreateMe(ctx);
  if (t.personId) {
    if (!(await ctx.db.get(t.personId))) throw new Error("Person not found");
    return t.personId;
  }
  if (t.name) return findOrCreatePerson(ctx, t.name);
  throw new Error("Pick a person or type a name");
}

// ---------------------------------------------------------------------------------------------
// Pipeline internals (called by voiceprint.ts)

export const state = internalQuery({ args: {}, handler: async (ctx) => getState(ctx) });

/** Cache a downloaded runtime asset (native addon or model). Replaces a stale/corrupt copy. */
export const setAsset = internalMutation({
  args: { kind: v.union(v.literal("native"), v.literal("model")), storageId: v.id("_storage") },
  handler: async (ctx, { kind, storageId }) => {
    const s = await ensureState(ctx);
    const field = kind === "native" ? "nativeStorageId" : "modelStorageId";
    const old = s[field];
    if (old && old !== storageId && (await ctx.db.system.get(old))) await ctx.storage.delete(old);
    await ctx.db.patch(s._id, { [field]: storageId });
  },
});

/** Claim a recording for voice identification. Returns the attempt number, or null to skip. */
export const beginRun = internalMutation({
  args: { recordingId: v.id("recordings"), force: v.optional(v.boolean()) },
  handler: async (ctx, { recordingId, force }) => {
    const r = await ctx.db.get(recordingId);
    if (!r || r.status !== "done") return null;
    if (r.voiceStatus === "done" && !force) return null;
    if (r.voiceStatus === "running" && (r.voiceAttemptAt ?? 0) > Date.now() - RUN_STALE_MS) return null;
    const attempt = (r.voiceStatus === "done" ? 0 : (r.voiceAttempts ?? 0)) + 1;
    await ctx.db.patch(recordingId, { voiceStatus: "running", voiceAttempts: attempt, voiceAttemptAt: Date.now() });
    return attempt;
  },
});

export const endRun = internalMutation({
  args: { recordingId: v.id("recordings"), error: v.string(), final: v.boolean() },
  handler: async (ctx, { recordingId, error, final }) => {
    await ctx.db.patch(recordingId, { voiceStatus: final ? "failed" : "pending", voiceError: error.slice(0, 500) });
  },
});

/** Hand a recording to the agent exactly once. Returns true if this call claimed it. */
export const claimAgentOffer = internalMutation({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, { recordingId }) => {
    const r = await ctx.db.get(recordingId);
    if (!r || r.agentOfferedAt) return false;
    await ctx.db.patch(recordingId, { agentOfferedAt: Date.now() });
    return true;
  },
});

export const runInput = internalQuery({
  args: { recordingId: v.id("recordings") },
  handler: async (ctx, { recordingId }) => {
    const rec = await ctx.db.get(recordingId);
    if (!rec) return null;
    const utterances = await ctx.db
      .query("utterances")
      .withIndex("by_recordingId", (q) => q.eq("recordingId", recordingId))
      .collect();
    return {
      status: rec.status,
      storageId: rec.storageId,
      startedAt: rec.startedAt,
      durationMs: rec.durationMs,
      speakers: rec.speakers ?? [],
      utterances: utterances.map((u) => ({
        speakerRaw: u.speakerRaw,
        startSec: (u.startAt - rec.startedAt) / 1000,
        endSec: (u.endAt - rec.startedAt) / 1000,
        text: u.text,
      })),
    };
  },
});

const match = v.object({ voiceId: v.id("voices"), score: v.number() });

/**
 * Store a recording's voiceprints: update matched voices, create new ones, relabel utterances,
 * and revisit the "is this you?" question.
 */
export const apply = internalMutation({
  args: {
    recordingId: v.id("recordings"),
    samples: v.array(
      v.object({
        speakerRaw: v.string(),
        embedding: v.array(v.float64()),
        seconds: v.number(),
        levelDb: v.number(),
        mixed: v.boolean(),
        match: v.optional(match),
        maybe: v.optional(match),
        clipStorageId: v.optional(v.id("_storage")),
        clipSeconds: v.optional(v.number()),
        sampleText: v.optional(v.string()),
      }),
    ),
  },
  handler: async (ctx, { recordingId, samples }) => {
    const rec = await ctx.db.get(recordingId);
    if (!rec) {
      for (const s of samples) if (s.clipStorageId) await ctx.storage.delete(s.clipStorageId);
      return null;
    }
    const affected = new Set<Id<"voices">>();
    for (const old of await ctx.db
      .query("voiceSamples")
      .withIndex("by_recordingId", (q) => q.eq("recordingId", recordingId))
      .collect()) {
      if (old.voiceId) affected.add(old.voiceId);
      await ctx.db.delete(old._id);
    }

    const clean = samples.filter((s) => !s.mixed);
    const loudestRaw =
      clean.length >= 2 ? clean.reduce((a, b) => (b.levelDb > a.levelDb ? b : a)).speakerRaw : null;
    const voiceFor = new Map<string, Id<"voices">>();

    for (const s of samples) {
      let voiceId: Id<"voices"> | undefined;
      if (!s.mixed) {
        const existing = s.match ? await ctx.db.get(s.match.voiceId) : null;
        if (existing) {
          voiceId = existing._id;
          await ctx.db.patch(voiceId, {
            centroid: updateCentroid(existing.centroid, existing.sampleCount, s.embedding),
            sampleCount: existing.sampleCount + 1,
          });
        } else {
          voiceId = await ctx.db.insert("voices", {
            centroid: s.embedding,
            sampleCount: 1,
            recordingCount: 0,
            multiCount: 0,
            loudestCount: 0,
            totalSeconds: 0,
            firstHeardAt: rec.startedAt,
            lastHeardAt: rec.startedAt,
            maybeSameAs: s.maybe,
            createdAt: Date.now(),
          });
        }
        voiceFor.set(s.speakerRaw, voiceId);
        affected.add(voiceId);
      }

      // Keep the longest clip we've heard for each voice; drop the rest.
      if (s.clipStorageId) {
        const voice = voiceId ? await ctx.db.get(voiceId) : null;
        if (voice && (!voice.clipStorageId || (s.clipSeconds ?? 0) > (voice.clipSeconds ?? 0) + 0.5)) {
          if (voice.clipStorageId) await ctx.storage.delete(voice.clipStorageId);
          await ctx.db.patch(voice._id, {
            clipStorageId: s.clipStorageId,
            clipSeconds: s.clipSeconds,
            sampleText: s.sampleText,
          });
        } else {
          await ctx.storage.delete(s.clipStorageId);
        }
      }

      await ctx.db.insert("voiceSamples", {
        recordingId,
        speakerRaw: s.speakerRaw,
        voiceId,
        embedding: s.embedding,
        seconds: Math.round(s.seconds * 10) / 10,
        levelDb: Math.round(s.levelDb * 10) / 10,
        loudest: s.speakerRaw === loudestRaw,
        speakersInRecording: clean.length,
        score: s.match && voiceId === s.match.voiceId ? Math.round(s.match.score * 1000) / 1000 : undefined,
        mixed: s.mixed || undefined,
        at: rec.startedAt,
      });
    }

    for (const id of affected) await recomputeStats(ctx, id);
    await ctx.db.patch(recordingId, {
      speakers: (rec.speakers ?? []).map((sp) => ({ ...sp, voiceId: voiceFor.get(sp.speakerRaw) })),
      voiceStatus: "done",
      voiceError: undefined,
    });
    const relabeled = await relabelRecording(ctx, recordingId);
    await refreshMeSuggestion(ctx);

    // Voices in this recording that still need a name, with their per-recording labels.
    const unnamed: { voiceId: Id<"voices">; label: string }[] = [];
    for (const sp of rec.speakers ?? []) {
      const id = voiceFor.get(sp.speakerRaw);
      const voice = id ? await ctx.db.get(id) : null;
      if (voice && !voice.personId && !voice.ignored && !voice.nameSuggestion) {
        unnamed.push({ voiceId: voice._id, label: sp.label });
      }
    }
    return { relabeled, unnamed };
  },
});

export const setNameSuggestion = internalMutation({
  args: {
    voiceId: v.id("voices"),
    name: v.string(),
    evidence: v.string(),
    recordingId: v.id("recordings"),
  },
  handler: async (ctx, { voiceId, name, evidence, recordingId }) => {
    const voice = await ctx.db.get(voiceId);
    if (!voice || voice.personId || voice.ignored || voice.nameSuggestion) return false;
    if (voice.dismissedNames?.includes(name.toLowerCase())) return false;
    const me = await ctx.db
      .query("people")
      .withIndex("by_isMe", (q) => q.eq("isMe", true))
      .first();
    if (me && me.name.toLowerCase() === name.toLowerCase()) return false;
    await ctx.db.patch(voiceId, {
      nameSuggestion: { name: name.slice(0, 60), evidence: evidence.slice(0, 300), recordingId, at: Date.now() },
    });
    return true;
  },
});

/** Done recordings that haven't been through voice identification yet, oldest first. */
export const pendingBackfill = internalQuery({
  args: { limit: v.number() },
  handler: async (ctx, { limit }) => {
    const out: Id<"recordings">[] = [];
    for await (const r of ctx.db.query("recordings").withIndex("by_startedAt").order("asc")) {
      if (r.status === "done" && r.voiceStatus !== "done" && r.voiceStatus !== "failed") out.push(r._id);
      if (out.length >= limit) break;
    }
    return out;
  },
});

/** Cron: restart voice runs that died (crashed action, lost scheduler entry). */
export const sweep = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = Date.now() - RUN_STALE_MS;
    let restarted = 0;
    for (const status of ["pending", "running"] as const) {
      const rows = await ctx.db
        .query("recordings")
        .withIndex("by_voiceStatus", (q) => q.eq("voiceStatus", status))
        .take(50);
      for (const r of rows) {
        if ((r.voiceAttemptAt ?? r.transcribedAt ?? 0) > cutoff) continue;
        if (status === "running") await ctx.db.patch(r._id, { voiceStatus: "pending" });
        await ctx.scheduler.runAfter(0, internal.voiceprint.run, {
          recordingId: r._id,
          offerToAgent: !r.agentOfferedAt,
        });
        restarted++;
      }
    }
    return restarted;
  },
});

/** personId per voice (for "same person" checks while matching). */
export const personsOf = internalQuery({
  args: { voiceIds: v.array(v.id("voices")) },
  handler: async (ctx, { voiceIds }) =>
    Promise.all(voiceIds.map(async (id) => ({ voiceId: id, personId: (await ctx.db.get(id))?.personId ?? null }))),
});

export const allSamples = internalQuery({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("voiceSamples").collect()).map((s) => ({
      id: s._id,
      recordingId: s.recordingId,
      speakerRaw: s.speakerRaw,
      at: s.at,
      embedding: s.embedding,
      mixed: s.mixed,
      voiceId: s.voiceId ?? null,
    })),
});

/**
 * Replace all voices with a fresh clustering of the stored samples (voiceprint.recluster).
 * Clusters reuse the old voice most of their samples came from, keeping its clip and name.
 */
export const applyRecluster = internalMutation({
  args: {
    clusters: v.array(v.object({ reuse: v.optional(v.id("voices")), sampleIds: v.array(v.id("voiceSamples")) })),
  },
  handler: async (ctx, { clusters }) => {
    const keep = new Set<Id<"voices">>();
    const sampleVoice = new Map<Id<"voiceSamples">, Id<"voices">>();
    for (const c of clusters) {
      const first = await ctx.db.get(c.sampleIds[0]);
      if (!first) continue;
      const voiceId =
        c.reuse && (await ctx.db.get(c.reuse))
          ? c.reuse
          : await ctx.db.insert("voices", {
              centroid: first.embedding,
              sampleCount: 0,
              recordingCount: 0,
              multiCount: 0,
              loudestCount: 0,
              totalSeconds: 0,
              firstHeardAt: first.at,
              lastHeardAt: first.at,
              createdAt: Date.now(),
            });
      keep.add(voiceId);
      for (const id of c.sampleIds) sampleVoice.set(id, voiceId);
    }
    const recordings = new Set<Id<"recordings">>();
    for (const s of await ctx.db.query("voiceSamples").collect()) {
      const voiceId = sampleVoice.get(s._id);
      if (voiceId !== s.voiceId) await ctx.db.patch(s._id, { voiceId, score: undefined });
      recordings.add(s.recordingId);
    }
    for (const voice of await ctx.db.query("voices").collect()) {
      if (keep.has(voice._id)) {
        await ctx.db.patch(voice._id, { maybeSameAs: undefined });
        await recomputeStats(ctx, voice._id);
      } else if (!voice.personId) {
        if (voice.clipStorageId) await ctx.storage.delete(voice.clipStorageId);
        await ctx.db.delete(voice._id);
      }
    }
    const changed: Id<"recordings">[] = [];
    for (const recordingId of recordings) {
      const rec = await ctx.db.get(recordingId);
      if (!rec?.speakers) continue;
      const samples = await ctx.db
        .query("voiceSamples")
        .withIndex("by_recordingId", (q) => q.eq("recordingId", recordingId))
        .collect();
      const bySpeaker = new Map(samples.map((x) => [x.speakerRaw, x.voiceId]));
      await ctx.db.patch(recordingId, {
        speakers: rec.speakers.map((sp) => ({ ...sp, voiceId: bySpeaker.get(sp.speakerRaw) ?? undefined })),
      });
      if (await relabelRecording(ctx, recordingId)) changed.push(recordingId);
    }
    const state = await ensureState(ctx);
    await ctx.db.patch(state._id, { meSuggestion: undefined, meDismissed: undefined });
    await refreshMeSuggestion(ctx);
    await resyncMemory(ctx, changed);
    return { voices: keep.size, relabeled: changed.length };
  },
});

// ---------------------------------------------------------------------------------------------
// Public API (web app)

type VoiceView = {
  _id: Id<"voices">;
  recordingCount: number;
  totalSeconds: number;
  firstHeardAt: number;
  lastHeardAt: number;
  clipUrl: string | null;
  sampleText: string | null;
  nameSuggestion: { name: string; evidence: string } | null;
  maybeSameAs: { voiceId: Id<"voices">; name: string | null } | null;
};

async function view(ctx: QueryCtx, v: Doc<"voices">): Promise<VoiceView> {
  let maybeSameAs: VoiceView["maybeSameAs"] = null;
  if (v.maybeSameAs) {
    const other = await ctx.db.get(v.maybeSameAs.voiceId);
    const person = other?.personId ? await ctx.db.get(other.personId) : null;
    if (other) maybeSameAs = { voiceId: other._id, name: person?.name ?? null };
  }
  return {
    _id: v._id,
    recordingCount: v.recordingCount,
    totalSeconds: v.totalSeconds,
    firstHeardAt: v.firstHeardAt,
    lastHeardAt: v.lastHeardAt,
    clipUrl: v.clipStorageId ? await ctx.storage.getUrl(v.clipStorageId) : null,
    sampleText: v.sampleText ?? null,
    nameSuggestion: v.nameSuggestion ? { name: v.nameSuggestion.name, evidence: v.nameSuggestion.evidence } : null,
    maybeSameAs,
  };
}

/** Everything the Voices page shows. */
export const overview = query({
  args: {},
  handler: async (ctx) => {
    if (!(await currentUser(ctx))) return null;
    const state = await getState(ctx);
    const voices = await ctx.db.query("voices").withIndex("by_lastHeardAt").order("desc").take(300);
    const people = await ctx.db.query("people").collect();

    const meVoice = state?.meSuggestion ? voices.find((v) => v._id === state.meSuggestion!.voiceId) : undefined;
    const peopleViews = await Promise.all(
      people.map(async (p) => {
        const own = voices.filter((v) => v.personId === p._id);
        return {
          _id: p._id,
          name: p.name,
          isMe: p.isMe,
          recordingCount: own.reduce((a, v) => a + v.recordingCount, 0),
          lastHeardAt: own.length ? Math.max(...own.map((v) => v.lastHeardAt)) : null,
          voices: await Promise.all(own.map((v) => view(ctx, v))),
        };
      }),
    );
    peopleViews.sort((a, b) => Number(b.isMe) - Number(a.isMe) || (b.lastHeardAt ?? 0) - (a.lastHeardAt ?? 0));

    const unnamedAll = voices.filter((v) => !v.personId && !v.ignored);
    const recurring = unnamedAll
      .filter((v) => v._id !== meVoice?._id && (v.recordingCount >= RECURRING_MIN || v.nameSuggestion))
      .sort((a, b) => Number(!!b.nameSuggestion) - Number(!!a.nameSuggestion) || b.recordingCount - a.recordingCount);

    const processed = await ctx.db
      .query("recordings")
      .withIndex("by_voiceStatus", (q) => q.eq("voiceStatus", "done"))
      .collect();
    return {
      meSuggestion: meVoice && !people.some((p) => p.isMe) ? await view(ctx, meVoice) : null,
      people: peopleViews,
      unnamed: await Promise.all(recurring.slice(0, 40).map((v) => view(ctx, v))),
      oneOffCount: unnamedAll.length - recurring.length - (meVoice && !meVoice.personId ? 1 : 0),
      background: await Promise.all(voices.filter((v) => v.ignored).map((v) => view(ctx, v))),
      recordingsProcessed: processed.length,
    };
  },
});

export const people = query({
  args: {},
  handler: async (ctx) => {
    if (!(await currentUser(ctx))) return [];
    return (await ctx.db.query("people").collect()).map((p) => ({ _id: p._id, name: p.name, isMe: p.isMe }));
  },
});

/** Name a voice: an existing person, a new name, or "me". Relabels every past recording too. */
export const nameVoice = mutation({
  args: { voiceId: v.id("voices"), ...target },
  handler: async (ctx, { voiceId, ...t }) => {
    await requireUser(ctx);
    const personId = await resolveTarget(ctx, t);
    return assignVoice(ctx, voiceId, personId);
  },
});

/**
 * Name a speaker from a transcript. If that speaker has a voiceprint this names the voice
 * everywhere; otherwise (too little clean speech) it labels just this recording.
 */
export const nameSpeaker = mutation({
  args: { recordingId: v.id("recordings"), speakerRaw: v.string(), ...target },
  handler: async (ctx, { recordingId, speakerRaw, ...t }) => {
    await requireUser(ctx);
    const rec = await ctx.db.get(recordingId);
    const sp = rec?.speakers?.find((s) => s.speakerRaw === speakerRaw);
    if (!rec || !sp) throw new Error("Speaker not found");
    const personId = await resolveTarget(ctx, t);
    const voice = sp.voiceId ? await ctx.db.get(sp.voiceId) : null;
    if (voice && voice.personId && voice.personId !== personId) {
      // A correction ("that wasn't Reed, it was Mom"): this conversation's voiceprint was matched
      // to the wrong voice. Move just this sample to its own voice for the right person, rather
      // than renaming the whole voice.
      const sample = (
        await ctx.db
          .query("voiceSamples")
          .withIndex("by_recordingId", (q) => q.eq("recordingId", recordingId))
          .collect()
      ).find((x) => x.speakerRaw === speakerRaw);
      if (sample) {
        const newVoice = await ctx.db.insert("voices", {
          centroid: sample.embedding,
          sampleCount: 1,
          personId,
          recordingCount: 0,
          multiCount: 0,
          loudestCount: 0,
          totalSeconds: 0,
          firstHeardAt: sample.at,
          lastHeardAt: sample.at,
          createdAt: Date.now(),
        });
        await ctx.db.patch(sample._id, { voiceId: newVoice, score: undefined });
        await recomputeStats(ctx, voice._id);
        await recomputeStats(ctx, newVoice);
        await ctx.db.patch(recordingId, {
          speakers: rec.speakers!.map((s) => (s.speakerRaw === speakerRaw ? { ...s, voiceId: newVoice } : s)),
        });
        if (await relabelRecording(ctx, recordingId)) await resyncMemory(ctx, [recordingId]);
        await refreshMeSuggestion(ctx);
        return { scope: "corrected" as const };
      }
    }
    if (voice) {
      await assignVoice(ctx, voice._id, personId);
      return { scope: "voice" as const };
    }
    await ctx.db.patch(recordingId, {
      speakers: rec.speakers!.map((s) => (s.speakerRaw === speakerRaw ? { ...s, personId } : s)),
    });
    if (await relabelRecording(ctx, recordingId)) await resyncMemory(ctx, [recordingId]);
    return { scope: "recording" as const };
  },
});

/** Undo a name: the voice goes back to unnamed (its recordings revert to "Speaker N"). */
export const unnameVoice = mutation({
  args: { voiceId: v.id("voices") },
  handler: async (ctx, { voiceId }) => {
    await requireUser(ctx);
    return assignVoice(ctx, voiceId, undefined);
  },
});

export const dismissMe = mutation({
  args: { voiceId: v.id("voices") },
  handler: async (ctx, { voiceId }) => {
    await requireUser(ctx);
    const s = await ensureState(ctx);
    await ctx.db.patch(s._id, {
      meSuggestion: s.meSuggestion?.voiceId === voiceId ? undefined : s.meSuggestion,
      meDismissed: [...new Set([...(s.meDismissed ?? []), voiceId])],
    });
  },
});

/** Background voices (TV, podcasts, a café) are labelled "Background" and never asked about. */
export const setIgnored = mutation({
  args: { voiceId: v.id("voices"), ignored: v.boolean() },
  handler: async (ctx, { voiceId, ignored }) => {
    await requireUser(ctx);
    const voice = await ctx.db.get(voiceId);
    if (!voice) throw new Error("Voice not found");
    await ctx.db.patch(voiceId, { ignored, personId: ignored ? undefined : voice.personId, nameSuggestion: undefined });
    await relabelVoice(ctx, voiceId);
    await refreshMeSuggestion(ctx);
  },
});

export const dismissNameSuggestion = mutation({
  args: { voiceId: v.id("voices") },
  handler: async (ctx, { voiceId }) => {
    await requireUser(ctx);
    const voice = await ctx.db.get(voiceId);
    if (!voice?.nameSuggestion) return;
    await ctx.db.patch(voiceId, {
      nameSuggestion: undefined,
      dismissedNames: [...new Set([...(voice.dismissedNames ?? []), voice.nameSuggestion.name.toLowerCase()])],
    });
  },
});

export const renamePerson = mutation({
  args: { personId: v.id("people"), name: v.string() },
  handler: async (ctx, { personId, name }) => {
    await requireUser(ctx);
    const clean = name.trim().replace(/\s+/g, " ").slice(0, 60);
    if (!clean) throw new Error("Name can't be empty");
    await ctx.db.patch(personId, { name: clean });
    for (const voice of await ctx.db
      .query("voices")
      .withIndex("by_personId", (q) => q.eq("personId", personId))
      .collect()) {
      await relabelVoice(ctx, voice._id);
    }
  },
});
