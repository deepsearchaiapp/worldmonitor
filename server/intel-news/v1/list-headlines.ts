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

async function fetchTopicArticles(topic: IntelTopic): Promise<IntelNewsTopicBucket | null> {
  const url = new URL(GDELT_BASE);
  url.searchParams.set('query', topic.query);
  url.searchParams.set('mode', 'artlist');
  url.searchParams.set('maxrecords', '20');
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

  const items: IntelNewsItem[] = [];
  for (const art of articles) {
    const link = String(art.url || art.url_mobile || '').trim();
    const title = String(art.title || '').trim();
    if (!link || !title) continue;

    items.push({
      source: String(art.domain || 'GDELT').trim(),
      title,
      link,
      publishedAt: parseGdeltDate(art.seendate),
      isAlert: false,                  // GDELT doesn't flag breaking — clients can layer their own
      topic: topic.id,
      tone: toNumber(art.tone),
    });
  }

  if (items.length === 0) return null;

  // Sort newest first — defensive in case GDELT returns out-of-order.
  items.sort((a, b) => b.publishedAt - a.publishedAt);

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
  const topLevelKey = 'intel-news:digest:v1';

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
        const perTopicKey = `intel-news:topic:v1:${topic.id}`;
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
