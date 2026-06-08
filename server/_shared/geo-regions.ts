/**
 * Deterministic geo: country → region, plus an alias → ISO-3166-1-alpha-2
 * canonicaliser. The foundation of the regional World Briefs.
 *
 * # Why this exists
 *
 * GDELT's parsed coordinates are unreliable, and the enrich LLM is not
 * deterministic about country CODES (it emits "UK", "USA", "Burma", …). So:
 * the LLM only *identifies* the country (a name or rough code); this module
 * turns that into a canonical ISO code and then into one of our regions via
 * tables WE control. Same input → same region, every time.
 *
 *   LLM output ("Türkiye" | "UK" | "DRC")
 *     → canonicalIso()   → ISO-2 ("TR" | "GB" | "CD")
 *     → regionForCountry() → RegionId ("europe" | "europe" | "africa")
 *
 * # Taxonomy (14 regions, full-world, war-monitoring split)
 *
 * Settled 2026-06-08. US is its own region (the app's primary market);
 * Canada stands alone. Edge calls baked into the table: Turkey→europe,
 * Caucasus→europe, Belarus→ukraine_russia, Iraq+Yemen→arabian_peninsula,
 * Mexico→latin_america. Africa is a single bucket (split later if volume
 * justifies). A story with no resolvable country returns null → the regional
 * briefs skip it (it still appears in the GLOBAL brief).
 *
 * Re-splitting a region later = edit this table + bump the consumer's
 * version. No model retraining, no per-item cost.
 */

export const REGION_IDS = [
  'us',
  'canada',
  'latin_america',
  'europe',
  'ukraine_russia',
  'levant',
  'iran',
  'arabian_peninsula',
  'africa',
  'east_asia',
  'southeast_asia',
  'south_asia',
  'central_asia',
  'oceania',
] as const;

export type RegionId = (typeof REGION_IDS)[number];

/** Human labels for the brief UI / dispatcher logs. */
export const REGION_LABELS: Record<RegionId, string> = {
  us: 'United States',
  canada: 'Canada',
  latin_america: 'Latin America',
  europe: 'Europe',
  ukraine_russia: 'Ukraine & Russia',
  levant: 'Levant',
  iran: 'Iran',
  arabian_peninsula: 'Arabian Peninsula',
  africa: 'Africa',
  east_asia: 'East Asia',
  southeast_asia: 'Southeast Asia',
  south_asia: 'South Asia',
  central_asia: 'Central Asia',
  oceania: 'Oceania',
};

/**
 * Exhaustive ISO-3166-1 alpha-2 → region. Every UN member state plus the
 * commonly-newsworthy territories (Taiwan, Hong Kong, Macau, Kosovo,
 * Palestine, Western Sahara, Puerto Rico, Greenland). Keys are UPPERCASE.
 */
export const COUNTRY_TO_REGION: Record<string, RegionId> = {
  // ── United States ──
  US: 'us',
  // ── Canada ──
  CA: 'canada',

  // ── Ukraine / Russia / Belarus ──
  UA: 'ukraine_russia', RU: 'ukraine_russia', BY: 'ukraine_russia',

  // ── Europe (EU + UK + EFTA + Balkans + Caucasus + Turkey + microstates) ──
  GB: 'europe', IE: 'europe', FR: 'europe', DE: 'europe', NL: 'europe',
  BE: 'europe', LU: 'europe', AT: 'europe', CH: 'europe', LI: 'europe',
  MC: 'europe', AD: 'europe', SM: 'europe', VA: 'europe', MT: 'europe',
  ES: 'europe', PT: 'europe', IT: 'europe', GR: 'europe', CY: 'europe',
  SE: 'europe', NO: 'europe', FI: 'europe', DK: 'europe', IS: 'europe',
  PL: 'europe', CZ: 'europe', SK: 'europe', HU: 'europe', RO: 'europe',
  BG: 'europe', EE: 'europe', LV: 'europe', LT: 'europe', MD: 'europe',
  HR: 'europe', SI: 'europe', RS: 'europe', BA: 'europe', ME: 'europe',
  MK: 'europe', AL: 'europe', XK: 'europe',
  GE: 'europe', AM: 'europe', AZ: 'europe', TR: 'europe',
  GL: 'europe', // Greenland (Danish territory)

  // ── Levant ──
  IL: 'levant', PS: 'levant', LB: 'levant', SY: 'levant', JO: 'levant',

  // ── Iran ──
  IR: 'iran',

  // ── Arabian Peninsula (+ Iraq, Yemen) ──
  SA: 'arabian_peninsula', AE: 'arabian_peninsula', QA: 'arabian_peninsula',
  BH: 'arabian_peninsula', KW: 'arabian_peninsula', OM: 'arabian_peninsula',
  YE: 'arabian_peninsula', IQ: 'arabian_peninsula',

  // ── Africa (whole continent — one bucket) ──
  DZ: 'africa', EG: 'africa', LY: 'africa', MA: 'africa', TN: 'africa',
  SD: 'africa', SS: 'africa', MR: 'africa', EH: 'africa', ML: 'africa',
  NE: 'africa', TD: 'africa', BF: 'africa',
  NG: 'africa', GH: 'africa', CI: 'africa', SN: 'africa', GN: 'africa',
  BJ: 'africa', TG: 'africa', SL: 'africa', LR: 'africa', GM: 'africa',
  GW: 'africa', CV: 'africa',
  CD: 'africa', CG: 'africa', CM: 'africa', CF: 'africa', GA: 'africa',
  GQ: 'africa', AO: 'africa', ST: 'africa',
  ET: 'africa', ER: 'africa', DJ: 'africa', SO: 'africa', KE: 'africa',
  TZ: 'africa', UG: 'africa', RW: 'africa', BI: 'africa',
  ZA: 'africa', ZW: 'africa', ZM: 'africa', MZ: 'africa', MW: 'africa',
  BW: 'africa', NA: 'africa', LS: 'africa', SZ: 'africa', MG: 'africa',
  MU: 'africa', SC: 'africa', KM: 'africa',

  // ── East Asia ──
  CN: 'east_asia', TW: 'east_asia', JP: 'east_asia', KR: 'east_asia',
  KP: 'east_asia', MN: 'east_asia', HK: 'east_asia', MO: 'east_asia',

  // ── Southeast Asia ──
  TH: 'southeast_asia', VN: 'southeast_asia', ID: 'southeast_asia',
  PH: 'southeast_asia', MY: 'southeast_asia', SG: 'southeast_asia',
  MM: 'southeast_asia', KH: 'southeast_asia', LA: 'southeast_asia',
  BN: 'southeast_asia', TL: 'southeast_asia',

  // ── South Asia ──
  IN: 'south_asia', PK: 'south_asia', AF: 'south_asia', BD: 'south_asia',
  LK: 'south_asia', NP: 'south_asia', BT: 'south_asia', MV: 'south_asia',

  // ── Central Asia ──
  KZ: 'central_asia', UZ: 'central_asia', TM: 'central_asia',
  KG: 'central_asia', TJ: 'central_asia',

  // ── Latin America (Mexico + Central + South + Caribbean) ──
  MX: 'latin_america', GT: 'latin_america', BZ: 'latin_america',
  SV: 'latin_america', HN: 'latin_america', NI: 'latin_america',
  CR: 'latin_america', PA: 'latin_america',
  CO: 'latin_america', VE: 'latin_america', EC: 'latin_america',
  PE: 'latin_america', BR: 'latin_america', BO: 'latin_america',
  PY: 'latin_america', UY: 'latin_america', AR: 'latin_america',
  CL: 'latin_america', GY: 'latin_america', SR: 'latin_america',
  CU: 'latin_america', DO: 'latin_america', HT: 'latin_america',
  JM: 'latin_america', TT: 'latin_america', BS: 'latin_america',
  BB: 'latin_america', GD: 'latin_america', LC: 'latin_america',
  VC: 'latin_america', AG: 'latin_america', DM: 'latin_america',
  KN: 'latin_america', PR: 'latin_america',

  // ── Oceania ──
  AU: 'oceania', NZ: 'oceania', PG: 'oceania', FJ: 'oceania', SB: 'oceania',
  VU: 'oceania', WS: 'oceania', TO: 'oceania', KI: 'oceania', FM: 'oceania',
  MH: 'oceania', PW: 'oceania', NR: 'oceania', TV: 'oceania',
};

/**
 * Primary English name per ISO-2 code — the basis for name → ISO resolution
 * (built once at load, below). Every code in COUNTRY_TO_REGION appears here so
 * the LLM emitting a NAME instead of a code still resolves.
 */
export const COUNTRY_NAMES: Record<string, string> = {
  US: 'United States', CA: 'Canada',
  UA: 'Ukraine', RU: 'Russia', BY: 'Belarus',
  GB: 'United Kingdom', IE: 'Ireland', FR: 'France', DE: 'Germany',
  NL: 'Netherlands', BE: 'Belgium', LU: 'Luxembourg', AT: 'Austria',
  CH: 'Switzerland', LI: 'Liechtenstein', MC: 'Monaco', AD: 'Andorra',
  SM: 'San Marino', VA: 'Vatican City', MT: 'Malta', ES: 'Spain',
  PT: 'Portugal', IT: 'Italy', GR: 'Greece', CY: 'Cyprus', SE: 'Sweden',
  NO: 'Norway', FI: 'Finland', DK: 'Denmark', IS: 'Iceland', PL: 'Poland',
  CZ: 'Czechia', SK: 'Slovakia', HU: 'Hungary', RO: 'Romania', BG: 'Bulgaria',
  EE: 'Estonia', LV: 'Latvia', LT: 'Lithuania', MD: 'Moldova', HR: 'Croatia',
  SI: 'Slovenia', RS: 'Serbia', BA: 'Bosnia and Herzegovina', ME: 'Montenegro',
  MK: 'North Macedonia', AL: 'Albania', XK: 'Kosovo', GE: 'Georgia',
  AM: 'Armenia', AZ: 'Azerbaijan', TR: 'Turkey', GL: 'Greenland',
  IL: 'Israel', PS: 'Palestine', LB: 'Lebanon', SY: 'Syria', JO: 'Jordan',
  IR: 'Iran',
  SA: 'Saudi Arabia', AE: 'United Arab Emirates', QA: 'Qatar', BH: 'Bahrain',
  KW: 'Kuwait', OM: 'Oman', YE: 'Yemen', IQ: 'Iraq',
  DZ: 'Algeria', EG: 'Egypt', LY: 'Libya', MA: 'Morocco', TN: 'Tunisia',
  SD: 'Sudan', SS: 'South Sudan', MR: 'Mauritania', EH: 'Western Sahara',
  ML: 'Mali', NE: 'Niger', TD: 'Chad', BF: 'Burkina Faso', NG: 'Nigeria',
  GH: 'Ghana', CI: 'Ivory Coast', SN: 'Senegal', GN: 'Guinea', BJ: 'Benin',
  TG: 'Togo', SL: 'Sierra Leone', LR: 'Liberia', GM: 'Gambia',
  GW: 'Guinea-Bissau', CV: 'Cape Verde', CD: 'Democratic Republic of the Congo',
  CG: 'Republic of the Congo', CM: 'Cameroon', CF: 'Central African Republic',
  GA: 'Gabon', GQ: 'Equatorial Guinea', AO: 'Angola',
  ST: 'Sao Tome and Principe', ET: 'Ethiopia', ER: 'Eritrea', DJ: 'Djibouti',
  SO: 'Somalia', KE: 'Kenya', TZ: 'Tanzania', UG: 'Uganda', RW: 'Rwanda',
  BI: 'Burundi', ZA: 'South Africa', ZW: 'Zimbabwe', ZM: 'Zambia',
  MZ: 'Mozambique', MW: 'Malawi', BW: 'Botswana', NA: 'Namibia', LS: 'Lesotho',
  SZ: 'Eswatini', MG: 'Madagascar', MU: 'Mauritius', SC: 'Seychelles',
  KM: 'Comoros',
  CN: 'China', TW: 'Taiwan', JP: 'Japan', KR: 'South Korea', KP: 'North Korea',
  MN: 'Mongolia', HK: 'Hong Kong', MO: 'Macau',
  TH: 'Thailand', VN: 'Vietnam', ID: 'Indonesia', PH: 'Philippines',
  MY: 'Malaysia', SG: 'Singapore', MM: 'Myanmar', KH: 'Cambodia', LA: 'Laos',
  BN: 'Brunei', TL: 'Timor-Leste',
  IN: 'India', PK: 'Pakistan', AF: 'Afghanistan', BD: 'Bangladesh',
  LK: 'Sri Lanka', NP: 'Nepal', BT: 'Bhutan', MV: 'Maldives',
  KZ: 'Kazakhstan', UZ: 'Uzbekistan', TM: 'Turkmenistan', KG: 'Kyrgyzstan',
  TJ: 'Tajikistan',
  MX: 'Mexico', GT: 'Guatemala', BZ: 'Belize', SV: 'El Salvador',
  HN: 'Honduras', NI: 'Nicaragua', CR: 'Costa Rica', PA: 'Panama',
  CO: 'Colombia', VE: 'Venezuela', EC: 'Ecuador', PE: 'Peru', BR: 'Brazil',
  BO: 'Bolivia', PY: 'Paraguay', UY: 'Uruguay', AR: 'Argentina', CL: 'Chile',
  GY: 'Guyana', SR: 'Suriname', CU: 'Cuba', DO: 'Dominican Republic',
  HT: 'Haiti', JM: 'Jamaica', TT: 'Trinidad and Tobago', BS: 'Bahamas',
  BB: 'Barbados', GD: 'Grenada', LC: 'Saint Lucia',
  VC: 'Saint Vincent and the Grenadines', AG: 'Antigua and Barbuda',
  DM: 'Dominica', KN: 'Saint Kitts and Nevis', PR: 'Puerto Rico',
  AU: 'Australia', NZ: 'New Zealand', PG: 'Papua New Guinea', FJ: 'Fiji',
  SB: 'Solomon Islands', VU: 'Vanuatu', WS: 'Samoa', TO: 'Tonga',
  KI: 'Kiribati', FM: 'Micronesia', MH: 'Marshall Islands', PW: 'Palau',
  NR: 'Nauru', TV: 'Tuvalu',
};

/**
 * Alias → ISO-2. Keys are NORMALISED (lowercase, accents + punctuation
 * stripped — see `normalizeName`). Covers (a) wrong codes the LLM emits
 * ("uk"→GB, "uae"→AE), and (b) country NAMES in case the LLM returns a name
 * instead of a code. Only entries that differ from a plain uppercase-of-the-
 * ISO-code are needed; obvious exact codes are handled directly.
 */
export const ALIAS_TO_ISO: Record<string, string> = {
  // United States
  'usa': 'US', 'us': 'US', 'u s': 'US', 'u s a': 'US', 'united states': 'US',
  'united states of america': 'US', 'america': 'US', 'the us': 'US',
  // United Kingdom (wrong code "UK" + constituent nations)
  'uk': 'GB', 'u k': 'GB', 'united kingdom': 'GB', 'britain': 'GB',
  'great britain': 'GB', 'england': 'GB', 'scotland': 'GB', 'wales': 'GB',
  'northern ireland': 'GB',
  // Common name → code
  'united arab emirates': 'AE', 'uae': 'AE',
  'saudi arabia': 'SA', 'south korea': 'KR', 'republic of korea': 'KR',
  'north korea': 'KP', 'korea': 'KR', 'dprk': 'KP',
  'russia': 'RU', 'russian federation': 'RU',
  'turkey': 'TR', 'turkiye': 'TR',
  'czech republic': 'CZ', 'czechia': 'CZ',
  'vatican': 'VA', 'vatican city': 'VA', 'holy see': 'VA',
  'palestine': 'PS', 'palestinian territories': 'PS', 'gaza': 'PS',
  'west bank': 'PS', 'state of palestine': 'PS',
  'myanmar': 'MM', 'burma': 'MM',
  'ivory coast': 'CI', 'cote divoire': 'CI',
  'cape verde': 'CV', 'cabo verde': 'CV',
  'swaziland': 'SZ', 'eswatini': 'SZ',
  'north macedonia': 'MK', 'macedonia': 'MK',
  'east timor': 'TL', 'timor leste': 'TL',
  'congo': 'CD', 'dr congo': 'CD', 'drc': 'CD',
  'democratic republic of congo': 'CD',
  'democratic republic of the congo': 'CD', 'congo kinshasa': 'CD',
  'republic of congo': 'CG', 'republic of the congo': 'CG',
  'congo brazzaville': 'CG',
  'south sudan': 'SS', 'western sahara': 'EH',
  'bosnia': 'BA', 'bosnia and herzegovina': 'BA',
  'laos': 'LA', 'vietnam': 'VN', 'viet nam': 'VN',
  'iran': 'IR', 'persia': 'IR', 'islamic republic of iran': 'IR',
  'syria': 'SY', 'syrian arab republic': 'SY',
  'taiwan': 'TW', 'republic of china': 'TW',
  'hong kong': 'HK', 'macau': 'MO', 'macao': 'MO',
  'china': 'CN', 'peoples republic of china': 'CN',
  'tanzania': 'TZ', 'venezuela': 'VE', 'bolivia': 'BO',
  'moldova': 'MD', 'kosovo': 'XK',
  'brunei': 'BN', 'east germany': 'DE',
  'netherlands': 'NL', 'holland': 'NL',
  'philippines': 'PH', 'the philippines': 'PH',
  'gambia': 'GM', 'the gambia': 'GM',
  'bahamas': 'BS', 'the bahamas': 'BS',
  'greenland': 'GL',
};

/** Normalise a free-text country string for alias lookup: lowercase, strip
 *  accents, drop punctuation, collapse whitespace. */
export function normalizeName(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')          // drop apostrophes: people's→peoples, d'ivoire→divoire
    .replace(/[^a-z0-9 ]/g, ' ')    // other punctuation → space
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Combined name → ISO lookup, built once: every country's primary name plus
 * the alias / wrong-code variants. Keys are normalised; ALIAS entries win on
 * any collision.
 */
const NAME_TO_ISO: Record<string, string> = (() => {
  const m: Record<string, string> = {};
  for (const [iso, name] of Object.entries(COUNTRY_NAMES)) m[normalizeName(name)] = iso;
  for (const [alias, iso] of Object.entries(ALIAS_TO_ISO)) m[alias] = iso;
  return m;
})();

/**
 * Turn the LLM's country output (a name OR a rough code) into a canonical
 * ISO-2 code, or null if unresolvable. Order:
 *   1. exact 2-letter code that exists in COUNTRY_TO_REGION → use it
 *   2. normalised name/alias lookup (every country name + wrong codes like "UK")
 *   3. give up → null
 */
export function canonicalIso(input: string | null | undefined): string | null {
  if (!input) return null;
  const upper = input.trim().toUpperCase();
  if (/^[A-Z]{2}$/.test(upper) && COUNTRY_TO_REGION[upper]) return upper;
  return NAME_TO_ISO[normalizeName(input)] ?? null;
}

/** ISO-2 → region (null if the code isn't in the table). */
export function regionForCountry(iso: string | null | undefined): RegionId | null {
  if (!iso) return null;
  return COUNTRY_TO_REGION[iso.trim().toUpperCase()] ?? null;
}

/** One-shot: LLM country name/code → region, or null (→ global only). */
export function resolveRegion(countryNameOrCode: string | null | undefined): RegionId | null {
  return regionForCountry(canonicalIso(countryNameOrCode));
}
