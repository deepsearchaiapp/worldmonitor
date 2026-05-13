/**
 * `GET /api/conflict-archive/v3/list` — handler core.
 *
 * Reads the Webz conflict archive at `conflict:archive:webz:v1`.
 * Wire-compatible with v2 / v1, real source + real link (licensed feed).
 *
 * The archive is populated by:
 *   • One-shot manual bootstrap at /api/conflict-archive/v3/refresh-webz
 *   • Organic growth from the live-news v4 enrichment cron — when the
 *     LLM tags a live-news-webz item as conflict, it gets copied here.
 */

import { cachedFetchJson, getCachedJson } from '../../_shared/redis';
import type { ConflictArchiveItemV3 } from './refresh';
import { ARCHIVE_WEBZ_KEY } from './refresh';

const DIGEST_KEY = 'conflict-archive:webz:v1:digest';
const TOP_LEVEL_TTL_S = 30;

export interface ListConflictArchiveV3Response {
  items: Array<{
    source: string;
    title: string;
    link: string;
    publishedAt: number;
    isAlert: boolean;
    summary: string | null;
    locationName: string | null;
    country: string | null;
    region?: string | null;
    location: { latitude: number; longitude: number } | null;
    sources: Array<{
      source: string;
      title: string;
      link: string;
      publishedAt: number;
    }> | null;
    isConflict: boolean;
    origin: 'webz' | 'worldnews' | 'live-news' | 'gdelt';
  }>;
  generatedAt: string;
}

export async function listConflictArchiveV3(): Promise<ListConflictArchiveV3Response> {
  const cached = await cachedFetchJson<ListConflictArchiveV3Response>(
    DIGEST_KEY,
    TOP_LEVEL_TTL_S,
    async () => {
      const archived = ((await getCachedJson(ARCHIVE_WEBZ_KEY)) as ConflictArchiveItemV3[] | null) ?? [];

      const items = archived.map((it) => ({
        source: it.source,
        title: it.title,
        link: it.link,
        publishedAt: it.publishedAt,
        isAlert: it.isAlert,
        summary: it.summary,
        locationName: it.locationName,
        country: it.country,
        region: it.region ?? null,
        location: it.location,
        sources: it.sources,
        isConflict: true,
        origin: it.origin,
      }));

      console.log(`[conflict-archive:v3] returning ${items.length} archived items`);

      return {
        items,
        generatedAt: new Date().toISOString(),
      };
    },
  );

  return cached ?? { items: [], generatedAt: new Date().toISOString() };
}
