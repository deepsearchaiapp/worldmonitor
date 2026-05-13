/**
 * `GET /api/conflict-archive/v3/refresh-webz` — manual seed endpoint.
 *
 * Not on the cron schedule. Hit it once after deploy to pre-fill the
 * webz conflict archive so the iOS map isn't empty on day one:
 *   curl -H "Authorization: Bearer $CRON_SECRET" \
 *        https://<your-domain>/api/conflict-archive/v3/refresh-webz
 *
 * After the seed, the archive grows organically as the live-news v4
 * enrichment cron tags items isConflict=true and copies them in.
 *
 * Auth: Bearer CRON_SECRET, or "vercel-cron" user-agent.
 */

import { refreshConflictArchiveV3 } from '../../../server/conflict-archive/v3/refresh';

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
    const result = await refreshConflictArchiveV3();
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    console.error('[conflict-archive:v3:refresh] handler failed:', err instanceof Error ? err.message : err);
    return new Response(JSON.stringify({ error: 'Internal error' }), { status: 500, headers });
  }
}
