/**
 * `GET /api/live-news/v1/list-us-headlines` — handler core.
 *
 * Pipeline:
 *   1. Fan-out fetch ~25 US RSS sources (per-source Redis cache, 10 min).
 *   2. Dedupe by 80-char title fingerprint, age-filter to last 3 days,
 *      sort by recency, cap at 60 items.
 *   3. BATCH-GET cached LLM locations from Redis for every titleHash.
 *      Items with hits get `location` populated immediately.
 *   4. For items still missing, fire-and-forget LLM enrichment in the
 *      background (no `await`) — the response goes back without waiting.
 *      Next iOS poll's BATCH-GET picks up whatever finished.
 *
 * Caching:
 *   - Top-level digest: `live-news:us:v1`, 30 s TTL.
 *   - Per-feed: 10 min TTL.
 *   - Per-headline location: 30 days (effectively forever).
 */

import { cachedFetchJson } from '../../_shared/redis';
import { keepAlive } from '../../_shared/keep-alive';
import { buildBaseDigest, type LiveNewsItem } from './_normalize';
import { attachCachedLocations, enrichMissingLocations } from './_enrich';
import { attachCachedSummaries, paraphraseMissingSummaries } from './_paraphrase';

const TOP_LEVEL_TTL_S = 30;
const NEGATIVE_TTL_S = 30;
const FAN_OUT_DEADLINE_MS = 20_000;

export interface ListUsHeadlinesResponse {
  items: LiveNewsItem[];
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
  generatedAt: string;
  /** Diagnostic — how many items were missing a cached location at digest time. */
  pendingEnrichment: number;
  /** Diagnostic — how many items were missing a cached LLM summary at digest time. */
  pendingParaphrase: number;
}

/** In-memory last-good — fallback if Redis is hard-down on a cold instance. */
let lastGoodResponse: ListUsHeadlinesResponse | null = null;

async function buildDigestPayload(): Promise<ListUsHeadlinesResponse> {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), FAN_OUT_DEADLINE_MS);

  try {
    const { items, feedStatuses } = await buildBaseDigest(deadline.signal);

    // Read path — attach already-enriched locations and summaries in parallel.
    // Both are independent BATCH GETs against different cache namespaces,
    // so we pipeline them.
    const [missingLocations, missingSummaries] = await Promise.all([
      attachCachedLocations(items),
      attachCachedSummaries(items),
    ]);

    // Write path — fire-and-forget BUT registered with Vercel's `waitUntil`
    // via our `keepAlive` helper. Without that registration the Edge
    // runtime kills the isolate the moment we return the response, which
    // silently cancels the LLM calls and leaves Redis empty (the bug we
    // hit on first deploy: every poll saw `pendingEnrichment=60` because
    // the writes never happened). With `keepAlive` the runtime keeps the
    // isolate alive ~up to 30 s so Claude can finish.
    if (missingLocations.length > 0) {
      console.log(`[live-news] Kicking off location enrichment for ${missingLocations.length} items`);
      keepAlive(enrichMissingLocations(missingLocations), 'live-news:enrich');
    }
    if (missingSummaries.length > 0) {
      console.log(`[live-news] Kicking off paraphrase for ${missingSummaries.length} items`);
      keepAlive(paraphraseMissingSummaries(missingSummaries), 'live-news:para');
    }

    return {
      items,
      feedStatuses,
      generatedAt: new Date().toISOString(),
      pendingEnrichment: missingLocations.length,
      pendingParaphrase: missingSummaries.length,
    };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

/**
 * Public entrypoint. Always returns a response (even an empty one if every
 * upstream fails). We never let `cachedFetchJson` write a negative sentinel
 * for the digest — see `live-sports/v1/list-us-events.ts` for the war story
 * on cache-poisoning. Empty digests cache normally for 30 s.
 */
export async function listUsHeadlines(): Promise<ListUsHeadlinesResponse> {
  // Bumped v1 → v2 alongside the paraphrase cache rotation. The previous
  // digest cache held items with `summary: null` from the pre-paragraph
  // build window — fresh requests would have served that stale shape for
  // up to 30 s after deploy. Rotating the digest prefix evicts it
  // instantly and forces every caller to rebuild.
  const cacheKey = 'live-news:us:v2';

  try {
    const result = await cachedFetchJson<ListUsHeadlinesResponse>(
      cacheKey,
      TOP_LEVEL_TTL_S,
      async () => buildDigestPayload(),
      NEGATIVE_TTL_S,
    );

    if (result) {
      lastGoodResponse = result;
      return result;
    }
  } catch (err) {
    console.warn('[live-news] listUsHeadlines failed:', err instanceof Error ? err.message : err);
  }

  if (lastGoodResponse) return lastGoodResponse;
  return {
    items: [],
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    pendingEnrichment: 0,
    pendingParaphrase: 0,
  };
}
