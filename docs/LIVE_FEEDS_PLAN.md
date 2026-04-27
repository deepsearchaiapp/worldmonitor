# Live News & Live Sports Feeds — Implementation Plan

**Status:** Draft, pre-implementation
**Owner:** ozan@apphesus.com
**Scope:** First original feature on the backend that does not proxy `api.worldmonitor.app`. Adds two new categories — Live News and Sports — to the iOS Feeds tab.
**Region:** USA only (v1)

---

## 1. Goals & non-goals

### Goals
- Add two new categories to the iOS Feeds tab: **Live News** and **Sports**.
- "Live" = freshest available, with 30 s auto-refresh while the tab is visible.
- Sports = all major US leagues mixed into one bucket; live games surfaced first.
- Live News = top US headlines + breaking news, deduped, breaking flagged as `isAlert`.
- Reuse existing iOS feed-row UI — no new row types.
- Operate independently of `api.worldmonitor.app`; this is fully our own backend.

### Non-goals (v1)
- No push notifications (APNs).
- No SSE / WebSocket streaming.
- No subcategory filters under Sports (no league chips).
- No score-change diffing or "what changed since last poll" logic.
- No non-US sports / non-US news.
- No score-card row UI; sports events render as ordinary feed rows.
- No deduplication against the existing `list-feed-digest` US bucket — the two coexist.

---

## 2. Architecture decision

### Runtime: Vercel Functions (Node runtime)
- Same as the existing `list-feed-digest` handler.
- Edge runtime would also work, but Node gives us the regex-RSS-parsing utilities already in use.

### Caching: three layers, all already wired
1. **Vercel Edge CDN** — `Cache-Control: public, s-maxage=30, stale-while-revalidate=60` on the response.
2. **Upstash Redis** — top-level digest keys with 30 s TTL.
3. **Per-source Redis sub-cache** — each RSS feed and each ESPN league has its own key with 30–60 s TTL so partial upstream failures degrade gracefully.
4. **In-memory last-good** — module-scope variable for total-Redis-down fallback.

### No new dependencies
- Reuse `server/_shared/redis.ts` (`cachedFetchJson`, `setCachedJsonBatch`).
- Reuse `server/_shared/rate-limit.ts`.
- Reuse the regex RSS parser from `server/worldmonitor/news/v1/list-feed-digest.ts` (extract into `server/_shared/rss-parser.ts` while we're at it).
- Reuse `server/worldmonitor/news/v1/_classifier.ts` for threat classification on news items.

### Rate-limit posture
- No upstream `api.worldmonitor.app` calls — these endpoints don't touch the proxy budget.
- ESPN unofficial API: cache aggressively, single fan-out per 30 s window across all users globally.
- US RSS feeds: same pattern; reuse the existing relay fallback (`fetchViaRailway`) for any source that blocks Vercel IPs.

---

## 3. Backend changes — `/Users/ozan/Developer/worldmonitor`

### 3.1 New files

```
server/live-news/v1/
  list-us-headlines.ts        # Main handler
  _sources.ts                 # Curated US RSS feed list
  _breaking.ts                # Breaking-keyword regex + isAlert detection

server/live-sports/v1/
  list-us-events.ts           # Main handler
  _leagues.ts                 # League → ESPN scoreboard URL map
  _normalize.ts               # ESPN event → NewsItem-compatible shape

api/live-news/v1/[rpc].ts     # Gateway entry (mirrors api/news/v1/[rpc].ts)
api/live-sports/v1/[rpc].ts   # Gateway entry

server/_shared/rss-parser.ts  # Extracted from list-feed-digest.ts (refactor)
```

### 3.2 Data sources

#### Live US news — RSS feeds (`_sources.ts`)
Curated list of top US national outlets. All must be added to `api/_rss-allowed-domains.js` if not already there.

| Source | URL | Notes |
|---|---|---|
| AP Top News | `https://feeds.apnews.com/rss/apf-topnews` | Wire authoritative |
| Reuters US | `https://feeds.reuters.com/reuters/USdomesticNews` | Verify still public |
| NPR News | `https://feeds.npr.org/1001/rss.xml` | |
| ABC News | `https://abcnews.go.com/abcnews/topstories` | |
| NBC News | `https://feeds.nbcnews.com/nbcnews/public/news` | |
| CBS News | `https://www.cbsnews.com/latest/rss/main` | |
| CNN Top | `https://rss.cnn.com/rss/cnn_topstories.rss` | Already in RELAY_ONLY_DOMAINS |
| Fox News | `https://moxie.foxnews.com/google-publisher/latest.xml` | |
| NYT Home | `https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml` | |
| WaPo National | `https://feeds.washingtonpost.com/rss/national` | |
| USA Today Top | `https://rssfeeds.usatoday.com/usatoday-newstopstories` | |
| Google News US | `https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en` | Backstop |

Per-feed cap: 8 items. Total cap after dedup: 40 items.

#### Live US sports — ESPN scoreboards (`_leagues.ts`)
ESPN's hidden public API. Pattern: `https://site.api.espn.com/apis/site/v2/sports/{sport}/{league}/scoreboard`.

| League | Path | Season window |
|---|---|---|
| NFL | `football/nfl` | Sep–Feb |
| NBA | `basketball/nba` | Oct–Jun |
| MLB | `baseball/mlb` | Mar–Oct |
| NHL | `hockey/nhl` | Oct–Jun |
| MLS | `soccer/usa.1` | Feb–Dec |
| WNBA | `basketball/wnba` | May–Oct |
| NCAA Football | `football/college-football` | Aug–Jan |
| NCAA MBB | `basketball/mens-college-basketball` | Nov–Apr |
| NCAA WBB | `basketball/womens-college-basketball` | Nov–Apr |
| PGA Tour | `golf/pga` | Year-round |
| Tennis ATP | `tennis/atp` | Year-round |
| Tennis WTA | `tennis/wta` | Year-round |
| NASCAR | `racing/nascar-premier` | Feb–Nov |
| F1 | `racing/f1` | Mar–Dec |

Off-season leagues simply return `events: []` from ESPN — no special handling.

### 3.3 Endpoint contracts

#### `GET /api/live-news/v1/list-us-headlines`
**Query params:** none (v1)
**Auth:** `X-WorldMonitor-Key` header (same as existing endpoints)
**Cache:** `public, s-maxage=30, stale-while-revalidate=60`
**Response:**
```ts
{
  items: NewsItem[];                 // sorted by publishedAt desc, max 40
  feedStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
  generatedAt: string;               // ISO timestamp
}
```

#### `GET /api/live-sports/v1/list-us-events`
**Query params:** none (v1)
**Auth:** `X-WorldMonitor-Key` header
**Cache:** `public, s-maxage=30, stale-while-revalidate=60`
**Response:**
```ts
{
  items: NewsItem[];                 // sorted: live first, then upcoming, then recently-finished
  leagueStatuses: Record<string, 'ok' | 'empty' | 'timeout'>;
  generatedAt: string;
}
```

### 3.4 Sports event filtering rules
ESPN event states are `pre` / `in` / `post`.

| State | Include if | Sort priority |
|---|---|---|
| `in` | always | 1 (top) |
| `pre` | starts within next **6 h** | 2 |
| `post` | finished within last **6 h** | 3 |

(Window widened from initial 2 h / 30 min based on user feedback.)

### 3.5 Sports event title format
No subcategory chips, but league still visible in title:
- **Live:** `[NFL] Chiefs 24 — 21 Bills · Q4 2:15`
- **Upcoming:** `[NBA] Lakers vs Warriors · 7:30 PM ET`
- **Final:** `[MLB] FINAL · Yankees 5 — 3 Red Sox`

`source = "ESPN"`, `link = espnGameUrl`, `category = "sports"`, `publishedAt = event.date`, `isAlert = false`, `isLive = (state === "in")` (new optional field).

### 3.6 Breaking-news detection (`_breaking.ts`)
Item is flagged `isAlert: true` if:
- `publishedAt` within last 30 minutes, AND
- title matches `/\b(breaking|live|update|developing|just in|alert)\b/i`, OR
- title is in ALL CAPS for >= 3 consecutive words, OR
- threat classifier returns `level: 'critical'`

### 3.7 Pseudocode — `list-us-headlines.ts`
```ts
export async function listUsHeadlines(): Promise<Response> {
  return cachedFetchJson('live-news:us:v1', 30, async () => {
    const sources = US_NEWS_SOURCES;  // from _sources.ts
    const settled = await Promise.allSettled(
      sources.map(src => fetchAndCacheRss(src, 60))  // per-feed Redis cache
    );

    const items = settled
      .flatMap(r => r.status === 'fulfilled' ? r.value : [])
      .map(item => ({ ...item, isAlert: detectBreaking(item) }))
      .filter(uniqueByTitleFingerprint())
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 40);

    return { items, feedStatuses, generatedAt: new Date().toISOString() };
  });
}
```

### 3.8 Pseudocode — `list-us-events.ts`
```ts
export async function listUsEvents(): Promise<Response> {
  return cachedFetchJson('live-sports:us:v1', 30, async () => {
    const settled = await Promise.allSettled(
      LEAGUES.map(l => fetchAndCacheEspn(l, 30))  // per-league Redis cache
    );

    const events = settled
      .flatMap(r => r.status === 'fulfilled' ? r.value.events : [])
      .filter(matchesStateWindow)        // in / pre 6h / post 6h
      .map(normalizeEspnEvent)           // → NewsItem shape
      .sort(byStateThenTime);            // live → upcoming → finished

    return { items: events, leagueStatuses, generatedAt: new Date().toISOString() };
  });
}
```

---

## 4. iOS changes — `/Users/ozan/Developer/world-monitor-ios`

### Scope split — v1 (this implementation)
- **Sports only.** Live News deferred until LLM-based location enrichment lands.
- Adds `.sports` `FeedFilter` case + Feed-tab fetch + map layer.

### 4.1 Models
- `Models/News/NewsModels.swift`: extend `NewsItem` with optional `isLive: Bool`.
- New `ListSportsEventsResponse` type: `{ items: [NewsItem], leagueStatuses: [String: String]?, generatedAt: String? }`.

### 4.2 APIEndpoint
- `Core/Networking/APIEndpoint.swift`: `case listUsSportsEvents` → `/api/live-sports/v1/list-us-events`, TTL 30 s.

### 4.3 FeedViewModel
- `Features/Feed/FeedViewModel.swift`: `sportsItems: [NewsItem]`, `fetchSports()`, fold into `rebuildAllItems()` under `.sports`.

### 4.4 FeedView
- `Features/Feed/FeedView.swift`: `FeedFilter.sports` case (label "SPORTS", icon "sportscourt", colour `.wmCyan`).
- `.task(id:)` parallel timer on 30 s cadence calling `fetchSports()` (independent of news 60 s).

### 4.5 Map — new layer "Sports"
**Files:**
- `Features/Map/IntelMapViewModel.swift`:
  - Add `case sports` to `MapLayerType` enum.
  - Add `@Published var showSports = false`.
  - Add `@Published private(set) var sportsAnnotations: [MapAnnotationItem] = []`.
  - Add `buildSportsAnnotations()` — pulls from `FeedViewModel.sportsItems` (or a shared store), filters to items with `location` populated, builds `MapAnnotationItem` per event.
- `Features/Map/MapboxIntelMapView.swift`:
  - Create `sportsMgr` PointAnnotationManager.
  - Add `"sports"` to `tappableLayerIds`.
  - Add `syncPoints(mgr: sportsMgr, items: vm.showSports ? vm.sportsAnnotations : [], type: .sports)` to `syncAll()`.
- `Features/Map/IntelMapView.swift`:
  - Add "Sports" toggle to `MapLayerControl` sheet (icon `sportscourt`, color `.wmCyan`, count = `viewModel.sportsAnnotations.count`).
  - Add `case .sports: return "sportscourt"` to `MapLayerType.icon` extension.
  - Add `case .sports: return .wmCyan` to `MapLayerType.color`.

**Pin rendering:** reuse the existing 9-layer reticle marker style. SF symbol `sportscourt` for the centre icon. No special clustering for v1 (Mapbox default applies).

**Tap behaviour:** taps trigger `AnnotationDetailSheet` like every other layer. `MapAnnotationItem.title` = same title used in feed (`[NFL] Chiefs 24 — 21 Bills · Q4 2:15`); `quickStats` includes start time + venue name; `infoRows` exposes league + status + away/home team breakdown.

**Premium gating:** mirror existing layers — gated unless `AppState.shared.isPremium`. (Confirm with product whether Sports should be free; easy flip.)

**Data source:** the `Sports` map layer reads from the same `sportsAnnotations` aggregate the Feed populates — single fetch, two surfaces.

---

## 5. Edge cases & failure modes

| Scenario | Behavior |
|---|---|
| One RSS feed times out | Excluded from `items`; status recorded in `feedStatuses`; rest of payload returns normally. |
| ESPN scoreboard returns 5xx | League excluded; rest of payload returns. |
| Total ESPN outage | `items` returned with only news-classifiable content (none for sports). iOS shows empty state in Sports tab. |
| Redis down | `cachedFetchJson` falls through to live fetch every request; in-memory last-good kept as last resort. Slow but functional. |
| Vercel cold start | First request takes ~2–3 s for fan-out. CDN `s-maxage=30` masks subsequent requests. |
| Off-season league | ESPN returns `events: []`; treated as `empty` status. No special handling. |
| US-EST clock skew on `pre`/`post` window | Use absolute UTC timestamps from ESPN; no local time math on server. |
| RSS with malformed pubDate | Item dropped from results; logged. |
| Duplicate stories across outlets (e.g. AP + Reuters) | Title fingerprint dedup (lowercase + strip punctuation + first 60 chars). |

---

## 6. Testing plan

### Manual
- `curl https://www.worldmonitor.news/api/live-news/v1/list-us-headlines -H "X-WorldMonitor-Key: ..."` → expect 40 items, mix of breaking and standard.
- Same for sports during a Sunday NFL window → expect live games at top.
- Force-disable Redis (env var) → endpoint should still return data, just slower.
- Run during NFL off-season → sports response should still include MLB/NBA/etc.

### iOS
- Open Feed tab → confirm "Live News" and "Sports" chips appear.
- Select "Sports" during a live NBA game → confirm live games at top with score.
- Leave tab open for 60 s → confirm auto-refresh fires twice (every 30 s).
- Switch to "Conflict" chip → confirm refresh cadence drops back to 60 s.

### Load
- Hit `/api/live-news/v1/list-us-headlines` 100x in 30 s → confirm only 1 upstream RSS fan-out per Redis log.
- Same for sports endpoint.

---

## 7. Phasing

### v1 — this plan
Two endpoints, three caching layers, iOS integration, no notifications.

### v2 candidates (separate plans, not in scope)
- Dedicated score-card row UI for sports (team logos, big score, period clock).
- APNs push for breaking-news + score-change events.
- Per-league filter chips under Sports.
- Live news beyond US (UK / EU / global breaking).
- Score-change diffing — emit `isUpdated` when score advanced since last poll.
- SSE streaming endpoint for sub-30-s latency on live games.
- Personalized "follow team" filtering.

---

## 8. Open questions

- ✅ "Live" definition → freshest-available, pull-based.
- ✅ Same row UI → confirmed.
- ✅ All US leagues, no subcategory → confirmed.
- ✅ Pre/post window → 6 h each side.
- ✅ Dedup vs existing US news bucket → keep separate.
- ❓ Should we expose a `since=` cursor for incremental fetch later? (deferred to v2)
- ❓ Internationalization of sports titles? (en-US only v1)

---

## 9. Rollout

1. Land backend endpoints behind the existing `X-WorldMonitor-Key` gate.
2. Smoke-test with `curl` in production.
3. Ship iOS PR behind a remote-config flag (if available) or just direct release.
4. Monitor Vercel function invocation counts and Redis hit rates for the first 48 h.
5. Tune TTLs if cache hit rate is below 90% during peak.

---

## 10. File-change summary

**Backend (new):**
- `server/live-news/v1/list-us-headlines.ts`
- `server/live-news/v1/_sources.ts`
- `server/live-news/v1/_breaking.ts`
- `server/live-sports/v1/list-us-events.ts`
- `server/live-sports/v1/_leagues.ts`
- `server/live-sports/v1/_normalize.ts`
- `api/live-news/v1/[rpc].ts`
- `api/live-sports/v1/[rpc].ts`

**Backend (modified):**
- `server/_shared/rss-parser.ts` (extracted from `list-feed-digest.ts`)
- `api/_rss-allowed-domains.js` (add any missing US sources)
- `server/gateway.ts` (register new RPC handlers if gateway is registry-driven)

**iOS (new):**
- (none — extend existing files)

**iOS (modified):**
- `world-monitor-ios/Models/News/NewsModels.swift` (add `isLive`)
- `world-monitor-ios/Networking/APIEndpoint.swift` (add 2 cases)
- `world-monitor-ios/Features/Feed/FeedViewModel.swift` (add fetchers + slots)
- `world-monitor-ios/Features/Feed/FeedView.swift` (add chips, dynamic refresh interval)
- Wherever `Category` enum lives (add `.liveNews`, `.sports`)
