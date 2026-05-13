/**
 * Live-news v3 refresh — pulls clustered top stories from World News API
 * (the new paid feed) and writes them into a Redis-backed accumulator.
 *
 * Why v3 instead of patching v2:
 *   • v2 pulls 15 RSS feeds and runs LLM dedup to cluster the same story
 *     across outlets. v3 gets the clustering free from the upstream API.
 *   • v2's response goes through a source/link scrub (we shadow outlet
 *     identity for legal reasons on the unlicensed RSS pipe). The v3
 *     upstream is a paid licensed feed — we ship the real source and
 *     the real article URL.
 *
 * The two pipelines coexist while we TestFlight the iOS switch. Legacy
 * iOS builds keep reading /v2 with its scrub; TestFlight builds read /v3
 * with real outlet data. Once we cut over App Store, we can retire v2.
 *
 * # Pipeline
 *
 *   1. Call top-news?source-country=us&language=en — one call returns
 *      ~10 clusters, each with 1-10 articles about the same story.
 *   2. Map each cluster → one LiveNewsItemWithSources:
 *      • canonical = cluster.news[0]
 *      • sources[] = every article in the cluster
 *   3. Merge into the existing Redis accumulator, idempotent on article
 *      id — so when the enrichment cron later fills in location / lat /
 *      lng / isConflict on an item, a subsequent refresh doesn't clobber
 *      those fields. We update title/sources/publishedAt; we preserve
 *      everything that was enriched.
 *   4. Drop items older than the rolling window (24 h). Cap total size.
 *
 * # Caching
 *
 *   Single Redis key:  live-news:wn:v1:digest
 *   TTL:               7 days (defensive — the cron rewrites it every 5
 *                      min, so the TTL only matters if the cron stops).
 *
 * # Failure mode
 *
 *   On API failure the cron returns `{ status: 'skipped' }`. The Redis
 *   accumulator keeps its last good payload, so the read endpoint keeps
 *   serving it. A 24-hour upstream outage is the worst case before the
 *   accumulator starts trimming items.
 */

import { topNews, searchNews, deriveSource, parsePublishDate, type WorldNewsArticle } from '../../_shared/worldnews-client';
import { getCachedJson, setCachedJson } from '../../_shared/redis';
import { sha256Hex } from '../../_shared/hash';

const DIGEST_KEY = 'live-news:wn:v1:digest';
const DIGEST_TTL_S = 7 * 24 * 60 * 60;  // 7 days
const ROLLING_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_ITEMS = 500;

/**
 * How far back the broad search-news pull reaches. Each call returns the
 * newest 100 articles in this window, so we pick a window big enough that
 * a 5-min cron tick comfortably overlaps the previous one (no gaps), but
 * small enough that we don't waste a fetch on stories we've already
 * accumulated.
 */
const BROAD_SEARCH_WINDOW_HOURS = 3;
const BROAD_SEARCH_NUMBER = 100;            // max page size — 100 × 0.01 = 1 pt over the base
/** Anglophone source-countries — same audience scope as legacy v2's US RSS feeds,
 *  widened slightly so iOS users see Reuters UK + Guardian AU coverage too. */
const BROAD_SEARCH_COUNTRIES = 'us,gb,au,ca';

/**
 * Internal wire shape for one outlet on a story. Mirrors the v2 shape
 * (`AlternateSource` in server/live-news/v1/_dedup.ts) so iOS clients
 * decode v2 and v3 with the same struct.
 */
export interface LiveNewsV3Source {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
}

/**
 * Top-level item shape. Field-compatible with v2 `LiveNewsItemWithSources`
 * so iOS reuses the existing NewsItem decoder. Enrichment-only fields
 * (`location`, `summary`, `isConflict`, etc.) start as null and may be
 * filled later by the enrichment cron — same pattern as v2.
 */
export interface LiveNewsV3Item {
  /** Stable worldnewsapi article id — used as the merge key on refresh. */
  id: number;
  source: string;          // bare host, e.g. "reuters.com"
  title: string;
  link: string;            // real article URL (no scrub on v3)
  publishedAt: number;     // ms since epoch
  isAlert: boolean;        // currently always false — API has no breaking flag
  titleHash: string;       // sha256 of normalized title, for enrichment cache reuse
  // Enrichment fields — populated later (or left null indefinitely)
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  confidence: number | null;
  country: string | null;
  region?: string;
  summary: string | null;  // initial value comes from the API's `summary` field
  rawDescription: string | null;
  isConflict: boolean | null;
  sources: LiveNewsV3Source[];
}

export interface RefreshResult {
  status: 'ok' | 'skipped';
  fetched: number;
  merged: number;
  totalAfter: number;
  generatedAt: string;
  /** Diagnostic — non-fatal mapping skips (bad URL, missing title, etc.). */
  dropped: number;
}

function normalizeTitleForHash(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim().slice(0, 200);
}

/**
 * Map one upstream article into a `LiveNewsV3Source` entry. Returns null
 * if the article is missing required fields (we'd rather drop the entry
 * than ship a half-built source line to iOS).
 */
function mapToSource(a: WorldNewsArticle): LiveNewsV3Source | null {
  const source = deriveSource(a.url);
  const publishedAt = parsePublishDate(a.publish_date);
  if (!source || !a.title || !a.url || publishedAt === null) return null;
  return {
    source,
    title: a.title,
    link: a.url,
    publishedAt,
  };
}

/**
 * Map one cluster (canonical + alternates) into our wire shape. The
 * canonical's enrichment fields stay null — they get filled later by
 * the enrichment cron. The API's `summary` field is preserved as the
 * initial summary; the enrichment LLM will only re-paraphrase items
 * with no summary.
 */
async function clusterToItem(cluster: { news: WorldNewsArticle[] }): Promise<LiveNewsV3Item | null> {
  if (!cluster.news || cluster.news.length === 0) return null;

  const sources: LiveNewsV3Source[] = [];
  for (const a of cluster.news) {
    const s = mapToSource(a);
    if (s) sources.push(s);
  }
  if (sources.length === 0) return null;

  const canonical = cluster.news[0]!;
  const lead = sources[0]!;
  // SHA-256 of normalized title — keeps us compatible with the existing
  // enrichment-cache key scheme so v3 items can hit cached summaries
  // from v2 enrichment of identical headlines.
  const titleHash = await sha256Hex(normalizeTitleForHash(lead.title));

  return {
    id: canonical.id,
    source: lead.source,
    title: lead.title,
    link: lead.link,
    publishedAt: lead.publishedAt,
    isAlert: false,
    titleHash,
    location: null,
    locationName: null,
    confidence: null,
    country: null,
    summary: canonical.summary?.trim() || null,
    rawDescription: null,
    isConflict: null,
    sources,
  };
}

/**
 * Merge new items with whatever is already in the accumulator. Identity
 * is the stable worldnewsapi `id` — same id wins. On a hit we preserve
 * every enrichment field the previous run accumulated; we only refresh
 * the cluster's source list, the canonical title/link, and publishedAt.
 */
function mergeItems(existing: LiveNewsV3Item[], fresh: LiveNewsV3Item[]): LiveNewsV3Item[] {
  const byId = new Map<number, LiveNewsV3Item>();
  for (const item of existing) {
    if (typeof item?.id === 'number') byId.set(item.id, item);
  }
  for (const next of fresh) {
    const prev = byId.get(next.id);
    if (!prev) {
      byId.set(next.id, next);
      continue;
    }
    // Preserve enrichment from the previous run; take everything else fresh.
    byId.set(next.id, {
      ...next,
      location: prev.location ?? next.location,
      locationName: prev.locationName ?? next.locationName,
      confidence: prev.confidence ?? next.confidence,
      country: prev.country ?? next.country,
      region: prev.region ?? next.region,
      // Summary preference: keep an enriched one if it exists, otherwise
      // take whatever the fresh fetch came with (often the API's own).
      summary: prev.summary ?? next.summary,
      isConflict: prev.isConflict ?? next.isConflict,
    });
  }
  // Drop items past the rolling window, then sort newest-first and cap.
  const cutoff = Date.now() - ROLLING_WINDOW_MS;
  return Array.from(byId.values())
    .filter((it) => it.publishedAt >= cutoff)
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .slice(0, MAX_ITEMS);
}

/**
 * Map one upstream search-news article into a wire item. Single-source —
 * no sibling outlets, so `sources[]` is just `[self]`. The top-news pass
 * later upgrades the entry with multi-source data when the same article
 * appears in a cluster.
 */
async function articleToItem(a: WorldNewsArticle): Promise<LiveNewsV3Item | null> {
  const self = mapToSource(a);
  if (!self) return null;
  const titleHash = await sha256Hex(normalizeTitleForHash(self.title));
  return {
    id: a.id,
    source: self.source,
    title: self.title,
    link: self.link,
    publishedAt: self.publishedAt,
    isAlert: false,
    titleHash,
    location: null,
    locationName: null,
    confidence: null,
    country: null,
    summary: a.summary?.trim() || null,
    rawDescription: null,
    isConflict: null,
    sources: [self],
  };
}

/**
 * Cron entry point. Two parallel API calls fan out into one merged
 * accumulator:
 *
 *   • `top-news`     — clustered top stories (multi-source canonical).
 *                      Low volume (~10 clusters) but high signal.
 *   • `search-news`  — broad pull across en-language anglophone outlets
 *                      over the last few hours. ~100 single-source items
 *                      per call. This is the volume layer.
 *
 * Items merge by article id. A top-news entry that shares an id with a
 * search-news entry wins (carries the richer `sources[]`). Otherwise
 * each unique id contributes one row.
 *
 * Idempotent — safe to invoke at any cadence; running faster than the
 * 5-min schedule just spends extra worldnewsapi points.
 */
export async function refreshLiveNewsV3(): Promise<RefreshResult> {
  const startedAt = Date.now();

  const earliestPublishDate = formatWorldNewsDate(Date.now() - BROAD_SEARCH_WINDOW_HOURS * 60 * 60 * 1000);

  // Fire both upstream calls in parallel. Each is independently null-tolerant —
  // if one fails (rate-limit, quota, transient 5xx) we still merge what the
  // other returned.
  const [topNewsResp, searchResp] = await Promise.all([
    topNews({ sourceCountry: 'us', language: 'en' }),
    searchNews({
      language: 'en',
      sourceCountries: BROAD_SEARCH_COUNTRIES,
      earliestPublishDate,
      sort: 'publish-time',
      sortDirection: 'DESC',
      number: BROAD_SEARCH_NUMBER,
    }),
  ]);

  if (!topNewsResp && !searchResp) {
    // Both failed — the client already logged. Accumulator stays as-is.
    return {
      status: 'skipped',
      fetched: 0,
      merged: 0,
      totalAfter: 0,
      dropped: 0,
      generatedAt: new Date().toISOString(),
    };
  }

  let dropped = 0;
  const freshById = new Map<number, LiveNewsV3Item>();

  // Pass 1 — search-news (volume). Each article becomes a single-source
  // entry. We insert these first so the top-news pass can upgrade them
  // in place with the richer cluster sources[].
  if (searchResp) {
    for (const a of searchResp.news ?? []) {
      const item = await articleToItem(a);
      if (item) freshById.set(item.id, item);
      else dropped++;
    }
  }

  // Pass 2 — top-news (clusters). Overwrites any existing entry with the
  // same id; the cluster's sources[] is strictly richer than the search
  // pass's [self].
  if (topNewsResp) {
    for (const cluster of topNewsResp.top_news ?? []) {
      const item = await clusterToItem(cluster);
      if (item) freshById.set(item.id, item);
      else dropped++;
    }
  }

  const fresh = Array.from(freshById.values());

  const existing = ((await getCachedJson(DIGEST_KEY)) as LiveNewsV3Item[] | null) ?? [];
  const merged = mergeItems(existing, fresh);

  await setCachedJson(DIGEST_KEY, merged, DIGEST_TTL_S);

  const elapsedMs = Date.now() - startedAt;
  console.log(
    `[live-news:v3:refresh] top-news=${topNewsResp ? (topNewsResp.top_news?.length ?? 0) : 'fail'} ` +
    `search=${searchResp ? (searchResp.news?.length ?? 0) : 'fail'} ` +
    `freshUnique=${fresh.length} existed=${existing.length} after=${merged.length} ` +
    `dropped=${dropped} in ${elapsedMs}ms`,
  );

  return {
    status: 'ok',
    fetched: fresh.length,
    merged: fresh.length,
    totalAfter: merged.length,
    dropped,
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Format a JS millisecond timestamp into the World News API's expected
 * date string: `YYYY-MM-DD HH:MM:SS` in UTC.
 */
function formatWorldNewsDate(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 19);
}
