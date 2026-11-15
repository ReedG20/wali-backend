// Small pure text helpers shared by the agent's writes (approvals, notes, transcript previews).
// No Convex or Node imports, so they're unit tested directly (tests/text.test.ts).

const STOP = new Set([
  "the", "and", "for", "that", "this", "with", "you", "your", "their", "they", "them", "his", "her", "its",
  "are", "was", "has", "have", "had", "will", "from", "about", "into", "what", "any", "all", "can",
]);

/** Curly quotes to straight ones, so "can’t" and "can't" are the same word. */
const straighten = (text: string) => text.replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"');

/**
 * The content words of a sentence, in order: lowercased, without filler words, singular, and cut
 * to a 5-letter stem ("summary" / "summarize", "step" / "steps" come out the same).
 */
export function contentWords(text: string): string[] {
  const out: string[] = [];
  for (const w of straighten(text).toLowerCase().replace(/[^a-z0-9\s']/g, " ").split(/\s+/)) {
    let word = w.replace(/'s$|'/g, "");
    if (word.length < 3 || STOP.has(word)) continue;
    if (word.length > 3 && word.endsWith("s") && !word.endsWith("ss")) word = word.slice(0, -1);
    out.push(word.slice(0, 5));
  }
  return out;
}

const DAY_WORDS = new Set([
  "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "january", "february", "march", "april", "june", "july", "august", "september", "october", "november", "december",
  "today", "tonight", "tomorrow", "yesterday", "morning", "afternoon", "evening", "night", "noon", "midnight",
  "weekend", "week", "month", "year", "next", "last",
]);
const NEGATION = /^(?:not|never|no|cannot|without|none|neither|nor|nobody|nothing)$|n't$/;
/** Capitalised words that start sentences without naming anything. */
const NOT_NAMES = new Set([
  "the", "they", "them", "their", "he", "she", "his", "her", "we", "it", "this", "that", "these", "those", "a", "an",
  "my", "our", "your", "i", "plan", "plans", "check", "get", "find", "read", "look", "summarize", "summarise",
  "ask", "remind", "note", "user", "wali", "when", "if", "after", "before", "on", "in", "at", "for", "to",
]);

/**
 * The parts of a sentence that change what it says while its other words stay the same, including
 * ones too short to count as content words: numbers and times, days and dates, names, and
 * whether it's negated.
 */
export function specifics(text: string): Set<string> {
  const out = new Set<string>();
  for (const raw of straighten(text).split(/\s+/)) {
    const token = raw.replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9']+$/g, "");
    if (!token) continue;
    const lower = token.toLowerCase();
    // "today's", "Friday's", "Sam's": the word without its possessive.
    const bare = lower.replace(/'s$/, "");
    if (/\d/.test(bare)) out.add(bare);
    else if (DAY_WORDS.has(bare)) out.add(bare);
    else if (NEGATION.test(lower)) out.add("(not)");
    else if (/^[A-Z]/.test(token) && !NOT_NAMES.has(bare)) out.add(bare);
  }
  return out;
}

/**
 * The same sentence again: the same content words in the same order, and the same specifics.
 * Only filler words, punctuation, capitals and singular/plural may differ.
 *
 * This decides whether a note or an ask is skipped as a repeat, so it is deliberately strict.
 * Looser matching (shared-word percentages) treated corrections as repeats: "…on Friday" after
 * "…on Monday", "today's" after "tomorrow's", "Ife owes Reed" after "Reed owes Ife", "the green
 * design" after "the blue design". Skipping one of those loses a fact; keeping a reworded
 * duplicate only costs a line.
 */
export function sameWording(a: string, b: string): boolean {
  const x = contentWords(a);
  const y = contentWords(b);
  if (!x.length || x.length !== y.length || x.some((w, i) => w !== y[i])) return false;
  const p = specifics(a);
  const q = specifics(b);
  if (p.size !== q.size) return false;
  for (const v of p) if (!q.has(v)) return false;
  return true;
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
