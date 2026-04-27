/**
 * Heuristic "is this breaking news?" detection for the Live News feed.
 *
 * We flag an item as `isAlert: true` when it looks like a high-priority
 * developing story. Three signals contribute:
 *   1. Title matches a breaking-keyword regex.
 *   2. Title is screaming-caps for several consecutive words.
 *   3. Item was published within the last 30 minutes.
 *
 * The first two are necessary on their own; the third by itself is
 * insufficient (a calm "weather forecast" headline 5 min old isn't breaking).
 */

const BREAKING_KEYWORDS_RE = /\b(breaking|live|just in|developing|alert|urgent|exclusive|now|emergency)\b/i;
const SCREAMING_CAPS_RE = /\b[A-Z]{4,}(?:\s+[A-Z]{2,}){2,}/; // 3+ consecutive ALL-CAPS words

const RECENT_THRESHOLD_MS = 30 * 60 * 1000; // 30 minutes

export interface BreakingSignals {
  isAlert: boolean;
  /** Diagnostic label so logs explain why an item was marked breaking. */
  reason: 'keyword' | 'caps' | 'keyword+recent' | 'none';
}

export function detectBreaking(title: string, publishedAt: number, now: number): BreakingSignals {
  const recent = publishedAt > 0 && now - publishedAt < RECENT_THRESHOLD_MS;
  const keywordHit = BREAKING_KEYWORDS_RE.test(title);
  const capsHit = SCREAMING_CAPS_RE.test(title);

  if (keywordHit && recent) return { isAlert: true, reason: 'keyword+recent' };
  if (keywordHit)            return { isAlert: true, reason: 'keyword' };
  if (capsHit)               return { isAlert: true, reason: 'caps' };
  return { isAlert: false, reason: 'none' };
}
