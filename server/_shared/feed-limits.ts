/**
 * Per-app-version feed caps — server-driven.
 *
 * The iOS client sends its marketing version as `?av=<version>` on the
 * live-news, conflict-archive, and intel-news list endpoints. Because `av` is
 * part of the request URL, the CDN keys each version's response separately, so
 * different versions can be served different caps without poisoning each
 * other's cached response.
 *
 * To change a limit for an app version: edit `LIMITS_BY_VERSION` below and
 * deploy. Resolution: an exact entry wins; a version NEWER than the latest
 * configured entry rolls forward and inherits that latest entry's limits (so a
 * freshly-bumped test build gets the most recent config automatically); an
 * older / in-between / unlisted version — and any client that doesn't send `av`
 * at all — falls back to the env vars, then to "no cap". So this stays fully
 * backward-compatible: already-shipped builds behave exactly as before.
 *
 * Resolution order (most specific wins):
 *   live-news : map.liveNewsMaxItems    → WM_FEED_MAX_ITEMS                       → ∞
 *   conflict  : map.conflictMaxItems    → WM_CONFLICT_MAX_ITEMS → WM_FEED_MAX_ITEMS → ∞
 *   intel     : map.categoryMaxPerTopic → WM_CATEGORY_MAX_PER_TOPIC               → ∞
 *
 * Note conflict still falls back to WM_FEED_MAX_ITEMS when neither the map nor
 * the dedicated WM_CONFLICT_MAX_ITEMS is set — that preserves the old shared
 * behavior for clients that don't send `av`.
 */

export interface FeedLimits {
  /** Max items returned by the LIVE-NEWS list (newest-first). */
  liveNewsMaxItems?: number;
  /** Max items returned by the CONFLICT-ARCHIVE list (newest-first). */
  conflictMaxItems?: number;
  /** Max intel-news clusters kept PER topic (each chip stays bounded). */
  categoryMaxPerTopic?: number;
}

/**
 * Version string (CFBundleShortVersionString, e.g. "2.1") → caps.
 *
 * EMPTY-by-default semantics: every version falls back to the env vars, so an
 * entry is a no-op until you list it. Add an entry only for a version you want
 * to override; an omitted field falls back to the env var. Example:
 *
 *   '2.2': { liveNewsMaxItems: 200, conflictMaxItems: 500, categoryMaxPerTopic: 100 },
 *   '2.3': { conflictMaxItems: 300 },   // live-news + intel → env vars
 */
const LIMITS_BY_VERSION: Record<string, FeedLimits> = {
  // Live-news digest holds ≤500, conflict RSE store ≤1000, so these are
  // servable; actual counts = min(cap, what the digest holds after the gates).
  '2.1': { liveNewsMaxItems: 300, conflictMaxItems: 300, categoryMaxPerTopic: 100 },
};

type EnvCapName =
  | 'WM_FEED_MAX_ITEMS'
  | 'WM_CONFLICT_MAX_ITEMS'
  | 'WM_CATEGORY_MAX_PER_TOPIC';

function envCap(name: EnvCapName): number {
  const raw = process.env[name];
  if (!raw) return Infinity;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : Infinity;
}

function normalizeVersion(av?: string | null): string {
  return (av ?? '').trim();
}

/** Component-wise numeric version compare so "2.10" > "2.9" (lexical compare
 *  would get that wrong). Returns 0 if either side is unparseable — the caller
 *  then treats it as "no roll-forward" and uses the env fallback. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.');
  const pb = b.split('.');
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = Number(pa[i] ?? '0');
    const y = Number(pb[i] ?? '0');
    if (!Number.isFinite(x) || !Number.isFinite(y)) return 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

/** Limits that apply to an app version. An exact map entry wins; otherwise, if
 *  the version is NEWER than the latest configured entry, it inherits that
 *  latest entry's limits — so a freshly-bumped test build automatically gets the
 *  most recent config without needing its own entry. Older / in-between /
 *  unparseable versions return undefined, and each resolver falls back to its
 *  env var. */
function effectiveLimits(av?: string | null): FeedLimits | undefined {
  const v = normalizeVersion(av);
  if (!v) return undefined;

  const exact = LIMITS_BY_VERSION[v];
  if (exact) return exact;

  const versions = Object.keys(LIMITS_BY_VERSION);
  if (versions.length === 0) return undefined;
  let latest = versions[0];
  for (const k of versions) {
    if (compareVersions(k, latest) > 0) latest = k;
  }
  // Roll forward only: a version above the latest configured entry inherits it.
  return compareVersions(v, latest) > 0 ? LIMITS_BY_VERSION[latest] : undefined;
}

/** Resolve the LIVE-NEWS item cap for an app version. */
export function liveNewsMaxItemsForVersion(av?: string | null): number {
  const mapped = effectiveLimits(av)?.liveNewsMaxItems;
  if (typeof mapped === 'number' && mapped > 0) return Math.floor(mapped);
  return envCap('WM_FEED_MAX_ITEMS');
}

/** Resolve the CONFLICT-ARCHIVE item cap for an app version. */
export function conflictMaxItemsForVersion(av?: string | null): number {
  const mapped = effectiveLimits(av)?.conflictMaxItems;
  if (typeof mapped === 'number' && mapped > 0) return Math.floor(mapped);
  // Dedicated conflict env var if set; otherwise the legacy shared WM_FEED_MAX_ITEMS.
  const dedicated = envCap('WM_CONFLICT_MAX_ITEMS');
  return Number.isFinite(dedicated) ? dedicated : envCap('WM_FEED_MAX_ITEMS');
}

/** Resolve the intel-news per-topic cap for an app version. */
export function categoryMaxPerTopicForVersion(av?: string | null): number {
  const mapped = effectiveLimits(av)?.categoryMaxPerTopic;
  if (typeof mapped === 'number' && mapped > 0) return Math.floor(mapped);
  return envCap('WM_CATEGORY_MAX_PER_TOPIC');
}
