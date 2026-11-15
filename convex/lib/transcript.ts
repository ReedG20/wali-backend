// Pure transcript processing: Scribe words -> utterances with neutral speaker labels.
// No Convex imports so it can be unit-tested with plain node.

export type ScribeWord = {
  text: string;
  type: "word" | "spacing" | "audio_event";
  start?: number | null;
  end?: number | null;
  speaker_id?: string | null;
};

export type Utterance = {
  startSec: number;
  endSec: number;
  speakerRaw: string;
  speakerLabel: string;
  text: string;
};

export type SpeakerStat = {
  speakerRaw: string;
  label: string;
  seconds: number;
};

/** A pause longer than this between two words of the same speaker starts a new utterance. */
export const PAUSE_SPLIT_SEC = 2.0;

/** Parse the `levels` bytes (uint16 LE per 20 ms slot). */
export function parseLevels(buf: ArrayBuffer): Uint16Array {
  const view = new DataView(buf);
  const n = Math.floor(buf.byteLength / 2);
  const out = new Uint16Array(n);
  for (let i = 0; i < n; i++) out[i] = view.getUint16(i * 2, true);
  return out;
}

export type Processed = {
  utterances: Utterance[];
  speakers: SpeakerStat[];
};

export function processWords(words: ScribeWord[]): Processed {
  // 1. Per-speaker word seconds, in order of first appearance.
  const seconds = new Map<string, number>();
  for (const w of words) {
    if (w.type !== "word" || w.start == null || w.end == null) continue;
    const spk = w.speaker_id ?? "unknown";
    seconds.set(spk, (seconds.get(spk) ?? 0) + Math.max(0, w.end - w.start));
  }

  // 2. Neutral labels: "Speaker 1", "Speaker 2", ... in order of appearance. Who the user is
  //    gets decided later (LLM layer / voice enrollment), not from loudness.
  const labels = new Map<string, string>();
  let n = 1;
  for (const spk of seconds.keys()) labels.set(spk, `Speaker ${n++}`);

  const speakers: SpeakerStat[] = [...seconds.entries()].map(([spk, sec]) => ({
    speakerRaw: spk,
    label: labels.get(spk)!,
    seconds: round(sec, 2),
  }));

  // 3. Utterances: runs of the same speaker, split on long pauses.
  const utterances: Utterance[] = [];
  let cur: Utterance | null = null;
  let pendingSpace = "";
  const flush = () => {
    if (cur) {
      cur.text = cur.text.trim();
      if (cur.text) utterances.push(cur);
    }
    cur = null;
    pendingSpace = "";
  };
  for (const w of words) {
    if (w.type === "spacing") {
      if (cur) pendingSpace += w.text;
      continue;
    }
    if (w.type !== "word" || w.start == null || w.end == null) continue;
    const spk = w.speaker_id ?? "unknown";
    const c = cur as Utterance | null;
    if (!c || c.speakerRaw !== spk || w.start - c.endSec > PAUSE_SPLIT_SEC) {
      flush();
      cur = {
        startSec: w.start,
        endSec: w.end,
        speakerRaw: spk,
        speakerLabel: labels.get(spk) ?? spk,
        text: w.text,
      };
    } else {
      c.text += (pendingSpace || " ") + w.text;
      c.endSec = Math.max(c.endSec, w.end);
      pendingSpace = "";
    }
  }
  flush();

  return { utterances, speakers };
}

function round(x: number, d: number) {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}
