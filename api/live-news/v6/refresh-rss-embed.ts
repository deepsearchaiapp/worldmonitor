/**
 * `GET /api/live-news/v6/refresh-rss-embed` — cron-only.
 *
 * Schedule in vercel.json: every 15 min. Pulls RSS feeds, embeds new
 * items via Gemini, clusters at threshold 0.7, writes the v6 digest.
 *
 * # Why this returns 202 immediately and runs in background
 *
 * Vercel Edge functions have a HARD 25 s initial-response cap that
 * applies on every plan, including Pro. `maxDuration` only extends
 * how long the function can keep running AFTER the initial response
 * goes out — useful for streaming, useless for a sync await that
 * holds the response open. With 158 RSS feeds being fan-fetched +
 * Gemini embedding + Redis writes, the full refresh takes 25-40 s
 * and the function gets killed mid-flight with "did not return an
 * initial response within 25 s".
 *
 * The fix: kick off the work via `keepAlive` (Vercel's `waitUntil`)
 * and return 202 right away. Pro lets that background work run for
 * up to 300 s, plenty of headroom. Cron monitor sees a fast 2xx and
 * keeps the schedule firing on time.
 *
 * Subsequent ticks are safe to overlap with in-flight work: every
 * step (per-feed cache, embedding cache, digest write) is idempotent.
 */

import { refreshLiveNewsV6 } from '../../../server/live-news/v6/refresh';
import { keepAlive } from '../../../server/_shared/keep-alive';

export const config = { runtime: 'edge', maxDuration: 300 };

function isAuthorizedCron(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = req.headers.get('authorization') ?? '';
    if (auth === `Bearer ${secret}`) return true;
  }
  const ua = (req.headers.get('user-agent') ?? '').toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  return false;
}

export default async function handler(req: Request): Promise<Response> {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (req.method !== 'GET') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers });
  }
  if (!isAuthorizedCron(req)) {
    return new Response(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }), { status: 403, headers });
  }

  // Kick off the refresh in the background — see file header for why.
  // The `.then(...)` arms write the result/error to Vercel logs so we
  // still see the per-tick summary; the HTTP response races out long
  // before the work completes.
  keepAlive(
    refreshLiveNewsV6().then(
      (result) => {
        console.log('[live-news:v6:refresh] completed:', JSON.stringify(result));
        return result;
      },
      (err) => {
        console.error('[live-news:v6:refresh] background failed:', err instanceof Error ? err.message : err);
      },
    ),
    'live-news-v6-refresh',
  );

  return new Response(
    JSON.stringify({ status: 'queued', startedAt: new Date().toISOString() }),
    { status: 202, headers },
  );
}
