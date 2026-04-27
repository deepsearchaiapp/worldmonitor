/**
 * HTTP entry — `GET /api/live-news/v1/list-us-headlines`
 *
 * Vanilla edge function (mirrors api/rss-proxy.js + api/live-sports/v1/...).
 * Does CORS, API-key check, rate-limit, then delegates to the core handler.
 *
 * Response body shape: `ListUsHeadlinesResponse` from
 * `server/live-news/v1/list-us-headlines.ts`.
 *
 * Caching: 30 s edge cache + 30 s Redis (top-level digest) + 10 min Redis
 * (per-feed) + 30 day Redis (per-headline LLM-enriched location).
 */

// @ts-expect-error — sibling .js helpers without local type declarations
import { getCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
// @ts-expect-error
import { validateApiKey } from '../../_api-key.js';
// @ts-expect-error
import { checkRateLimit } from '../../_rate-limit.js';
import { listUsHeadlines } from '../../../server/live-news/v1/list-us-headlines';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), {
      status: 405,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const keyCheck = validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return new Response(JSON.stringify({ error: keyCheck.error }), {
      status: 401,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }

  const rateLimitResponse = await checkRateLimit(req, corsHeaders);
  if (rateLimitResponse) return rateLimitResponse;

  try {
    const body = await listUsHeadlines();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        // CDN: 30 s fresh, 60 s SWR, 5 min stale-if-error.
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60, stale-if-error=300',
      },
    });
  } catch (err) {
    console.error('[live-news] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
