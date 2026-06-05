/**
 * `GET /api/world-brief/v1/refresh-regional` — cron-only.
 *
 * Refreshes one region's conflict brief plus 9 intel-category world-brief
 * cells per run and merges them into `news:world-brief-regional:v1`. The
 * shard rotates by half-hour slot, so the full 8-region matrix refreshes in
 * about 4 hours when scheduled twice hourly.
 */

import {
  isRegionId,
  pickRegionalWorldBriefShard,
  refreshRegionalWorldBrief,
} from '../../../server/world-brief/v1/_generate';
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

  const url = new URL(req.url);
  const requestedRegion = url.searchParams.get('region');
  const region = isRegionId(requestedRegion)
    ? requestedRegion
    : pickRegionalWorldBriefShard();

  keepAlive(
    refreshRegionalWorldBrief({ region }).then(
      (result) => {
        console.log('[world-brief:regional:refresh] completed:', JSON.stringify(result));
        return result;
      },
      (err) => {
        console.error(
          '[world-brief:regional:refresh] background failed:',
          err instanceof Error ? err.message : err,
        );
      },
    ),
    'world-brief-regional-refresh',
  );

  return new Response(
    JSON.stringify({ status: 'queued', region, startedAt: new Date().toISOString() }),
    { status: 202, headers },
  );
}
