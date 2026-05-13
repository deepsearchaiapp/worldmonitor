/**
 * `GET /api/live-news/v4/refresh-webz` — cron-only endpoint.
 *
 * Runs on the schedule in vercel.json (currently every 30 min to fit the
 * Webz Lite free quota). Pulls posts from Webz.io and merges them into
 * `live-news:webz:v1:digest`. The read endpoint at
 * `/api/live-news/v4/list-us-headlines` serves whatever's in that key.
 *
 * Auth: Bearer CRON_SECRET, or "vercel-cron" user-agent.
 */

import { refreshLiveNewsV4 } from '../../../server/live-news/v4/refresh';

export const config = { runtime: 'edge' };

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

  try {
    const result = await refreshLiveNewsV4();
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    console.error('[live-news:v4:refresh] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers });
  }
}
