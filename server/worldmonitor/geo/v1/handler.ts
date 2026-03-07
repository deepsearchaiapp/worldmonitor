import type { GeoServiceHandler } from './service';

import { getStaticLayers } from './get-static-layers';

export const geoHandler: GeoServiceHandler = {
  getStaticLayers,
};
