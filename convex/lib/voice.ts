// Pure voice-identification helpers: WAV parsing, clean-clip selection, vector math, matching.
// No Convex imports so they can be unit-tested with plain node.

/** Embedding model: WeSpeaker ResNet34 trained on VoxCeleb (256-dim, 16 kHz). */
export const EMBEDDING_DIM = 256;
export const SAMPLE_RATE = 16_000;

/** A speaker needs this much clean (non-overlapping) speech for a usable voiceprint. */
export const MIN_CLEAN_SEC = 4;
/** Longest clip we embed per speaker per recording. */
export const MAX_CLIP_SEC = 30;
/** Trim this much off each edge of a turn (word timing is approximate; edges bleed). */
export const EDGE_TRIM_SEC = 0.15;

/**
 * Cosine similarity at/above which a speaker is auto-assigned to a known voice. Calibrated on 107
 * real pendant voiceprints (2026-11-14): at 0.70 the wearer's voice absorbed samples as far as 0.78
 * from its centroid; at 0.75 its loosest member is 0.86, with no fragmentation (4 voices); 0.80
 * starts splitting people. Different people in one conversation scored median 0.74 vs each other.
 */
export const MATCH_THRESHOLD = 0.75;
/**
 * When the runner-up voice is NAMED as a different person, the best must beat it by this much or
 * the speaker is left unassigned (a wrong name is worse than "Speaker 2"). Not applied between
 * unnamed voices: there it only fragments one person into many voices.
 */
export const MATCH_MARGIN = 0.03;
/** Below MATCH but at/above this: a new voice is created and flagged as "maybe the same as X". */
export const MAYBE_THRESHOLD = 0.65;
/** If the two halves of one speaker's clip disagree this much, Scribe probably merged two people. */
export const SPLIT_CHECK_MIN_SEC = 12;
export const SPLIT_THRESHOLD = 0.45;
/** Cap on how many samples weigh into a centroid, so it keeps adapting (new mic position, a cold). */
export const CENTROID_MAX_WEIGHT = 50;

export type Pcm = { sampleRate: number; samples: Float32Array };

/** Parse a RIFF/WAVE file with 16-bit PCM (any channel count; channels are averaged). */
export function parseWav(buf: ArrayBuffer): Pcm {
  const view = new DataView(buf);
  const tag = (o: number) => String.fromCharCode(...new Uint8Array(buf, o, 4));
  if (buf.byteLength < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") throw new Error("not a WAV file");
  let off = 12;
  let channels = 1;
  let sampleRate = SAMPLE_RATE;
  let bits = 16;
  let format = 1;
  while (off + 8 <= buf.byteLength) {
    const id = tag(off);
    const size = view.getUint32(off + 4, true);
    const body = off + 8;
    if (id === "fmt ") {
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      sampleRate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
    } else if (id === "data") {
      if (format !== 1 && format !== 0xfffe) throw new Error(`unsupported WAV format ${format}`);
      if (bits !== 16) throw new Error(`unsupported WAV bit depth ${bits}`);
      const len = Math.min(size, buf.byteLength - body);
      const frames = Math.floor(len / (2 * channels));
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let acc = 0;
        for (let c = 0; c < channels; c++) acc += view.getInt16(body + (i * channels + c) * 2, true);
        out[i] = acc / channels / 32768;
      }
      return { sampleRate, samples: out };
    }
    off = body + size + (size & 1);
  }
  throw new Error("WAV has no data chunk");
}

/** 16-bit mono WAV for a clip (used for the "play this voice" button). */
export function encodeWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((ch, i) => v.setUint8(o + i, ch.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + samples.length * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    v.setInt16(44 + i * 2, Math.round(s * 32767), true);
  }
  return buf;
}

export type Turn = { speakerRaw: string; startSec: number; endSec: number };
export type Span = { start: number; end: number };

/**
 * Each speaker's clean speech: their turns, edge-trimmed, minus any time another speaker's turn
 * overlaps. Longest spans first, capped at MAX_CLIP_SEC.
 */
export function cleanSpans(turns: Turn[], durationSec: number): Map<string, Span[]> {
  const bySpeaker = new Map<string, Span[]>();
  for (const t of turns) {
    const others = turns.filter((o) => o.speakerRaw !== t.speakerRaw && o.endSec > t.startSec && o.startSec < t.endSec);
    let pieces: Span[] = [
      { start: Math.max(0, t.startSec + EDGE_TRIM_SEC), end: Math.min(durationSec, t.endSec - EDGE_TRIM_SEC) },
    ];
    for (const o of others) {
      const next: Span[] = [];
      for (const p of pieces) {
        const cutA = o.startSec - EDGE_TRIM_SEC;
        const cutB = o.endSec + EDGE_TRIM_SEC;
        if (cutB <= p.start || cutA >= p.end) next.push(p);
        else {
          if (cutA > p.start) next.push({ start: p.start, end: cutA });
          if (cutB < p.end) next.push({ start: cutB, end: p.end });
        }
      }
      pieces = next;
    }
    const list = bySpeaker.get(t.speakerRaw) ?? [];
    for (const p of pieces) if (p.end - p.start >= 0.5) list.push(p);
    bySpeaker.set(t.speakerRaw, list);
  }
  for (const [spk, spans] of bySpeaker) {
    spans.sort((a, b) => b.end - b.start - (a.end - a.start));
    const kept: Span[] = [];
    let total = 0;
    for (const s of spans) {
      if (total >= MAX_CLIP_SEC) break;
      const take = Math.min(s.end - s.start, MAX_CLIP_SEC - total);
      kept.push({ start: s.start, end: s.start + take });
      total += take;
    }
    kept.sort((a, b) => a.start - b.start);
    bySpeaker.set(spk, kept);
  }
  return bySpeaker;
}

export function spanSeconds(spans: Span[]) {
  return spans.reduce((a, s) => a + (s.end - s.start), 0);
}

/** Concatenate spans of a PCM signal. */
export function cut(pcm: Pcm, spans: Span[]): Float32Array {
  const parts = spans.map((s) =>
    pcm.samples.subarray(Math.floor(s.start * pcm.sampleRate), Math.floor(s.end * pcm.sampleRate)),
  );
  const out = new Float32Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** RMS level in dBFS (silence floors at -120). */
export function rmsDb(x: Float32Array): number {
  if (!x.length) return -120;
  let acc = 0;
  for (let i = 0; i < x.length; i++) acc += x[i] * x[i];
  const rms = Math.sqrt(acc / x.length);
  return rms > 0 ? Math.max(-120, 20 * Math.log10(rms)) : -120;
}

export function normalize(v: ArrayLike<number>): number[] {
  let n = 0;
  for (let i = 0; i < v.length; i++) n += v[i] * v[i];
  n = Math.sqrt(n) || 1;
  return Array.from(v, (x) => x / n);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let d = 0;
  let x = 0;
  let y = 0;
  for (let i = 0; i < a.length; i++) {
    d += a[i] * b[i];
    x += a[i] * a[i];
    y += b[i] * b[i];
  }
  return d / (Math.sqrt(x * y) || 1);
}

/** Unit-length mean of embeddings (a voice's centroid, recomputed from its samples). */
export function meanUnit(vs: number[][]): number[] {
  const d = vs[0]?.length ?? 0;
  const acc = new Array<number>(d).fill(0);
  for (const e of vs) for (let i = 0; i < d; i++) acc[i] += e[i];
  return normalize(acc);
}

/** Running mean of unit vectors, re-normalized. `weight` is how many samples the old centroid holds. */
export function updateCentroid(centroid: number[], weight: number, sample: number[]): number[] {
  const w = Math.min(weight, CENTROID_MAX_WEIGHT);
  return normalize(centroid.map((c, i) => c * w + sample[i]));
}

export type Candidate = { speakerRaw: string; voiceId: string; score: number };

/**
 * One-to-one assignment of a recording's speakers to known voices: best scores first, each voice
 * used at most once per recording (two people in a room are never the same voice). If the best
 * voice doesn't beat a `conflicting` one (named as a different person) by `margin`, the speaker is
 * ambiguous and left unassigned.
 */
export function assignExclusive(
  cands: Candidate[],
  threshold: number,
  margin = 0,
  conflicting: (a: string, b: string) => boolean = () => false,
): Map<string, Candidate> {
  const bySpeaker = new Map<string, Candidate[]>();
  for (const c of cands) {
    const list = bySpeaker.get(c.speakerRaw) ?? [];
    list.push(c);
    bySpeaker.set(c.speakerRaw, list);
  }
  const ambiguous = new Set<string>();
  for (const [spk, list] of bySpeaker) {
    list.sort((a, b) => b.score - a.score);
    const top = list[0];
    const rival = list.find((c) => c.voiceId !== top.voiceId && conflicting(c.voiceId, top.voiceId));
    if (top.score >= threshold && rival && rival.score > top.score - margin) ambiguous.add(spk);
  }
  const out = new Map<string, Candidate>();
  const usedVoices = new Set<string>();
  for (const c of [...cands].sort((a, b) => b.score - a.score)) {
    if (c.score < threshold) break;
    if (ambiguous.has(c.speakerRaw) || out.has(c.speakerRaw) || usedVoices.has(c.voiceId)) continue;
    out.set(c.speakerRaw, c);
    usedVoices.add(c.voiceId);
  }
  return out;
}

export type StoredSample = {
  id: string;
  recordingId: string;
  speakerRaw: string;
  at: number;
  embedding: number[];
  mixed?: boolean;
};

/**
 * Re-cluster stored voiceprints from scratch with the live matching rules (chronological, one voice
 * per speaker per recording). Nothing is named yet in a recluster, so no margin applies.
 */
export function clusterOnline(samples: StoredSample[], threshold = MATCH_THRESHOLD) {
  const clusters: { centroid: number[]; members: StoredSample[] }[] = [];
  const byRec = new Map<string, StoredSample[]>();
  for (const s of [...samples].sort((a, b) => a.at - b.at)) {
    if (s.mixed) continue;
    const list = byRec.get(s.recordingId) ?? [];
    list.push(s);
    byRec.set(s.recordingId, list);
  }
  for (const recSamples of byRec.values()) {
    const cands: Candidate[] = [];
    for (const s of recSamples)
      clusters.forEach((c, i) => cands.push({ speakerRaw: s.speakerRaw, voiceId: String(i), score: cosine(s.embedding, c.centroid) }));
    const assigned = assignExclusive(cands, threshold);
    for (const s of recSamples) {
      const m = assigned.get(s.speakerRaw);
      if (m) {
        const c = clusters[Number(m.voiceId)];
        c.members.push(s);
        c.centroid = meanUnit(c.members.slice(-CENTROID_MAX_WEIGHT).map((x) => x.embedding));
      } else {
        clusters.push({ centroid: s.embedding, members: [s] });
      }
    }
  }
  return clusters;
}

export type VoiceStats = {
  voiceId: string;
  /** Recordings this voice appears in. */
  recordings: number;
  /** Recordings where 2+ voiceprinted speakers were present. */
  multi: number;
  /** Of `multi`, how many it was the loudest in. */
  loudest: number;
};

/**
 * Which voice is the wearer? The pendant sits on their chest, so they are in nearly every
 * conversation and are usually the loudest. Returns a voice id only when the evidence is clear.
 */
export function guessWearer(stats: VoiceStats[], totalRecordings: number): string | null {
  if (totalRecordings < 5 || !stats.length) return null;
  const sorted = [...stats].sort((a, b) => b.recordings - a.recordings);
  const best = sorted[0];
  const second = sorted[1];
  if (best.recordings / totalRecordings < 0.5) return null;
  if (second && second.recordings > best.recordings * 0.6) return null;
  if (best.multi >= 2 && best.loudest / best.multi < 0.6) return null;
  return best.voiceId;
}
