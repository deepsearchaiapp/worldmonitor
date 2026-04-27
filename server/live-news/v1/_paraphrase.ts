/**
 * LLM-based paraphrasing for Live News items.
 *
 * Pipeline mirrors the location-enrichment design:
 *   1. BATCH GET cached summaries for every titleHash.
 *   2. Items with hits get `summary` populated immediately.
 *   3. Items still missing → fire-and-forget LLM batch call.
 *   4. LLM responses written to Redis with 30-day TTL.
 *
 * Cache layout:
 *   live-news:para:v1:{titleHash} → { summary } | UNPARAPHRASED_MARKER
 *
 * The LLM may decline to summarize when:
 *   - The RSS description is too sparse (paywall snippet, "Read more...").
 *   - The story has insufficient context to summarize without speculating.
 *   - The headline is non-news (a video clip, podcast intro, etc.).
 *
 * In all those cases we cache the negative marker so we never re-ask, and
 * iOS falls back to the source webpage view (existing behavior).
 */

import { callClaude } from '../../_shared/llm';
import { getCachedJsonBatch, setCachedJson } from '../../_shared/redis';
import type { LiveNewsItem } from './_normalize';

const SUMMARY_TTL_S = 30 * 24 * 60 * 60; // 30 days
const PARAPHRASE_BATCH_SIZE = 8;          // smaller than location — bigger inputs per item
const MAX_PARAPHRASE_PER_REQUEST = 40;
// v3 — bumped after we discovered Upstash silently dropped large SET
// values in v2 because we were URL-encoding them into the path. The fix
// (body-based SET) lives in `_shared/redis.ts`. We rotate the prefix so
// the next build starts with a clean namespace, free of the partial
// negative-cache markers written before the bug was found.
const CACHE_PREFIX = 'live-news:para:v3:';

/** Sentinel — LLM declined to summarize this story. iOS falls back to source. */
const UNPARAPHRASED_MARKER = '__WM_LIVE_NEWS_UNPARAPHRASED__';

interface CachedSummary {
  summary: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Read path
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mutates `items` in place: items whose hash has a cached summary get
 * `summary` populated. Returns the sub-list still missing — those are the
 * candidates for LLM enrichment.
 */
export async function attachCachedSummaries(items: LiveNewsItem[]): Promise<LiveNewsItem[]> {
  if (items.length === 0) return [];

  const keys = items.map((it) => `${CACHE_PREFIX}${it.titleHash}`);
  const cache = await getCachedJsonBatch(keys);

  const missing: LiveNewsItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!;
    const cached = cache.get(keys[i]!);
    if (cached === undefined) {
      missing.push(item);
      continue;
    }
    if (cached === UNPARAPHRASED_MARKER) {
      // LLM previously declined — leave summary null so iOS falls back to source.
      continue;
    }
    const c = cached as CachedSummary;
    if (c && typeof c.summary === 'string' && c.summary.length > 0) {
      item.summary = c.summary;
    }
  }

  return missing;
}

// ─────────────────────────────────────────────────────────────────────────────
// Write path
// ─────────────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a neutral news summarizer for a multi-source live news feed.

For each news item, write a paragraph-length factual summary that gives the reader the substance of the story — not just a rephrased headline.

Structure:
- Sentence 1: lead with the key event (who, what, where, when).
- Sentences 2 to 4: expand on the substance: how it happened, who is affected, what numbers / parties / timeline are involved, what the immediate consequences are.
- Closing sentence: the implication, the next step, or the broader context that helps the reader understand why this matters.

Length:
- 4 to 6 sentences total, 100 to 180 words.
- Aim for the upper end of that range when the source description is rich; never artificially pad if there isn't enough substance.

Sourcing rules:
- Use ONLY the facts present in the input title and description. Do not invent specifics (numbers, names, quotes, dates) that are not in the input.
- You MAY add neutral background context drawn from common knowledge about named entities (e.g. what an agency is, where a location is, what a recurring event represents). Do not stretch this into specific claims.
- No editorial spin, no rhetorical questions, no source attribution ("According to the New York Times..."), no quoted headlines.
- Past or present tense, never future tense. Active voice when possible.

Sparse-input fallback:
- If the input description is genuinely too thin to support a paragraph (for example: just a video link, podcast intro, or one-line headline with no body), still produce the best possible 3 to 4 sentence summary using only what is supported. Do not hallucinate.
- Set summary to null only when the input is so devoid of newsworthy substance that any expansion would be speculation.

Output a JSON object with a "results" array, one entry per input id:
- id: string (matches input)
- summary: paragraph-length factual summary as plain text, or null

Return JSON ONLY. No prose outside the JSON, no markdown fences, no code fences.`;

interface LlmResultEntry {
  id: string;
  summary?: string | null;
}

interface LlmResponse {
  results: LlmResultEntry[];
}

function buildPrompt(items: LiveNewsItem[]): string {
  const inputs = items.map((it) => ({
    id: it.titleHash,
    title: it.title,
    source: it.source,
    description: it.rawDescription ?? '',
  }));
  return `Summarize these ${items.length} news items:\n\n${JSON.stringify(inputs, null, 2)}`;
}

/** Tolerant JSON parser — same approach as `_enrich.ts`. */
function extractJson(text: string): unknown | null {
  try { return JSON.parse(text); } catch { /* fall through */ }
  const stripped = text.replace(/```(?:json)?\s*([\s\S]*?)\s*```/g, '$1').trim();
  try { return JSON.parse(stripped); } catch { /* fall through */ }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return JSON.parse(stripped.slice(start, end + 1)); } catch { /* fall through */ }
  }
  return null;
}

/** Validate + normalize a single LLM result entry into our cache shape. */
function toCachedSummary(entry: LlmResultEntry): CachedSummary | null {
  const summary = entry.summary;
  if (typeof summary !== 'string') return null;
  const trimmed = summary.trim();
  // Floor: 80 chars is roughly two short sentences. Below that the LLM
  // probably echoed the title back instead of expanding — caching it
  // would mean shipping a "title twice" experience to users.
  if (trimmed.length < 80) return null;
  // Ceiling: paragraph-length spec is ~180 words ≈ 1100 chars. 2000
  // gives headroom for occasional verbose outputs without letting a
  // runaway response leak into the response payload.
  if (trimmed.length > 2000) return null;
  return { summary: trimmed };
}

async function paraphraseBatch(batch: LiveNewsItem[]): Promise<void> {
  if (batch.length === 0) return;

  // Filter out items with no source description — they'd produce hallucinated
  // or trivially-rephrased output, neither of which is valuable. Items
  // dropped here get the UNPARAPHRASED_MARKER so iOS falls back to source.
  const withDesc = batch.filter((it) => (it.rawDescription ?? '').length >= 60);
  const sparse = batch.filter((it) => (it.rawDescription ?? '').length < 60);

  await Promise.all(sparse.map(async (item) => {
    const key = `${CACHE_PREFIX}${item.titleHash}`;
    await setCachedJson(key, UNPARAPHRASED_MARKER, SUMMARY_TTL_S);
  }));

  if (withDesc.length === 0) {
    console.log(`[live-news:para] All ${batch.length} items had sparse descriptions — skipping LLM, marked unparaphrasable`);
    return;
  }

  const result = await callClaude({
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(withDesc),
    // 4000 token cap for batch of 8 = ~500 tokens per item.
    // Paragraph-length output is ~250–350 tokens per item; the headroom
    // covers JSON envelope overhead and occasional longer entries.
    maxTokens: 4000,
    temperature: 0.3,
    apiKeyEnv: 'ANTHROPIC_API_KEY_PARAPHRASE',
  });

  if (!result) {
    console.warn(`[live-news:para] LLM call returned null for batch of ${withDesc.length}`);
    return;
  }

  const parsed = extractJson(result.content) as LlmResponse | null;
  if (!parsed || !Array.isArray(parsed.results)) {
    console.warn(`[live-news:para] Failed to parse LLM JSON output:`, result.content.slice(0, 200));
    return;
  }

  const byId = new Map<string, LlmResultEntry>();
  for (const entry of parsed.results) {
    if (entry?.id) byId.set(entry.id, entry);
  }

  let written = 0;
  let unparaphrased = 0;

  await Promise.all(withDesc.map(async (item) => {
    const entry = byId.get(item.titleHash);
    const key = `${CACHE_PREFIX}${item.titleHash}`;
    const cached = entry ? toCachedSummary(entry) : null;
    if (cached) {
      await setCachedJson(key, cached, SUMMARY_TTL_S);
      written++;
    } else {
      // LLM returned null/garbage for this item — cache the negative so we
      // don't re-ask. iOS falls back to the source webpage.
      await setCachedJson(key, UNPARAPHRASED_MARKER, SUMMARY_TTL_S);
      unparaphrased++;
    }
  }));

  console.log(
    `[live-news:para] LLM paraphrased ${written}/${withDesc.length} items (${unparaphrased} unparaphrasable, ${sparse.length} sparse). ` +
    `Tokens: in=${result.inputTokens} out=${result.outputTokens}`,
  );
}

/**
 * Public: paraphrase all missing items, in batches.
 *
 * Caller fires-and-forgets so the iOS request returns immediately. Next
 * poll's BATCH GET picks up whatever finished.
 */
export async function paraphraseMissingSummaries(missing: LiveNewsItem[]): Promise<void> {
  if (missing.length === 0) return;

  const slice = missing.slice(0, MAX_PARAPHRASE_PER_REQUEST);
  if (slice.length < missing.length) {
    console.log(`[live-news:para] Capping batch at ${MAX_PARAPHRASE_PER_REQUEST}/${missing.length} items`);
  }

  for (let i = 0; i < slice.length; i += PARAPHRASE_BATCH_SIZE) {
    const batch = slice.slice(i, i + PARAPHRASE_BATCH_SIZE);
    try {
      await paraphraseBatch(batch);
    } catch (err) {
      console.warn('[live-news:para] batch failed:', err instanceof Error ? err.message : err);
    }
  }
}
