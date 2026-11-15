import { test } from "node:test";
import assert from "node:assert/strict";
import { parseLevels, processWords, type ScribeWord } from "../convex/lib/transcript.ts";

/** Build a Scribe-like word list: [speaker, start, end, text] with spacing tokens between. */
function words(spec: [string, number, number, string][]): ScribeWord[] {
  const out: ScribeWord[] = [];
  spec.forEach(([spk, start, end, text], i) => {
    if (i > 0)
      out.push({ text: " ", type: "spacing", start: spec[i - 1][2], end: start, speaker_id: spk });
    out.push({ text, type: "word", start, end, speaker_id: spk });
  });
  return out;
}

test("speakers numbered by first appearance, runs split on speaker change", () => {
  const w = words([
    ["speaker_1", 0.0, 0.5, "hi"],
    ["speaker_1", 0.6, 1.4, "there"],
    ["speaker_1", 1.5, 2.2, "friend."],
    ["speaker_0", 3.0, 3.8, "Hello"],
    ["speaker_0", 3.9, 4.9, "back."],
    ["speaker_1", 5.0, 5.5, "Yes."],
  ]);
  const r = processWords(w);
  assert.deepEqual(
    r.utterances.map((u) => [u.speakerLabel, u.speakerRaw, u.text]),
    [
      ["Speaker 1", "speaker_1", "hi there friend."],
      ["Speaker 2", "speaker_0", "Hello back."],
      ["Speaker 1", "speaker_1", "Yes."],
    ],
  );
  assert.deepEqual(
    r.speakers.map((s) => [s.label, s.seconds]),
    [
      ["Speaker 1", 2.5],
      ["Speaker 2", 1.8],
    ],
  );
});

test("long pause splits an utterance of the same speaker", () => {
  const w = words([
    ["speaker_0", 0, 1, "before"],
    ["speaker_0", 4, 5, "after"],
  ]);
  assert.deepEqual(
    processWords(w).utterances.map((u) => u.text),
    ["before", "after"],
  );
});

test("audio events and words without timing are skipped", () => {
  const w: ScribeWord[] = [
    { text: "(laughter)", type: "audio_event", start: 0, end: 1, speaker_id: "speaker_0" },
    { text: "ok", type: "word", start: 1, end: 1.5, speaker_id: "speaker_0" },
    { text: "ghost", type: "word", start: null, end: null, speaker_id: "speaker_0" },
  ];
  assert.deepEqual(
    processWords(w).utterances.map((u) => u.text),
    ["ok"],
  );
});

test("no words -> no utterances", () => {
  const r = processWords([]);
  assert.equal(r.utterances.length, 0);
  assert.equal(r.speakers.length, 0);
});

test("parseLevels reads uint16 LE", () => {
  const b = new Uint8Array([0x39, 0x02, 0xff, 0x7f]).buffer;
  assert.deepEqual([...parseLevels(b)], [569, 32767]);
});
