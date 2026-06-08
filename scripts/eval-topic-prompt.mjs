#!/usr/bin/env node
/**
 * Eval harness — compare the CURRENT topic-classification prompt against the
 * A' ("sharpened criteria") prompt on a hand-labeled gold set. Scores the
 * `topics` field only (precision / recall / F1) and prints a per-headline diff.
 *
 * Tests the PROMPT in isolation: headline-only input, no GDELT hint, no article
 * body — so the score reflects the wording change alone.
 *
 *   EACHLABS_API_KEY=xxx node scripts/eval-topic-prompt.mjs
 *
 * Add --model anthropic/claude-sonnet-4.5 to test the fallback model too.
 */

const API_URL = 'https://api.eachlabs.ai/v1/chat/completions';
const MODEL = process.argv.includes('--model')
  ? process.argv[process.argv.indexOf('--model') + 1]
  : 'google/gemini-2.5-flash-lite';

// ── Prompt assembly (mirrors LOCATION_ONLY_SYSTEM_PROMPT, topics block swapped) ──
const PREAMBLE = `You classify a news article. Return ONE JSON object with these fields:

  - region: ONE of "us","canada","latin_america","europe","middle_east","africa","asia","oceania". Always set this field.

  - isConflict: boolean. True ONLY if the story is about armed conflict, military operations, terrorist attacks, civil unrest, or any kinetic event. False otherwise.
`;

const TOPICS_CURRENT = `
  - topics: an ARRAY of zero or more of these exact strings — ONLY the categories that are a PRIMARY subject of the story:
      "cyber" — cyberattacks, data breaches, ransomware, hacking, cyber-espionage
      "military" — armed forces, defense, weapons, military operations / exercises / deployments
      "nuclear" — nuclear weapons, nuclear energy / power, uranium, IAEA, proliferation
      "sanctions" — sanctions, embargoes, tariffs, trade restrictions, export controls
      "intelligence" — espionage, spy agencies, surveillance programs, classified leaks, covert operations
      "maritime" — central to naval forces, ships, ports, piracy, or a sea incident
      "business" — a company, a financial market, or an economic indicator is the LITERAL subject
      "scitech" — science, technology, AI, space, medical research, innovation
      "entertainment" — film, TV, music, celebrities, gaming, awards, the sports business
    Tag a category ONLY when it is a primary subject. NEVER tag for background, a passing mention, or a downstream consequence. Most stories have 0-2 topics; 3+ should be rare.
    Be especially strict with "business": NEVER tag it for elections, budgets, fiscal-policy debates, diplomacy, legal trials, or political-personality stories.
    Return [] when none apply.
`;

const TOPICS_APRIME = `
  - topics: an ARRAY of zero or more of these exact strings. Tag a category when the story CENTERS ON it — it is the main subject OR a dedicated, substantial part of the story (not a passing mention, background, or a downstream consequence). Apply each category's specific rules. A story may carry several topics when it genuinely spans them.
      "cyber" — INCLUDE: a cyberattack, data breach, ransomware, hacking campaign, malware / exploit / disclosed vulnerability, or cyber-espionage; a cyber-defense or cyber-policy action. EXCLUDE: routine IT outages with no attacker, or ordinary tech-product news (that is "scitech").
      "military" — armed forces, defense, weapons, strikes, troop movements, or military operations / exercises / deployments. An armed conflict belongs HERE — a war is "military", NOT "nuclear"/"maritime", unless the story itself centers on the nuclear or naval dimension.
      "nuclear" — INCLUDE: a nuclear weapons program / test / arsenal, uranium or enrichment, a nuclear facility / reactor / power plant, fuel or waste, an IAEA action or inspection, a non-proliferation treaty or talks, or a radiation / nuclear-safety event. EXCLUDE: a broader armed conflict merely because a party possesses nuclear weapons; energy-market or stock stories that only mention uranium.
      "sanctions" — INCLUDE: imposing / lifting / expanding sanctions, embargoes, export controls, asset freezes or seizures, designations (OFAC / entity list / Magnitsky), or tariffs and financial restrictions (e.g. SWIFT) used as a trade-restriction measure. EXCLUDE: general diplomacy or conflict not centered on a sanctions measure; ordinary trade or business news with no restriction.
      "intelligence" — INCLUDE: espionage or spying, a spy-agency operation (CIA / MI6 / Mossad / FSB), surveillance programs, covert operations, classified-document leaks, or counterintelligence arrests. EXCLUDE: ordinary diplomacy, politics, or military operations not about intelligence activity.
      "maritime" — INCLUDE: naval forces or operations, a warship / submarine / carrier, a sea or strait incident (attack, seizure, collision, blockade), piracy, port or shipping-lane disruption, or a freedom-of-navigation action. EXCLUDE: a land conflict merely near a coast; commodity or oil-price stories that mention a strait only in passing.
      "business" — a company, a financial market, or an economic indicator is the LITERAL subject (earnings, IPOs, mergers, stock / bond markets, central-bank or monetary policy, corporate leadership).
      "scitech" — science, technology, AI, space, medical research, innovation.
      "entertainment" — film, TV, music, celebrities, gaming, awards, the sports business.
    Be especially strict with "business": NEVER tag it for elections, budgets, fiscal-policy debates, diplomacy, legal trials, or political-personality stories.
    Return [] when none apply.
`;

const TOPICS_APRIME2 = `
  - topics: an ARRAY of zero or more of these exact strings. Tag a category when the story CENTERS ON it — it is the main subject OR a dedicated, substantial part of the story (not a passing mention, background, or a downstream consequence). Apply each category's specific rules. A story may carry several topics when it genuinely spans them.
      "cyber" — INCLUDE: a cyberattack, data breach, ransomware, hacking campaign, malware / exploit / disclosed vulnerability, or cyber-espionage; a cyber-defense or cyber-policy action. EXCLUDE: routine IT outages with no attacker, or ordinary tech-product news (that is "scitech").
      "military" — armed forces, defense, weapons, strikes, troop movements, or military operations / exercises / deployments. An armed conflict belongs HERE — a war is "military", NOT "nuclear"/"maritime", unless the story itself centers on the nuclear or naval dimension.
      "nuclear" — INCLUDE: a nuclear weapons program / test / arsenal, uranium or enrichment, a nuclear facility / reactor / power plant, fuel or waste, an IAEA action or inspection, a non-proliferation treaty or talks, or a radiation / nuclear-safety event. EXCLUDE: a broader armed conflict merely because a party possesses nuclear weapons; a stock / earnings / market story whose company NAME merely contains "nuclear" or "uranium" (that is "business"); and uranium or other commodity price moves (also "business").
      "sanctions" — INCLUDE: imposing / lifting / expanding sanctions, embargoes, export controls, asset freezes or seizures, designations (OFAC / entity list / Magnitsky), or tariffs and financial restrictions (e.g. SWIFT) used as a trade-restriction measure. EXCLUDE: general diplomacy or conflict not centered on a sanctions measure; ordinary trade or business news with no restriction.
      "intelligence" — INCLUDE: espionage or spying, a spy-agency operation (CIA / MI6 / Mossad / FSB), surveillance programs, covert operations, classified-document leaks, or counterintelligence arrests. EXCLUDE: ordinary diplomacy, politics, or military operations not about intelligence activity.
      "maritime" — INCLUDE: naval forces or operations, a warship / submarine / carrier, a sea or strait incident (attack, seizure, collision, blockade), piracy, port or shipping-lane disruption, or a freedom-of-navigation action. EXCLUDE: do NOT tag merely because a body of water or chokepoint is NAMED (Red Sea, Strait of Hormuz, South China Sea, Suez, Panama Canal) — tag ONLY when a ship, naval force, port, or sea-based incident is the actual subject. An exchange of strikes, missiles, or shelling between forces is "military", NOT "maritime", even in a coastal or maritime region.
      "business" — a company, a financial market, or an economic indicator is the LITERAL subject (earnings, IPOs, mergers, stock / bond markets, central-bank or monetary policy, corporate leadership).
      "scitech" — science, technology, AI, space, medical research, innovation.
      "entertainment" — film, TV, music, celebrities, gaming, awards, the sports business.
    Be especially strict with "business": NEVER tag it for elections, budgets, fiscal-policy debates, diplomacy, legal trials, or political-personality stories.
    Return [] when none apply.
`;

const SUFFIX = `
  - country, locationName, lat, lng: ONLY when isConflict=true; OMIT otherwise.

Return JSON ONLY. No prose, no markdown, no code fences.`;

const buildSystem = (topics) => PREAMBLE + topics + SUFFIX;

// ── Gold set: expect = topics that MUST be present; allow = acceptable extras ──
const GOLD = [
  // Genuine security stories (recall targets)
  { h: "IAEA inspectors barred from Iran's Fordow enrichment site", expect: ['nuclear'], allow: ['intelligence'] },
  { h: 'LockBit ransomware gang leaks stolen hospital patient data', expect: ['cyber'], allow: [] },
  { h: 'US Treasury sanctions three firms over Russian oil exports', expect: ['sanctions'], allow: [] },
  { h: 'Houthi forces seize a cargo ship in the Red Sea', expect: ['maritime'], allow: ['military'] },
  { h: 'FBI arrests defense contractor for passing classified files to China', expect: ['intelligence'], allow: [] },
  { h: 'North Korea conducts new long-range ICBM test', expect: ['nuclear', 'military'], allow: [] },
  { h: 'Microsoft patches an actively exploited Windows zero-day', expect: ['cyber'], allow: ['scitech'] },
  { h: 'EU adds 20 entities to its Russia sanctions list over chip exports', expect: ['sanctions'], allow: [] },
  { h: 'US carrier strike group enters the South China Sea amid tensions', expect: ['maritime'], allow: ['military'] },
  { h: 'Mossad operation foiled an assassination plot, Israeli officials say', expect: ['intelligence'], allow: ['military'] },
  // Multi-topic genuine
  { h: 'Chinese state hackers breached US telecom networks, NSA says', expect: ['cyber', 'intelligence'], allow: [] },
  { h: 'G7 imposes a price cap and shipping ban on Russian crude oil', expect: ['sanctions'], allow: ['maritime'] },
  { h: 'Pentagon unveils a new hypersonic missile program', expect: ['military'], allow: [] },
  // War stories that MENTION security topics — must NOT cross-tag
  { h: 'Israel and Iran trade strikes, threatening to drag the region back to war', expect: ['military'], allow: [] },
  { h: 'Iran fires missiles into Israel; Tel Aviv retaliates', expect: ['military'], allow: [] },
  { h: 'Russian shelling kills five in eastern Ukraine', expect: ['military'], allow: [] },
  { h: 'Drone strike kills a militant commander in Yemen', expect: ['military'], allow: [] },
  // Traps — keyword present but topic is NOT the subject
  { h: 'Nano Nuclear Energy (NNE) stock rating cut to Sell at Wall Street Zen', expect: ['business'], allow: [] },
  { h: 'Uranium prices rally on supply concerns', expect: ['business'], allow: [] },
  { h: 'OPEC+ raises oil output after Strait of Hormuz tensions ease', expect: ['business'], allow: [] },
  { h: 'CBS Weekend News', expect: [], allow: [] },
  { h: 'Lawmakers spar over Iran policy in a heated congressional hearing', expect: [], allow: [] },
  // Business / entertainment / scitech lanes
  { h: 'Apple reports record Q3 earnings, beating Wall Street estimates', expect: ['business'], allow: [] },
  { h: 'Taylor Swift announces a global stadium tour', expect: ['entertainment'], allow: [] },
  { h: "NASA's Europa Clipper begins its journey to Jupiter", expect: ['scitech'], allow: [] },
];

const VALID = new Set(['cyber','military','nuclear','sanctions','intelligence','maritime','business','scitech','entertainment']);

async function classify(system, headline) {
  const body = {
    model: MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: `Headline: ${headline}\nSource: (test)\n\n(Article body unavailable — classify on the headline alone.)` },
    ],
    temperature: 0.2,
    max_tokens: 300,
    response_format: { type: 'json_object' },
  };
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.EACHLABS_API_KEY}` },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const json = await resp.json();
  const content = json.choices?.[0]?.message?.content ?? '{}';
  let parsed; try { parsed = JSON.parse(content); } catch { return []; }
  return Array.isArray(parsed.topics)
    ? [...new Set(parsed.topics.map((t) => String(t).toLowerCase()).filter((t) => VALID.has(t)))]
    : [];
}

function score(rows) {
  let tp = 0, fp = 0, fn = 0;
  for (const r of rows) {
    const got = new Set(r.got);
    const expect = new Set(r.expect);
    const allow = new Set([...r.expect, ...r.allow]);
    for (const t of expect) (got.has(t) ? tp++ : fn++);
    for (const t of got) if (!allow.has(t)) fp++;
  }
  const prec = tp + fp ? tp / (tp + fp) : 1;
  const rec = tp + fn ? tp / (tp + fn) : 1;
  const f1 = prec + rec ? (2 * prec * rec) / (prec + rec) : 0;
  return { tp, fp, fn, prec, rec, f1 };
}

async function runVariant(name, system) {
  const rows = [];
  for (const g of GOLD) {
    let got = [];
    try { got = await classify(system, g.h); } catch (e) { got = [`ERR:${e.message}`]; }
    rows.push({ ...g, got });
  }
  const s = score(rows);
  console.log(`\n===== ${name} (${MODEL}) =====`);
  console.log(`precision=${s.prec.toFixed(2)} recall=${s.rec.toFixed(2)} F1=${s.f1.toFixed(2)}  (tp=${s.tp} fp=${s.fp} fn=${s.fn})`);
  for (const r of rows) {
    const miss = r.expect.filter((t) => !r.got.includes(t));
    const extra = r.got.filter((t) => !r.expect.includes(t) && !r.allow.includes(t));
    const flag = miss.length || extra.length ? '  ⚠' : '  ✓';
    console.log(`${flag} ${JSON.stringify(r.got).padEnd(34)} ⟵ ${r.h}`);
    if (miss.length) console.log(`       MISSED: ${miss.join(', ')}`);
    if (extra.length) console.log(`       NOISE:  ${extra.join(', ')}`);
  }
  return s;
}

(async () => {
  if (!process.env.EACHLABS_API_KEY) { console.error('Set EACHLABS_API_KEY'); process.exit(1); }
  const cur = await runVariant('CURRENT (primary-only)', buildSystem(TOPICS_CURRENT));
  const apr = await runVariant("A' (sharpened criteria)", buildSystem(TOPICS_APRIME));
  const ap2 = await runVariant("A'' (A' + tighter maritime/nuclear)", buildSystem(TOPICS_APRIME2));
  console.log('\n===== SUMMARY =====');
  console.log(`CURRENT : P=${cur.prec.toFixed(2)} R=${cur.rec.toFixed(2)} F1=${cur.f1.toFixed(2)}`);
  console.log(`A'      : P=${apr.prec.toFixed(2)} R=${apr.rec.toFixed(2)} F1=${apr.f1.toFixed(2)}`);
  console.log(`A''     : P=${ap2.prec.toFixed(2)} R=${ap2.rec.toFixed(2)} F1=${ap2.f1.toFixed(2)}`);
})();
