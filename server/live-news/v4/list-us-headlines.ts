/**
 * `GET /api/live-news/v4/list-us-headlines` — handler core.
 *
 * Reads the Webz-fed accumulator at `live-news:webz:v1:digest`. Wire shape
 * is compatible with v3 / v2 / v1 so iOS decodes via the existing
 * `NewsItem` model.
 *
 * Source/link are real (Webz licenses the content) — no scrub.
 */

import { getCachedJson } from '../../_shared/redis';
import type { LiveNewsV4Item } from './refresh';

const DIGEST_KEY = 'live-news:webz:v1:digest';

export interface ListUsHeadlinesV4Response {
  items: LiveNewsV4Item[];
  /** Empty on v4 — kept for wire-shape parity with v2/v3. */
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
  generatedAt: string;
  pendingEnrichment: number;
  pendingParaphrase: number;
}

export async function listUsHeadlinesV4(): Promise<ListUsHeadlinesV4Response> {
  const items = ((await getCachedJson(DIGEST_KEY)) as LiveNewsV4Item[] | null) ?? [];

  const pendingEnrichment = items.filter((it) => it.location === null).length;
  // No LLM paraphrase in this pipeline — kept for wire-shape parity.
  const pendingParaphrase = items.filter((it) => it.summary === null).length;

  return {
    items,
    feedStatuses: {},
    generatedAt: new Date().toISOString(),
    pendingEnrichment,
    pendingParaphrase,
  };
}
