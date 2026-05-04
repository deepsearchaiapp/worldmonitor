#!/usr/bin/env node

import { loadEnvFile, CHROME_UA, getRedisCredentials, acquireLock, releaseLock, withRetry, writeFreshnessMetadata, logSeedResult, verifySeedKey } from './_seed-utils.mjs';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';

loadEnvFile(import.meta.url);

const LIVE_KEY = 'military:flights:v1';
const STALE_KEY = 'military:flights:stale:v1';
const LIVE_TTL = 600;
const STALE_TTL = 86400;

const THEATER_POSTURE_LIVE_KEY = 'theater-posture:sebuf:v1';
const THEATER_POSTURE_STALE_KEY = 'theater-posture:sebuf:stale:v1';
const THEATER_POSTURE_BACKUP_KEY = 'theater-posture:sebuf:backup:v1';
const THEATER_POSTURE_LIVE_TTL = 900;
const THEATER_POSTURE_STALE_TTL = 86400;
const THEATER_POSTURE_BACKUP_TTL = 604800;

// ── Proxy Config ─────────────────────────────────────────
const OPENSKY_PROXY_AUTH = process.env.OPENSKY_PROXY_AUTH || process.env.OREF_PROXY_AUTH || '';
const PROXY_ENABLED = !!OPENSKY_PROXY_AUTH;

// ── Query Regions ──────────────────────────────────────────
const QUERY_REGIONS = [
  { name: 'PACIFIC', lamin: 10, lamax: 46, lomin: 107, lomax: 143 },
  { name: 'WESTERN', lamin: 13, lamax: 85, lomin: -10, lomax: 57 },
];

// ── Military Hex Ranges (ICAO 24-bit) ─────────────────────
const HEX_RANGES = [
  { start: 'ADF7C8', end: 'AFFFFF', operator: 'usaf', country: 'USA' },
  { start: '400000', end: '40003F', operator: 'raf', country: 'UK' },
  { start: '43C000', end: '43CFFF', operator: 'raf', country: 'UK' },
  { start: '3AA000', end: '3AFFFF', operator: 'faf', country: 'France' },
  { start: '3B7000', end: '3BFFFF', operator: 'faf', country: 'France' },
  { start: '3EA000', end: '3EBFFF', operator: 'gaf', country: 'Germany' },
  { start: '3F4000', end: '3FBFFF', operator: 'gaf', country: 'Germany' },
  { start: '738A00', end: '738BFF', operator: 'iaf', country: 'Israel' },
  { start: '4D0000', end: '4D03FF', operator: 'nato', country: 'NATO' },
  { start: '33FF00', end: '33FFFF', operator: 'other', country: 'Italy' },
  { start: '350000', end: '3503FF', operator: 'other', country: 'Spain' },
  { start: '480000', end: '480FFF', operator: 'other', country: 'Netherlands' },
  { start: '4B8200', end: '4B82FF', operator: 'other', country: 'Turkey' },
  { start: '710258', end: '71028F', operator: 'other', country: 'Saudi Arabia' },
  { start: '710380', end: '71039F', operator: 'other', country: 'Saudi Arabia' },
  { start: '896800', end: '896BFF', operator: 'other', country: 'UAE' },
  { start: '06A200', end: '06A3FF', operator: 'other', country: 'Qatar' },
  { start: '706000', end: '706FFF', operator: 'other', country: 'Kuwait' },
  { start: '7CF800', end: '7CFAFF', operator: 'other', country: 'Australia' },
  { start: 'C2D000', end: 'C2DFFF', operator: 'other', country: 'Canada' },
  { start: '800200', end: '8002FF', operator: 'other', country: 'India' },
  { start: '010070', end: '01008F', operator: 'other', country: 'Egypt' },
  { start: '48D800', end: '48D87F', operator: 'other', country: 'Poland' },
  { start: '468000', end: '4683FF', operator: 'other', country: 'Greece' },
  { start: '478100', end: '4781FF', operator: 'other', country: 'Norway' },
  { start: '444000', end: '446FFF', operator: 'other', country: 'Austria' },
  { start: '44F000', end: '44FFFF', operator: 'other', country: 'Belgium' },
  { start: '4B7000', end: '4B7FFF', operator: 'other', country: 'Switzerland' },
  { start: 'E40000', end: 'E41FFF', operator: 'other', country: 'Brazil' },
];

// ── Commercial ICAO 3-letter codes (blocklist for ambiguous patterns) ────
const COMMERCIAL_CALLSIGNS = new Set([
  'CCA', 'CHH', 'SVA', 'THY', 'THK', 'TUR', 'ELY', 'ELAL',
  'UAE', 'QTR', 'ETH', 'SAA', 'PAK', 'AME', 'RED',
]);

// ── Military Callsign Patterns ─────────────────────────────
const CALLSIGN_PATTERNS = [
  // US Air Force — distinctive military callsigns
  { re: /^RCH\d/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^REACH\d/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^DUKE\d/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^SAM\d{2,}/i, operator: 'usaf', aircraftType: 'vip' },
  { re: /^AF[12]\d/i, operator: 'usaf', aircraftType: 'vip' },
  { re: /^EXEC\d/i, operator: 'usaf', aircraftType: 'vip' },
  { re: /^GOLD\d/i, operator: 'usaf', aircraftType: 'special_ops' },
  { re: /^KING\d/i, operator: 'usaf', aircraftType: 'tanker' },
  { re: /^SHELL\d/i, operator: 'usaf', aircraftType: 'tanker' },
  { re: /^TEAL\d/i, operator: 'usaf', aircraftType: 'tanker' },
  { re: /^BOLT\d/i, operator: 'usaf', aircraftType: 'fighter' },
  { re: /^VIPER\d/i, operator: 'usaf', aircraftType: 'fighter' },
  { re: /^RAPTOR/i, operator: 'usaf', aircraftType: 'fighter' },
  { re: /^BONE\d/i, operator: 'usaf', aircraftType: 'bomber' },
  { re: /^DEATH\d/i, operator: 'usaf', aircraftType: 'bomber' },
  { re: /^DOOM\d/i, operator: 'usaf', aircraftType: 'bomber' },
  { re: /^SNTRY/i, operator: 'usaf', aircraftType: 'awacs' },
  { re: /^DRAGN/i, operator: 'usaf', aircraftType: 'reconnaissance' },
  { re: /^COBRA\d/i, operator: 'usaf', aircraftType: 'reconnaissance' },
  { re: /^RIVET/i, operator: 'usaf', aircraftType: 'reconnaissance' },
  { re: /^OLIVE\d/i, operator: 'usaf', aircraftType: 'reconnaissance' },
  { re: /^JAKE\d/i, operator: 'usaf', aircraftType: 'reconnaissance' },
  { re: /^NCHO/i, operator: 'usaf', aircraftType: 'special_ops' },
  { re: /^SHADOW\d/i, operator: 'usaf', aircraftType: 'special_ops' },
  { re: /^EVAC\d/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^MOOSE\d/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^HERKY/i, operator: 'usaf', aircraftType: 'transport' },
  { re: /^FORTE\d/i, operator: 'usaf', aircraftType: 'drone' },
  { re: /^HAWK\d/i, operator: 'usaf', aircraftType: 'drone' },
  { re: /^REAPER/i, operator: 'usaf', aircraftType: 'drone' },
  // US Navy
  { re: /^NAVY\d/i, operator: 'usn', aircraftType: null },
  { re: /^CNV\d/i, operator: 'usn', aircraftType: 'transport' },
  { re: /^VRC\d/i, operator: 'usn', aircraftType: 'transport' },
  { re: /^TRIDENT/i, operator: 'usn', aircraftType: 'patrol' },
  { re: /^BRONCO/i, operator: 'usn', aircraftType: 'fighter' },
  // US Marines
  { re: /^MARINE/i, operator: 'usmc', aircraftType: null },
  { re: /^HMX/i, operator: 'usmc', aircraftType: 'vip' },
  // US Army
  { re: /^ARMY\d/i, operator: 'usa', aircraftType: null },
  { re: /^PAT\d{2,}/i, operator: 'usa', aircraftType: 'transport' },
  { re: /^DUSTOFF/i, operator: 'usa', aircraftType: 'helicopter' },
  // US Coast Guard
  { re: /^COAST GUARD/i, operator: 'other', aircraftType: 'patrol' },
  { re: /^CG\d{3,}/i, operator: 'other', aircraftType: 'patrol' },
  // UK RAF / Royal Navy
  { re: /^RNAVY/i, operator: 'rn', aircraftType: null },
  { re: /^RRR\d/i, operator: 'raf', aircraftType: null },
  { re: /^ASCOT/i, operator: 'raf', aircraftType: 'transport' },
  { re: /^RAFAIR/i, operator: 'raf', aircraftType: 'transport' },
  { re: /^TARTAN/i, operator: 'raf', aircraftType: 'tanker' },
  // NATO
  { re: /^NATO\d/i, operator: 'nato', aircraftType: 'awacs' },
  // France
  { re: /^FAF\d/i, operator: 'faf', aircraftType: null },
  { re: /^CTM\d/i, operator: 'faf', aircraftType: 'transport' },
  { re: /^FRENCH\s?(AIR|MIL|NAVY)/i, operator: 'faf', aircraftType: null },
  // Germany
  { re: /^GAF\d/i, operator: 'gaf', aircraftType: null },
  { re: /^GERMAN\s?(AIR|MIL|NAVY)/i, operator: 'gaf', aircraftType: null },
  // Israel — ELAL removed (commercial El Al), IAF requires digit suffix
  { re: /^IAF\d{2,}/i, operator: 'iaf', aircraftType: null },
  // Turkey — THK removed (civil Turkish Aeronautical Assoc), TURAF is Turkish AF
  { re: /^TURAF/i, operator: 'other', aircraftType: null },
  { re: /^TRKAF/i, operator: 'other', aircraftType: null },
  // Saudi Arabia — SVA removed (Saudia commercial ICAO code)
  { re: /^RSAF\d/i, operator: 'other', aircraftType: null },
  // Other specific military
  { re: /^UAF\d/i, operator: 'other', aircraftType: null },
  { re: /^AIR INDIA ONE/i, operator: 'other', aircraftType: 'vip' },
  { re: /^IAM\d/i, operator: 'other', aircraftType: null },
  { re: /^JASDF/i, operator: 'other', aircraftType: null },
  { re: /^ROKAF/i, operator: 'other', aircraftType: null },
  { re: /^KAF\d/i, operator: 'other', aircraftType: null },
  { re: /^RAAF\d/i, operator: 'other', aircraftType: null },
  { re: /^AUSSIE\d/i, operator: 'other', aircraftType: null },
  { re: /^CANFORCE/i, operator: 'other', aircraftType: 'transport' },
  { re: /^CFC\d/i, operator: 'other', aircraftType: null },
  { re: /^PLF\d/i, operator: 'other', aircraftType: null },
  { re: /^HAF\d/i, operator: 'other', aircraftType: null },
  { re: /^EGY\d{3,}/i, operator: 'other', aircraftType: null },
  { re: /^PAF\d/i, operator: 'other', aircraftType: null },
  // Russia
  { re: /^RFF\d/i, operator: 'vks', aircraftType: null },
  { re: /^RSD\d/i, operator: 'vks', aircraftType: null },
  { re: /^RUSSIAN/i, operator: 'vks', aircraftType: null },
  // China — CCA removed (China Airlines ICAO), CHH removed (Hainan Airlines ICAO)
  { re: /^PLAAF/i, operator: 'plaaf', aircraftType: null },
  { re: /^PLA\d/i, operator: 'plaaf', aircraftType: null },
  { re: /^CHINA\s?(AIR\s?FORCE|MIL|NAVY)/i, operator: 'plaaf', aircraftType: null },
];

const OPERATOR_COUNTRY = {
  usaf: 'USA', usn: 'USA', usmc: 'USA', usa: 'USA',
  raf: 'UK', rn: 'UK', faf: 'France', gaf: 'Germany',
  plaaf: 'China', plan: 'China', vks: 'Russia',
  iaf: 'Israel', nato: 'NATO', other: 'Unknown',
};

const HOTSPOTS = [
  { name: 'INDO-PACIFIC', lat: 28.0, lon: 125.0, radius: 18, priority: 'high' },
  { name: 'CENTCOM', lat: 28.0, lon: 42.0, radius: 15, priority: 'high' },
  { name: 'EUCOM', lat: 52.0, lon: 28.0, radius: 15, priority: 'medium' },
  { name: 'ARCTIC', lat: 75.0, lon: 0.0, radius: 10, priority: 'low' },
];

// ── Theater Posture Theaters ───────────────────────────────
const POSTURE_THEATERS = [
  { id: 'iran-theater', bounds: { north: 42, south: 20, east: 65, west: 30 }, thresholds: { elevated: 8, critical: 20 }, strikeIndicators: { minTankers: 2, minAwacs: 1, minFighters: 5 } },
  { id: 'taiwan-theater', bounds: { north: 30, south: 18, east: 130, west: 115 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'baltic-theater', bounds: { north: 65, south: 52, east: 32, west: 10 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'blacksea-theater', bounds: { north: 48, south: 40, east: 42, west: 26 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'korea-theater', bounds: { north: 43, south: 33, east: 132, west: 124 }, thresholds: { elevated: 5, critical: 12 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'south-china-sea', bounds: { north: 25, south: 5, east: 121, west: 105 }, thresholds: { elevated: 6, critical: 15 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 4 } },
  { id: 'east-med-theater', bounds: { north: 37, south: 33, east: 37, west: 25 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'israel-gaza-theater', bounds: { north: 33, south: 29, east: 36, west: 33 }, thresholds: { elevated: 3, critical: 8 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
  { id: 'yemen-redsea-theater', bounds: { north: 22, south: 11, east: 54, west: 32 }, thresholds: { elevated: 4, critical: 10 }, strikeIndicators: { minTankers: 1, minAwacs: 1, minFighters: 3 } },
];

// ── Detection Functions ────────────────────────────────────
function isKnownHex(hexCode) {
  const hex = hexCode.toUpperCase();
  for (const r of HEX_RANGES) {
    if (hex >= r.start && hex <= r.end) return r;
  }
  return null;
}

function identifyByCallsign(callsign, originCountry) {
  const cs = callsign.toUpperCase().trim();
  const prefix3 = cs.substring(0, 3);
  if (COMMERCIAL_CALLSIGNS.has(prefix3) || COMMERCIAL_CALLSIGNS.has(cs)) return null;
  const origin = (originCountry || '').toLowerCase().trim();
  const preferred = [];
  if (origin === 'united kingdom' || origin === 'uk') preferred.push('rn', 'raf');
  if (origin === 'united states' || origin === 'usa') preferred.push('usn', 'usaf', 'usa', 'usmc');
  if (preferred.length > 0) {
    for (const p of CALLSIGN_PATTERNS) {
      if (!preferred.includes(p.operator)) continue;
      if (p.re.test(cs)) return p;
    }
  }
  for (const p of CALLSIGN_PATTERNS) {
    if (p.re.test(cs)) return p;
  }
  return null;
}

function detectAircraftType(callsign) {
  if (!callsign) return 'unknown';
  const cs = callsign.toUpperCase().trim();
  if (/^(SHELL|TEXACO|ARCO|ESSO|PETRO|KC|STRAT)/.test(cs)) return 'tanker';
  if (/^(SENTRY|AWACS|MAGIC|DISCO|DARKSTAR|E3|E8|E6)/.test(cs)) return 'awacs';
  if (/^(RCH|REACH|MOOSE|EVAC|DUSTOFF|C17|C5|C130|C40)/.test(cs)) return 'transport';
  if (/^(HOMER|OLIVE|JAKE|PSEUDO|GORDO|RC|U2|SR)/.test(cs)) return 'reconnaissance';
  if (/^(RQ|MQ|REAPER|PREDATOR|GLOBAL)/.test(cs)) return 'drone';
  if (/^(DEATH|BONE|DOOM|B52|B1|B2)/.test(cs)) return 'bomber';
  if (/^(BOLT|VIPER|RAPTOR|BRONCO|EAGLE|HORNET|FALCON|STRIKE|TANGO|FURY)/.test(cs)) return 'fighter';
  return 'unknown';
}

function getNearbyHotspot(lat, lon) {
  for (const h of HOTSPOTS) {
    const d = Math.sqrt((lat - h.lat) ** 2 + (lon - h.lon) ** 2);
    if (d <= h.radius) return h;
  }
  return null;
}

// ── HTTP CONNECT Tunnel via Residential Proxy ──────────────
function redactProxy(msg) {
  return String(msg || '').replace(/\/\/[^@]+@/g, '//<redacted>@');
}

function parseProxyAuth() {
  const atIdx = OPENSKY_PROXY_AUTH.lastIndexOf('@');
  if (atIdx === -1) return null;
  const userPass = OPENSKY_PROXY_AUTH.substring(0, atIdx);
  const hostPort = OPENSKY_PROXY_AUTH.substring(atIdx + 1);
  const colonIdx = hostPort.lastIndexOf(':');
  return {
    userPass,
    host: hostPort.substring(0, colonIdx),
    port: parseInt(hostPort.substring(colonIdx + 1), 10),
  };
}

function proxyFetchJson(url, { headers = {}, timeout = 15000 } = {}) {
  const parsed = new URL(url);
  const proxy = parseProxyAuth();
  if (!proxy) return Promise.reject(new Error('No proxy config'));

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('PROXY TIMEOUT')); }, timeout + 5000);
    const connectReq = http.request({
      host: proxy.host,
      port: proxy.port,
      method: 'CONNECT',
      path: `${parsed.hostname}:443`,
      headers: {
        'Host': `${parsed.hostname}:443`,
        'Proxy-Authorization': 'Basic ' + Buffer.from(proxy.userPass).toString('base64'),
      },
      timeout,
    });
    connectReq.on('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        socket.destroy();
        return reject(new Error(`CONNECT ${res.statusCode}`));
      }
      const tlsSocket = tls.connect({ socket, servername: parsed.hostname }, () => {
        const req = https.request({
          socket: tlsSocket,
          hostname: parsed.hostname,
          path: parsed.pathname + parsed.search,
          method: 'GET',
          headers: { ...headers, 'Accept': 'application/json', 'User-Agent': CHROME_UA },
          timeout,
        }, (resp) => {
          let data = '';
          resp.on('data', chunk => data += chunk);
          resp.on('end', () => {
            clearTimeout(timer);
            if (resp.statusCode >= 400) {
              return reject(new Error(`HTTP ${resp.statusCode}: ${data.substring(0, 200)}`));
            }
            try { resolve(JSON.parse(data)); }
            catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
          });
        });
        req.on('error', (e) => { clearTimeout(timer); reject(e); });
        req.on('timeout', () => { req.destroy(); clearTimeout(timer); reject(new Error('TIMEOUT')); });
        req.end();
      });
      tlsSocket.on('error', (e) => { clearTimeout(timer); reject(e); });
    });
    connectReq.on('error', (e) => { clearTimeout(timer); reject(new Error(redactProxy(e.message))); });
    connectReq.on('timeout', () => { connectReq.destroy(); clearTimeout(timer); reject(new Error('CONNECT TIMEOUT')); });
    connectReq.end();
  });
}

// ── Data Sources ───────────────────────────────────────────
const OPENSKY_BASE = 'https://opensky-network.org/api';
const WINGBITS_BASE = 'https://customer-api.wingbits.com/v1/flights';
const ADSBX_HOST = 'adsbexchange-com1.p.rapidapi.com';
const ADSBX_MIL_URL = `https://${ADSBX_HOST}/v2/mil/`;

// ICAO aircraft type code → high-level category (used for ADSBExchange's `t` field).
// ADSBX returns canonical ICAO type codes (C17, F16, EC35, ...) which are far more
// reliable than callsign heuristics. Fallback to detectAircraftType(callsign) if missing.
const ICAO_TYPE_TO_CATEGORY = {
  // Tankers / aerial refueling
  K35R: 'tanker', K35E: 'tanker', K35T: 'tanker', KC10: 'tanker', KC30: 'tanker',
  KC46: 'tanker', KDC1: 'tanker', VC10: 'tanker', A332: 'tanker', A310: 'tanker',
  TRIS: 'tanker',
  // AWACS / airborne early-warning / battle-mgmt
  E3: 'awacs', E3CF: 'awacs', E3TF: 'awacs', E737: 'awacs', E2: 'awacs', E2D: 'awacs',
  E6: 'awacs', E8: 'awacs',
  // ISR / reconnaissance / patrol
  U2: 'reconnaissance', RC35: 'reconnaissance', P3: 'reconnaissance', P8: 'reconnaissance',
  RC1: 'reconnaissance', SR71: 'reconnaissance', E11: 'reconnaissance',
  // UAVs / drones
  MQ9: 'drone', MQ1: 'drone', RQ1: 'drone', RQ4: 'drone', MQ4: 'drone', MQ25: 'drone',
  // Bombers
  B1: 'bomber', B2: 'bomber', B52: 'bomber', TU95: 'bomber', TU22: 'bomber', TU60: 'bomber', H6: 'bomber',
  // Fighters / attack
  F15: 'fighter', F16: 'fighter', F18: 'fighter', F22: 'fighter', F35: 'fighter',
  A10: 'fighter', EUFI: 'fighter', TYPH: 'fighter', RAFL: 'fighter', GR4: 'fighter',
  J10: 'fighter', J11: 'fighter', J20: 'fighter', JH7: 'fighter',
  SU25: 'fighter', SU27: 'fighter', SU30: 'fighter', SU34: 'fighter', SU35: 'fighter', SU57: 'fighter',
  // Transport / cargo
  C17: 'transport', C5: 'transport', C5M: 'transport', C130: 'transport', C30J: 'transport',
  C160: 'transport', A400: 'transport', C295: 'transport', C212: 'transport', CN35: 'transport',
  C40: 'transport', C2: 'transport', AN12: 'transport', AN26: 'transport', AN72: 'transport',
  AN12: 'transport', IL76: 'transport', Y8: 'transport', Y9: 'transport', Y20: 'transport',
  // VIP / executive
  C32: 'vip', C32A: 'vip', C37: 'vip', GLF5: 'vip', GLF4: 'vip', GLEX: 'vip',
  // Helicopters
  H60: 'helicopter', S70: 'helicopter', H47: 'helicopter', H53: 'helicopter', H1: 'helicopter',
  H64: 'helicopter', EC35: 'helicopter', AS65: 'helicopter', NH90: 'helicopter', PUMA: 'helicopter',
  EH10: 'helicopter', AS32: 'helicopter', LYNX: 'helicopter', H145: 'helicopter', H225: 'helicopter',
  // Trainers
  TEX2: 'trainer', T6: 'trainer', T38: 'trainer', T1: 'trainer', T45: 'trainer', PC9: 'trainer',
  PC21: 'trainer', HAWK: 'trainer', M345: 'trainer', M346: 'trainer', YK52: 'trainer',
};

function classifyByTypeCode(t) {
  if (!t) return null;
  return ICAO_TYPE_TO_CATEGORY[t.toUpperCase()] || null;
}

// Read ADSBExchange `dbFlags` bitfield: 1=military, 2=interesting, 4=PIA, 8=LADD
function adsbxIsInteresting(dbFlags) {
  return Number.isInteger(dbFlags) && (dbFlags & 2) === 2;
}

// ── ADSBExchange (RapidAPI) — Tier 0, authoritative military feed ─────────
async function fetchADSBExchangeFlights() {
  const key = process.env.RAPIDAPI_KEY || process.env.ADSBX_API_KEY;
  if (!key) {
    console.log('  [ADSBX] No RAPIDAPI_KEY — skipped');
    return null;
  }

  const resp = await fetch(ADSBX_MIL_URL, {
    headers: {
      'x-rapidapi-host': ADSBX_HOST,
      'x-rapidapi-key': key,
      Accept: 'application/json',
      'User-Agent': CHROME_UA,
    },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`ADSBX HTTP ${resp.status}: ${body.substring(0, 200)}`);
  }

  const data = await resp.json();
  const acs = Array.isArray(data?.ac) ? data.ac : [];
  console.log(`  [ADSBX] ${acs.length} military aircraft (msg=${data?.msg || 'n/a'})`);

  const flights = [];
  const byType = {};

  for (const ac of acs) {
    const hex = String(ac.hex || '').toLowerCase();
    if (!hex) continue;

    const lat = typeof ac.lat === 'number' ? ac.lat : null;
    const lon = typeof ac.lon === 'number' ? ac.lon : null;
    if (lat == null || lon == null) continue; // no position → cannot map

    const callsign = String(ac.flight || '').trim();
    const registration = String(ac.r || '').trim();
    const typeCode = String(ac.t || '').trim().toUpperCase();

    const altRaw = ac.alt_baro;
    const onGround = altRaw === 'ground';
    const altitude = onGround ? 0 : (typeof altRaw === 'number' ? altRaw : 0);
    const speed = typeof ac.gs === 'number' ? Math.round(ac.gs) : 0;
    const heading = typeof ac.track === 'number' ? ac.track : 0;
    const verticalRate = typeof ac.baro_rate === 'number' ? Math.round(ac.baro_rate)
      : (typeof ac.geom_rate === 'number' ? Math.round(ac.geom_rate) : undefined);
    const squawk = ac.squawk || undefined;

    // Operator + country: prefer hex match (deterministic), fall back to callsign pattern.
    const hexMatch = isKnownHex(hex);
    const csMatch = callsign ? identifyByCallsign(callsign, '') : null;

    let operator, operatorCountry;
    if (hexMatch) {
      operator = hexMatch.operator;
      operatorCountry = hexMatch.country;
    } else if (csMatch) {
      operator = csMatch.operator;
      operatorCountry = OPERATOR_COUNTRY[csMatch.operator] || 'Unknown';
    } else {
      operator = 'other';
      operatorCountry = 'Unknown';
    }

    // Aircraft category: ICAO type code is most reliable; fall back to callsign heuristics.
    const aircraftType = classifyByTypeCode(typeCode)
      || csMatch?.aircraftType
      || detectAircraftType(callsign);

    const hotspot = getNearbyHotspot(lat, lon);
    const isInteresting = adsbxIsInteresting(ac.dbFlags)
      || (hotspot && hotspot.priority === 'high')
      || aircraftType === 'bomber' || aircraftType === 'reconnaissance' || aircraftType === 'awacs';

    const seenSec = typeof ac.seen === 'number' ? ac.seen : 0;
    const lastSeenMs = Date.now() - Math.round(seenSec * 1000);

    flights.push({
      id: `adsbx-${hex}`,
      callsign: callsign || `MIL-${hex.substring(0, 4).toUpperCase()}`,
      hexCode: hex.toUpperCase(),
      registration: registration || undefined,
      aircraftType,
      aircraftModel: typeCode || undefined,
      operator,
      operatorCountry,
      lat,
      lon,
      altitude,
      heading,
      speed,
      verticalRate,
      onGround,
      squawk,
      confidence: 'high', // ADSBX explicitly tags military
      isInteresting: !!isInteresting,
      note: hotspot ? `Near ${hotspot.name}` : undefined,
      lastSeenMs,
    });
    byType[aircraftType] = (byType[aircraftType] || 0) + 1;
  }

  return { flights, byType };
}

async function fetchOpenSkyAuthenticated(region) {
  const username = process.env.OPENSKY_USERNAME;
  const password = process.env.OPENSKY_PASSWORD;
  if (!username || !password) return null;

  const params = `lamin=${region.lamin}&lamax=${region.lamax}&lomin=${region.lomin}&lomax=${region.lomax}`;
  const url = `${OPENSKY_BASE}/states/all?${params}`;

  if (PROXY_ENABLED) {
    const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
    const data = await proxyFetchJson(url, {
      headers: { Authorization: authHeader },
    });
    return data.states || [];
  }

  const authHeader = 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64');
  const resp = await fetch(url, {
    headers: { Authorization: authHeader, 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OpenSky auth HTTP ${resp.status}: ${body.substring(0, 200)}`);
  }
  const data = await resp.json();
  return data.states || [];
}

async function fetchOpenSkyAnonymous(region) {
  const params = `lamin=${region.lamin}&lamax=${region.lamax}&lomin=${region.lomin}&lomax=${region.lomax}`;
  const url = `${OPENSKY_BASE}/states/all?${params}`;

  if (PROXY_ENABLED) {
    const data = await proxyFetchJson(url);
    return data.states || [];
  }

  const resp = await fetch(url, {
    headers: { 'User-Agent': CHROME_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`OpenSky anon HTTP ${resp.status}: ${body.substring(0, 200)}`);
  }
  const data = await resp.json();
  return data.states || [];
}

async function fetchWingbits() {
  const apiKey = process.env.WINGBITS_API_KEY;
  if (!apiKey) {
    console.log('  [Wingbits] No WINGBITS_API_KEY — skipped');
    return [];
  }

  const areas = QUERY_REGIONS.map((r) => ({
    alias: r.name,
    by: 'box',
    la: (r.lamax + r.lamin) / 2,
    lo: (r.lomax + r.lomin) / 2,
    w: Math.abs(r.lomax - r.lomin) * 60,
    h: Math.abs(r.lamax - r.lamin) * 60,
    unit: 'nm',
  }));

  console.log(`  [Wingbits] POST ${WINGBITS_BASE} with ${areas.length} areas: ${areas.map(a => `${a.alias}(${a.w}x${a.h}nm)`).join(', ')}`);

  const resp = await fetch(WINGBITS_BASE, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': CHROME_UA },
    body: JSON.stringify(areas),
    signal: AbortSignal.timeout(20_000),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`Wingbits HTTP ${resp.status}: ${body.substring(0, 200)}`);
  }
  const data = await resp.json();

  if (!Array.isArray(data)) {
    console.warn(`  [Wingbits] Unexpected response shape: ${typeof data}, keys: ${Object.keys(data || {}).join(',')}`);
    return [];
  }
  console.log(`  [Wingbits] Response: ${data.length} area results`);
  for (let i = 0; i < data.length; i++) {
    const ar = data[i];
    const flightList = Array.isArray(ar.data) ? ar.data : Array.isArray(ar.flights) ? ar.flights : Array.isArray(ar) ? ar : [];
    console.log(`  [Wingbits]   area[${i}] ${ar.alias || areas[i]?.alias || '?'}: ${flightList.length} flights, keys: ${Object.keys(ar || {}).join(',')}`);
    if (flightList.length > 0) {
      console.log(`  [Wingbits]     sample[0]: ${JSON.stringify(flightList[0]).substring(0, 200)}`);
    }
  }

  const states = [];
  const seenIds = new Set();
  for (const areaResult of data) {
    const flightList = Array.isArray(areaResult.data) ? areaResult.data
      : Array.isArray(areaResult.flights) ? areaResult.flights
      : Array.isArray(areaResult) ? areaResult : [];
    for (const f of flightList) {
      const icao24 = f.h || f.icao24 || f.id;
      if (!icao24 || seenIds.has(icao24)) continue;
      seenIds.add(icao24);
      const callsign = (f.f || f.callsign || f.flight || '').trim();
      const raMs = f.ra ? new Date(f.ra).getTime() : (f.ts || Date.now());
      states.push([
        icao24,
        callsign,
        f.co || f.originCountry || '',
        null,
        raMs / 1000,
        f.lo || f.longitude || f.lon || f.lng,
        f.la || f.latitude || f.lat,
        (f.ab || f.altitude || f.alt || 0) * 0.3048,
        f.og ?? f.gr ?? f.onGround ?? false,
        (f.gs || f.groundSpeed || f.speed || 0) * 0.514444,
        f.th || f.heading || f.track || 0,
        (f.vr || f.verticalRate || 0) * 0.00508,
        null,
        null,
        f.sq || f.squawk || null,
      ]);
    }
  }
  return states;
}

// ── Fetch All States (Wingbits first, OpenSky supplements) ─
async function fetchAllStates() {
  const seenIds = new Set();
  const allStates = [];
  let source = 'none';

  // Tier 1: Wingbits — no proxy needed, fast, reliable
  try {
    const wbStates = await fetchWingbits();
    for (const state of wbStates) {
      const icao24 = state[0];
      if (seenIds.has(icao24)) continue;
      seenIds.add(icao24);
      allStates.push(state);
    }
    if (wbStates.length > 0) {
      source = 'wingbits';
      console.log(`  [Wingbits] ${wbStates.length} unique aircraft loaded`);
    }
  } catch (e) {
    console.warn(`  [Wingbits] ${e.message}`);
  }

  // Tier 2: OpenSky (auth via proxy) — supplements with aircraft Wingbits may miss
  for (const region of QUERY_REGIONS) {
    let states = null;

    try {
      states = await fetchOpenSkyAuthenticated(region);
      if (states && states.length > 0) {
        if (source === 'none') source = 'opensky-auth';
        console.log(`  [OpenSky Auth] ${region.name}: ${states.length} states`);
      }
    } catch (e) {
      console.warn(`  [OpenSky Auth] ${region.name}: ${redactProxy(e.message)}`);
    }

    // Tier 3: OpenSky anonymous (via proxy) — last resort
    if (!states || states.length === 0) {
      try {
        states = await fetchOpenSkyAnonymous(region);
        if (states && states.length > 0) {
          if (source === 'none') source = 'opensky-anon';
          console.log(`  [OpenSky Anon] ${region.name}: ${states.length} states`);
        }
      } catch (e) {
        console.warn(`  [OpenSky Anon] ${region.name}: ${redactProxy(e.message)}`);
      }
    }

    if (states) {
      let added = 0;
      for (const state of states) {
        const icao24 = state[0];
        if (seenIds.has(icao24)) continue;
        seenIds.add(icao24);
        allStates.push(state);
        added++;
      }
      if (added > 0) console.log(`  [OpenSky] +${added} new from ${region.name} (total: ${allStates.length})`);
    }
  }

  return { allStates, source };
}

// ── Filter & Build Military Flights ────────────────────────
function filterMilitaryFlights(allStates) {
  const flights = [];
  const byType = {};

  for (const state of allStates) {
    const icao24 = state[0];
    const callsign = (state[1] || '').trim();
    const lat = state[6];
    const lon = state[5];
    if (lat == null || lon == null) continue;

    const originCountry = state[2] || '';
    const csMatch = callsign ? identifyByCallsign(callsign, originCountry) : null;
    const hexMatch = isKnownHex(icao24);
    if (!csMatch && !hexMatch) continue;

    let operator, aircraftType, operatorCountry, confidence;
    if (csMatch) {
      operator = csMatch.operator;
      aircraftType = csMatch.aircraftType || detectAircraftType(callsign);
      operatorCountry = OPERATOR_COUNTRY[csMatch.operator] || 'Unknown';
      confidence = hexMatch ? 'high' : 'medium';
    } else {
      operator = hexMatch.operator;
      aircraftType = detectAircraftType(callsign);
      operatorCountry = hexMatch.country;
      confidence = 'medium';
    }

    const baroAlt = state[7];
    const velocity = state[9];
    const track = state[10];
    const vertRate = state[11];
    const hotspot = getNearbyHotspot(lat, lon);
    const isInteresting = (hotspot && hotspot.priority === 'high') ||
      aircraftType === 'bomber' || aircraftType === 'reconnaissance' || aircraftType === 'awacs';

    flights.push({
      id: `opensky-${icao24}`,
      callsign: callsign || `UNKN-${icao24.substring(0, 4).toUpperCase()}`,
      hexCode: icao24.toUpperCase(),
      lat,
      lon,
      altitude: baroAlt != null ? Math.round(baroAlt * 3.28084) : 0,
      heading: track != null ? track : 0,
      speed: velocity != null ? Math.round(velocity * 1.94384) : 0,
      verticalRate: vertRate != null ? Math.round(vertRate * 196.85) : undefined,
      onGround: state[8],
      squawk: state[14] || undefined,
      aircraftType,
      operator,
      operatorCountry,
      confidence,
      isInteresting: isInteresting || false,
      note: hotspot ? `Near ${hotspot.name}` : undefined,
      lastSeenMs: state[4] ? state[4] * 1000 : Date.now(),
    });
    byType[aircraftType] = (byType[aircraftType] || 0) + 1;
  }

  return { flights, byType };
}

// ── Theater Posture Calculation ────────────────────────────
function calculateTheaterPostures(flights) {
  return POSTURE_THEATERS.map((theater) => {
    const tf = flights.filter(
      (f) => f.lat >= theater.bounds.south && f.lat <= theater.bounds.north &&
        f.lon >= theater.bounds.west && f.lon <= theater.bounds.east,
    );
    const total = tf.length;
    const tankers = tf.filter((f) => f.aircraftType === 'tanker').length;
    const awacs = tf.filter((f) => f.aircraftType === 'awacs').length;
    const fighters = tf.filter((f) => f.aircraftType === 'fighter').length;
    const postureLevel = total >= theater.thresholds.critical ? 'critical'
      : total >= theater.thresholds.elevated ? 'elevated' : 'normal';
    const strikeCapable = tankers >= theater.strikeIndicators.minTankers &&
      awacs >= theater.strikeIndicators.minAwacs && fighters >= theater.strikeIndicators.minFighters;
    const ops = [];
    if (strikeCapable) ops.push('strike_capable');
    if (tankers > 0) ops.push('aerial_refueling');
    if (awacs > 0) ops.push('airborne_early_warning');
    return {
      theater: theater.id, postureLevel, activeFlights: total,
      trackedVessels: 0, activeOperations: ops, assessedAt: Date.now(),
    };
  });
}

// ── Redis Write ────────────────────────────────────────────
async function redisSet(url, token, key, value, ttl) {
  const payload = JSON.stringify(value);
  const cmd = ttl ? ['SET', key, payload, 'EX', ttl] : ['SET', key, payload];
  const resp = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(cmd),
    signal: AbortSignal.timeout(10_000),
  });
  return resp.ok;
}

// ── Main ───────────────────────────────────────────────────
async function main() {
  const startMs = Date.now();
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const { url, token } = getRedisCredentials();

  console.log(`=== military:flights Seed (proxy: ${PROXY_ENABLED ? 'enabled' : 'direct'}) ===`);

  const locked = await acquireLock('military:flights', runId, 120_000);
  if (!locked) {
    console.log('  SKIPPED: another seed run in progress');
    process.exit(0);
  }

  try {
    // Tier 0 — ADSBExchange (authoritative military feed via RapidAPI). Returns final-shape flights.
    let adsbx = null;
    try {
      adsbx = await fetchADSBExchangeFlights();
    } catch (e) {
      console.warn(`  [ADSBX] ${e.message}`);
    }

    console.log('  Fetching legacy sources (Wingbits/OpenSky)...');
    const { allStates, source: legacySource } = await fetchAllStates();
    console.log(`  Raw states: ${allStates.length} (source: ${legacySource})`);

    const { flights: legacyFlights, byType: legacyByType } = filterMilitaryFlights(allStates);
    console.log(`  Legacy military: ${legacyFlights.length} (${Object.entries(legacyByType).map(([t, n]) => `${t}:${n}`).join(', ')})`);

    // Merge: ADSBX takes priority (richer metadata, authoritative). Legacy fills gaps.
    const merged = new Map();
    if (adsbx?.flights?.length) {
      for (const f of adsbx.flights) merged.set(f.hexCode.toUpperCase(), f);
    }
    let legacyAdded = 0;
    for (const f of legacyFlights) {
      const k = (f.hexCode || '').toUpperCase();
      if (!k || merged.has(k)) continue;
      merged.set(k, f);
      legacyAdded++;
    }

    const flights = Array.from(merged.values());
    const byType = {};
    for (const f of flights) byType[f.aircraftType] = (byType[f.aircraftType] || 0) + 1;

    const source = adsbx?.flights?.length
      ? (legacyAdded > 0 ? `adsbx+${legacySource}` : 'adsbx')
      : legacySource;

    console.log(`  Combined: ${flights.length} flights (adsbx: ${adsbx?.flights?.length || 0}, +legacy: ${legacyAdded}) — source: ${source}`);
    console.log(`  Types: ${Object.entries(byType).map(([t, n]) => `${t}:${n}`).join(', ')}`);

    if (flights.length === 0) {
      console.log('  SKIPPED: 0 military flights — preserving stale data');
      process.exit(0);
    }

    const payload = { flights, fetchedAt: Date.now(), stats: { total: flights.length, byType } };

    const ok1 = await redisSet(url, token, LIVE_KEY, payload, LIVE_TTL);
    const ok2 = await redisSet(url, token, STALE_KEY, payload, STALE_TTL);
    console.log(`  ${LIVE_KEY}: ${ok1 ? 'written' : 'FAILED'}`);
    console.log(`  ${STALE_KEY}: ${ok2 ? 'written' : 'FAILED'}`);

    await writeFreshnessMetadata('military', 'flights', flights.length, source);

    const verified = await verifySeedKey(LIVE_KEY);
    console.log(`  Verified: ${verified ? 'yes' : 'NO'}`);

    const theaterFlights = flights.map((f) => ({
      id: f.hexCode || f.id,
      callsign: f.callsign,
      lat: f.lat, lon: f.lon,
      altitude: f.altitude || 0, heading: f.heading || 0, speed: f.speed || 0,
      aircraftType: f.aircraftType || detectAircraftType(f.callsign),
    }));
    const theaters = calculateTheaterPostures(theaterFlights);
    const posturePayload = { theaters };
    const tp1 = await redisSet(url, token, THEATER_POSTURE_LIVE_KEY, posturePayload, THEATER_POSTURE_LIVE_TTL);
    const tp2 = await redisSet(url, token, THEATER_POSTURE_STALE_KEY, posturePayload, THEATER_POSTURE_STALE_TTL);
    const tp3 = await redisSet(url, token, THEATER_POSTURE_BACKUP_KEY, posturePayload, THEATER_POSTURE_BACKUP_TTL);
    await redisSet(url, token, 'seed-meta:theater-posture', { fetchedAt: Date.now(), recordCount: theaterFlights.length, sourceVersion: source || '' }, 604800);
    const elevated = theaters.filter((t) => t.postureLevel !== 'normal').length;
    console.log(`  Theater posture: ${theaters.length} theaters (${elevated} elevated), redis: ${tp1 && tp2 && tp3 ? 'OK' : 'PARTIAL'}`);

    const durationMs = Date.now() - startMs;
    logSeedResult('military', flights.length, durationMs);
    console.log(`\n=== Done (${Math.round(durationMs)}ms) ===`);
  } finally {
    await releaseLock('military:flights', runId);
  }
}

main().catch((err) => {
  console.error('FATAL:', err.message || err);
  process.exit(1);
});
