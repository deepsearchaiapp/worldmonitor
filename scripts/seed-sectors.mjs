#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, sleep, runSeed, writeExtraKey } from './_seed-utils.mjs';

loadEnvFile(import.meta.url);

const CANONICAL_KEY = 'market:sectors:v1';
const CACHE_TTL = 1800; // 30 min
const YAHOO_DELAY_MS = 200;

const SECTOR_SYMBOLS = ['XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLI', 'XLP', 'XLU', 'XLB', 'XLRE', 'XLC', 'SMH'];

async function fetchYahooQuote(symbol) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`;
    const resp = await fetch(url, {
      headers: { 'User-Agent': CHROME_UA },
      signal: AbortSignal.timeout(10_000),
    });
    if (resp.status === 429) {
      console.warn(`  [Yahoo] ${symbol} rate limited`);
      return null;
    }
    if (!resp.ok) {
      console.warn(`  [Yahoo] ${symbol} HTTP ${resp.status}`);
      return null;
    }
    const data = await resp.json();
    const result = data?.chart?.result?.[0];
    const meta = result?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice;
    const prevClose = meta.chartPreviousClose || meta.previousClose || price;
    const change = prevClose ? ((price - prevClose) / prevClose) * 100 : 0;
    return { symbol, name: symbol, change: +change.toFixed(2) };
  } catch (err) {
    console.warn(`  [Yahoo] ${symbol} error: ${err.message}`);
    return null;
  }
}

async function fetchSectors() {
  const sectors = [];
  const apiKey = process.env.FINNHUB_API_KEY;

  // Try Finnhub first (parallel)
  if (apiKey) {
    const results = await Promise.all(SECTOR_SYMBOLS.map(async (s) => {
      try {
        const resp = await fetch(`https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(s)}`, {
          headers: { 'User-Agent': CHROME_UA, 'X-Finnhub-Token': apiKey },
          signal: AbortSignal.timeout(10_000),
        });
        if (!resp.ok) return null;
        const d = await resp.json();
        if (d.c === 0 && d.h === 0) return null;
        return { symbol: s, name: s, change: d.dp };
      } catch { return null; }
    }));
    for (const r of results) {
      if (r) {
        sectors.push(r);
        console.log(`  [Finnhub] ${r.symbol}: ${r.change > 0 ? '+' : ''}${r.change}%`);
      }
    }
  }

  // Yahoo fallback for any missing
  if (sectors.length < SECTOR_SYMBOLS.length) {
    const fetched = new Set(sectors.map((s) => s.symbol));
    for (const s of SECTOR_SYMBOLS) {
      if (fetched.has(s)) continue;
      await sleep(YAHOO_DELAY_MS);
      const q = await fetchYahooQuote(s);
      if (q) {
        sectors.push(q);
        console.log(`  [Yahoo] ${q.symbol}: ${q.change > 0 ? '+' : ''}${q.change}%`);
      }
    }
  }

  if (sectors.length === 0) throw new Error('All sector fetches failed');
  return { sectors };
}

function validate(data) {
  return Array.isArray(data?.sectors) && data.sectors.length >= 1;
}

let seedData = null;

async function fetchAndStash() {
  seedData = await fetchSectors();
  return seedData;
}

runSeed('market', 'sectors', CANONICAL_KEY, fetchAndStash, {
  validateFn: validate,
  ttlSeconds: CACHE_TTL,
  sourceVersion: 'yahoo+finnhub-etf',
}).then(async () => {
  if (!seedData) return;
  // Also write the quotes-compatible key for the RPC layer
  const quotesKey = `market:quotes:v1:${[...SECTOR_SYMBOLS].sort().join(',')}`;
  const sectorQuotes = seedData.sectors.map((s) => ({
    symbol: s.symbol, name: s.name, display: s.name,
    price: 0, change: s.change, sparkline: [],
  }));
  await writeExtraKey(quotesKey, { quotes: sectorQuotes, finnhubSkipped: false, skipReason: '', rateLimited: false }, CACHE_TTL);
}).catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
