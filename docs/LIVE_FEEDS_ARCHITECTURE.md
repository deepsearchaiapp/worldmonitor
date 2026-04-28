# Live Feeds Architecture — Sports Events & Live News

**Status:** Implemented & deployed
**Companion to:** `LIVE_FEEDS_PLAN.md` (original plan; this doc reflects what actually shipped)
**Audience:** Engineers continuing development in future coding sessions

This document captures the full implementation of the two flagship "live" features:
- **Live Sports** — real-time US sports events from ESPN.
- **Live News** — international news with LLM-enriched location + AI summaries + semantic dedup.

Both features have a backend (Node-on-Vercel-Edge) component and an iOS client component. They share the same architectural pattern (shared service singleton + Combine observation), so changes to one are usually a template for the other.

---

## 1. High-level overview

Both features behave the same shape:

```
┌─────────────┐      ┌──────────────────────┐      ┌──────────────────────┐
│  iOS        │      │  Vercel Edge (Node)  │      │  External services   │
│             │      │                      │      │                      │
│ Feed chip   │ ───▶ │  GET /api/live-X/v1  │ ───▶ │  RSS feeds           │
│ Map layer   │      │     /list-...        │      │  ESPN site API       │
│             │      │                      │      │  Anthropic Claude    │
│             │ ◀─── │  JSON response       │ ◀─── │  Upstash Redis       │
└─────────────┘      └──────────────────────┘      └──────────────────────┘
```

Each iOS surface (Feed tab + Map tab) **observes a shared service singleton** that does the actual fetching, so opening both surfaces never doubles the upstream load.

Both backend handlers follow a "**read cache → return immediately, fire enrichment in background**" pattern, with the heavy lifting (LLM calls, RSS fetches) cached aggressively in Redis.

---

## 2. Sports Events — Server Side

### Endpoint
`GET https://www.worldmonitor.news/api/live-sports/v1/list-us-events`

Auth: `X-WorldMonitor-Key` header (same as existing endpoints).
Response cache: `Cache-Control: public, s-maxage=30, stale-while-revalidate=60, stale-if-error=300`.

### Files
```
api/live-sports/v1/list-us-events.ts          // edge handler entry (CORS, auth, rate-limit)
server/live-sports/v1/list-us-events.ts       // core handler logic
server/live-sports/v1/_leagues.ts             // ESPN league config (14 leagues)
server/live-sports/v1/_venue-coords.ts        // city → lat/lng lookup table
server/live-sports/v1/_normalize.ts           // ESPN event → SportEventItem shape
```

### Data flow

```
GET /api/live-sports/v1/list-us-events
  ↓
listUsSportsEvents()
  ↓
cachedFetchJson('live-sports:us:v2', ttl=30s)
  ├─ HIT  → return cached digest
  └─ MISS → buildDigest()
              ↓
              Promise.allSettled(LEAGUES.map(fetchLeagueWithCache))
              ↓ (each league: own Redis key 'live-sports:espn:v2:{path}', 30s TTL)
              ↓
              For each league raw scoreboard:
                normalizeScoreboard(raw, now)
                  - filter to state pre/in/post within 6h-24h windows
                  - build title prefix [NFL] Chiefs 24 — 21 Bills · Q4 2:15
                  - lookup venue coords from city + state
                  - compute sortPriority (live=0, upcoming=1, finished=2)
              ↓
              Concat + sort + return digest
```

### League config (`_leagues.ts`)

14 leagues currently, all ESPN site-API endpoints (path-pattern `https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard`):

| League | ESPN path |
|---|---|
| NFL, NBA, MLB, NHL | football/nfl, basketball/nba, baseball/mlb, hockey/nhl |
| MLS, WNBA | soccer/usa.1, basketball/wnba |
| NCAAF, NCAAM, NCAAW | football/college-football, basketball/mens-college-basketball, basketball/womens-college-basketball |
| PGA, ATP, WTA | golf/pga, tennis/atp, tennis/wta |
| NASCAR, F1 | racing/nascar-premier, racing/f1 |

**No API key required** — ESPN's site API is public (officially undocumented but stable for years).

### Filter windows

ESPN reports each event with `state: 'pre' | 'in' | 'post'`. We include:
- `state == 'in'`: always
- `state == 'pre'`: starts within next **6 h** (and not >30 min in past as tolerance)
- `state == 'post'`: finished within last **6 h**

Configurable in `_normalize.ts`:
```ts
const PRE_WINDOW_MS = 6 * 60 * 60 * 1000;
const POST_WINDOW_MS = 6 * 60 * 60 * 1000;
```

### Output shape (the wire format iOS decodes)

```ts
{
  items: SportEventItem[],
  leagueStatuses: { NFL: 'ok' | 'empty' | 'timeout' | 'error', ... },
  generatedAt: ISO string,
}

SportEventItem = {
  source: 'ESPN',
  title: '[NFL] Chiefs 24 — 21 Bills · Q4 2:15',
  link: ESPN game page URL,
  publishedAt: ms timestamp (game start time),
  isAlert: false,           // sports events never set this
  isLive: boolean,          // true if state=='in'
  threat: null,
  location: { latitude, longitude } | null,
  locationName: venue name | null,
  league: 'NFL',
  state: 'pre' | 'in' | 'post',
  sortPriority: 0 | 1 | 2,
}
```

### Caching

| Key | TTL | Layer |
|---|---|---|
| `live-sports:us:v2` | 30 s | Top-level digest |
| `live-sports:espn:v2:{path}` | 30 s | Per-league raw scoreboard |
| In-memory `lastGoodResponse` | function instance lifetime | Hard fallback |

`v1 → v2` rotation history: bumped once when we discovered cache poisoning from negative-sentinel writes (see `LIVE_FEEDS_PLAN.md` war story).

### Venue coordinate resolution

ESPN provides `competition.venue.address.{city, state}` but no lat/lng directly. `_venue-coords.ts` ships a static table of ~70 sports cities (all major-league metros + Canadian NHL cities + MLS additions). Lookup:

```ts
lookupVenueCoords(city, state):
  1. Try `${city}|${state}` key match → exact city centroid
  2. Fall back to state centroid via `STATE_CENTROIDS`
  3. Return null if neither found
```

Items with null coords still appear in the Feed tab but are excluded from the map.

NCAA football/basketball reach into smaller college towns (Tuscaloosa AL, Lawrence KS) — those fall through to state centroids. Acceptable for v1; expand the table later if precision matters.

### What's deliberately NOT here

- **No paraphrase / LLM enrichment.** Sports events are short, structured strings; LLM would add nothing.
- **No semantic dedup.** Events are inherently unique by venue × time.
- **No multi-region support.** US-only for now.

---

## 3. Sports Events — iOS Side

### Files
```
Core/Networking/APIEndpoint.swift             // case listUsSportsEvents
Core/Networking/LiveSportsService.swift       // SHARED SINGLETON
Models/News/NewsModels.swift                  // ListSportsEventsResponse + extras on NewsItem
Features/Feed/FeedView.swift                  // FeedFilter.sports chip
Features/Feed/FeedViewModel.swift             // sportsItems aggregation
Features/Map/IntelMapViewModel.swift          // MapLayerType.sports + buildSportsAnnotations
Features/Map/MapboxIntelMapView.swift         // sportsMgr PointAnnotationManager
Features/Map/IntelMapView.swift               // Sports toggle + style extensions
```

### Architecture: single source of truth

```
┌─────────────────────────────────────┐
│  LiveSportsService.shared           │  ← single fetch path
│    @Published items: [NewsItem]     │  ← single source of truth
│    fetch() with in-flight coalesce  │
└──────────────┬──────────────────────┘
               │ Combine .sink
        ┌──────┴───────┐
        ▼              ▼
┌────────────────┐  ┌──────────────────┐
│ FeedViewModel  │  │ IntelMapViewModel│
│ sportsItems    │  │ sportsAnnotations│
└────────────────┘  └──────────────────┘
```

Both view-models observe `LiveSportsService.shared.$items`. When the service publishes new items, each VM rebuilds its derived state (Feed rows / map pins).

**Result:** Feed tab and Map tab opening simultaneously triggers ONE backend request. The 30 s in-memory + Redis cache ensures concurrent fetches across the device coalesce into one upstream call.

### NewsItem reuse

We deliberately decode sports events into the existing `NewsItem` Codable struct rather than introducing a parallel `SportEvent` type. This means:
- Feed-row UI works without modification
- Map detail sheet (`AnnotationDetailSheet`) works without modification
- Sports-specific fields (`isLive`, `league`) are optional `let X: T?` in `NewsItem` (NOT `let X: T? = nil` — see iOS Codable gotcha section)

### Refresh cadence

```swift
// FeedView.swift
.task(id: "sports-refresh") {
    while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(30))
        await viewModel.fetchSports()
    }
}

// MapboxIntelMapView.swift
.task(id: "sports-map-refresh") {
    while !Task.isCancelled {
        try? await Task.sleep(for: .seconds(30))
        await viewModel.fetchSportsForMap()
    }
}
```

Both call into `LiveSportsService.fetch()`. The service's in-flight coalescing means only one HTTP request is ever in flight at a time even when both timers fire simultaneously.

### Map detail sheet (AnnotationDetailSheet)

For sports pins, the synthesizer in `IntelMapViewModel.buildSportsAnnotations`:
- `title` includes `[LEAGUE]` prefix and live score / status
- `descriptionText` is a friendly prompt (depends on state: live / upcoming / finished)
- `quickStats` shows LEAGUE / TIME / STATUS|VENUE
- `infoRows` shows League, Venue, Status, Game Time
- `url` is the ESPN game page

Tapping the "Open on ESPN" button presents `FeedItemDetailView` (existing in-app web view + translation toolbar) — `makeFeedItem` synthesizes a `FeedItem` for the sheet.

### Premium gating

Sports map layer is gated by the same `MapLayerControl.layerToggle` mechanism as every other layer (paywall on toggle-on for free users). No special carve-out.

---

## 4. Live News — Server Side

### Endpoint
`GET https://www.worldmonitor.news/api/live-news/v1/list-us-headlines`

Auth: `X-WorldMonitor-Key`.
Response cache: `Cache-Control: public, s-maxage=30, stale-while-revalidate=60, stale-if-error=300`.

### Files
```
api/live-news/v1/list-us-headlines.ts          // edge handler entry
server/live-news/v1/list-us-headlines.ts       // core handler — pipeline orchestration
server/live-news/v1/_sources.ts                // RSS source list + priority tiers
server/live-news/v1/_normalize.ts              // RSS fetch + parse + title-fingerprint dedup
server/live-news/v1/_breaking.ts               // breaking-news heuristic (isAlert flag)
server/live-news/v1/_enrich.ts                 // LLM location enrichment
server/live-news/v1/_paraphrase.ts             // LLM paragraph summarization
server/live-news/v1/_dedup.ts                  // LLM semantic dedup (per-country)
server/_shared/keep-alive.ts                   // Vercel waitUntil helper (used by all 3 LLM stages)
```

### Pipeline overview

```
GET /api/live-news/v1/list-us-headlines
  ↓
listUsHeadlines()
  ↓
cachedFetchJson('live-news:us:v4', ttl=30s)
  ├─ HIT  → return cached digest
  └─ MISS → buildDigestPayload()
              ↓
              [1] buildBaseDigest()
                    - fan-out RSS fetches (Promise.allSettled, per-feed cache 600s)
                    - parse via regex (handles RSS 2.0, Atom, RDF dc:date)
                    - title-fingerprint dedup (strip BREAKING/LIVE prefixes,
                      outlet branding, punctuation, lowercase, first 80 chars)
                    - source-priority tie-break: AP/Reuters > BBC/AJ > NYT/Guardian/CNN/Fox > FP/Diplomat
                    - keep items younger than 14 days OR with no date
                    - sort recency desc, cap at 180
              ↓
              [2] Promise.all(
                    attachCachedLocations,    ← reads live-news:loc:v1:{titleHash}
                    attachCachedSummaries,    ← reads live-news:para:v3:{titleHash}
                    loadCachedDedupMap,       ← reads live-news:dedup:v1:{titleHash}
                  )
              ↓
              [3] Fire-and-forget LLM calls (wrapped in keepAlive):
                    - enrichMissingLocations(missingLocations)
                    - paraphraseMissingSummaries(missingSummaries)
                    - classifyUnknownsAsync(items, dedupMap)
              ↓
              [4] applyDedup(items, dedupMap)
                    - group by canonical hash, keep representative per group
              ↓
              return { items: deduped, ... }
```

The KEY DESIGN PRINCIPLE: Stage [3] runs in the background via `keepAlive`. The HTTP response goes back immediately with whatever was in cache. Subsequent polls (~30 s later) pick up freshly-cached data.

**Convergence:** First poll = items shown but unenriched. Second poll = locations + summaries appear. Third poll = dedup decisions kick in, duplicates collapse. Steady state reached after ~3 polls.

### RSS source list (`_sources.ts`)

17 sources with priority tiers. Lower = more authoritative.

| Tier | Sources | Why this tier |
|---|---|---|
| 1 (wire) | AP Top, AP World, Reuters World, Reuters Top | First-to-break, most others paraphrase from these |
| 2 (broadcasters) | BBC World, Al Jazeera, Deutsche Welle, France 24, NHK World, CBC World, NPR | International coverage, neutral framing |
| 3 (papers + balanced US) | Guardian World, NYT World, **CNN Top, Fox News** | Major papers + balanced US perspective (left + right) |
| 4 (analysis) | Foreign Policy, The Diplomat, Google News (World) | Specialist or aggregator backstop |

Priority drives **dedup tie-breaks**: when two outlets cover the same story, the lower-priority-number one is kept. So an AP version always wins over a Guardian version.

`relayOnly: true` flag: for hosts that block Vercel edge IPs (currently CNN). Routes via Railway relay (existing infrastructure).

### Title-fingerprint dedup (Layer 1)

`normalizeTitle()` in `_normalize.ts`:
1. Strip outlet branding suffix: `" - BBC News"`, `" | Reuters"` (regex anchored on uppercase entity names)
2. Lowercase
3. Strip prefixes: `BREAKING:`, `LIVE:`, `UPDATE:`, `WATCH:`, `EXCLUSIVE:`, `URGENT:`, `JUST IN:`, `DEVELOPING:`, `OPINION:`, `ANALYSIS:`
4. Drop non-word chars
5. Collapse whitespace
6. First 80 chars

Same fingerprint = duplicate. Group, pick by source priority, then by recency.

Catches: identical and near-identical wording across outlets.
Misses: semantic duplicates (different wording, same event) — that's Layer 2's job.

### Location enrichment (`_enrich.ts`)

**LLM:** Claude Haiku 4.5, default `ANTHROPIC_API_KEY`.

**Cache:** `live-news:loc:v1:{titleHash}` → `{ latitude, longitude, city, country, locationName, confidence }` or `__WM_LIVE_NEWS_UNLOCATED__` sentinel.
**TTL:** 30 days.

**Trigger:** items missing the cache key go into `enrichMissingLocations`, fired via `keepAlive`.

**Prompt strategy:** "Always return a best-guess location, even when uncertain. Lower the confidence rather than returning null." → produces coords for ~90%+ of items, even abstract national stories use country centroid.

**Batch size:** 20 items per LLM call (`ENRICH_BATCH_SIZE`). Cap of 60 items per request to avoid runaway costs on cold cache.

### Paraphrase enrichment (`_paraphrase.ts`)

**LLM:** Claude Haiku 4.5, **separate** `ANTHROPIC_API_KEY_PARAPHRASE` (cost separation in dashboard).

**Cache:** `live-news:para:v3:{titleHash}` → `{ summary: string }` or `__WM_LIVE_NEWS_UNPARAPHRASED__`.
**TTL:** 30 days.

**Cache version history:**
- v1: original 2–3 sentence prompt
- v2: bumped when we widened to paragraph-length prompt
- v3: bumped during the body-based-SET fix (see Vercel gotcha section below)

**Prompt strategy:** Paragraph-length output (4–6 sentences, 100–180 words). Lead → expansion → implication. Allowed to add neutral background context drawn from common knowledge but cannot invent specifics.

**Batch size:** 8 items per LLM call (smaller than location because each item carries the RSS description for the LLM to summarize from).

**Sparse-input handling:** items whose RSS description is < 60 chars get auto-marked unparaphrasable without an LLM call. Saves tokens on items that would just hallucinate.

**Min/max length validation:** summaries < 80 chars or > 2000 chars are rejected (negative-cached) — they probably echoed the title or went off the rails.

### Semantic dedup (`_dedup.ts`) — Layer 2

**LLM:** Claude Haiku 4.5, billed against `ANTHROPIC_API_KEY_PARAPHRASE` (same key as paraphrase for combined billing).

**Cache:** `live-news:dedup:v1:{titleHash}` → `{ canonical: string }`.
- `canonical = self.titleHash` → item is unique
- `canonical = otherHash` → item is duplicate of `otherHash`

**TTL:** 30 days. Decisions are **never re-evaluated** — once an item is classified, the call sticks for the cache lifetime. (Per product spec: "we shouldn't try to control it again after some time later".)

**Country bucketing:** items grouped by `country` (from location enrichment). LLM only compares within a bucket — limits comparison space and prompt size.

**Pre-conditions:** items need both `summary` AND `country` populated to be classified. Items missing either are skipped this round, retried next.

**Optimization (recent):** the prompt sends only **single-sentence snippets** of summaries, not the full paragraph. Reduced per-item tokens ~3× and brought wall time from 18–25 s to 8–11 s. See `summarySnippet` heuristic in `_dedup.ts`.

**Cap:** 50 items per LLM call (`MAX_LLM_ITEMS_PER_PASS`). Items beyond the cap roll over to next poll.

**Timeout:** 60 s (override of `callClaude` default 25 s — needed for the larger dedup prompts).

**Singleton optimization:** countries with exactly 1 unknown and 0 anchors get cached as unique without any LLM call.

**Hallucination guard:** if the LLM returns a `canonical` that doesn't match any input ID, fall back to `self` (treat as unique).

### Output shape

```ts
{
  items: LiveNewsItem[],            // post-dedup
  feedStatuses: { 'AP Top News': 'ok', ... },
  generatedAt: ISO string,
  pendingEnrichment: number,        // diagnostic: items missing location
  pendingParaphrase: number,        // diagnostic: items missing summary
}

LiveNewsItem = {
  source: string,
  title: string,                    // RSS-original, never modified
  link: string,
  publishedAt: number,              // ms epoch
  isAlert: boolean,                 // breaking-news heuristic
  titleHash: string,                // SHA-256 of normalized title
  location: { latitude, longitude } | null,
  locationName: string | null,      // e.g. "Kyiv, Ukraine"
  confidence: number | null,        // 0..1, LLM's location confidence
  country: string | null,           // ISO 3166-1 alpha-2
  summary: string | null,           // LLM paragraph
  rawDescription: string | null,    // internal — RSS description, used as LLM input
}
```

iOS doesn't care about `titleHash`, `confidence`, `country`, `rawDescription` — they decode as ignored extras.

### Cache key summary

| Key | TTL | Layer | Purpose |
|---|---|---|---|
| `live-news:us:v4` | 30 s | Top-level | Cached digest response |
| `live-news:rss:v1:{feedUrl}` | 600 s | Per-feed | Parsed RSS |
| `live-news:loc:v1:{titleHash}` | 30 d | Per-headline | LLM location decision |
| `live-news:para:v3:{titleHash}` | 30 d | Per-headline | LLM paragraph summary |
| `live-news:dedup:v1:{titleHash}` | 30 d | Per-headline | LLM dedup decision (canonical hash) |

`v#` rotation history is documented inline at each key constant.

### Cost (steady state)

| Stage | Per call | Cycles/day | Daily | Monthly |
|---|---|---|---|---|
| Location enrichment | ~$0.001 | ~5 calls | ~$0.005 | ~$0.15 |
| Paraphrase | ~$0.014 | ~3 calls | ~$0.042 | ~$1.30 (actually ~$30 due to cold-start refills) |
| Dedup | ~$0.005 | ~1 call | ~$0.005 | ~$0.15 |

Real-world steady state: **~$30–60/month combined LLM spend** (paraphrase is the cost driver; location and dedup are rounding errors).

Cost separation: `ANTHROPIC_API_KEY` for location, `ANTHROPIC_API_KEY_PARAPHRASE` for paraphrase + dedup. Anthropic dashboard groups by API key.

---

## 5. Live News — iOS Side

### Files
```
Core/Networking/APIEndpoint.swift             // case listUsHeadlines
Core/Networking/LiveNewsService.swift         // SHARED SINGLETON
Models/News/NewsModels.swift                  // ListLiveNewsResponse + NewsItem extensions
Features/Feed/FeedView.swift                  // FeedFilter.liveNews chip + 30s refresh task
Features/Feed/FeedViewModel.swift             // liveNewsItems aggregation
Features/News/NewsDetailView.swift            // FeedItemDetailView with summary mode
Features/Map/IntelMapViewModel.swift          // MapLayerType.liveNews + buildLiveNewsAnnotations
Features/Map/MapboxIntelMapView.swift         // liveNewsMgr PointAnnotationManager
Features/Map/IntelMapView.swift               // Live News toggle + AnnotationDetailSheet
```

### Architecture: same pattern as sports

```
LiveNewsService.shared
  @Published items: [NewsItem]
       │ Combine .sink
       ├──→ FeedViewModel.liveNewsItems  (Feed chip)
       ├──→ IntelMapViewModel.liveNewsAnnotations  (Map pins)
       └──→ IntelMapViewModel.alertNews  (Map alert ticker)
```

The alert ticker on the Map tab is now driven by Live News (not the upstream-proxied `list-feed-digest`). Backfill logic: if there aren't ≥6 items flagged `isAlert == true`, fill with the freshest non-breaking items so the ticker is never empty.

### NewsItem decoder gotcha (CRITICAL)

`NewsItem` has `let isLive: Bool?`, `let league: String?`, `let summary: String?` — **without `= nil` defaults**.

This is intentional. Swift's auto-synthesized Codable decoder has a known edge case: when a `let` property has a default value AND is in CodingKeys, the synthesizer may **skip the decode call** and leave the default in place. We hit this and lost ~6 hours debugging "summary is null even though server is sending it".

The fix:
```swift
// ✓ CORRECT — synthesizer correctly calls decodeIfPresent
let summary: String?

// ✗ WRONG — synthesizer skips decode, summary stays nil
let summary: String? = nil
```

Cost of this: the manual `NewsItem(...)` construction in `NewsDetailView.swift:1576` has to pass `isLive: nil, league: nil, summary: nil` explicitly. Worth it.

### Detail view (FeedItemDetailView)

Three rendering modes, evaluated in priority order:

1. **Summary mode** (when `item.summary` is non-nil, default for live news): renders the paragraph in reader-mode typography. "View Original Source" button at the bottom (inline, scrolls with content) swaps to web view.
2. **Translated mode**: existing translation flow.
3. **Web view**: source webpage in `TranslatableWebView`.

Toolbar has a `globe ↔ doc.text.fill` toggle to switch back to summary from web view.

### Map detail sheet (AnnotationDetailSheet)

For Live News pins, `buildLiveNewsAnnotations`:
- `title` is the RSS-original title (no LLM rewrite)
- `descriptionText` is the LLM summary (rendered larger — `.body` size — for live news specifically, vs `.caption` for other layer types)
- `quickStats` shows SOURCE / TIME / BREAKING|LOCATION
- `infoRows` shows Source, Location, Published, Status
- `url` is the source article URL

Tapping "Open Article" presents `FeedItemDetailView` — but the synthesized `FeedItem` deliberately **omits summary** so the user sees the source web view directly (avoids showing the same summary twice; map detail already showed it).

### Pin spiral jitter

Multiple Live News stories at the same coordinate (e.g. all Russia stories pinning to Moscow) get fanned out in a golden-angle spiral. First item in a bucket sits at the canonical coord; subsequent items get offset 1 km × index in a 137.5° spiral. All pins individually tappable, deterministic positions across polls.

Implementation in `buildLiveNewsAnnotations` in `IntelMapViewModel.swift`. ~25 lines, no Mapbox clustering machinery.

### Refresh cadence

Same 30 s pattern as sports — both Feed-tab task and Map-view task call `LiveNewsService.fetch()`. In-flight coalescing means one upstream request even when both timers fire simultaneously.

### Map layer persistence (premium only)

`IntelMapViewModel` persists all 22 layer toggles (sports, live news, conflict, military, etc.) to UserDefaults under key `wmMapLayerPrefs.v1`. Auto-saves via `Publishers.MergeMany` debounced sink on every toggle change. Restored unconditionally on init (NOT gated on premium status — race-safe; persistence is the gate).

`LayerPrefs` Codable uses **custom decoder with `decodeIfPresent` fallbacks** so adding new toggles in future builds doesn't wipe existing users' saved state.

### Premium gating

- Live News map layer toggle: same paywall as every other layer
- Tapping a Live News item in Feed: `canOpenNews()` returns `isPremium` (no metered free reads)
- Tapping the alert ticker on Map: same `canOpenNews()` gate

---

## 6. Shared infrastructure

### Vercel Edge runtime: `keepAlive` (CRITICAL)

**The bug we hit:** Vercel's Edge Functions kill the JavaScript isolate as soon as the HTTP response returns. **Unawaited Promises get cancelled mid-flight, with no warning.** Symptom: "Kicking off X..." prints in Vercel logs but the success/failure log from inside the promise never appears, and downstream state (Redis writes) never updates.

**The fix:** `server/_shared/keep-alive.ts` exposes `keepAlive(promise, label)` which reads the Vercel request-context store from `globalThis[Symbol.for('@vercel/request-context')]` and registers the promise via `ctx.waitUntil()`. This tells Vercel "the response is ready, but please keep this isolate alive until this Promise resolves" — up to 5 minutes.

**Used by:**
- `enrichMissingLocations` (location LLM batches)
- `paraphraseMissingSummaries` (paraphrase LLM batches)
- `classifyUnknownsAsync` (dedup LLM call)

**Lesson:** Any fire-and-forget Promise in a Vercel Edge handler MUST be wrapped in `keepAlive`. If you forget, the Promise silently runs for milliseconds and dies.

### Upstash Redis: body-based SET (CRITICAL)

**The bug we hit:** Our original `setCachedJson` used Upstash's path-based SET (`/set/{key}/{value}/EX/{seconds}`) with the value URL-encoded into the path. For small values (location coords, ~150 chars JSON) this worked. For paragraph-length summaries (~700–1100 chars JSON, ~2500 chars URL-encoded) Upstash returned non-2xx silently — and our code only caught network errors, not 4xx.

Result: paraphrase LLM calls succeeded, "writes" appeared to succeed in our logs, but Redis was empty.

**The fix:** `setCachedJson` now uses body-based SET (`POST /set/{key}?EX={seconds}` with the value in the request body) and explicitly checks `resp.ok`. Handles arbitrarily large values.

**Companion fix:** `getCachedJson` and `getCachedJsonBatch` had to be updated to handle two response shapes from Upstash — sometimes the GET returns the value as a string (needs JSON.parse), sometimes as an already-parsed object. Both helpers now do `typeof raw === 'string' ? JSON.parse(raw) : raw`.

**Lesson:** Always check `resp.ok` after `fetch()`. `fetch()` does NOT throw on 4xx/5xx — it resolves with `ok: false`. Our `try/catch` was useless for HTTP errors.

### Cache poisoning prevention

Our handlers deliberately **never let `cachedFetchJson` write its negative-sentinel** for the digest. Original implementation returned `null` from the fetcher when "all upstream sources failed", which caused `cachedFetchJson` to write `__WM_NEG__` for 60 s — during which every poll got a synthetic empty response.

Current implementations always return the digest (even if empty) so natural TTL expiry retries on its own. War story documented inline in `list-us-events.ts`.

### Environment variables

| Var | Purpose |
|---|---|
| `UPSTASH_REDIS_REST_URL` | Redis endpoint (existing infra) |
| `UPSTASH_REDIS_REST_TOKEN` | Redis auth (existing infra) |
| `WORLDMONITOR_VALID_KEYS` | Comma-separated `X-WorldMonitor-Key` allowlist |
| `WS_RELAY_URL` | Railway relay for IP-blocked feed hosts (CNN, etc.) |
| `RELAY_SHARED_SECRET` | Railway relay auth |
| **`ANTHROPIC_API_KEY`** | **Claude key for location enrichment** |
| **`ANTHROPIC_API_KEY_PARAPHRASE`** | **Claude key for paraphrase + dedup (separate billing)** |

The two Anthropic keys can point at the same actual API key — separation is purely for billing visibility in Anthropic's dashboard.

---

## 7. Operational notes

### Deploy order

After making backend changes:
1. Push to `main` (or your branch).
2. Vercel auto-deploys.
3. **Wait 30+ seconds** for any cached responses to expire if you bumped a cache key version.
4. Curl the endpoint with browser User-Agent (Cloudflare's WAF blocks default curl UA). Use:
   ```bash
   curl -sS '<URL>' \
     -H 'X-WorldMonitor-Key: <key>' \
     -H 'Origin: https://www.worldmonitor.news' \
     -H 'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ...Chrome/131.0.0.0...' \
     | jq '...'
   ```

After making iOS changes:
1. Build & install on device.
2. Pull-to-refresh in the Feed tab to bypass APIClient's 30 s cache.

### Debugging checklist for "items aren't showing"

When iOS shows fewer items than expected, work through these in order:

1. **Curl the endpoint** with browser UA. Confirm the JSON has the expected items.
2. **Check Vercel logs** for `[live-news] returning digest withSummary=X/Y withLocation=Z/Y dedup-dropped=N`. This tells you the response composition.
3. **Check iOS console** for `[LiveNews] fetched N items · summaries=A · locations=B · pendingEnrich=C`. This tells you what iOS decoded.
4. **If curl shows summaries but iOS log shows summaries=0**: it's a Codable issue. Likely the `let X: T? = nil` gotcha (see iOS Codable section). Verify the field doesn't have a default value.
5. **If Vercel `withSummary=0` but Redis has data**: it's a `getCachedJsonBatch` parse issue. Check if Upstash is returning objects vs strings.
6. **If Vercel logs show "Kicking off X" but no LLM completion log**: `keepAlive` is missing or broken. Background promise was killed.

### Known limitations

- **Cross-country dedup gap.** Stories appearing in two country buckets (e.g. summit news pinning to both DC and Beijing) won't collapse. Country bucketing is a deliberate cost optimization.
- **Dedup decisions are immutable for 30 days.** A wrong LLM call sticks. Mitigated by conservative prompt ("only mark duplicate if same specific event") but not zero risk.
- **Single LLM call per cycle for dedup.** If it times out, no decisions written that cycle. Per-country parallelization deferred due to Anthropic Tier 1 rate-limit risk.
- **NCAA sports venues fall to state centroids.** Lat/lng table doesn't cover smaller college towns. Acceptable for v1.
- **All English-language sources.** `summarySnippet` heuristic in dedup assumes Latin-style sentence boundaries. Non-English wires (Le Monde, Tagesschau in their original language) would need different handling.

---

## 8. Future development guide

### Adding a new RSS source to Live News

1. Add to `_sources.ts`:
   ```ts
   { name: 'Source Name', url: 'https://...', priority: 2 },
   ```
2. If host blocks Vercel IPs: add `relayOnly: true`.
3. Add the host to `api/_rss-allowed-domains.js` (only if accessed via `/api/rss-proxy` — direct RSS fetches in `_normalize.ts` don't use the allowlist).
4. Deploy. New source items have new `titleHash` keys, won't collide with existing cache.

### Adding a new sports league

1. Add to `LEAGUES` in `_leagues.ts`:
   ```ts
   { shortName: 'XYZ', longName: 'Full Name', espnPath: 'sport/league' },
   ```
2. Verify ESPN scoreboard URL works: `https://site.api.espn.com/apis/site/v2/sports/{path}/scoreboard`.
3. If venues are in cities not yet in `_venue-coords.ts`, add them.
4. Deploy.

### Adding a new map layer (sports/news pattern)

1. **Backend**: new endpoint mirroring `live-sports/v1` or `live-news/v1` structure. Pick a cache key prefix.
2. **iOS APIEndpoint**: add a case + path + TTL.
3. **iOS service**: create `LiveXYZService` mirroring `LiveSportsService` (singleton, in-flight coalescing, `@Published items`).
4. **iOS FeedFilter**: if it should appear in the Feed tab, add a case to `FeedFilter` enum.
5. **iOS MapLayerType**: add a case + icon + color + label extensions.
6. **iOS MapboxIntelMapView**: add `xyzMgr: PointAnnotationManager`, register in `tappableLayerIds`, `allManagerIds`, `syncAll`, and the teardown nil-out list.
7. **iOS MapLayerControl**: add toggle in the appropriate section.
8. **iOS IntelMapViewModel**: add `@Published showXYZ`, `@Published xyzAnnotations`, `buildXYZAnnotations`, `observeXYZ`, and add to `LayerPrefs` Codable + restore.
9. **mbxMarkerStyle**: add a case for the new type's icon/color (it's an exhaustive switch — won't compile until added).

### Tuning dedup accuracy

If duplicates start slipping through:
- **First**: bump `summarySnippet` from 1 sentence to 2 sentences (in `_dedup.ts`). Almost certainly fixes it.
- **Second**: adjust the system prompt in `_dedup.ts` to be more aggressive about merging (loosen "only mark as duplicate if same specific event" wording).
- **Third**: bump cache version `live-news:dedup:v1` → `v2` so existing decisions get re-evaluated against the new prompt.

If too many uniques get marked as duplicates:
- Tighten the prompt (more conservative).
- Bump cache version to flush bad decisions.

### Common pitfalls (don't repeat these)

1. **Don't add `= nil` to optional `let` properties used in Codable.** Use plain `let X: T?` (see iOS Codable gotcha).
2. **Don't fire-and-forget Promises in Vercel Edge handlers without `keepAlive`.** They get killed.
3. **Don't trust `fetch()` to throw on 4xx.** It doesn't. Always check `resp.ok`.
4. **Don't put large values in URL paths.** Use POST body for any value over a few hundred chars.
5. **Don't mutate items array from inside a `.map()` if you also need the originals.** Use clones or split passes.
6. **Don't bump cache prefixes without comments.** Future you needs to know why.

---

## 9. Glossary

| Term | Meaning |
|---|---|
| **titleHash** | SHA-256 of normalized title — stable per-headline cache key |
| **canonical hash** | The `titleHash` of the representative item for a story; duplicates share canonical |
| **fingerprint dedup** | Layer 1 dedup using normalized title text (cheap regex) |
| **semantic dedup** | Layer 2 dedup using LLM to compare summaries (per-country) |
| **anchor item** | Item with already-cached dedup decision; provides comparison context for new items |
| **unknown item** | Item without a cached dedup decision; needs LLM evaluation |
| **enrichment** | LLM-driven population of location data on news items |
| **paraphrase** | LLM-driven generation of paragraph summaries |
| **keepAlive** | Vercel `waitUntil` wrapper to prevent isolate termination |
| **negative sentinel** | Special cache value indicating "we tried, it failed" — prevents retry storms |
| **state (sports)** | ESPN's pre/in/post for game lifecycle |
| **priority (news)** | Source ranking 1-4 used for dedup tie-breaks |

---

## 10. Quick reference: file map

```
worldmonitor/
├── api/
│   ├── live-sports/v1/list-us-events.ts          ENTRY
│   └── live-news/v1/list-us-headlines.ts          ENTRY
├── server/
│   ├── _shared/
│   │   ├── llm.ts                                 callClaude + provider chain
│   │   ├── keep-alive.ts                          waitUntil wrapper
│   │   ├── redis.ts                               cachedFetchJson, getCachedJson(Batch)
│   │   └── hash.ts                                sha256Hex
│   ├── live-sports/v1/
│   │   ├── _leagues.ts
│   │   ├── _venue-coords.ts
│   │   ├── _normalize.ts
│   │   └── list-us-events.ts                      buildDigest, listUsSportsEvents
│   └── live-news/v1/
│       ├── _sources.ts
│       ├── _normalize.ts
│       ├── _breaking.ts
│       ├── _enrich.ts                             location LLM
│       ├── _paraphrase.ts                         paragraph LLM
│       ├── _dedup.ts                              semantic LLM dedup
│       └── list-us-headlines.ts                   pipeline orchestration
└── docs/
    ├── LIVE_FEEDS_PLAN.md                         original plan doc
    └── LIVE_FEEDS_ARCHITECTURE.md                 (this file)

world-monitor-ios/
└── world-monitor-ios/
    ├── Core/Networking/
    │   ├── APIEndpoint.swift                      endpoint registry
    │   ├── APIClient.swift                        fetch + iOS-side cache
    │   ├── LiveSportsService.swift                shared singleton
    │   └── LiveNewsService.swift                  shared singleton
    ├── Models/News/
    │   └── NewsModels.swift                       NewsItem + ListXResponse types
    └── Features/
        ├── Feed/
        │   ├── FeedView.swift                     chips, refresh tasks
        │   └── FeedViewModel.swift                aggregation
        ├── News/
        │   └── NewsDetailView.swift               FeedItemDetailView w/ summary mode
        └── Map/
            ├── IntelMapView.swift                 MapLayerControl, AnnotationDetailSheet
            ├── IntelMapViewModel.swift            layer state, annotation builders, prefs persistence
            └── MapboxIntelMapView.swift           Mapbox glue, marker style, manager wiring
```
