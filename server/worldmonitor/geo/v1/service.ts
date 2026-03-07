/**
 * Manually created service definition for geo/v1.
 * Skips proto generation since this endpoint serves static config data.
 */

export interface ServerContext {
  request: Request;
  pathParams: Record<string, string>;
  headers: Record<string, string>;
}

export interface GetStaticLayersRequest {
  variant: string;
}

export interface GeoServiceHandler {
  getStaticLayers(
    ctx: ServerContext,
    req: GetStaticLayersRequest,
  ): Promise<Record<string, unknown>>;
}

export interface RouteDescriptor {
  method: string;
  path: string;
  handler: (req: Request) => Promise<Response>;
}

export interface ServerOptions {
  onError?: (error: unknown, req: Request) => Response | Promise<Response>;
}

export function createGeoServiceRoutes(
  handler: GeoServiceHandler,
  options?: ServerOptions,
): RouteDescriptor[] {
  return [
    {
      method: 'GET',
      path: '/api/geo/v1/get-static-layers',
      handler: async (req: Request): Promise<Response> => {
        try {
          const url = new URL(req.url, 'http://localhost');
          const params = url.searchParams;
          const body: GetStaticLayersRequest = {
            variant: params.get('variant') ?? 'all',
          };

          const ctx: ServerContext = {
            request: req,
            pathParams: {},
            headers: Object.fromEntries(req.headers.entries()),
          };

          const result = await handler.getStaticLayers(ctx, body);
          return new Response(JSON.stringify(result), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err: unknown) {
          if (options?.onError) {
            return options.onError(err, req);
          }
          const message = err instanceof Error ? err.message : String(err);
          return new Response(JSON.stringify({ message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          });
        }
      },
    },
  ];
}
