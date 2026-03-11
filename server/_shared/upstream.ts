/**
 * Upstream proxy — fetches data from the original worldmonitor.app API
 * when our own Redis cache is empty/stale.
 *
 * This lets us piggyback on their fully-populated infrastructure
 * (seed scripts, relay, API tokens) without needing our own.
 *
 * All requests include Origin + Referer headers to pass their CORS checks.
 * The iOS app never touches their API directly — only our Vercel edge does,
 * so if they ever block us we can swap the fetcher server-side without
 * shipping an app update.
 *
 * Their defenses (from reading their source):
 *   • Bot UA blocking — we send Chrome UA ✓
 *   • CORS whitelist — we send Origin: worldmonitor.app ✓
 *   • API key (optional for trusted origins) — not needed ✓
 *   • Rate limit: 600 req/60s per IP (Upstash sliding window)
 *   • ETag support — we use If-None-Match to save bandwidth ✓
 */

const UPSTREAM_BASE = 'https://api.worldmonitor.app';
const UPSTREAM_TIMEOUT_MS = 8_000;

const UPSTREAM_HEADERS: Record<string, string> = {
  'Origin': 'https://www.worldmonitor.app',
  'Referer': 'https://www.worldmonitor.app/',
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  'Accept': 'application/json',
};

/**
 * ETag cache — stores last-known ETag + body per path.
 * On 304 Not Modified we return the cached body without re-downloading.
 * Saves ~500KB per bootstrap call when data hasn't changed.
 */
const etagCache = new Map<string, { etag: string; body: unknown }>();

/** Track rate-limit state so we can back off before hitting 429. */
let rateLimitReset = 0; // epoch ms when the rate limit window resets

/**
 * Fetch JSON from the upstream API.
 * Features:
 *   • ETag / If-None-Match → avoids re-downloading unchanged data
 *   • Rate-limit awareness → backs off when close to 429
 *   • Graceful degradation → returns null on any failure
 */
export async function fetchUpstream<T = unknown>(
  path: string,
  timeoutMs = UPSTREAM_TIMEOUT_MS,
): Promise<T | null> {
  // If we recently got rate-limited, don't even try until the window resets
  if (rateLimitReset > Date.now()) {
    console.warn(`[upstream] ${path} — skipped (rate-limited until ${new Date(rateLimitReset).toISOString()})`);
    return null;
  }

  const url = `${UPSTREAM_BASE}${path}`;
  try {
    const headers: Record<string, string> = { ...UPSTREAM_HEADERS };

    // Send ETag for conditional request (saves bandwidth on unchanged data)
    const cached = etagCache.get(path);
    if (cached?.etag) {
      headers['If-None-Match'] = cached.etag;
    }

    const resp = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });

    // Track rate-limit headers for proactive back-off
    const remaining = resp.headers.get('x-ratelimit-remaining');
    const reset = resp.headers.get('x-ratelimit-reset');
    if (remaining === '0' && reset) {
      rateLimitReset = Number(reset);
      console.warn(`[upstream] rate limit exhausted, backing off until ${new Date(rateLimitReset).toISOString()}`);
    }

    // 304 Not Modified — return cached body (no bandwidth wasted)
    if (resp.status === 304 && cached?.body) {
      return cached.body as T;
    }

    // 429 Too Many Requests — respect Retry-After
    if (resp.status === 429) {
      const retryAfter = resp.headers.get('retry-after');
      rateLimitReset = Date.now() + (Number(retryAfter || 60) * 1000);
      console.warn(`[upstream] ${path} → 429, backing off ${retryAfter || 60}s`);
      return null;
    }

    if (!resp.ok) {
      console.warn(`[upstream] ${path} → HTTP ${resp.status}`);
      return null;
    }

    const body = (await resp.json()) as T;

    // Store ETag + body for future conditional requests
    const etag = resp.headers.get('etag');
    if (etag) {
      etagCache.set(path, { etag, body });
      // Cap cache size to prevent unbounded memory growth
      if (etagCache.size > 100) {
        const oldest = etagCache.keys().next().value;
        if (oldest) etagCache.delete(oldest);
      }
    }

    return body;
  } catch (err) {
    console.warn(`[upstream] ${path} failed:`, err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Fetch bootstrap tier from upstream and return the data map.
 * Used to backfill missing Redis keys.
 */
export async function fetchUpstreamBootstrap(
  tier: 'fast' | 'slow',
): Promise<Record<string, unknown> | null> {
  const result = await fetchUpstream<{ data?: Record<string, unknown>; missing?: string[] }>(
    `/api/bootstrap?tier=${tier}`,
  );
  if (!result?.data) return null;
  console.log(`[upstream] bootstrap/${tier} → ${Object.keys(result.data).length} keys (missing: ${result.missing?.length ?? 0})`);
  return result.data;
}
