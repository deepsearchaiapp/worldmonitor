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
import { buildBaseDigest, type LiveNewsItem } from './_normalize';
import { attachCachedLocations, enrichMissingLocations } from './_enrich';

const TOP_LEVEL_TTL_S = 30;
const NEGATIVE_TTL_S = 30;
const FAN_OUT_DEADLINE_MS = 20_000;

export interface ListUsHeadlinesResponse {
  items: LiveNewsItem[];
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
  generatedAt: string;
  /** Diagnostic — how many items were missing a cached location at digest time. */
  pendingEnrichment: number;
}

/** In-memory last-good — fallback if Redis is hard-down on a cold instance. */
let lastGoodResponse: ListUsHeadlinesResponse | null = null;

async function buildDigestPayload(): Promise<ListUsHeadlinesResponse> {
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), FAN_OUT_DEADLINE_MS);

  try {
    const { items, feedStatuses } = await buildBaseDigest(deadline.signal);

    // Read path — attach already-enriched locations.
    const missing = await attachCachedLocations(items);

    // Write path — fire-and-forget. We deliberately don't `await` here so
    // the response returns immediately. The promise keeps running on the
    // edge instance long enough to finish the LLM call (Claude Haiku
    // typically returns in < 3 s for 20 headlines).
    if (missing.length > 0) {
      console.log(`[live-news] Kicking off enrichment for ${missing.length} missing items`);
      // No `await` — but we catch so an unhandled rejection doesn't crash
      // the function. Errors land in Vercel logs via the helper itself.
      enrichMissingLocations(missing).catch((err) => {
        console.warn('[live-news] enrichment promise rejected:', err);
      });
    }

    return {
      items,
      feedStatuses,
      generatedAt: new Date().toISOString(),
      pendingEnrichment: missing.length,
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
  const cacheKey = 'live-news:us:v1';

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
  };
}
