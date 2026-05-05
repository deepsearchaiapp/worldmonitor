/**
 * `GET /api/intel-news/v1/list-headlines` — handler core.
 *
 * On-demand GDELT digest. Six topics (cyber, military, nuclear, sanctions,
 * intelligence, maritime) are fetched in parallel from the GDELT 2.0 Doc API
 * and cached per-topic in Redis. Mirrors the ADSBExchange on-demand pattern
 * we use for military flights — no GitHub Actions cron.
 *
 * GDELT's per-IP rate limiting is handled by:
 *   • Per-topic cache (30 min) so concurrent client polls share a single
 *     upstream request.
 *   • cachedFetchJson coalescing — concurrent miss callers hit GDELT once.
 *   • Negative-result caching (2 min) so a 429 doesn't get retried until
 *     the cooldown elapses.
 *
 * Articles are normalized to the same shape as live-news items so the iOS
 * client can decode them with the existing `NewsItem` model.
 */

import { cachedFetchJson } from '../../_shared/redis';
import { INTEL_TOPICS, type IntelTopic } from './_topics';

const PER_TOPIC_TTL_S = 30 * 60;        // 30 min — matches GDELT update cadence
const PER_TOPIC_NEG_TTL_S = 120;        // 2 min — back off after 429
const TOP_LEVEL_TTL_S = 30;             // 30 s — same urgency tier as live-news
const FETCH_TIMEOUT_MS = 10_000;
const GDELT_BASE = 'https://api.gdeltproject.org/api/v2/doc/doc';

interface GdeltArticle {
  url?: string;
  url_mobile?: string;
  title?: string;
  seendate?: string;
  socialimage?: string;
  domain?: string;
  language?: string;
  sourcecountry?: string;
  tone?: string | number;
}

interface GdeltResponse {
  articles?: GdeltArticle[];
}

/** One outlet's coverage of the same syndicated story. */
export interface IntelNewsAlternateSource {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
}

/** Item shape — matches iOS NewsItem decoder. */
export interface IntelNewsItem {
  source: string;             // domain (e.g. "reuters.com")
  title: string;
  link: string;
  publishedAt: number;        // ms since epoch
  isAlert: boolean;
  /** Topic id — used by iOS chips to filter. */
  topic: string;
  /** Tone score from GDELT, when present (typically -10..+10). */
  tone: number | null;
  /**
   * All outlets reporting the same headline, populated by within-topic
   * title dedup. Always includes the canonical (sources[0] === rep)
   * when present. Empty when the item has no detected duplicates —
   * matches the v2 live-news convention.
   */
  sources?: IntelNewsAlternateSource[];
}

export interface IntelNewsTopicBucket {
  id: string;
  label: string;
  items: IntelNewsItem[];
  fetchedAt: number;
  /** When the upstream call failed and we returned a stale cached value. */
  stale?: boolean;
}

export interface ListIntelNewsResponse {
  topics: IntelNewsTopicBucket[];
  generatedAt: string;
}

/** GDELT seendate is `YYYYMMDDTHHMMSSZ`. Convert to ms-since-epoch. */
function parseGdeltDate(s: string | undefined): number {
  if (!s || s.length < 14) return 0;
  // Example: "20260504T123045Z"
  const yr = s.slice(0, 4);
  const mo = s.slice(4, 6);
  const dy = s.slice(6, 8);
  const hh = s.slice(9, 11);
  const mm = s.slice(11, 13);
  const ss = s.slice(13, 15);
  const iso = `${yr}-${mo}-${dy}T${hh}:${mm}:${ss}Z`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Normalize a headline for dedup grouping.
 *
 * GDELT republishes wire stories (AP, Reuters, AFP, etc.) across many
 * outlets verbatim, so the same headline shows up under one topic many
 * times. Group by:
 *   - Lower-case
 *   - Strip non-alphanumeric Unicode (commas, dashes, smart quotes, etc.)
 *   - Collapse whitespace
 *
 * This catches wire-syndicated duplicates without false-grouping similar
 * but distinct stories — different events with different headlines stay
 * separate. We deliberately don't do fuzzy matching; LLM-driven
 * semantic dedup (like live-news v2's classifier) is overkill for the
 * intel digest where the duplicate signal is exact-string.
 */
function normalizeTitle(t: string): string {
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchTopicArticles(topic: IntelTopic): Promise<IntelNewsTopicBucket | null> {
  const url = new URL(GDELT_BASE);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', 'artlist');
  // Bumped 20 → 50 (Task 4c+). Within GDELT's 250 hard cap and gives
  // each topic chip enough depth that scrolling feels meaningful.
  // After title-dedup the visible item count is typically ~30–40.
  url.searchParams.set('maxrecords', '50');
  url.searchParams.set('format', 'json');
  url.searchParams.set('sort', 'date');
  url.searchParams.set('timespan', '24h');

  let resp: Response;
  try {
    resp = await fetch(url.toString(), {
      headers: {
        Accept: 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; WorldMonitor/1.0)',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    console.warn(`[intel-news] ${topic.id} fetch error:`, (err as Error).message);
    return null;
  }

  if (!resp.ok) {
    console.warn(`[intel-news] ${topic.id} HTTP ${resp.status}`);
    return null;
  }

  let data: GdeltResponse;
  try {
    data = (await resp.json()) as GdeltResponse;
  } catch {
    return null;
  }

  const articles = Array.isArray(data?.articles) ? data.articles : [];
  if (articles.length === 0) return null;

  // First pass: build raw item list straight from the GDELT response.
  // Dedup happens in the second pass.
  const rawItems: IntelNewsItem[] = [];
  for (const art of articles) {
    const link = String(art.url || art.url_mobile || '').trim();
    const title = String(art.title || '').trim();
    if (!link || !title) continue;

    rawItems.push({
      source: String(art.domain || 'GDELT').trim(),
      title,
      link,
      publishedAt: parseGdeltDate(art.seendate),
      isAlert: false,                  // GDELT doesn't flag breaking — clients can layer their own
      topic: topic.id,
      tone: toNumber(art.tone),
    });
  }

  if (rawItems.length === 0) return null;

  // Second pass: group by normalized title. Wire stories (AP, Reuters)
  // get republished verbatim across dozens of domains under the same
  // topic — collapse them into one canonical item with `sources[]`
  // listing every outlet so the iOS detail view can render a stacked
  // "Read on X" CTA per outlet.
  const groups = new Map<string, IntelNewsItem[]>();
  for (const item of rawItems) {
    const key = normalizeTitle(item.title);
    if (!key) continue;
    const bucket = groups.get(key) ?? [];
    bucket.push(item);
    groups.set(key, bucket);
  }

  const items: IntelNewsItem[] = [];
  let dupedAway = 0;
  for (const group of groups.values()) {
    // Within each group: keep the freshest as canonical, list every
    // outlet under sources[] (canonical first, others by recency).
    group.sort((a, b) => b.publishedAt - a.publishedAt);
    const canonical = group[0]!;
    if (group.length > 1) {
      canonical.sources = group.map((g) => ({
        source: g.source,
        title: g.title,
        link: g.link,
        publishedAt: g.publishedAt,
      }));
      dupedAway += group.length - 1;
    }
    items.push(canonical);
  }

  // Sort newest first — defensive in case GDELT returns out-of-order
  // and to keep the iOS feed in chronological order.
  items.sort((a, b) => b.publishedAt - a.publishedAt);

  if (dupedAway > 0) {
    console.log(`[intel-news] ${topic.id}: ${rawItems.length} raw → ${items.length} unique (-${dupedAway} duplicate outlets)`);
  }

  return {
    id: topic.id,
    label: topic.label,
    items,
    fetchedAt: Date.now(),
  };
}

/**
 * Public entrypoint. Always returns a 200 — empty buckets on full upstream
 * failure rather than failing the request, so the iOS feed never goes blank.
 */
export async function listIntelNews(): Promise<ListIntelNewsResponse> {
  // v2 — adds title-dedup with sources[]. Old v1 caches still decode
  // safely on the iOS side (sources is optional) but bumping the key
  // forces an immediate rebuild after deploy so users see the dedup
  // benefit without waiting for the 30 min TTL to expire.
  const topLevelKey = 'intel-news:digest:v2';

  // Top-level cache aggregates per-topic results. Per-topic caches let us
  // partially refresh — if 5 topics are fresh and 1 is stale, only 1 GDELT
  // hit is needed.
  const cached = await cachedFetchJson<ListIntelNewsResponse>(
    topLevelKey,
    TOP_LEVEL_TTL_S,
    async () => {
      // Fetch each topic with its own cachedFetchJson so per-topic 30 min
      // cache survives even when the top-level 30 s key expires.
      const promises = INTEL_TOPICS.map(async (topic) => {
        const perTopicKey = `intel-news:topic:v2:${topic.id}`;
        return cachedFetchJson<IntelNewsTopicBucket>(
          perTopicKey,
          PER_TOPIC_TTL_S,
          () => fetchTopicArticles(topic),
          PER_TOPIC_NEG_TTL_S,
        );
      });

      const results = await Promise.all(promises);

      // Filter nulls (topics where GDELT failed AND nothing was cached).
      // Note: the iOS client tolerates missing topics — empty chip = "no
      // recent stories" rather than an error state.
      const topics = results.filter((b): b is IntelNewsTopicBucket => b !== null);

      const totalArticles = topics.reduce((s, t) => s + t.items.length, 0);
      console.log(`[intel-news] digest: ${topics.length}/${INTEL_TOPICS.length} topics, ${totalArticles} articles`);

      return {
        topics,
        generatedAt: new Date().toISOString(),
      };
    },
    30, // negative cache 30 s if every topic fails
  );

  return cached ?? { topics: [], generatedAt: new Date().toISOString() };
}
