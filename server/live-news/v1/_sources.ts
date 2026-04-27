/**
 * US news RSS sources curated for the Live News feed.
 *
 * Aim: broad national coverage with mainstream + politics + business +
 * a few major regional papers. Tech/lifestyle outlets are intentionally
 * excluded — Live News should feel "what's happening *now* in the US",
 * not "today on Wirecutter".
 *
 * Adding a feed?
 *   1. Verify the URL returns valid RSS/Atom (curl + grep for `<rss` or `<feed`).
 *   2. Add the host to `api/_rss-allowed-domains.js` if not already present.
 *   3. Set `relayOnly: true` if the host blocks Vercel edge IPs.
 */

export interface NewsSource {
  /** Human-readable name surfaced in the iOS feed row. */
  name: string;
  /** RSS/Atom feed URL. */
  url: string;
  /**
   * If true, fetch via the Railway relay instead of direct.
   * Used for hosts that block Vercel edge IPs (e.g. CNN's RSS).
   */
  relayOnly?: boolean;
}

export const US_NEWS_SOURCES: readonly NewsSource[] = [
  // ── Wires (authoritative, fast) ──────────────────────────────────────
  { name: 'AP Top News',        url: 'https://feeds.apnews.com/rss/apf-topnews' },
  { name: 'Reuters US',         url: 'https://feeds.reuters.com/reuters/USdomesticNews' },
  { name: 'Reuters World',      url: 'https://feeds.reuters.com/reuters/worldNews' },

  // ── National broadcasters ────────────────────────────────────────────
  { name: 'NPR News',           url: 'https://feeds.npr.org/1001/rss.xml' },
  { name: 'NPR Politics',       url: 'https://feeds.npr.org/1014/rss.xml' },
  { name: 'ABC News',           url: 'https://abcnews.go.com/abcnews/topstories' },
  { name: 'NBC News',           url: 'https://feeds.nbcnews.com/nbcnews/public/news' },
  { name: 'CBS News',           url: 'https://www.cbsnews.com/latest/rss/main' },
  { name: 'CNN Top',            url: 'https://rss.cnn.com/rss/cnn_topstories.rss', relayOnly: true },
  { name: 'CNN US',             url: 'https://rss.cnn.com/rss/cnn_us.rss', relayOnly: true },
  { name: 'Fox News',           url: 'https://moxie.foxnews.com/google-publisher/latest.xml' },
  { name: 'PBS NewsHour',       url: 'https://www.pbs.org/newshour/feeds/rss/headlines' },

  // ── National papers ──────────────────────────────────────────────────
  { name: 'NYT Home',           url: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml' },
  { name: 'NYT US',             url: 'https://rss.nytimes.com/services/xml/rss/nyt/US.xml' },
  { name: 'WaPo National',      url: 'https://feeds.washingtonpost.com/rss/national' },
  { name: 'WaPo Politics',      url: 'https://feeds.washingtonpost.com/rss/politics' },
  { name: 'USA Today Top',      url: 'https://rssfeeds.usatoday.com/usatoday-newstopstories' },
  { name: 'WSJ US Business',    url: 'https://feeds.a.dj.com/rss/RSSWSJD.xml' },

  // ── Politics / inside-the-beltway ────────────────────────────────────
  { name: 'Politico Top',       url: 'https://www.politico.com/rss/politicopicks.xml' },
  { name: 'The Hill Top',       url: 'https://thehill.com/news/feed/' },
  { name: 'Axios Top',          url: 'https://api.axios.com/feed/' },

  // ── Business / finance ───────────────────────────────────────────────
  { name: 'CNBC Top News',      url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { name: 'Bloomberg Markets',  url: 'https://feeds.bloomberg.com/markets/news.rss' },

  // ── Major regional papers (with national reach) ──────────────────────
  { name: 'LA Times National',  url: 'https://www.latimes.com/nation/rss2.0.xml' },

  // ── Aggregator (backstop) ────────────────────────────────────────────
  { name: 'Google News US',     url: 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en' },
] as const;

/** Per-feed item cap before global dedup runs. */
export const ITEMS_PER_FEED = 8;

/** Total cap on the assembled digest after dedup + age filter. */
export const MAX_ITEMS = 60;

/** Items older than this are dropped — even if RSS still surfaces them. */
export const MAX_AGE_MS = 3 * 24 * 60 * 60 * 1000; // 3 days
