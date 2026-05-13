/**
 * Webz.io News API Lite client — paid licensed feed evaluated alongside
 * worldnewsapi for the live-news + conflict-archive pipelines.
 *
 * Endpoint family:
 *   • GET /newsApiLite — only endpoint available on the Lite tier.
 *
 * Auth: `?token=...` query param (see WEBZ_API_TOKEN env var).
 *
 * Quota (Lite tier):
 *   • 1,000 calls / month
 *   • 10 posts per call
 *   • 30-day historical window
 *   • 3-day default search range
 *   • Every response includes `requestsLeft` so we can self-throttle.
 *
 * Search syntax: Lucene-like
 *   q=language:english thread.country:(US OR GB OR AU OR CA)
 *   q=(airstrike OR "missile strike" OR shelling) language:english
 *
 * The client returns `null` on any failure rather than throwing — same
 * contract as the worldnews client. Callers (crons, mostly) treat null
 * as "skip this run, accumulator keeps the last good payload."
 */

const API_BASE = 'https://api.webz.io';
const DEFAULT_TIMEOUT_MS = 8_000;

/** Shared back-off — webz quotas reset monthly so when we hit the cap we
 *  back off for the rest of the day rather than retrying in tight loops. */
let backoffUntilMs = 0;
let lastBackoffReason: 'rate-limit' | 'quota-exhausted' | null = null;

/** In-flight coalescing — concurrent identical requests share one upstream
 *  call. Keyed by the full URL (token included since it's a query param,
 *  but the same key string is reused). */
const inflight = new Map<string, Promise<unknown>>();

function getToken(): string | null {
  const t = process.env.WEBZ_API_TOKEN;
  if (!t) {
    console.warn('[webz] WEBZ_API_TOKEN env var is not set — all calls will be skipped');
    return null;
  }
  return t;
}

// ─────────────────────────────────────────────────────────────────────────
// Response shapes — only fields we actually consume.
//
// All optional except `uuid` + `url` + `published`. The Lite tier omits a
// lot of fields on a per-article basis (saw `summary` missing on most
// articles, `text` truncated to ~200 chars or replaced by a "Full text
// is unavailable..." sentinel string on some). The mapper in the cron
// is defensive about every field.
// ─────────────────────────────────────────────────────────────────────────

export interface WebzThread {
  uuid?: string;
  url?: string;
  site_full?: string;     // e.g. "www.independent.ie"
  site?: string;          // e.g. "independent.ie" — already a bare hostname
  site_section?: string;
  site_title?: string;
  section_title?: string;
  site_type?: string;     // "news"
  title?: string;
  title_full?: string;
  published?: string;
  replies_count?: number;
  participants_count?: number;
  country?: string;       // ISO alpha-2 — country of the outlet, NOT story location
  main_image?: string;
  performance_score?: number;
  domain_rank?: number;
}

export interface WebzEntities {
  persons?: Array<{ name: string; sentiment?: string }>;
  locations?: Array<{ name: string; sentiment?: string }>;
  organizations?: Array<{ name: string; sentiment?: string; tickers?: string[] }>;
}

export interface WebzPost {
  uuid: string;
  url: string;
  thread?: WebzThread;
  ord_in_thread?: number;
  parent_url?: string | null;
  author?: string | null;
  published: string;              // ISO 8601 with TZ offset
  updated?: string;
  crawled?: string;
  title: string;
  text?: string;                  // often truncated in Lite; sometimes a sentinel string
  highlightText?: string;         // search-result snippet with <em> tags
  highlightTitle?: string;
  highlightThreadTitle?: string;
  language?: string;              // "english" (not ISO code)
  sentiment?: string;             // "positive" | "negative" | "neutral"
  categories?: string[];
  topics?: string[];
  entities?: WebzEntities;
  external_links?: string[];
  external_images?: string[];
  internal_images?: string[];
  breaking?: boolean;
  ai_allow?: boolean;
  rating?: unknown;
  summary?: string;               // rarely populated on Lite
}

export interface WebzSearchResponse {
  posts: WebzPost[];
  totalResults: number;
  moreResultsAvailable: number;
  next: string | null;            // relative URL fragment for next page
  requestsLeft: number;           // monthly quota counter
  warnings?: string;
}

// ─────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────

export interface SearchNewsParams {
  /** Lucene-style query. Required by the API. */
  q: string;
  /** Cursor timestamp for pagination — comes from a previous response's
   *  `next` URL. Omit on the first call. */
  ts?: number;
}

export function searchNews(params: SearchNewsParams): Promise<WebzSearchResponse | null> {
  const qs = new URLSearchParams({ q: params.q });
  if (params.ts !== undefined) qs.set('ts', String(params.ts));
  return get<WebzSearchResponse>(`/newsApiLite`, qs);
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers — used by the crons that map the response into our wire shape.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Derive a clean hostname from a post. `thread.site` is already a bare
 * domain when present; otherwise fall back to parsing the URL.
 */
export function deriveSource(post: WebzPost): string {
  if (post.thread?.site) return post.thread.site.replace(/^www\./i, '');
  try {
    return new URL(post.url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/**
 * Parse Webz's ISO-8601-with-TZ-offset date string into a millisecond
 * epoch. Returns null if unparseable.
 */
export function parsePublishDate(s: string | undefined): number | null {
  if (!s) return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const TEXT_UNAVAILABLE_RE = /^\s*Full text is unavailable/i;

/**
 * License-safe summary derivation:
 *
 *   1. Use the API's own `summary` when present (verbatim).
 *   2. Otherwise use a slice of `text` (also API-provided, verbatim).
 *   3. Filter out the Lite-tier sentinel string and obvious junk.
 *   4. Return null if nothing usable — iOS treats null as "no summary,
 *      show the source web view directly".
 *
 * We NEVER LLM-rewrite the content. Per the licensing terms, only the
 * API's own text is republishable.
 */
export function deriveSummary(post: WebzPost, maxLen = 500): string | null {
  const fromSummary = post.summary?.trim();
  if (fromSummary && fromSummary.length > 0) {
    return fromSummary.slice(0, maxLen);
  }
  const text = post.text?.trim();
  if (!text) return null;
  if (TEXT_UNAVAILABLE_RE.test(text)) return null;
  if (text.length < 40) return null;          // tiny fragments aren't useful
  return text.slice(0, maxLen);
}

// ─────────────────────────────────────────────────────────────────────────
// Low-level GET. Mirrors the worldnews-client design — same back-off,
// in-flight coalescing, and quota logging conventions.
// ─────────────────────────────────────────────────────────────────────────

async function get<T>(path: string, params: URLSearchParams): Promise<T | null> {
  if (backoffUntilMs > Date.now()) {
    console.warn(
      `[webz] ${path} skipped — ${lastBackoffReason} back-off until ${new Date(backoffUntilMs).toISOString()}`,
    );
    return null;
  }

  const token = getToken();
  if (!token) return null;

  params.set('token', token);
  const url = `${API_BASE}${path}?${params.toString()}`;

  const existing = inflight.get(url) as Promise<T | null> | undefined;
  if (existing) return existing;

  const promise = (async (): Promise<T | null> => {
    try {
      const resp = await fetch(url, {
        headers: { 'Accept': 'application/json' },
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });

      // 429 — rate limit. Webz Lite docs don't promise a Retry-After
      // header; we back off 5 s and let the next tick try again.
      if (resp.status === 429) {
        backoffUntilMs = Date.now() + 5_000;
        lastBackoffReason = 'rate-limit';
        console.warn(`[webz] ${path} → 429 rate-limited, backing off 5s`);
        return null;
      }

      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.warn(`[webz] ${path} → HTTP ${resp.status} ${body.slice(0, 200)}`);
        // Quota-exhausted responses are typically wrapped as 402 / 403;
        // back off until UTC midnight regardless of the exact status so
        // we don't burn the cron's clock retrying.
        if (resp.status === 402 || resp.status === 403) {
          const now = new Date();
          backoffUntilMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0);
          lastBackoffReason = 'quota-exhausted';
        }
        return null;
      }

      const body = (await resp.json()) as T & { requestsLeft?: number; warnings?: string };
      if (typeof body?.requestsLeft === 'number') {
        console.log(`[webz] ${path} quota: requestsLeft=${body.requestsLeft}${body.warnings ? ` warnings="${body.warnings}"` : ''}`);
        // Self-throttle: when monthly quota is about to drain, back off
        // for the rest of the day so we don't burn the last few calls in
        // one fast cron sequence.
        if (body.requestsLeft <= 5) {
          const now = new Date();
          backoffUntilMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5, 0);
          lastBackoffReason = 'quota-exhausted';
          console.warn(`[webz] requestsLeft=${body.requestsLeft} — backing off until UTC tomorrow`);
        }
      }
      return body;
    } catch (err) {
      console.warn(`[webz] ${path} failed:`, err instanceof Error ? err.message : err);
      return null;
    } finally {
      inflight.delete(url);
    }
  })();

  inflight.set(url, promise);
  return promise;
}
