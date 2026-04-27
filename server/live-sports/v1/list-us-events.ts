/**
 * `GET /api/live-sports/v1/list-us-events` — handler core.
 *
 * Fan-out to ESPN scoreboards for every US league we track, normalize
 * events into our feed-item shape, sort live → upcoming → finished.
 *
 * Three caching layers:
 *   1. Top-level digest cache — Redis key `live-sports:us:v1`, 30 s TTL.
 *   2. Per-league sub-cache — Redis key `live-sports:espn:v1:{path}`, 30 s.
 *   3. In-memory `lastGoodResponse` for total-Redis-down fallback.
 *
 * The HTTP entrypoint is a thin wrapper at api/live-sports/v1/list-us-events.js
 * (vanilla edge function — same pattern as api/rss-proxy.js).
 */

import { cachedFetchJson } from '../../_shared/redis';
import { CHROME_UA } from '../../_shared/constants';
import { LEAGUES, espnScoreboardUrl, type LeagueConfig } from './_leagues';
import { normalizeScoreboard, type SportEventItem } from './_normalize';

const ESPN_FETCH_TIMEOUT_MS = 6_000;
const PER_LEAGUE_TTL_S = 30;
const TOP_LEVEL_TTL_S = 30;
const NEGATIVE_TTL_S = 60;

export interface ListUsSportsEventsResponse {
  items: SportEventItem[];
  leagueStatuses: Record<string, 'ok' | 'empty' | 'timeout' | 'error'>;
  generatedAt: string;
}

/** Last successful response retained in module memory for hard-fallback. */
let lastGoodResponse: ListUsSportsEventsResponse | null = null;

async function fetchEspnScoreboard(league: LeagueConfig): Promise<unknown | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ESPN_FETCH_TIMEOUT_MS);
  const startedAt = Date.now();
  try {
    const resp = await fetch(espnScoreboardUrl(league), {
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    if (!resp.ok) {
      console.warn(`[live-sports] ESPN ${league.shortName} → HTTP ${resp.status} (${Date.now() - startedAt}ms)`);
      return null;
    }
    const body = await resp.json();
    const eventCount = (body && typeof body === 'object' && Array.isArray((body as { events?: unknown[] }).events))
      ? (body as { events: unknown[] }).events.length
      : 0;
    console.log(`[live-sports] ESPN ${league.shortName} → ${eventCount} raw events (${Date.now() - startedAt}ms)`);
    return body;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[live-sports] ESPN ${league.shortName} fetch failed (${Date.now() - startedAt}ms):`, msg);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Fetch + cache one league's scoreboard. We cache the *raw* ESPN payload
 * (not the normalized one) so a future change to title formatting doesn't
 * require a cache flush.
 */
async function fetchLeagueWithCache(league: LeagueConfig): Promise<{
  league: LeagueConfig;
  raw: unknown | null;
}> {
  const cacheKey = `live-sports:espn:v1:${league.espnPath}`;
  const raw = await cachedFetchJson<{ payload: unknown }>(
    cacheKey,
    PER_LEAGUE_TTL_S,
    async () => {
      const payload = await fetchEspnScoreboard(league);
      if (payload == null) return null;
      return { payload };
    },
    NEGATIVE_TTL_S,
  );
  return { league, raw: raw?.payload ?? null };
}

/** Build the digest from scratch — runs only on Redis miss. */
async function buildDigest(): Promise<ListUsSportsEventsResponse> {
  const now = Date.now();
  console.log(`[live-sports] buildDigest start — fetching ${LEAGUES.length} leagues`);
  const settled = await Promise.allSettled(LEAGUES.map(fetchLeagueWithCache));

  const leagueStatuses: ListUsSportsEventsResponse['leagueStatuses'] = {};
  let allItems: SportEventItem[] = [];
  const perLeagueCounts: Record<string, { raw: number | string; kept: number }> = {};

  for (let i = 0; i < settled.length; i++) {
    const league = LEAGUES[i]!;
    const result = settled[i]!;

    if (result.status === 'rejected') {
      leagueStatuses[league.shortName] = 'error';
      perLeagueCounts[league.shortName] = { raw: 'rejected', kept: 0 };
      continue;
    }

    const raw = result.value.raw;
    if (raw == null) {
      leagueStatuses[league.shortName] = 'timeout';
      perLeagueCounts[league.shortName] = { raw: 'null', kept: 0 };
      continue;
    }

    const rawCount = Array.isArray((raw as { events?: unknown[] }).events)
      ? (raw as { events: unknown[] }).events.length
      : 0;
    const items = normalizeScoreboard(league, raw, now);
    leagueStatuses[league.shortName] = items.length > 0 ? 'ok' : 'empty';
    perLeagueCounts[league.shortName] = { raw: rawCount, kept: items.length };
    allItems = allItems.concat(items);
  }

  console.log(`[live-sports] buildDigest done — ${allItems.length} items total. Per-league:`, JSON.stringify(perLeagueCounts));

  // Sort: live first (priority 0), then upcoming by start time asc,
  // then finished by start time desc.
  allItems.sort((a, b) => {
    if (a.sortPriority !== b.sortPriority) return a.sortPriority - b.sortPriority;
    if (a.sortPriority === 1) return a.publishedAt - b.publishedAt;       // soonest first
    return b.publishedAt - a.publishedAt;                                 // most recent first
  });

  return {
    items: allItems,
    leagueStatuses,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Public entrypoint — used by the HTTP handler.
 * Always returns a response object; on total upstream failure returns the
 * last good payload (or an empty digest if we have never had a good fetch).
 */
export async function listUsSportsEvents(): Promise<ListUsSportsEventsResponse> {
  const cacheKey = 'live-sports:us:v1';

  try {
    const result = await cachedFetchJson<ListUsSportsEventsResponse>(
      cacheKey,
      TOP_LEVEL_TTL_S,
      async () => {
        const digest = await buildDigest();
        // Treat fully-empty digest as a soft failure (don't poison cache).
        if (digest.items.length === 0 && Object.values(digest.leagueStatuses).every((s) => s !== 'ok')) {
          return null;
        }
        return digest;
      },
      NEGATIVE_TTL_S,
    );

    if (result) {
      lastGoodResponse = result;
      return result;
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn('[live-sports] listUsSportsEvents failed:', msg);
  }

  // Hard fallback path — Redis down + every league failed.
  if (lastGoodResponse) {
    return lastGoodResponse;
  }
  return {
    items: [],
    leagueStatuses: Object.fromEntries(LEAGUES.map((l) => [l.shortName, 'error' as const])),
    generatedAt: new Date().toISOString(),
  };
}
