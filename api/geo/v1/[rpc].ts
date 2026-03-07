export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createGeoServiceRoutes } from '../../../server/worldmonitor/geo/v1/service';
import { geoHandler } from '../../../server/worldmonitor/geo/v1/handler';

export default createDomainGateway(
  createGeoServiceRoutes(geoHandler, serverOptions),
);
