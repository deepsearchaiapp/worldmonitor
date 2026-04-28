/**
 * International news RSS sources for the Live News feed.
 *
 * Curation principles:
 *   - **Authoritative wires first** (AP, Reuters, AFP via direct or Google):
 *     they break stories before everyone else and are usually the source
 *     other outlets are paraphrasing.
 *   - **International over US-domestic**: Live News is meant to feel like
 *     a global situational-awareness layer, not a US politics feed.
 *     Outlets focused mainly on US domestic politics are excluded.
 *   - **Quality over coverage**: ~15 sources is enough; more outlets just
 *     adds duplicate stories without adding new information.
 *   - **`priority`** orders dedup tie-breaks: when two outlets cover the
 *     same story, the entry from the lower-priority-number source wins.
 *
 * Adding a feed?
 *   1. Verify the URL returns valid RSS/Atom (curl + grep for `<rss` or `<feed`).
 *   2. Add the host to `api/_rss-allowed-domains.js` if not already present.
 *   3. Set `relayOnly: true` if the host blocks Vercel edge IPs.
 *   4. Pick `priority`: 1 for authoritative wires, 2 for top broadcasters,
 *      3 for major papers, 4 for analysis / specialist outlets.
 */

export interface NewsSource {
  /** Human-readable name surfaced in the iOS feed row. */
  name: string;
  /** RSS/Atom feed URL. */
  url: string;
  /**
   * Lower number = higher priority in dedup tie-breaks.
   *   1 = authoritative wires (AP, Reuters)
   *   2 = top international broadcasters (BBC, Al Jazeera, DW)
   *   3 = major newspapers (Guardian, NYT World)
   *   4 = analysis / regional specialists (Foreign Policy, The Diplomat)
   */
  priority: number;
  /**
   * If true, fetch via the Railway relay instead of direct.
   * Used for hosts that block Vercel edge IPs.
   */
  relayOnly?: boolean;
}

export const US_NEWS_SOURCES: readonly NewsSource[] = [
  // ── Tier 1 — Authoritative wires ─────────────────────────────────────
  { name: 'AP Top News',          url: 'https://feeds.apnews.com/rss/apf-topnews',                  priority: 1 },
  { name: 'AP World',             url: 'https://feeds.apnews.com/rss/apf-intlnews',                 priority: 1 },
  { name: 'Reuters World',        url: 'https://feeds.reuters.com/reuters/worldNews',               priority: 1 },
  { name: 'Reuters Top News',     url: 'https://feeds.reuters.com/reuters/topNews',                 priority: 1 },

  // ── Tier 2 — Top international broadcasters ──────────────────────────
  { name: 'BBC News World',       url: 'https://feeds.bbci.co.uk/news/world/rss.xml',               priority: 2 },
  { name: 'Al Jazeera English',   url: 'https://www.aljazeera.com/xml/rss/all.xml',                 priority: 2 },
  { name: 'Deutsche Welle',       url: 'https://rss.dw.com/rdf/rss-en-all',                         priority: 2 },
  { name: 'France 24',            url: 'https://www.france24.com/en/rss',                           priority: 2 },
  { name: 'NHK World',            url: 'https://www3.nhk.or.jp/nhkworld/en/news/feed/rss/',         priority: 2 },
  { name: 'CBC News World',       url: 'https://www.cbc.ca/cmlink/rss-world',                       priority: 2 },
  { name: 'NPR News',             url: 'https://feeds.npr.org/1001/rss.xml',                        priority: 2 },

  // ── Tier 3 — Major papers (international sections) ───────────────────
  { name: 'The Guardian World',   url: 'https://www.theguardian.com/world/rss',                     priority: 3 },
  { name: 'NYT World',            url: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',    priority: 3 },

  // ── Tier 3 — Balanced US perspective (left + right) ──────────────────
  // Two outlets with overtly different editorial leans, kept at the same
  // priority. We're aiming for a viewpoint balance, not source weighting.
  { name: 'CNN Top',              url: 'https://rss.cnn.com/rss/cnn_topstories.rss',                priority: 3, relayOnly: true },
  { name: 'Fox News',             url: 'https://moxie.foxnews.com/google-publisher/latest.xml',     priority: 3 },

  // ── Tier 4 — Analysis / regional specialists ─────────────────────────
  { name: 'Foreign Policy',       url: 'https://foreignpolicy.com/feed/',                           priority: 4 },
  { name: 'The Diplomat',         url: 'https://thediplomat.com/feed/',                             priority: 4 },

  // ── Aggregator backstop (catches breaking before direct feeds update) ─
  { name: 'Google News (World)',  url: 'https://news.google.com/rss/headlines/section/topic/WORLD?hl=en-US&gl=US&ceid=US:en', priority: 4 },
] as const;

/**
 * Per-feed item cap before global dedup. Higher than before because the
 * source list shrank — each source contributes a larger slice.
 */
export const ITEMS_PER_FEED = 15;

/**
 * Hard cap on the assembled digest. Reached only when a flood of fresh
 * stories arrives in the time window. Otherwise the time filter does the
 * trimming.
 */
export const MAX_ITEMS = 180;

/**
 * Maximum age of items considered fresh enough to appear, used purely as
 * a sanity safeguard against feeds emitting weeks-old archive content.
 *
 * The PRIMARY trim is the `MAX_ITEMS` cap on recency-sorted items — a
 * tight time window was too aggressive for a 180-slot feed and dropped
 * stories users wanted to see. 14 days lets even quieter feeds contribute
 * while still protecting against literal-archive reposts.
 */
export const MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
