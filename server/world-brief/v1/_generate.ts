/**
 * World Brief generator — the hourly "AI World Brief" shown on top of the
 * conflict and live-news feed sections.
 *
 * Reads the v6 RSS-clustering digest (`live-news:v6:digest`), ranks the
 * most-referenced clusters, and asks Gemini for an original-wording,
 * copyright-safe factual brief of each. Two sections are produced:
 *
 *   conflict  — clusters with `isConflict === true`, ranked by TOTAL source
 *               count (RSS + GDELT corroboration both count).
 *   liveNews  — all clusters, ranked by distinct RSS-publisher count only
 *               (GDELT never counts). Reused by every non-conflict feed
 *               section in the app.
 *
 * GDELT members deepen the conflict ranking but never reach the LLM — only
 * RSS headlines + the RSS-supplied lede are sent for summarization, per the
 * pipeline rule that GDELT content never touches an LLM.
 */

import { getCachedJson, setCachedJson } from '../../_shared/redis';
import { callGemini } from '../../_shared/llm';
import type { ClusteredItem } from '../../live-news/v6/_cluster';

/** v6 digest key — see server/live-news/v6/refresh.ts (DIGEST_KEY). */
const DIGEST_KEY = 'live-news:v6:digest';

export const WORLD_BRIEF_KEY = 'news:world-brief:v1';

/** 25 h — long enough to survive ~a day of missed hourly crons. Staleness
 *  is surfaced to the user via `generatedAt` on the card. */
const WORLD_BRIEF_TTL_S = 25 * 60 * 60;

/** Distinct-RSS-publisher gate — matches the live-news/conflict read gate. */
const MIN_RSS_SOURCES = Number(process.env.WM_V6_MIN_SOURCES) || 3;

const TOP_N = 8;
const MAX_MEMBER_HEADLINES = 10;
const MAX_TEXT_LEN = 600;

export type BriefThreatLevel = 'CRITICAL' | 'HIGH' | 'ELEVATED' | 'MODERATE';
const THREAT_ORDER: BriefThreatLevel[] = ['MODERATE', 'ELEVATED', 'HIGH', 'CRITICAL'];

export interface WorldBriefCluster {
  /** v6 cluster id (canonical titleHash) — lets iOS deep-link to the feed. */
  id: string;
  /** Original-wording neutral headline (not copied from any outlet). */
  headline: string;
  /** Factual core: who / what / when / where. */
  whatHappened: string;
  /** One sentence on significance / wider implications. */
  whyItMatters: string;
  /** 2–4 free-form uppercase topical tags. */
  tags: string[];
  threatLevel: BriefThreatLevel;
  /** Ranking metric: total sources for conflict, RSS publishers for live-news. */
  sourceCount: number;
  link: string;
  imageUrl: string | null;
  locationName: string | null;
  publishedAt: number;
}

export interface WorldBriefSection {
  /** 1–2 sentence synthesis across all clusters in this section. */
  overview: string;
  threatLevel: BriefThreatLevel;
  clusters: WorldBriefCluster[];
}

export interface WorldBriefPayload {
  generatedAt: number;
  conflict: WorldBriefSection | null;
  liveNews: WorldBriefSection | null;
}

type BriefMode = 'conflict' | 'live-news';

interface PickedCluster {
  cluster: ClusteredItem;
  /** Mode-appropriate source count used both for ranking and display. */
  score: number;
  /** Up to 10 RSS member headlines — the only content sent to the LLM. */
  rssHeadlines: string[];
}

// ── Ranking ────────────────────────────────────────────────────────────────

function rssSourceCount(c: ClusteredItem): number {
  return c.sources.filter((s) => s.origin === 'rss').length;
}

/**
 * Pick the top-N most-referenced clusters for a section.
 *
 *   conflict   — only `isConflict` clusters, scored by total source count.
 *   live-news  — all clusters, scored by distinct RSS-publisher count.
 *
 * Both modes require ≥ MIN_RSS_SOURCES distinct RSS publishers (the display
 * gate); GDELT corroboration never satisfies the gate.
 */
function pickClusters(clusters: ClusteredItem[], mode: BriefMode): PickedCluster[] {
  return clusters
    .filter((c) => c && Array.isArray(c.sources) && rssSourceCount(c) >= MIN_RSS_SOURCES)
    .filter((c) => (mode === 'conflict' ? c.isConflict === true : true))
    .map((c) => ({
      cluster: c,
      score: mode === 'conflict' ? c.sources.length : rssSourceCount(c),
      rssHeadlines: c.sources
        .filter((s) => s.origin === 'rss')
        .slice(0, MAX_MEMBER_HEADLINES)
        .map((s) => s.title)
        .filter((t): t is string => typeof t === 'string' && t.trim().length > 0),
    }))
    .sort((a, b) => b.score - a.score || b.cluster.publishedAt - a.cluster.publishedAt)
    .slice(0, TOP_N);
}

// ── LLM prompt ───────────────────────────────────────────────────────────────

function systemPrompt(mode: BriefMode): string {
  const desk =
    mode === 'conflict'
      ? 'a geopolitical conflict-monitoring intelligence desk'
      : 'a world-news intelligence desk';
  return `You are the editor of ${desk}. You receive several news stories. Each story is a cluster of headlines from multiple independent outlets covering the SAME event, plus a short lede.

For EACH story, write an original, neutral, factual brief. This is critical:
- Do NOT copy or lightly reword any sentence from the supplied headlines or lede. Identify the underlying factual claims — who, what, when, where — and restate them entirely in your own words.
- Report only facts corroborated by the supplied material. Never speculate or add outside information.
- Stay neutral: no loaded adjectives, no editorializing; attribute contested or one-sided claims.

For each story produce:
- "headline": a concise, original, neutral headline — max 12 words.
- "whatHappened": 1-2 sentences stating the core facts (who / what / when / where).
- "whyItMatters": one sentence on the significance or wider implications.
- "tags": 2 to 4 short UPPERCASE topical tags, e.g. "MISSILE STRIKE", "CEASEFIRE TALKS", "SANCTIONS", "ELECTION".
- "threatLevel": one of "CRITICAL", "HIGH", "ELEVATED", "MODERATE" — how severe or escalatory the event is${mode === 'conflict' ? '' : ' (for non-conflict news, judge overall global significance instead)'}.

Also produce:
- "overview": 1-2 sentences synthesizing the most important developments across all stories.
- "overallThreatLevel": one of "CRITICAL", "HIGH", "ELEVATED", "MODERATE" — the highest level the overall situation warrants.

Respond with ONLY a JSON object of exactly this shape:
{"overview":"...","overallThreatLevel":"...","stories":[{"index":1,"headline":"...","whatHappened":"...","whyItMatters":"...","tags":["..."],"threatLevel":"..."}]}
The "index" must match the STORY number. Include exactly one entry per story.`;
}

function userPrompt(picked: PickedCluster[]): string {
  const today = new Date().toISOString().split('T')[0];
  const blocks = picked.map((p, i) => {
    const lede = (p.cluster.summary || '').trim() || '(no lede available)';
    const headlines = p.rssHeadlines.map((h) => `  - ${h}`).join('\n') || '  - (none)';
    return `STORY ${i + 1}:\nLede: ${lede}\nHeadlines from ${p.rssHeadlines.length} outlet(s):\n${headlines}`;
  });
  return `Today is ${today}.\n\nHere are ${picked.length} news stories to brief:\n\n${blocks.join('\n\n')}`;
}

// ── Parsing / sanitizing LLM output ──────────────────────────────────────────

interface LlmStory {
  index: number;
  headline?: string;
  whatHappened?: string;
  whyItMatters?: string;
  tags?: unknown;
  threatLevel?: string;
}
interface LlmResponse {
  overview?: string;
  overallThreatLevel?: string;
  stories?: LlmStory[];
}

function normalizeThreat(value: unknown): BriefThreatLevel {
  const v = String(value || '').trim().toUpperCase();
  if (v === 'CRITICAL' || v === 'HIGH' || v === 'ELEVATED' || v === 'MODERATE') return v;
  return 'MODERATE';
}

function maxThreat(levels: BriefThreatLevel[]): BriefThreatLevel {
  return levels.reduce<BriefThreatLevel>(
    (acc, l) => (THREAT_ORDER.indexOf(l) > THREAT_ORDER.indexOf(acc) ? l : acc),
    'MODERATE',
  );
}

function clampText(value: unknown, fallback = ''): string {
  const s = typeof value === 'string' ? value.trim() : '';
  return (s || fallback).slice(0, MAX_TEXT_LEN);
}

function sanitizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().toUpperCase().slice(0, 30);
    if (tag && !seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
    if (out.length >= 4) break;
  }
  return out;
}

function parseLlmResponse(content: string): LlmResponse | null {
  try {
    const parsed = JSON.parse(content) as LlmResponse;
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    // jsonMode normally guarantees valid JSON; treat anything else as failure.
  }
  return null;
}

// ── Section build ────────────────────────────────────────────────────────────

/**
 * Build one brief section. Returns null when there is nothing to brief or
 * the LLM call fails outright — the caller then falls back to the prior
 * payload (last-known-good). A partial LLM response is tolerated: clusters
 * the model omitted fall back to the raw cluster title/lede.
 */
async function buildSection(
  clusters: ClusteredItem[],
  mode: BriefMode,
): Promise<WorldBriefSection | null> {
  const picked = pickClusters(clusters, mode);
  if (picked.length === 0) {
    console.warn(`[world-brief] mode=${mode} no clusters passed the gate`);
    return null;
  }

  const result = await callGemini({
    system: systemPrompt(mode),
    prompt: userPrompt(picked),
    model: 'gemini-2.5-flash',
    jsonMode: true,
    maxTokens: 4000,
    temperature: 0.3,
    timeoutMs: 30_000,
    caller: `world-brief:${mode}`,
  });

  if (!result) {
    console.warn(`[world-brief] mode=${mode} Gemini call failed`);
    return null;
  }

  const parsed = parseLlmResponse(result.content);
  if (!parsed) {
    console.warn(`[world-brief] mode=${mode} unparseable LLM response`);
    return null;
  }

  const storyByIndex = new Map<number, LlmStory>();
  for (const s of parsed.stories ?? []) {
    const idx = Number(s?.index);
    if (Number.isFinite(idx)) storyByIndex.set(idx, s);
  }

  const briefClusters: WorldBriefCluster[] = picked.map((p, i) => {
    const story = storyByIndex.get(i + 1);
    return {
      id: p.cluster.id,
      headline: clampText(story?.headline, p.cluster.title),
      whatHappened: clampText(story?.whatHappened, p.cluster.summary || ''),
      whyItMatters: clampText(story?.whyItMatters),
      tags: sanitizeTags(story?.tags),
      threatLevel: normalizeThreat(story?.threatLevel),
      sourceCount: p.score,
      link: p.cluster.link,
      imageUrl: p.cluster.imageUrl ?? null,
      locationName: p.cluster.locationName ?? null,
      publishedAt: p.cluster.publishedAt,
    };
  });

  const sectionThreat = parsed.overallThreatLevel
    ? normalizeThreat(parsed.overallThreatLevel)
    : maxThreat(briefClusters.map((c) => c.threatLevel));

  return {
    overview: clampText(parsed.overview),
    threatLevel: sectionThreat,
    clusters: briefClusters,
  };
}

// ── Public entry points ──────────────────────────────────────────────────────

/**
 * Generate both brief sections from the current v6 digest. On a per-section
 * failure the previous section is carried forward (last-known-good).
 */
export async function generateWorldBrief(): Promise<WorldBriefPayload> {
  const digest = (await getCachedJson(DIGEST_KEY, false, 5_000)) as ClusteredItem[] | null;
  const clusters = Array.isArray(digest) ? digest : [];
  console.log(`[world-brief] digest clusters=${clusters.length}`);

  const [conflict, liveNews] = await Promise.all([
    buildSection(clusters, 'conflict'),
    buildSection(clusters, 'live-news'),
  ]);

  const payload: WorldBriefPayload = {
    generatedAt: Date.now(),
    conflict,
    liveNews,
  };

  if (!conflict || !liveNews) {
    const prev = (await getCachedJson(WORLD_BRIEF_KEY, false, 3_000)) as WorldBriefPayload | null;
    if (prev) {
      if (!conflict && prev.conflict) {
        payload.conflict = prev.conflict;
        console.log('[world-brief] conflict section preserved from last-known-good');
      }
      if (!liveNews && prev.liveNews) {
        payload.liveNews = prev.liveNews;
        console.log('[world-brief] liveNews section preserved from last-known-good');
      }
    }
  }

  return payload;
}

export interface RefreshWorldBriefResult {
  status: 'ok' | 'empty';
  conflictClusters: number;
  liveNewsClusters: number;
  generatedAt: string;
}

/** Cron entry point — generate the brief and write it to Redis. Idempotent. */
export async function refreshWorldBrief(): Promise<RefreshWorldBriefResult> {
  const startedAt = Date.now();
  const payload = await generateWorldBrief();
  await setCachedJson(WORLD_BRIEF_KEY, payload, WORLD_BRIEF_TTL_S);

  const conflictClusters = payload.conflict?.clusters.length ?? 0;
  const liveNewsClusters = payload.liveNews?.clusters.length ?? 0;
  console.log(
    `[world-brief] DONE total=${Date.now() - startedAt}ms ` +
      `conflict=${conflictClusters} liveNews=${liveNewsClusters}`,
  );

  return {
    status: conflictClusters + liveNewsClusters > 0 ? 'ok' : 'empty',
    conflictClusters,
    liveNewsClusters,
    generatedAt: new Date(payload.generatedAt).toISOString(),
  };
}
