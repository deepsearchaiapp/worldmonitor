/**
 * GET /api/geo/v1/get-static-layers?variant=all
 *
 * Returns all static geographic layer data used by the map.
 * Data is imported directly from the frontend config files —
 * single source of truth for both web and mobile clients.
 *
 * Variant parameter controls which groups are included:
 *   - "full"      — geopolitical/security layers only
 *   - "tech"      — full + tech ecosystem layers
 *   - "finance"   — full + financial infrastructure layers
 *   - "commodity" — full + mining/resources layers
 *   - "all"       — everything (default)
 */

import type { ServerContext, GetStaticLayersRequest } from './service';

// --- Full variant (geopolitical core) ---
import { INTEL_HOTSPOTS } from '../../../../src/config/geo';
import { CONFLICT_ZONES } from '../../../../src/config/geo';
import { NUCLEAR_FACILITIES } from '../../../../src/config/geo';
import { UNDERSEA_CABLES } from '../../../../src/config/geo';
import { STRATEGIC_WATERWAYS } from '../../../../src/config/geo';
import { SPACEPORTS } from '../../../../src/config/geo';
import { MILITARY_BASES } from '../../../../src/config/geo';
import { CRITICAL_MINERALS } from '../../../../src/config/geo';
import { APT_GROUPS } from '../../../../src/config/geo';
import { ECONOMIC_CENTERS } from '../../../../src/config/geo';
import { PIPELINES } from '../../../../src/config/pipelines';
import { AI_DATA_CENTERS } from '../../../../src/config/ai-datacenters';
import { PORTS } from '../../../../src/config/ports';
import { TRADE_ROUTES } from '../../../../src/config/trade-routes';

// --- Tech variant ---
import { STARTUP_HUBS } from '../../../../src/config/tech-geo';
import { ACCELERATORS } from '../../../../src/config/tech-geo';
import { TECH_HQS } from '../../../../src/config/tech-geo';
import { CLOUD_REGIONS } from '../../../../src/config/tech-geo';

// --- Finance variant ---
import { STOCK_EXCHANGES } from '../../../../src/config/finance-geo';
import { FINANCIAL_CENTERS } from '../../../../src/config/finance-geo';
import { CENTRAL_BANKS } from '../../../../src/config/finance-geo';
import { COMMODITY_HUBS } from '../../../../src/config/finance-geo';

// --- Commodity variant ---
import { MINING_SITES } from '../../../../src/config/commodity-geo';
import { PROCESSING_PLANTS } from '../../../../src/config/commodity-geo';
import { COMMODITY_PORTS } from '../../../../src/config/commodity-geo';

// --- Gamma irradiators (JSON) ---
import irradiatorsData from '../../../../data/gamma-irradiators.json';

const VALID_VARIANTS = new Set(['all', 'full', 'tech', 'finance', 'commodity']);

// Pre-build responses since data is static — avoid re-computing on every request.
let cachedResponses: Record<string, Record<string, unknown>> | null = null;

function buildResponses(): Record<string, Record<string, unknown>> {
  const fullLayers: Record<string, unknown> = {
    hotspots: INTEL_HOTSPOTS,
    conflictZones: CONFLICT_ZONES,
    nuclearSites: NUCLEAR_FACILITIES,
    pipelines: PIPELINES,
    underseaCables: UNDERSEA_CABLES,
    irradiators: (irradiatorsData as { facilities: unknown[] }).facilities,
    datacenters: AI_DATA_CENTERS,
    spaceports: SPACEPORTS,
    ports: PORTS,
    tradeRoutes: TRADE_ROUTES,
    waterways: STRATEGIC_WATERWAYS,
    militaryBases: MILITARY_BASES,
    criticalMinerals: CRITICAL_MINERALS,
    aptGroups: APT_GROUPS,
    economicCenters: ECONOMIC_CENTERS,
  };

  const techLayers: Record<string, unknown> = {
    startupHubs: STARTUP_HUBS,
    accelerators: ACCELERATORS,
    techHQs: TECH_HQS,
    cloudRegions: CLOUD_REGIONS,
  };

  const financeLayers: Record<string, unknown> = {
    stockExchanges: STOCK_EXCHANGES,
    financialCenters: FINANCIAL_CENTERS,
    centralBanks: CENTRAL_BANKS,
    commodityHubs: COMMODITY_HUBS,
  };

  const commodityLayers: Record<string, unknown> = {
    miningSites: MINING_SITES,
    processingPlants: PROCESSING_PLANTS,
    commodityPorts: COMMODITY_PORTS,
  };

  return {
    full: { ...fullLayers },
    tech: { ...fullLayers, ...techLayers },
    finance: { ...fullLayers, ...financeLayers },
    commodity: { ...fullLayers, ...commodityLayers },
    all: { ...fullLayers, ...techLayers, ...financeLayers, ...commodityLayers },
  };
}

export async function getStaticLayers(
  _ctx: ServerContext,
  req: GetStaticLayersRequest,
): Promise<Record<string, unknown>> {
  const variant = VALID_VARIANTS.has(req.variant) ? req.variant : 'all';

  if (!cachedResponses) {
    cachedResponses = buildResponses();
  }

  return cachedResponses[variant]!;
}
