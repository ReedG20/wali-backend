// Small pure text helpers shared by the agent's writes (approvals, notes, transcript previews).
// No Convex or Node imports, so they're unit tested directly (tests/text.test.ts).

const STOP = new Set([
  "the", "and", "for", "that", "this", "with", "you", "your", "their", "they", "them", "his", "her", "its",
  "are", "was", "has", "have", "had", "will", "from", "about", "into", "what", "any", "all", "can",
]);

/** Lowercased content words, cut to a 5-letter stem so "summary" and "summarize" count as the same word. */
export function wordSet(text: string): Set<string> {
  const out = new Set<string>();
  for (const w of text.toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/)) {
    const word = w.replace(/'s$|'/g, "");
    if (word.length < 3 || STOP.has(word)) continue;
    out.add(word.slice(0, 5));
  }
  return out;
}

/** Share of content words two texts have in common (Jaccard), 0 to 1. */
export function overlap(a: string, b: string): number {
  const x = wordSet(a);
  const y = wordSet(b);
  if (!x.size || !y.size) return 0;
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both);
}

/**
 * Memory text sometimes arrives stamped "[2026-11-15] …" or "[recent] …": the memory service
 * stamps recent items that way and search_memory results carried a date prefix the model then
 * copied into notes. The stamp is metadata, not part of the sentence.
 */
export function stripDateStamp(text: string): string {
  return text.replace(/^\s*(?:\[(?:recent|\d{4}-\d{2}-\d{2}(?:[T ][^\]]*)?)\]\s*)+/i, "").trim();
}

/**
 * Preview text for a recording: one "Name: …" per turn. Consecutive pieces from the same speaker
 * are joined, so a speaker who paused doesn't read as "Speaker 1: … Speaker 1: … Speaker 1: uh".
 */
export function previewText(utterances: { label: string; text: string }[], max = 160): string {
  const turns: { label: string; text: string }[] = [];
  for (const u of utterances) {
    const last = turns[turns.length - 1];
    if (last && last.label === u.label) last.text = `${last.text} ${u.text}`;
    else turns.push({ label: u.label, text: u.text });
  }
  return turns
    .map((t) => `${t.label}: ${t.text}`)
    .join(" ")
    .slice(0, max);
}
