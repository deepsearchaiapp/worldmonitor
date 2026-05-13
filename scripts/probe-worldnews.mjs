#!/usr/bin/env node
/**
 * Probe the World News API and pretty-print the response.
 *
 * Usage (from repo root):
 *
 *   node scripts/probe-worldnews.mjs top
 *   node scripts/probe-worldnews.mjs search --text "drone strike" --hours 6
 *   node scripts/probe-worldnews.mjs search --countries us,gb --hours 3 --number 50
 *   node scripts/probe-worldnews.mjs retrieve --ids 431232870,431142254
 *   node scripts/probe-worldnews.mjs geo --location "Kharkiv"
 *   node scripts/probe-worldnews.mjs raw --text "iran"      # dump the full response JSON
 *
 * The script reads WORLDNEWS_API_KEY from the environment. If it's not set,
 * it reads `.env` in the repo root (no dependency on dotenv — naive parse).
 *
 * Every call prints the quota headers so you can watch your daily budget
 * burn down while iterating on queries.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// ── env loading ────────────────────────────────────────────────────────
function loadApiKey() {
  if (process.env.WORLDNEWS_API_KEY) return process.env.WORLDNEWS_API_KEY;
  try {
    const envFile = readFileSync(resolve(REPO_ROOT, '.env'), 'utf8');
    const m = envFile.match(/^WORLDNEWS_API_KEY\s*=\s*(.+)$/m);
    if (m && m[1] && m[1].trim()) return m[1].trim();
  } catch { /* .env not present */ }
  console.error('WORLDNEWS_API_KEY is not set. Add it to .env or export it.');
  process.exit(1);
}

const API_KEY = loadApiKey();
const BASE = 'https://api.worldnewsapi.com';

// ── arg parsing ────────────────────────────────────────────────────────
const [, , command, ...rest] = process.argv;
const args = {};
for (let i = 0; i < rest.length; i += 2) {
  const k = rest[i]?.replace(/^--/, '');
  const v = rest[i + 1];
  if (k) args[k] = v;
}

// ── helpers ────────────────────────────────────────────────────────────
function formatPublishDate(d) {
  // "YYYY-MM-DD HH:MM:SS" — what the API expects
  return new Date(d).toISOString().replace('T', ' ').slice(0, 19);
}

function summarizeArticle(a) {
  const ts = a.publish_date ?? '(no date)';
  const host = (() => { try { return new URL(a.url).hostname.replace(/^www\./, ''); } catch { return '?'; } })();
  const title = (a.title ?? '').replace(/\s+/g, ' ').trim();
  const summaryLen = (a.summary ?? '').length;
  const textLen = (a.text ?? '').length;
  const country = (a.source_country ?? '').toLowerCase();
  return {
    id: a.id,
    when: ts,
    country,
    host,
    title: title.length > 110 ? title.slice(0, 107) + '...' : title,
    hasSummary: summaryLen > 0 ? `${summaryLen}c` : '-',
    textLen,
  };
}

function printTable(rows) {
  if (rows.length === 0) {
    console.log('  (no items)');
    return;
  }
  const cols = Object.keys(rows[0]);
  const widths = cols.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)));
  const fmt = (vals) => vals.map((v, i) => String(v ?? '').padEnd(widths[i])).join('  ');
  console.log('  ' + fmt(cols));
  console.log('  ' + cols.map((_, i) => '-'.repeat(widths[i])).join('  '));
  for (const r of rows) console.log('  ' + fmt(cols.map((c) => r[c])));
}

async function call(path, params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    usp.set(k, String(v));
  }
  usp.set('api-key', API_KEY);
  const url = `${BASE}${path}?${usp}`;

  const started = Date.now();
  const resp = await fetch(url);
  const elapsed = Date.now() - started;

  const used = resp.headers.get('x-api-quota-used');
  const left = resp.headers.get('x-api-quota-left');
  const req = resp.headers.get('x-api-quota-request');
  console.log(
    `[${resp.status}] ${path} in ${elapsed}ms  · quota: used=${used} left=${left} req=${req}`,
  );

  const body = await resp.json().catch(() => null);
  if (!resp.ok) {
    console.error('Error body:', JSON.stringify(body, null, 2));
    process.exit(1);
  }
  return body;
}

// ── commands ───────────────────────────────────────────────────────────
async function cmdTop() {
  const body = await call('/top-news', {
    'source-country': args.country ?? 'us',
    language: args.language ?? 'en',
  });
  const clusters = body.top_news ?? [];
  console.log(`\nTop-news clusters: ${clusters.length}`);
  clusters.forEach((c, i) => {
    const lead = c.news?.[0];
    if (!lead) return;
    const others = (c.news ?? []).slice(1);
    console.log(`\n  [cluster #${i + 1}, ${c.news.length} article(s)]`);
    console.log(`  → ${lead.title}`);
    const host = (() => { try { return new URL(lead.url).hostname.replace(/^www\./, ''); } catch { return '?'; } })();
    console.log(`    ${host} · ${lead.publish_date}`);
    if (others.length > 0) {
      console.log(`    Also covered by:`);
      for (const o of others) {
        const h = (() => { try { return new URL(o.url).hostname.replace(/^www\./, ''); } catch { return '?'; } })();
        console.log(`      - ${h.padEnd(28)} ${(o.title ?? '').slice(0, 80)}`);
      }
    }
  });
}

async function cmdSearch() {
  const hours = Number(args.hours ?? 6);
  const number = Number(args.number ?? 20);
  const body = await call('/search-news', {
    text: args.text,
    language: args.language ?? 'en',
    'source-countries': args.countries ?? 'us,gb,au,ca',
    'earliest-publish-date': formatPublishDate(Date.now() - hours * 60 * 60 * 1000),
    sort: 'publish-time',
    'sort-direction': 'DESC',
    number,
  });
  const news = body.news ?? [];
  console.log(`\navailable=${body.available}  returned=${news.length}\n`);
  printTable(news.map(summarizeArticle));
}

async function cmdRetrieve() {
  if (!args.ids) {
    console.error('--ids is required (comma-separated integers)');
    process.exit(1);
  }
  const body = await call('/retrieve-news', { ids: args.ids });
  console.log(JSON.stringify(body, null, 2));
}

async function cmdGeo() {
  if (!args.location) {
    console.error('--location is required (e.g. "Kharkiv" or "Tel Aviv, Israel")');
    process.exit(1);
  }
  const body = await call('/geo-coordinates', { location: args.location });
  console.log(JSON.stringify(body, null, 2));
}

async function cmdRaw() {
  // Same as search, but dumps the full JSON instead of the table view.
  const hours = Number(args.hours ?? 6);
  const number = Number(args.number ?? 10);
  const body = await call('/search-news', {
    text: args.text,
    language: args.language ?? 'en',
    'source-countries': args.countries ?? 'us,gb,au,ca',
    'earliest-publish-date': formatPublishDate(Date.now() - hours * 60 * 60 * 1000),
    sort: 'publish-time',
    'sort-direction': 'DESC',
    number,
  });
  console.log(JSON.stringify(body, null, 2));
}

// ── dispatch ───────────────────────────────────────────────────────────
const commands = {
  top: cmdTop,
  search: cmdSearch,
  retrieve: cmdRetrieve,
  geo: cmdGeo,
  raw: cmdRaw,
};

if (!command || !commands[command]) {
  console.log(`Usage: node scripts/probe-worldnews.mjs <command> [--flag value]

Commands:
  top                              Top-news clusters for a country
                                   (defaults: --country us --language en)

  search   --text "drone strike"   Search-news with the summary table view
           --hours 6
           --number 20
           --countries us,gb,au,ca

  retrieve --ids 431232870,...     Fetch full article objects by id

  geo      --location "Kharkiv"    Geocode a place name → lat/lng

  raw      [search args]           Same as search but dumps the full JSON
                                   (use when you need every field)
`);
  process.exit(command ? 1 : 0);
}

commands[command]().catch((err) => {
  console.error('Failed:', err);
  process.exit(1);
});
