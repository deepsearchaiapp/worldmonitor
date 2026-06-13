/**
 * HTTP entry — `GET /api/world-brief/v1/weekly-digest?regionId=<id>&category=<id>`
 *
 * A 7-day rollup for one region × category, assembled from the hourly brief
 * snapshots the refresh-regions cron already wrote. Runs NO LLM and generates
 * NO brief — pure read-side aggregation (see server/world-brief/v1/weekly-
 * digest.ts for the logic). Returns up to 15 distinct most-referenced stories
 * across the week, deduped by shared source URL.
 *
 * Optional `at=<unix seconds>` overrides the anchor time (defaults to now) —
 * the same-time-of-day pivot the daily slots are taken from.
 *
 * Cache policy follows the never-cache-empty rule:
 *   • populated → 200, long CDN cache (s-maxage=300, stale-if-error=24h)
 *   • no snapshots yet → 404, no-store
 *   • Redis read failed → 503, no-store
 *   • bad/missing regionId or category → 400, no-store
 */

// @ts-expect-error -- JS helper, no types
import { getCorsHeaders, isDisallowedOrigin } from '../../_cors.js';
// @ts-expect-error -- JS helper, no types
import { validateApiKey } from '../../_api-key.js';
// @ts-expect-error -- JS helper, no types
import { checkRateLimit } from '../../_rate-limit.js';
import { isRegionId } from '../../../server/world-brief/v1/get-region';
import {
  getRegionWeeklyDigest,
  normalizeDigestCategory,
} from '../../../server/world-brief/v1/weekly-digest';

export const config = { runtime: 'edge' };

export default async function handler(req: Request): Promise<Response> {
  const corsHeaders = getCorsHeaders(req, 'GET, OPTIONS');
  const jsonHeaders = { 'Content-Type': 'application/json', ...corsHeaders };

  if (isDisallowedOrigin(req)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), { status: 403, headers: jsonHeaders });
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: jsonHeaders });
  }

  const keyCheck = validateApiKey(req);
  if (keyCheck.required && !keyCheck.valid) {
    return new Response(JSON.stringify({ error: keyCheck.error }), { status: 401, headers: jsonHeaders });
  }

  const rl = await checkRateLimit(req, corsHeaders);
  if (rl) return rl;

  // Empty/error responses must never be CDN-cached (never-cache-empty rule).
  const noStore = { ...jsonHeaders, 'Cache-Control': 'no-store' };

  const url = new URL(req.url);
  const rawRegion = url.searchParams.get('regionId');
  const regionId = rawRegion && rawRegion.trim() ? rawRegion.trim() : null;
  if (!isRegionId(regionId)) {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid regionId', regionId: regionId ?? null }),
      { status: 400, headers: noStore },
    );
  }

  const category = normalizeDigestCategory(url.searchParams.get('category'));
  if (!category) {
    return new Response(
      JSON.stringify({ error: 'Missing or invalid category', category: url.searchParams.get('category') ?? null }),
      { status: 400, headers: noStore },
    );
  }

  // Optional `at=<unix seconds>` anchor; absent/empty/invalid → now. Guard the
  // empty string explicitly: Number('') === 0 is finite, which would silently
  // anchor the whole digest to the 1970 epoch.
  const atRaw = url.searchParams.get('at');
  const atSeconds = atRaw && atRaw.trim() !== '' ? Number(atRaw) : NaN;
  const nowMs = Number.isFinite(atSeconds) && atSeconds > 0 ? atSeconds * 1000 : Date.now();

  try {
    const result = await getRegionWeeklyDigest(regionId, category, nowMs);
    switch (result.status) {
      case 'ok':
        return new Response(JSON.stringify(result.payload), {
          status: 200,
          headers: {
            ...jsonHeaders,
            // A 7-day rollup moves very little hour-to-hour (one new hourly
            // snapshot barely shifts a top-15), so it caches MORE aggressively
            // than get-region (300s): 15-min edge cache collapses the ~182
            // (region × category) URLs to a handful of origin reads even under
            // heavy use, and each origin read is 7 snapshot GETs. Long
            // stale-if-error rides out a Redis blip (never-cache-empty).
            'Cache-Control': 'public, s-maxage=900, stale-while-revalidate=600, stale-if-error=86400',
          },
        });
      case 'empty':
        return new Response(
          JSON.stringify({ error: 'No weekly digest for this region/category yet', regionId, category }),
          { status: 404, headers: noStore },
        );
      case 'unavailable':
        return new Response(
          JSON.stringify({ error: 'Weekly digest temporarily unavailable', regionId, category }),
          { status: 503, headers: noStore },
        );
    }
  } catch (err) {
    console.error('[world-brief:v1:weekly-digest] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers: noStore });
  }
}
