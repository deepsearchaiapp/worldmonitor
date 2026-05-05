/**
 * HTTP entry — `GET /api/intel-news/v1/refresh`
 *
 * Cron-only endpoint. Sequentially refreshes all 10 GDELT topic
 * accumulators with 5.5-second pacing between calls (per GDELT's
 * fair-use rate limit).
 *
 * Triggered by Vercel cron (configured in `vercel.json`'s `crons` block,
 * default schedule `*​/15 * * * *`). Manual invocation requires the
 * `CRON_SECRET` env var as a Bearer token — Vercel auto-attaches this
 * header to scheduled cron requests when the secret is set.
 *
 * # Why Node.js runtime (not edge)
 *
 * Vercel Edge functions cap "initial response" at ~25 s on Pro plan,
 * regardless of `maxDuration`. This handler does ~55 s of synchronous
 * GDELT work before responding, which blows past that limit.
 * Node.js runtime supports `maxDuration: 300` on Pro, so 55 s of work
 * fits comfortably with margin.
 *
 * No CORS handling — this endpoint is only called by Vercel cron
 * internally (no browser origin), so no preflight is needed.
 */

import type { IncomingMessage, ServerResponse } from 'http';
import { refreshAllTopics } from '../../../server/intel-news/v1/refresh';

export const config = {
  // 60 s gives the sequential 10-topic fan-out (≈55 s) plus 5 s housekeeping
  // budget. Pro plan supports up to 300 s if we ever need more.
  maxDuration: 60,
};

function isAuthorizedCron(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET;
  if (secret) {
    const auth = (req.headers.authorization ?? '') as string;
    if (auth === `Bearer ${secret}`) return true;
  }
  // Fallback: Vercel cron UA. Useful before CRON_SECRET is configured.
  const ua = ((req.headers['user-agent'] ?? '') as string).toLowerCase();
  if (ua.includes('vercel-cron')) return true;
  return false;
}

export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method !== 'GET') {
    res.statusCode = 405;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!isAuthorizedCron(req)) {
    res.statusCode = 403;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Forbidden — cron-only endpoint' }));
    return;
  }

  try {
    const result = await refreshAllTopics();
    res.statusCode = 200;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(result));
  } catch (err) {
    console.error('[intel-news:refresh] handler failed:', err instanceof Error ? err.message : err);
    res.statusCode = 500;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'Internal error' }));
  }
}
