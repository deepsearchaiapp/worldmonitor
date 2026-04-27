/**
 * ESPN scoreboard endpoint catalogue for US sports leagues.
 *
 * Each league is fetched in parallel from ESPN's public (unofficial) site API.
 * No auth required. Cached per-league with short TTL because scores change.
 *
 * Off-season leagues simply return `events: []` — no special handling needed.
 *
 * Source pattern:
 *   https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard
 */

export interface LeagueConfig {
  /** Display label used as the title prefix, e.g. "[NFL]". */
  shortName: string;
  /** Human-readable label for telemetry / map detail panels. */
  longName: string;
  /** ESPN site-API path, e.g. "football/nfl". */
  espnPath: string;
}

export const LEAGUES: readonly LeagueConfig[] = [
  // Big four
  { shortName: 'NFL', longName: 'National Football League', espnPath: 'football/nfl' },
  { shortName: 'NBA', longName: 'National Basketball Association', espnPath: 'basketball/nba' },
  { shortName: 'MLB', longName: 'Major League Baseball', espnPath: 'baseball/mlb' },
  { shortName: 'NHL', longName: 'National Hockey League', espnPath: 'hockey/nhl' },

  // Other US pro leagues
  { shortName: 'MLS', longName: 'Major League Soccer', espnPath: 'soccer/usa.1' },
  { shortName: 'WNBA', longName: "Women's National Basketball Association", espnPath: 'basketball/wnba' },

  // College
  { shortName: 'NCAAF', longName: 'NCAA Football', espnPath: 'football/college-football' },
  { shortName: 'NCAAM', longName: "NCAA Men's Basketball", espnPath: 'basketball/mens-college-basketball' },
  { shortName: 'NCAAW', longName: "NCAA Women's Basketball", espnPath: 'basketball/womens-college-basketball' },

  // Individual sports / motorsport
  { shortName: 'PGA', longName: 'PGA Tour', espnPath: 'golf/pga' },
  { shortName: 'ATP', longName: 'ATP Tennis', espnPath: 'tennis/atp' },
  { shortName: 'WTA', longName: 'WTA Tennis', espnPath: 'tennis/wta' },
  { shortName: 'NASCAR', longName: 'NASCAR Cup Series', espnPath: 'racing/nascar-premier' },
  { shortName: 'F1', longName: 'Formula 1', espnPath: 'racing/f1' },
] as const;

/** Build the full ESPN scoreboard URL for a league. */
export function espnScoreboardUrl(league: LeagueConfig): string {
  return `https://site.api.espn.com/apis/site/v2/sports/${league.espnPath}/scoreboard`;
}
