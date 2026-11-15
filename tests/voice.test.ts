import { test } from "node:test";
import assert from "node:assert/strict";
import {
  EDGE_TRIM_SEC,
  MAX_CLIP_SEC,
  assignExclusive,
  clusterOnline,
  cleanSpans,
  cosine,
  cut,
  encodeWav,
  guessWearer,
  normalize,
  parseWav,
  spanSeconds,
  updateCentroid,
} from "../convex/lib/voice.ts";

test("WAV round-trips through encode/parse", () => {
  const samples = new Float32Array(1600).map((_, i) => Math.sin(i / 10) * 0.5);
  const pcm = parseWav(encodeWav(samples, 16000));
  assert.equal(pcm.sampleRate, 16000);
  assert.equal(pcm.samples.length, 1600);
  assert.ok(Math.abs(pcm.samples[100] - samples[100]) < 1e-3);
});

test("clean spans drop overlap with other speakers and trim edges", () => {
  const spans = cleanSpans(
    [
      { speakerRaw: "a", startSec: 0, endSec: 10 },
      { speakerRaw: "b", startSec: 4, endSec: 6 }, // talks over a
    ],
    20,
  );
  const a = spans.get("a")!;
  for (const s of a) assert.ok(s.end <= 4 - EDGE_TRIM_SEC + 1e-9 || s.start >= 6 + EDGE_TRIM_SEC - 1e-9);
  assert.ok(Math.abs(spanSeconds(a) - (10 - 2 - 4 * EDGE_TRIM_SEC)) < 1e-9);
  // b is entirely overlapped by a, so it has no clean speech
  assert.equal(spanSeconds(spans.get("b")!), 0);
});

test("clean spans cap total length", () => {
  const turns = Array.from({ length: 10 }, (_, i) => ({ speakerRaw: "a", startSec: i * 10, endSec: i * 10 + 9 }));
  assert.ok(Math.abs(spanSeconds(cleanSpans(turns, 200).get("a")!) - MAX_CLIP_SEC) < 1e-9);
});

test("cut concatenates spans", () => {
  const pcm = { sampleRate: 10, samples: new Float32Array(100).map((_, i) => i) };
  const out = cut(pcm, [
    { start: 1, end: 2 },
    { start: 5, end: 5.5 },
  ]);
  assert.deepEqual(Array.from(out), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 50, 51, 52, 53, 54]);
});

test("exclusive assignment: one voice per speaker, best score wins", () => {
  const m = assignExclusive(
    [
      { speakerRaw: "s0", voiceId: "me", score: 0.9 },
      { speakerRaw: "s1", voiceId: "me", score: 0.8 }, // also close to me, but s0 is closer
      { speakerRaw: "s1", voiceId: "mom", score: 0.75 },
      { speakerRaw: "s2", voiceId: "jake", score: 0.5 }, // below threshold
    ],
    0.7,
  );
  assert.equal(m.get("s0")?.voiceId, "me");
  assert.equal(m.get("s1")?.voiceId, "mom");
  assert.equal(m.has("s2"), false);
});

test("centroid stays unit length and moves toward new samples", () => {
  const c = normalize([1, 0, 0]);
  const next = updateCentroid(c, 1, normalize([0, 1, 0]));
  assert.ok(Math.abs(Math.hypot(...next) - 1) < 1e-9);
  assert.ok(cosine(next, [0, 1, 0]) > 0.5);
});

test("wearer guess needs presence, dominance and loudness", () => {
  const me = { voiceId: "me", recordings: 9, multi: 6, loudest: 5 };
  const mom = { voiceId: "mom", recordings: 3, multi: 3, loudest: 1 };
  assert.equal(guessWearer([me, mom], 10), "me");
  assert.equal(guessWearer([me, mom], 4), null, "too few recordings");
  assert.equal(guessWearer([{ ...me, recordings: 4 }, mom], 10), null, "not in enough recordings");
  assert.equal(guessWearer([me, { ...mom, recordings: 7 }], 10), null, "a second voice is nearly as common");
  assert.equal(guessWearer([{ ...me, loudest: 1 }, mom], 10), null, "rarely the loudest");
});

test("too close to call between two differently-named people stays unassigned", () => {
  const cands = [
    { speakerRaw: "s0", voiceId: "reed", score: 0.86 },
    { speakerRaw: "s0", voiceId: "jake", score: 0.85 },
  ];
  assert.equal(assignExclusive(cands, 0.8, 0.03, () => true).has("s0"), false);
  // unnamed (or same-person) rivals don't block the match
  assert.equal(assignExclusive(cands, 0.8, 0.03).get("s0")?.voiceId, "reed");
});

test("online clustering keeps people apart within a recording and joins them across recordings", () => {
  const a = normalize([1, 0.1, 0]);
  const b = normalize([0, 1, 0.1]);
  const jitter = (v: number[], k: number) => normalize(v.map((x, i) => x + (i === k ? 0.05 : 0)));
  const samples = [
    { id: "1", recordingId: "r1", speakerRaw: "s0", at: 1, embedding: a },
    { id: "2", recordingId: "r1", speakerRaw: "s1", at: 1, embedding: b },
    { id: "3", recordingId: "r2", speakerRaw: "s0", at: 2, embedding: jitter(b, 2) },
    { id: "4", recordingId: "r2", speakerRaw: "s1", at: 2, embedding: jitter(a, 2) },
    { id: "5", recordingId: "r3", speakerRaw: "s0", at: 3, embedding: jitter(a, 1), mixed: true },
  ];
  const clusters = clusterOnline(samples, 0.8);
  assert.equal(clusters.length, 2);
  const ids = clusters.map((c) => c.members.map((m) => m.id).sort().join(","));
  assert.deepEqual(ids.sort(), ["1,4", "2,3"]);
});
