/**
 * Convert raw ESPN scoreboard events into our internal feed-item shape.
 *
 * The output shape matches the iOS `NewsItem` model so the existing feed-row
 * UI renders sports events without any new code paths. Extra fields (`isLive`,
 * location coords) are tolerated by the iOS Codable.
 *
 * ESPN's response is loosely typed — every field is treated as optional and
 * we degrade gracefully when something is missing rather than dropping the
 * event.
 */

import type { LeagueConfig } from './_leagues';
import { lookupVenueCoords } from './_venue-coords';

/** Window (in ms) before/after game time during which we still surface it. */
const PRE_WINDOW_MS = 6 * 60 * 60 * 1000;   // 6 h before
const POST_WINDOW_MS = 6 * 60 * 60 * 1000;  // 6 h after

/** Output shape — mirrors iOS `NewsItem` plus `isLive`. */
export interface SportEventItem {
  source: string;
  title: string;
  link: string;
  publishedAt: number;          // ms since epoch (game start time)
  isAlert: boolean;
  isLive: boolean;
  threat: null;                 // sports never have threat classification
  location: { lat: number; lng: number } | null;
  locationName: string | null;
  league: string;               // e.g. "NFL"
  state: 'pre' | 'in' | 'post'; // ESPN state
  /** Sort priority used by handler: 0 = live, 1 = upcoming, 2 = finished. */
  sortPriority: number;
}

interface EspnTeam {
  homeAway?: 'home' | 'away';
  score?: string;
  team?: { displayName?: string; abbreviation?: string; shortDisplayName?: string };
  winner?: boolean;
}

interface EspnCompetition {
  competitors?: EspnTeam[];
  venue?: {
    fullName?: string;
    address?: { city?: string; state?: string; country?: string };
  };
  status?: {
    type?: { state?: 'pre' | 'in' | 'post'; shortDetail?: string; detail?: string; completed?: boolean };
    displayClock?: string;
    period?: number;
  };
}

interface EspnEvent {
  id?: string;
  date?: string;                // ISO timestamp
  shortName?: string;           // e.g. "BUF @ KC"
  name?: string;
  status?: EspnCompetition['status'];
  competitions?: EspnCompetition[];
  links?: Array<{ rel?: string[]; href?: string }>;
}

interface EspnScoreboard {
  events?: EspnEvent[];
}

function pickGameLink(event: EspnEvent): string | null {
  const links = event.links ?? [];
  // Prefer the official "summary" / "gamecast" link
  const preferred = links.find((l) => l.rel?.includes('summary')) ?? links[0];
  return preferred?.href ?? null;
}

function teamLabel(t: EspnTeam | undefined): string {
  return t?.team?.shortDisplayName ?? t?.team?.abbreviation ?? t?.team?.displayName ?? '?';
}

/**
 * Build the human-readable title for the feed/map row.
 *   live:       "[NFL] Chiefs 24 — 21 Bills · Q4 2:15"
 *   upcoming:   "[NFL] Chiefs vs Bills · 7:30 PM ET"
 *   final:      "[NFL] FINAL · Chiefs 24 — 21 Bills"
 *   solo sport: "[PGA] Masters · Round 3 · T2 Scheffler -8"  (best-effort)
 */
function buildTitle(
  league: LeagueConfig,
  state: 'pre' | 'in' | 'post' | undefined,
  competition: EspnCompetition | undefined,
  event: EspnEvent,
): string {
  const prefix = `[${league.shortName}]`;
  const competitors = competition?.competitors ?? [];
  const home = competitors.find((c) => c.homeAway === 'home') ?? competitors[0];
  const away = competitors.find((c) => c.homeAway === 'away') ?? competitors[1];

  // Solo / individual sports → no two-team structure; fall back to event name + status detail
  if (competitors.length < 2) {
    const name = event.shortName ?? event.name ?? 'Event';
    const detail = competition?.status?.type?.shortDetail ?? competition?.status?.type?.detail ?? '';
    return detail ? `${prefix} ${name} · ${detail}` : `${prefix} ${name}`;
  }

  const homeName = teamLabel(home);
  const awayName = teamLabel(away);
  const homeScore = home?.score ?? '0';
  const awayScore = away?.score ?? '0';
  const clock = competition?.status?.type?.shortDetail ?? '';

  switch (state) {
    case 'in':
      return `${prefix} ${awayName} ${awayScore} — ${homeScore} ${homeName}${clock ? ' · ' + clock : ''}`;
    case 'post':
      return `${prefix} FINAL · ${awayName} ${awayScore} — ${homeScore} ${homeName}`;
    case 'pre':
    default:
      return `${prefix} ${awayName} vs ${homeName}${clock ? ' · ' + clock : ''}`;
  }
}

function shouldInclude(state: 'pre' | 'in' | 'post' | undefined, gameStartMs: number, now: number): boolean {
  if (state === 'in') return true;
  if (state === 'pre') return gameStartMs - now <= PRE_WINDOW_MS && gameStartMs >= now - 30 * 60 * 1000; // tolerate slightly-past pre
  if (state === 'post') return now - gameStartMs <= POST_WINDOW_MS;
  return false;
}

function priorityFor(state: 'pre' | 'in' | 'post' | undefined): number {
  if (state === 'in') return 0;
  if (state === 'pre') return 1;
  return 2; // post
}

/**
 * Normalize a single ESPN scoreboard payload for one league.
 * Returns the items that pass the time-window filter.
 */
export function normalizeScoreboard(
  league: LeagueConfig,
  raw: unknown,
  now: number,
): SportEventItem[] {
  const board = raw as EspnScoreboard | null;
  const events = board?.events ?? [];
  const items: SportEventItem[] = [];
  let droppedNoDate = 0;
  let droppedWindow = 0;
  const stateCounts: Record<string, number> = {};

  for (const event of events) {
    const competition = event.competitions?.[0];
    const state = competition?.status?.type?.state ?? event.status?.type?.state;
    const startIso = event.date;
    const gameStartMs = startIso ? Date.parse(startIso) : NaN;

    stateCounts[state ?? 'unknown'] = (stateCounts[state ?? 'unknown'] ?? 0) + 1;

    if (!Number.isFinite(gameStartMs)) {
      droppedNoDate++;
      continue;
    }
    if (!shouldInclude(state, gameStartMs, now)) {
      droppedWindow++;
      continue;
    }

    const title = buildTitle(league, state, competition, event);
    const link = pickGameLink(event) ?? `https://www.espn.com/${league.espnPath}/`;
    const venue = competition?.venue;
    const coords = lookupVenueCoords(venue?.address?.city, venue?.address?.state);

    items.push({
      source: 'ESPN',
      title,
      link,
      publishedAt: gameStartMs,
      isAlert: false,
      isLive: state === 'in',
      threat: null,
      location: coords,
      locationName: venue?.fullName ?? null,
      league: league.shortName,
      state: (state ?? 'pre') as 'pre' | 'in' | 'post',
      sortPriority: priorityFor(state),
    });
  }

  if (events.length > 0 && items.length === 0) {
    console.log(
      `[live-sports] normalize ${league.shortName}: ${events.length} raw, 0 kept ` +
      `(dropped ${droppedNoDate} no-date, ${droppedWindow} out-of-window). ` +
      `States: ${JSON.stringify(stateCounts)}`,
    );
  }

  return items;
}
