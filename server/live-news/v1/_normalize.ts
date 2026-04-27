/**
 * RSS fetch → parse → dedupe → age-filter → digest item shape.
 *
 * Mirrors the regex-based parser used by `list-feed-digest.ts` so we don't
 * pull in a heavyweight XML library. The trade-off: weird RSS dialects can
 * slip through with empty fields, but the same parser has worked across
 * 300+ feeds in production.
 */

import { US_NEWS_SOURCES, ITEMS_PER_FEED, MAX_ITEMS, MAX_AGE_MS, type NewsSource } from './_sources';
import { detectBreaking } from './_breaking';
import { CHROME_UA } from '../../_shared/constants';
import { cachedFetchJson } from '../../_shared/redis';
import { sha256Hex } from '../../_shared/hash';

const FEED_TIMEOUT_MS = 8_000;
const PER_FEED_TTL_S = 600; // 10 min RSS cache — RSS rarely updates faster

/** Output shape — designed to decode into the iOS `NewsItem` model verbatim. */
export interface LiveNewsItem {
  source: string;
  title: string;
  link: string;
  publishedAt: number;     // ms since epoch
  isAlert: boolean;
  /** SHA-256 of normalized title — used as the cache key for LLM enrichment. */
  titleHash: string;
  /** Filled in by the enrichment step; absent on first poll. */
  location: { latitude: number; longitude: number } | null;
  locationName: string | null;
  /** LLM confidence 0..1 (only meaningful when location is non-null). */
  confidence: number | null;
  /** Optional ISO country code from the LLM. Useful for client-side filtering. */
  country: string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// XML parsing — regex-based, mirrors list-feed-digest.ts
// ─────────────────────────────────────────────────────────────────────────────

const TAG_REGEX_CACHE = new Map<string, { cdata: RegExp; plain: RegExp }>();
for (const tag of ['title', 'link', 'pubDate', 'published', 'updated', 'description', 'summary']) {
  TAG_REGEX_CACHE.set(tag, {
    cdata: new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i'),
    plain: new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i'),
  });
}

function extractTag(xml: string, tag: string): string {
  const cached = TAG_REGEX_CACHE.get(tag);
  const cdataRe = cached?.cdata ?? new RegExp(`<${tag}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*<\\/${tag}>`, 'i');
  const plainRe = cached?.plain ?? new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, 'i');

  const cdataMatch = xml.match(cdataRe);
  if (cdataMatch) return cdataMatch[1]!.trim();

  const match = xml.match(plainRe);
  return match ? decodeXmlEntities(match[1]!.trim()) : '';
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-feed fetch + parse (with Redis caching)
// ─────────────────────────────────────────────────────────────────────────────

interface RawItem {
  source: string;
  title: string;
  link: string;
  publishedAt: number;
}

async function fetchRssText(url: string, signal: AbortSignal): Promise<string | null> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FEED_TIMEOUT_MS);
  const onAbort = () => ctrl.abort();
  signal.addEventListener('abort', onAbort, { once: true });

  try {
    const resp = await fetch(url, {
      headers: {
        'User-Agent': CHROME_UA,
        Accept: 'application/rss+xml, application/xml, text/xml, */*',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      signal: ctrl.signal,
    });
    if (!resp.ok) return null;
    return await resp.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}

function parseFeed(xml: string, source: NewsSource): RawItem[] {
  const items: RawItem[] = [];
  const itemRegex = /<item[\s>]([\s\S]*?)<\/item>/gi;
  const entryRegex = /<entry[\s>]([\s\S]*?)<\/entry>/gi;

  let matches = [...xml.matchAll(itemRegex)];
  const isAtom = matches.length === 0;
  if (isAtom) matches = [...xml.matchAll(entryRegex)];

  for (const match of matches.slice(0, ITEMS_PER_FEED)) {
    const block = match[1]!;
    const title = extractTag(block, 'title');
    if (!title) continue;

    let link: string;
    if (isAtom) {
      const hrefMatch = block.match(/<link[^>]+href=["']([^"']+)["']/);
      link = hrefMatch?.[1] ?? '';
    } else {
      link = extractTag(block, 'link');
    }
    if (!link) continue;

    const pubStr = isAtom
      ? (extractTag(block, 'published') || extractTag(block, 'updated'))
      : extractTag(block, 'pubDate');
    const date = pubStr ? new Date(pubStr) : null;
    const publishedAt = date && !Number.isNaN(date.getTime()) ? date.getTime() : 0;

    items.push({ source: source.name, title, link, publishedAt });
  }

  return items;
}

async function fetchSourceWithCache(source: NewsSource, signal: AbortSignal): Promise<RawItem[]> {
  const cacheKey = `live-news:rss:v1:${source.url}`;
  try {
    const items = await cachedFetchJson<{ items: RawItem[] }>(
      cacheKey,
      PER_FEED_TTL_S,
      async () => {
        const xml = await fetchRssText(source.url, signal);
        if (!xml) return null;
        const parsed = parseFeed(xml, source);
        if (parsed.length === 0) return null;
        return { items: parsed };
      },
      120, // negative TTL — short so sources self-heal quickly
    );
    return items?.items ?? [];
  } catch {
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Title fingerprinting (dedup + LLM cache key)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Normalise a title for fingerprinting:
 *   - lowercase
 *   - strip punctuation/symbols
 *   - collapse whitespace
 *   - take first 80 chars (most stories share the same opening)
 *
 * The 80-char prefix is the dedup heuristic: AP/Reuters/CNN often headline
 * the same event with near-identical openings.
 */
export function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

/** SHA-256 hex of normalized title — stable LLM-cache key. */
export async function titleHash(title: string): Promise<string> {
  return sha256Hex(normalizeTitle(title));
}

// ─────────────────────────────────────────────────────────────────────────────
// Public: build the digest (without LLM enrichment — that runs separately)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetch all sources, parse, dedupe, age-filter, and produce the base digest
 * with `location` left null. The enrichment step fills in `location`/etc.
 */
export async function buildBaseDigest(signal: AbortSignal): Promise<{
  items: LiveNewsItem[];
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
}> {
  const now = Date.now();
  const cutoff = now - MAX_AGE_MS;

  const settled = await Promise.allSettled(
    US_NEWS_SOURCES.map((src) => fetchSourceWithCache(src, signal)),
  );

  const feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'> = {};
  const allRaw: RawItem[] = [];

  settled.forEach((result, i) => {
    const src = US_NEWS_SOURCES[i]!;
    if (result.status === 'rejected') {
      feedStatuses[src.name] = 'timeout';
      return;
    }
    const arr = result.value;
    feedStatuses[src.name] = arr.length > 0 ? 'ok' : 'empty';
    allRaw.push(...arr);
  });

  // Dedup by 80-char title fingerprint, keeping the freshest copy.
  const dedupMap = new Map<string, RawItem>();
  for (const item of allRaw) {
    const key = normalizeTitle(item.title);
    const existing = dedupMap.get(key);
    if (!existing || item.publishedAt > existing.publishedAt) {
      dedupMap.set(key, item);
    }
  }

  // Age filter — drop anything older than 3 days (and items with no date,
  // which would otherwise sort to the bottom and cap our digest size with
  // junk).
  const fresh = [...dedupMap.values()].filter((it) => it.publishedAt > 0 && it.publishedAt >= cutoff);

  fresh.sort((a, b) => b.publishedAt - a.publishedAt);
  const top = fresh.slice(0, MAX_ITEMS);

  // Assemble the digest items in parallel — `titleHash` is async (Web Crypto).
  const items: LiveNewsItem[] = await Promise.all(
    top.map(async (it) => {
      const breaking = detectBreaking(it.title, it.publishedAt, now);
      return {
        source: it.source,
        title: it.title,
        link: it.link,
        publishedAt: it.publishedAt,
        isAlert: breaking.isAlert,
        titleHash: await titleHash(it.title),
        location: null,
        locationName: null,
        confidence: null,
        country: null,
      };
    }),
  );

  return { items, feedStatuses };
}
