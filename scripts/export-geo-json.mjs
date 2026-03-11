#!/usr/bin/env node

/**
 * Export geo.ts static data to JSON for iOS app bundling.
 * Run: node scripts/export-geo-json.mjs
 * Output: geo-static.json
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// We'll parse the TypeScript files manually since we can't import them directly
// Use tsx to transpile and evaluate
const geoPath = join(__dirname, '..', 'src', 'config', 'geo.ts');
const basesPath = join(__dirname, '..', 'src', 'config', 'bases-expanded.ts');

const geoSrc = readFileSync(geoPath, 'utf8');
const basesSrc = readFileSync(basesPath, 'utf8');

// Strip TypeScript-specific syntax
function stripTS(src) {
  return src
    .replace(/import\s+type\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];?\s*/g, '')
    .replace(/import\s+\{[^}]*\}\s+from\s+['"][^'"]*['"];?\s*/g, '')
    .replace(/export\s+/g, '')
    // Remove type annotations on variables
    .replace(/:\s*(Hotspot|ConflictZone|MilitaryBase|UnderseaCable|NuclearFacility|StrategicWaterway|APTGroup|EconomicCenter|Spaceport|CriticalMineralProject)\[\]/g, '')
    .replace(/:\s*Record<number,\s*'severe'\s*\|\s*'high'\s*\|\s*'moderate'>/g, '')
    // Remove generic type params like Set<string>, Map<string, ...>
    .replace(/new Set<[^>]*>/g, 'new Set')
    .replace(/new Map<[^>]*>/g, 'new Map')
    // Remove type annotations on function params/returns
    .replace(/:\s*MilitaryBase\[\]/g, '')
    .replace(/:\s*string/g, '')
    .replace(/as\s+const/g, '');
}

// Evaluate bases-expanded first
const basesCode = stripTS(basesSrc);
const MILITARY_BASES_EXPANDED = new Function(basesCode + '\nreturn MILITARY_BASES_EXPANDED;')();

// Evaluate geo.ts with bases injected
let geoCode = stripTS(geoSrc);

// Inject MILITARY_BASES_EXPANDED
geoCode = `const MILITARY_BASES_EXPANDED = ${JSON.stringify(MILITARY_BASES_EXPANDED)};\n` + geoCode;

const geoModule = new Function(geoCode + `
return {
  INTEL_HOTSPOTS,
  STRATEGIC_WATERWAYS,
  APT_GROUPS,
  CONFLICT_ZONES,
  MILITARY_BASES,
  UNDERSEA_CABLES,
  NUCLEAR_FACILITIES,
  SANCTIONED_COUNTRIES,
  ECONOMIC_CENTERS,
  SPACEPORTS,
  CRITICAL_MINERALS,
};
`)();

const output = {
  intelHotspots: geoModule.INTEL_HOTSPOTS,
  strategicWaterways: geoModule.STRATEGIC_WATERWAYS,
  aptGroups: geoModule.APT_GROUPS,
  conflictZones: geoModule.CONFLICT_ZONES,
  militaryBases: geoModule.MILITARY_BASES,
  underseaCables: geoModule.UNDERSEA_CABLES,
  nuclearFacilities: geoModule.NUCLEAR_FACILITIES,
  sanctionedCountries: geoModule.SANCTIONED_COUNTRIES,
  economicCenters: geoModule.ECONOMIC_CENTERS,
  spaceports: geoModule.SPACEPORTS,
  criticalMinerals: geoModule.CRITICAL_MINERALS,
};

// Stats
console.log('=== Geo Static Data Export ===');
for (const [key, val] of Object.entries(output)) {
  const count = Array.isArray(val) ? val.length : Object.keys(val).length;
  console.log(`  ${key}: ${count} items`);
}

const json = JSON.stringify(output);
const outPath = join(__dirname, '..', 'geo-static.json');
const { writeFileSync } = await import('node:fs');
writeFileSync(outPath, json);
console.log(`\nWritten to ${outPath} (${(json.length / 1024).toFixed(0)} KB)`);
