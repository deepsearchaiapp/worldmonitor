/**
 * HTTP entry — `GET /api/live-sports/v1/list-us-events`
 *
 * Vanilla edge function (mirrors api/rss-proxy.js). Does CORS,
 * API-key check, rate-limit, then delegates to the core handler.
 *
 * Response is JSON with shape `ListUsSportsEventsResponse`:
 *   { items: SportEventItem[], leagueStatuses: {...}, generatedAt: ISO }
 *
 * Caching: 30 s edge cache + 30 s Redis (per-league + top-level digest).
 * The Cache-Control header lets Vercel's CDN serve subsequent requests
 * directly without invoking this function.
 */

// @ts-expect-error — sibling .js helpers without local type declarations
import { getCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
// @ts-expect-error
import { validateApiKey } from '../../_api-key.js';
// @ts-expect-error
import { checkRateLimit } from '../../_rate-limit.js';
import { listUsSportsEvents } from '../../../server/live-sports/v1/list-us-events';

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
    const body = await listUsSportsEvents();
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json',
        // CDN: 30 s fresh, 60 s stale-while-revalidate, 5 min stale-if-error
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=60, stale-if-error=300',
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[live-sports] handler failed:', msg);
    return new Response(JSON.stringify({ error: 'Internal error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json', ...corsHeaders },
    });
  }
}
