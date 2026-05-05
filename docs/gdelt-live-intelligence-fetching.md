# GDELT data: how to fetch it, and how WorldMonitor wires “Live Intelligence”

This document explains (1) how to obtain data from the **GDELT 2.0 Doc API** in general, and (2) how **this repository** implements category-based fetching for the **Live Intelligence** panel (`gdelt-intel`).

Official project: [The GDELT Project](https://www.gdeltproject.org/). API documentation for the Doc endpoint is published on the GDELT site; this doc focuses on the patterns WorldMonitor uses.

---

## 1. Do you need an API key?

**No.** The public Doc API at `https://api.gdeltproject.org` does not use application keys for the requests WorldMonitor makes. Access is subject to **fair use and strict per-IP rate limiting** (often HTTP **429**), especially from cloud egress IPs. The codebase optionally uses a **proxy** (`PROXY_URL`) for seed scripts—not a GDELT credential.

---

## 2. GDELT 2.0 Doc API (minimal mental model)

The **Doc API** returns material derived from global news/web text: article lists, timelines, tone metrics, etc., depending on query parameters.

### Base URL

```text
https://api.gdeltproject.org/api/v2/doc/doc
```

### Parameters WorldMonitor uses

| Parameter   | Typical value | Purpose |
|------------|----------------|---------|
| `query`    | GDELT boolean search string | What to match (e.g. topics, keywords). |
| `mode`     | `artlist`, `TimelineTone`, `TimelineVol` | Response shape. |
| `format`   | `json` | Machine-readable output. |
| `maxrecords` | `10` (articles) | Cap list size (Doc API limits apply). |
| `timespan` | `24h` (articles), `14d` (timelines) | Rolling window. |
| `sort`     | `date` (articles) | Ordering for article list. |

### Example: article list (curl)

Replace `QUERY` with a URL-encoded GDELT query string:

```bash
curl -sG 'https://api.gdeltproject.org/api/v2/doc/doc' \
  --data-urlencode 'query=(cyberattack OR ransomware) sourcelang:eng' \
  --data-urlencode 'mode=artlist' \
  --data-urlencode 'maxrecords=10' \
  --data-urlencode 'format=json' \
  --data-urlencode 'sort=date' \
  --data-urlencode 'timespan=24h' \
  -H 'User-Agent: Mozilla/5.0 (compatible; WorldMonitor/1.0)'
```

The JSON payload includes an `articles` array; each item may contain fields such as `title`, `url`, `seendate`, `domain`, `tone`, `language`, `socialimage`, depending on mode and availability.

### Example: tone timeline

Same base URL, different `mode` and `timespan` (WorldMonitor uses **14 days** for sparkline data):

```bash
curl -sG 'https://api.gdeltproject.org/api/v2/doc/doc' \
  --data-urlencode 'query=(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng' \
  --data-urlencode 'mode=TimelineTone' \
  --data-urlencode 'format=json' \
  --data-urlencode 'timespan=14d'
```

Volume timelines use `mode=TimelineVol` with the same `query` and `timespan`.

### Query language notes

- Queries are **GDELT’s boolean syntax** (operators like `OR`, quoted phrases, parentheses).
- `sourcelang:eng` restricts to English sources in WorldMonitor’s topic definitions.
- Exact grammar and field names are defined by GDELT; refer to their documentation when extending queries.

---

## 3. Architecture in WorldMonitor (read/write split)

WorldMonitor does **not** call GDELT on every browser request for Live Intelligence.

```
┌─────────────────────────────────────────────────────────────────┐
│  Railway / cron (Node)                                           │
│  scripts/seed-gdelt-intel.mjs                                    │
│    → fetchGdeltJson() in scripts/_gdelt-fetch.mjs                │
│    → HTTPS GET api.gdeltproject.org/api/v2/doc/doc             │
│    → normalize + validate                                        │
│    → Redis UPSTASH                                               │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
   Redis keys (representative):
   • intelligence:gdelt-intel:v1     — bundled topics + articles
   • gdelt:intel:tone:<topicId>     — tone timeline per topic
   • gdelt:intel:vol:<topicId>      — volume timeline per topic
   • seed-meta:intelligence:gdelt-intel — freshness metadata

┌─────────────────────────────────────────────────────────────────┐
│  Vercel Edge / server handler                                    │
│  server/worldmonitor/intelligence/v1/search-gdelt-documents.ts   │
│    → reads intelligence:gdelt-intel:v1 only                      │
│  server/worldmonitor/intelligence/v1/get-gdelt-topic-timeline.ts   │
│    → reads gdelt:intel:tone:* and gdelt:intel:vol:*              │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│  Browser SPA                                                     │
│  src/services/gdelt-intel.ts → IntelligenceServiceClient RPC    │
│  src/components/GdeltIntelPanel.ts                               │
└─────────────────────────────────────────────────────────────────┘
```

**Why:** GDELT throttles shared IPs; centralizing fetches in a **seed job** avoids hammering GDELT from edge functions and keeps cold starts predictable.

---

## 4. Categories (topics) and their queries

Topics are defined **twice** in code and must stay in sync:

1. **Seeder (source of truth for Redis payloads):** `scripts/seed-gdelt-intel.mjs` — `INTEL_TOPICS` array.
2. **Client (UI labels + RPC query strings):** `src/services/gdelt-intel.ts` — `INTEL_TOPICS` (with `name`, `icon`, `description` for the app; `query` must match the seeder).

Current topic IDs and queries (from the seeder):

| Topic ID      | GDELT `query` |
|---------------|----------------|
| `military`    | `(military exercise OR troop deployment OR airstrike OR "naval exercise") sourcelang:eng` |
| `cyber`       | `(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng` |
| `nuclear`     | `(nuclear OR uranium enrichment OR IAEA OR "nuclear weapon" OR plutonium) sourcelang:eng` |
| `sanctions`   | `(sanctions OR embargo OR "trade war" OR tariff OR "economic pressure") sourcelang:eng` |
| `intelligence`| `(espionage OR spy OR "intelligence agency" OR covert OR surveillance) sourcelang:eng` |
| `maritime`    | `(naval blockade OR piracy OR "strait of hormuz" OR "south china sea" OR warship) sourcelang:eng` |

Adding a category means: add an entry to **both** arrays, extend `VALID_TOPICS` in `server/worldmonitor/intelligence/v1/get-gdelt-topic-timeline.ts`, run seeds, and ensure health/bootstrap keys remain consistent.

---

## 5. Seeder implementation (`scripts/seed-gdelt-intel.mjs`)

### 5.1 Article fetch per topic

For each topic, the script builds a URL:

- `query` = topic’s boolean string  
- `mode=artlist`  
- `maxrecords=10`  
- `format=json`  
- `sort=date`  
- `timespan=24h`  

It calls `fetchGdeltJson(url)` from `scripts/_gdelt-fetch.mjs`, which:

1. Tries **direct** `fetch` with retries and backoff on **429** and **503**.
2. If direct attempts fail and **`PROXY_URL`** is set, runs up to **N** **curl**-based requests through the proxy (session rotation helps bypass some throttles).

Articles are normalized to: `title`, `url`, `source` (domain), `date` (`seendate`), optional `image`, `language`, numeric `tone`.

### 5.2 Timeline fetch per topic

After articles, for each topic the seeder runs **two** parallel Doc requests:

- `mode=TimelineTone`, `timespan=14d`  
- `mode=TimelineVol`, `timespan=14d`  

Timeline calls use a **smaller** retry budget (`maxRetries: 0`, `proxyMaxAttempts: 2`) so a bad GDELT day does not block the whole job for too long.

### 5.3 Pacing and rate-limit hygiene

- **20 seconds** between topics (`INTER_TOPIC_DELAY_MS`) after the first, to reduce 429 chains.
- If a topic exhausts retries with 429-like failure, an extra **2 minute** pause (`POST_EXHAUST_DELAY_MS`) before the next topic.
- If a topic returns **zero articles** after rate limits, the seeder **merges the previous Redis snapshot** for that topic’s articles so good data is not overwritten by empty runs (`verifySeedKey` + prior `topics`).

### 5.4 Validation and publish

- `validate()` requires **at least three** topics with non-empty article arrays before accepting a new snapshot (partial outages tolerated).
- `publishTransform()` strips internal fields (`_tone`, `_vol`, `exhausted`) before writing the canonical JSON blob.
- `afterPublish()` writes per-topic timeline keys and may **extend TTL** on existing tone/vol keys when new timeline fetches failed (avoids charts disappearing mid-cycle).

### 5.5 Redis and metadata

`runSeed()` (from `scripts/_seed-utils.mjs`) writes:

- Canonical key: **`intelligence:gdelt-intel:v1`** (TTL 24h in script constants; cron is expected more frequently than expiry).
- Extra keys: **`gdelt:intel:tone:<id>`**, **`gdelt:intel:vol:<id>`** with a shorter timeline TTL (12h in script constants).
- Seed metadata for health checks (see `api/health.js` / `api/seed-health.js`).

Cron expectations are documented in repo health config (e.g. ~6h + grace for staleness checks).

---

## 6. Server read path (no live GDELT call)

### 6.1 `searchGdeltDocuments`

File: `server/worldmonitor/intelligence/v1/search-gdelt-documents.ts`

- Loads **`intelligence:gdelt-intel:v1`** from Redis.
- Finds the **first** topic in the seeded array for which either condition holds:
  1. The incoming `req.query` (lowercased) **contains the topic `id` as a substring** (e.g. the `cyber` topic matches because the query contains the token `cyberattack`), or  
  2. **Some article title** (lowercased) contains the **first 20 characters** of the full query string (brittle fallback—titles rarely contain the leading parenthesis and boolean syntax).

Because matching uses `.find()` on the stored topic order, **topic `query` strings should include the topic `id` somewhere** if you want reliable lookups. Several topics embed their id or a clear substring (`military`, `cyber`, `nuclear`, `sanctions`, `intelligence` via `"intelligence agency"`). If you add topics whose `id` never appears in `query`, confirm the title fallback or adjust the handler to map by explicit topic id.

Returns up to `maxRecords` (capped at 20) articles for that topic.

If Redis has no seed, it returns **`error: 'seed-unavailable'`** so the client can show an empty state instead of infinite retry.

### 6.2 `getGdeltTopicTimeline`

File: `server/worldmonitor/intelligence/v1/get-gdelt-topic-timeline.ts`

- Validates `topic` against a fixed allowlist (`military`, `cyber`, `nuclear`, `sanctions`, `intelligence`, `maritime`).
- Reads **`gdelt:intel:tone:<topic>`** and **`gdelt:intel:vol:<topic>`** from Redis.

---

## 7. Browser client (`src/services/gdelt-intel.ts`)

- **`IntelligenceServiceClient`** calls `searchGdeltDocuments` and `getGdeltTopicTimeline` over the app’s RPC base URL.
- **`fetchTopicIntelligence(topic)`** loads articles: uses bootstrap hydration key `gdeltIntel` when present, else `fetchGdeltArticles(topic.query, 10, '24h')`.
- **Circuit breaker** caches successful RPC responses client-side (see `createCircuitBreaker` usage in the same file).
- **`GdeltIntelPanel`** tabs over `getIntelTopics()` and renders articles + optional sparklines from timelines.

---

## 8. Running the GDELT intel seeder locally

Prerequisites: Node, project env with **Upstash Redis** (same variables as other seed scripts—see `scripts/_seed-utils.mjs` and `.env.example`).

```bash
node scripts/seed-gdelt-intel.mjs
```

Optional: set **`PROXY_URL`** if direct requests return 429 from your network.

---

## 9. Operational checklist (self-host)

| Step | Action |
|------|--------|
| 1 | Ensure Redis is reachable from the machine running seeds. |
| 2 | Schedule `seed-gdelt-intel.mjs` on a fixed cadence (see `api/health.js` / `api/seed-health.js` for stale thresholds). |
| 3 | Optionally configure **`PROXY_URL`** for reliable egress. |
| 4 | Confirm `intelligence:gdelt-intel:v1` and `seed-meta:intelligence:gdelt-intel` appear in Redis after a successful run. |
| 5 | Load the app: Live Intelligence panel should populate; if not, check for `seed-unavailable` in RPC responses. |

---

## 10. Related files (quick index)

| File | Role |
|------|------|
| `scripts/seed-gdelt-intel.mjs` | Fetches all topics from GDELT, writes Redis. |
| `scripts/_gdelt-fetch.mjs` | Retries, 429 handling, optional curl proxy. |
| `server/worldmonitor/intelligence/v1/search-gdelt-documents.ts` | Serves articles from Redis. |
| `server/worldmonitor/intelligence/v1/get-gdelt-topic-timeline.ts` | Serves tone/volume series from Redis. |
| `src/services/gdelt-intel.ts` | Client queries, topic list, caching. |
| `src/components/GdeltIntelPanel.ts` | Live Intelligence UI. |
| `api/bootstrap.js` | Includes `gdeltIntel` in hydration for faster first paint. |

---

## 11. Happy variant (positive topics)

`src/services/gdelt-intel.ts` also defines **`POSITIVE_GDELT_TOPICS`** for the “happy” product variant. Those queries are fetched through a separate code path (`fetchPositiveTopicIntelligence` / positive circuit breaker). They are **not** part of the default six military/cyber/… tabs unless that variant enables them. Seeding for positive topics may be handled by separate scripts or bootstrap content; check `data-loader` and seed scripts if you extend that variant.

---

*This document describes the implementation in the WorldMonitor repository at the time of writing. GDELT’s upstream API behavior, limits, and field names may change; always verify against the official GDELT documentation for production integrations.*
