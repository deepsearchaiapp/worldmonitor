/**
 * `GET /api/world-brief/v1/refresh` — cron-only.
 *
 * Schedule in vercel.json: hourly at :12 (after the :09 enrich cron, so the
 * digest's `isConflict` flags are fresh). Reads `live-news:v6:digest`, ranks
 * the most-referenced clusters, asks Gemini for an original-wording factual
 * brief of the top 8 per section, and writes `news:world-brief:v1`.
 *
 * Like the v6 RSS refresh this returns 202 immediately and finishes in the
 * background via `keepAlive` — two sequential-fallback Gemini calls can run
 * past the 25 s Edge initial-response cap. The work is idempotent.
 */

import { refreshWorldBrief } from '../../../server/world-brief/v1/_generate';
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

  keepAlive(
    refreshWorldBrief().then(
      (result) => {
        console.log('[world-brief:refresh] completed:', JSON.stringify(result));
        return result;
      },
      (err) => {
        console.error('[world-brief:refresh] background failed:', err instanceof Error ? err.message : err);
      },
    ),
    'world-brief-refresh',
  );

  return new Response(
    JSON.stringify({ status: 'queued', startedAt: new Date().toISOString() }),
    { status: 202, headers },
  );
}
