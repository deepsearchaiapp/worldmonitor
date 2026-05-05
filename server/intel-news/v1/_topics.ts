/**
 * Intel News topics — mapped to GDELT 2.0 Doc API queries.
 *
 * Each topic surfaces in the iOS feed as its own filter chip and contributes
 * articles to a unified intel-news digest. Topic IDs are stable (used as
 * cache key namespaces) — renaming requires a migration.
 *
 * Topic queries are derived from the project doc
 * `docs/gdelt-live-intelligence-fetching.md`. Keep this list in sync with
 * any chip enum on the iOS side and any prompt/category tag we add to the
 * LLM enrichment downstream.
 */

export interface IntelTopic {
  /** Stable id used as the iOS chip enum case + Redis key suffix. */
  id: string;
  /** Human-readable label shown in the iOS chip. */
  label: string;
  /** GDELT boolean query, ASCII only. */
  query: string;
}

export const INTEL_TOPICS: IntelTopic[] = [
  {
    id: 'cyber',
    label: 'CYBER',
    query: '(cyberattack OR ransomware OR hacking OR "data breach" OR APT) sourcelang:eng',
  },
  {
    id: 'military',
    label: 'MILITARY',
    query: '(military exercise OR troop deployment OR airstrike OR "naval exercise") sourcelang:eng',
  },
  {
    id: 'nuclear',
    label: 'NUCLEAR',
    query: '(nuclear OR uranium enrichment OR IAEA OR "nuclear weapon" OR plutonium) sourcelang:eng',
  },
  {
    id: 'sanctions',
    label: 'SANCTIONS',
    query: '(sanctions OR embargo OR "trade war" OR tariff OR "economic pressure") sourcelang:eng',
  },
  {
    id: 'intelligence',
    label: 'INTELLIGENCE',
    query: '(espionage OR spy OR "intelligence agency" OR covert OR surveillance) sourcelang:eng',
  },
  {
    id: 'maritime',
    label: 'MARITIME',
    query: '(naval blockade OR piracy OR "strait of hormuz" OR "south china sea" OR warship) sourcelang:eng',
  },
];

export const VALID_TOPIC_IDS = new Set(INTEL_TOPICS.map((t) => t.id));
