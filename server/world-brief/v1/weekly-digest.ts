/**
 * Weekly digest — read side. Aggregates the ALREADY-GENERATED hourly brief
 * snapshots for one region × category into a single 7-day rollup. This
 * endpoint runs NO LLM and triggers NO brief generation; it only reads the
 * snapshots the refresh-regions cron already wrote
 * (`news:world-brief:region:<id>:hour:<YYYYMMDDHH>`, indexed at
 * `news:world-brief:region:<id>:index`).
 *
 * Logic (per the product spec):
 *   1. Anchor at the request time (or `at=`). For each of the last 7 days
 *      (including today), take the snapshot at the SAME time-of-day — e.g. a
 *      request at 12:43 pulls today's ~12:00 snapshot, yesterday's ~12:00,
 *      and so on. Hourly granularity; a missing hour resolves to the nearest
 *      snapshot within a few hours so a single missed cron tick doesn't drop
 *      a whole day.
 *   2. Each day's snapshot contributes up to 8 clusters for the category
 *      (conflict / liveNews / any category section incl. merged security &
 *      politics).
 *   3. Collapse duplicates across days — two clusters are the SAME story when
 *      they share ANY full source URL (normalised: fragment + trailing slash
 *      dropped, case-folded; path + query kept). The most-referenced instance
 *      (highest sourceCount) represents the story; recurrence is tallied.
 *   4. Return the top 15 distinct stories by source count. No synthesis,
 *      no LLM.
 */

import { getCachedJson } from '../../_shared/redis';
import { type RegionId } from '../../_shared/geo-regions';
import {
  CATEGORY_IDS,
  regionBriefIndexKey,
  regionBriefSnapshotKey,
  hourBucketToMs,
  regionBriefHourBucket,
  normalizeUrl,
  type WorldBriefPayload,
  type WorldBriefSection,
  type WorldBriefCluster,
} from './_generate';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Days of history to roll up — today + the previous 6. */
const DIGEST_DAYS = 7;
/** Per-day slot tolerance: a day's same-hour target resolves to the nearest
 *  snapshot within ±this. 6h tolerates several missed cron hours while staying
 *  far inside the 24h gap to the adjacent day's slot (no cross-day bleed). */
const SLOT_WINDOW_MS = 6 * 60 * 60 * 1000;
/** Final story count. */
const TOP_NEWS = 15;

/** Categories this endpoint accepts: the two top-level sections + every
 *  category id (incl. merged `security` / `politics`). */
const DIGEST_CATEGORIES: ReadonlySet<string> = new Set<string>([
  'conflict', 'liveNews', ...CATEGORY_IDS,
]);

/** Narrow + canonicalise a category query param. Accepts the `live-news`
 *  spelling as an alias for `liveNews`; returns null when unrecognised. */
export function normalizeDigestCategory(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const v = raw.trim();
  if (v === 'live-news' || v === 'livenews') return 'liveNews';
  return DIGEST_CATEGORIES.has(v) ? v : null;
}

/** Pull the requested section out of a snapshot payload. */
function sectionFor(payload: WorldBriefPayload, category: string): WorldBriefSection | null {
  if (category === 'conflict') return payload.conflict;
  if (category === 'liveNews') return payload.liveNews;
  return payload.categories?.[category] ?? null;
}

/** One rolled-up story — the brief cluster shape iOS already decodes, plus
 *  weekly metadata. Extra fields are additive (old clients ignore them). */
export interface WeeklyDigestItem extends WorldBriefCluster {
  /** Distinct days (of the 7) this story appeared in. ≥1. */
  dayCount: number;
}

export interface WeeklyDigestPayload {
  regionId: RegionId;
  category: string;
  /** When this rollup was assembled (anchor time), epoch ms. */
  generatedAt: number;
  /** Distinct daily snapshots that contributed (≤ DIGEST_DAYS; fewer until a
   *  full week of history has accrued). */
  daysCovered: number;
  /** Top stories, most-referenced first, deduped across the week. */
  news: WeeklyDigestItem[];
}

export type WeeklyDigestResult =
  | { status: 'ok'; payload: WeeklyDigestPayload }
  | { status: 'empty' }
  | { status: 'unavailable' };

/** UTC calendar date "YYYYMMDD" of an hour bucket. */
function bucketDay(bucket: string): string {
  return bucket.slice(0, 8);
}

/**
 * Resolve the snapshot buckets to load: for each of the last DIGEST_DAYS
 * days, the bucket nearest the same-time-of-day target, within SLOT_WINDOW_MS.
 *
 * Collapsed to AT MOST ONE bucket per UTC calendar day (the one closest to
 * any slot target). The ±SLOT_WINDOW_MS fallback can reach across a UTC
 * midnight, so two adjacent day-slots could otherwise both land on the same
 * calendar day — double-counting that day's stories (up to 16) and inflating
 * the day tally. One-per-calendar-day matches the spec's "one brief per day"
 * intent and makes `daysCovered` a true distinct-day count.
 *
 * Exported for unit testing.
 */
export function chooseBuckets(index: string[], nowMs: number): string[] {
  const available = index
    .filter((b) => typeof b === 'string' && /^\d{10}$/.test(b))
    .map((b) => ({ bucket: b, ms: hourBucketToMs(b) }))
    .filter((b) => Number.isFinite(b.ms));
  if (available.length === 0) return [];

  // Best (closest-to-its-slot-target) bucket per UTC calendar day.
  const byDay = new Map<string, { bucket: string; dist: number }>();
  for (let d = 0; d < DIGEST_DAYS; d++) {
    const target = nowMs - d * DAY_MS;
    const exact = regionBriefHourBucket(new Date(target));
    let pick: string | null = null;
    let pickDist = Infinity;
    const exactHit = available.find((a) => a.bucket === exact);
    if (exactHit) {
      pick = exact;
      pickDist = Math.abs(exactHit.ms - target);
    } else {
      for (const a of available) {
        const dist = Math.abs(a.ms - target);
        if (dist <= SLOT_WINDOW_MS && dist < pickDist) {
          pickDist = dist;
          pick = a.bucket;
        }
      }
    }
    if (!pick) continue;
    const day = bucketDay(pick);
    const existing = byDay.get(day);
    if (!existing || pickDist < existing.dist) byDay.set(day, { bucket: pick, dist: pickDist });
  }
  return [...byDay.values()].map((v) => v.bucket);
}

/** A cluster collected from a snapshot, with its normalised URL set. */
interface Candidate {
  cluster: WorldBriefCluster;
  day: string;
  urls: string[];
  score: number;
}

/** A kept (deduped) story under assembly. */
interface Kept {
  cluster: WorldBriefCluster;
  days: Set<string>;
  score: number;
}

/**
 * Cross-day dedup via union-find. "Same story" — sharing a cluster id OR ANY
 * full source URL — is a TRANSITIVE relation: if C shares one URL with A and a
 * different URL with B, then A, B, C are all one story. A greedy first-match
 * fold misses that (B would ship as a duplicate); union-find collapses every
 * connected component correctly regardless of candidate order.
 *
 * Per component: the representative is the highest-sourceCount instance (the
 * "most referenced" version), `score` is that max, and `days` is the union of
 * every contributing day. Exported for unit testing.
 */
export function dedupe(candidates: Candidate[]): Kept[] {
  const n = candidates.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let r = x;
    while (parent[r] !== r) r = parent[r]!;
    while (parent[x] !== r) { const next = parent[x]!; parent[x] = r; x = next; }
    return r;
  };
  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  // Link any two candidates that share a cluster id or a normalised URL.
  const idOwner = new Map<string, number>();
  const urlOwner = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const c = candidates[i]!;
    const prevId = idOwner.get(c.cluster.id);
    if (prevId !== undefined) union(i, prevId);
    else idOwner.set(c.cluster.id, i);
    for (const u of c.urls) {
      const prevU = urlOwner.get(u);
      if (prevU !== undefined) union(i, prevU);
      else urlOwner.set(u, i);
    }
  }

  // Collapse each connected component into one kept story.
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    let arr = groups.get(root);
    if (!arr) { arr = []; groups.set(root, arr); }
    arr.push(i);
  }

  const kept: Kept[] = [];
  for (const idxs of groups.values()) {
    let rep = candidates[idxs[0]!]!;
    const days = new Set<string>();
    let score = -Infinity;
    for (const i of idxs) {
      const c = candidates[i]!;
      days.add(c.day);
      if (c.score > score) score = c.score;
      if (c.score > rep.score
        || (c.score === rep.score && c.cluster.publishedAt > rep.cluster.publishedAt)) {
        rep = c;
      }
    }
    kept.push({ cluster: rep.cluster, days, score });
  }

  return kept;
}

/**
 * Assemble the weekly digest for one region × category from existing
 * snapshots. Read-only; never generates a brief.
 */
export async function getRegionWeeklyDigest(
  regionId: RegionId,
  category: string,
  nowMs: number,
): Promise<WeeklyDigestResult> {
  let index: string[] | null;
  try {
    index = (await getCachedJson(
      regionBriefIndexKey(regionId),
      false,
      undefined,
      true, // strict — operational failure throws (→ unavailable, never cache-empty)
    )) as string[] | null;
  } catch (err) {
    console.error(
      `[world-brief:weekly-digest:${regionId}/${category}] index read failed:`,
      err instanceof Error ? err.message : err,
    );
    return { status: 'unavailable' };
  }

  const buckets = chooseBuckets(Array.isArray(index) ? index : [], nowMs);
  if (buckets.length === 0) return { status: 'empty' };

  // Load the chosen snapshots in parallel. A single snapshot read failing is
  // best-effort (that day drops); we only fail the whole digest if EVERY read
  // errors (operational) — distinguished from genuinely-empty sections.
  let readErrors = 0;
  const snapshots = await Promise.all(
    buckets.map(async (bucket) => {
      try {
        const payload = (await getCachedJson(
          regionBriefSnapshotKey(regionId, bucket),
          false,
          undefined,
          true,
        )) as WorldBriefPayload | null;
        return payload ? { bucket, payload } : null;
      } catch (err) {
        readErrors++;
        console.warn(
          `[world-brief:weekly-digest:${regionId}/${category}] snapshot ${bucket} read failed:`,
          err instanceof Error ? err.message : err,
        );
        return null;
      }
    }),
  );

  const loaded = snapshots.filter((s): s is { bucket: string; payload: WorldBriefPayload } => s !== null);
  if (loaded.length === 0) {
    // Index pointed at buckets but none could be read.
    return readErrors > 0 ? { status: 'unavailable' } : { status: 'empty' };
  }

  // Collect every category cluster across the loaded days.
  const candidates: Candidate[] = [];
  for (const { bucket, payload } of loaded) {
    const section = sectionFor(payload, category);
    const clusters = section?.clusters;
    if (!Array.isArray(clusters)) continue;
    const day = bucketDay(bucket);
    for (const cluster of clusters) {
      if (!cluster || typeof cluster.id !== 'string') continue;
      const urls = Array.isArray(cluster.sources)
        ? cluster.sources
            .map((s) => (s && typeof s.url === 'string' && s.url ? normalizeUrl(s.url) : ''))
            .filter((u) => u.length > 0)
        : [];
      candidates.push({
        cluster,
        day,
        urls,
        score: typeof cluster.sourceCount === 'number' ? cluster.sourceCount : 0,
      });
    }
  }

  if (candidates.length === 0) {
    // Snapshots read fine but the category had nothing to brief all week.
    return { status: 'empty' };
  }

  // dedupe() is order-independent (union-find), so no pre-sort is needed for
  // correctness — the kept stories are ranked below.
  const kept = dedupe(candidates);

  // Final ordering: source count desc, then recurrence (more days = more
  // significant over the week), then recency.
  kept.sort(
    (a, b) =>
      b.score - a.score ||
      b.days.size - a.days.size ||
      b.cluster.publishedAt - a.cluster.publishedAt,
  );

  const news: WeeklyDigestItem[] = kept.slice(0, TOP_NEWS).map((k) => ({
    ...k.cluster,
    dayCount: k.days.size,
  }));

  return {
    status: 'ok',
    payload: {
      regionId,
      category,
      generatedAt: nowMs,
      // Distinct UTC calendar days that contributed (chooseBuckets already
      // caps at one bucket per day, but compute from days to be exact).
      daysCovered: new Set(loaded.map((s) => bucketDay(s.bucket))).size,
      news,
    },
  };
}
