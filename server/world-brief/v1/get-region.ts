/**
 * Read side of the regional briefs feature — serves a single per-region brief
 * to the iOS "My Briefs" feature.
 *
 * The dispatcher cron (`api/world-brief/v1/refresh-regions`) writes each
 * region's brief to `news:world-brief:region:<id>:v1`. This reader returns one
 * such payload on demand. The payload shape is the SAME `WorldBriefPayload`
 * the global brief uses (conflict + liveNews + per-category sections), so iOS
 * decodes it with the existing model and the app picks the requested category
 * section client-side (the region × category "cell").
 *
 * Three outcomes, kept distinct so the HTTP layer can honour the
 * never-cache-empty rule (read-fail → 503, empty → no-store, populated → long):
 *   • ok          — key present and decoded
 *   • empty       — genuine key miss (region not generated yet this cycle)
 *   • unavailable — Redis read failed (timeout / network / non-2xx)
 */

import { getCachedJson } from '../../_shared/redis';
import { REGION_IDS, type RegionId } from '../../_shared/geo-regions';
import {
  regionBriefKey,
  regionBriefIndexKey,
  regionBriefSnapshotKey,
  hourBucketToMs,
  type WorldBriefPayload,
} from './_generate';

/** Narrow an arbitrary string to a known region id (query-param validation). */
export function isRegionId(id: string | null | undefined): id is RegionId {
  return !!id && (REGION_IDS as readonly string[]).includes(id);
}

export type RegionBriefResult =
  | { status: 'ok'; payload: WorldBriefPayload }
  | { status: 'empty' }
  | { status: 'unavailable' };

/**
 * Read one region's brief. Uses the redis `strict` flag so an operational
 * failure is reported as `unavailable` rather than masquerading as an
 * empty/not-yet-generated brief — the latter must never be long-cached.
 */
export async function getRegionBrief(regionId: RegionId): Promise<RegionBriefResult> {
  try {
    const payload = (await getCachedJson(
      regionBriefKey(regionId),
      false,
      undefined, // default op timeout
      true, // strict — throw on operational failure, null only on genuine miss
    )) as WorldBriefPayload | null;

    if (!payload) return { status: 'empty' };
    return { status: 'ok', payload };
  } catch (err) {
    console.error(
      `[world-brief:get-region:${regionId}] read failed:`,
      err instanceof Error ? err.message : err,
    );
    return { status: 'unavailable' };
  }
}

/**
 * Read the region brief snapshot for a specific time (a user's delivery hour).
 * Resolution: prefer the latest snapshot at/​before `atMs` (nearest-before) if
 * it's within MAX_SLOT_DISTANCE; otherwise the closest available snapshot
 * within that window. If nothing is within the window the slot genuinely has
 * no brief → `empty` (the app shows a quiet "no brief" row rather than a
 * mismatched one). A still-fresh `latest` brief covers the pre-index window
 * just after deploy.
 */
const MAX_SLOT_DISTANCE_MS = 12 * 60 * 60 * 1000; // 12 h — "reasonably close"

export async function getRegionBriefAt(regionId: RegionId, atMs: number): Promise<RegionBriefResult> {
  try {
    const index = (await getCachedJson(
      regionBriefIndexKey(regionId),
      false,
      undefined,
      true,
    )) as string[] | null;
    const buckets = Array.isArray(index) ? index : [];

    // Choose the best bucket: nearest-before within 12h, else closest within 12h.
    let chosen: string | null = null;
    if (buckets.length > 0) {
      let beforeBucket: string | null = null;
      let beforeMs = -Infinity;
      for (const b of buckets) {
        const t = hourBucketToMs(b);
        if (t <= atMs && t > beforeMs) {
          beforeMs = t;
          beforeBucket = b;
        }
      }
      if (beforeBucket && atMs - beforeMs <= MAX_SLOT_DISTANCE_MS) {
        chosen = beforeBucket;
      } else {
        let best: string | null = null;
        let bestDist = Infinity;
        for (const b of buckets) {
          const dist = Math.abs(hourBucketToMs(b) - atMs);
          if (dist < bestDist) {
            bestDist = dist;
            best = b;
          }
        }
        if (best && bestDist <= MAX_SLOT_DISTANCE_MS) chosen = best;
      }
    }

    if (chosen) {
      const payload = (await getCachedJson(
        regionBriefSnapshotKey(regionId, chosen),
        false,
        undefined,
        true,
      )) as WorldBriefPayload | null;
      if (payload) return { status: 'ok', payload };
      // expired race → fall through to the latest-within-window check
    }

    // No usable snapshot within 12h. Use `latest` only if it's itself within
    // the window (covers the just-after-deploy gap before any index exists);
    // otherwise this slot has no brief.
    const latest = (await getCachedJson(
      regionBriefKey(regionId),
      false,
      undefined,
      true,
    )) as WorldBriefPayload | null;
    if (latest?.generatedAt && Math.abs(latest.generatedAt - atMs) <= MAX_SLOT_DISTANCE_MS) {
      return { status: 'ok', payload: latest };
    }
    return { status: 'empty' };
  } catch (err) {
    console.error(
      `[world-brief:get-region:${regionId}:at=${atMs}] read failed:`,
      err instanceof Error ? err.message : err,
    );
    return { status: 'unavailable' };
  }
}
