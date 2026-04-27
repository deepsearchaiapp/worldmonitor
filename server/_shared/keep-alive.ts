/**
 * `keepAlive(promise)` — extend a background task across an Edge Function
 * response in Vercel's runtime.
 *
 * # Why this exists
 *
 * Vercel's Edge Functions kill the JavaScript isolate as soon as
 * `return new Response(...)` returns. Any unawaited Promise (LLM
 * enrichment, analytics writes, log shipping, etc.) gets cancelled
 * mid-flight, with no warning. Symptoms: "Kicking off X..." prints in
 * Vercel logs but the success/failure log from inside the promise never
 * appears, and downstream state (Redis, DB, etc.) never updates.
 *
 * Vercel exposes a request-context store on `globalThis` keyed by the
 * shared symbol `Symbol.for('@vercel/request-context')`. Calling
 * `.get()` on it yields a context object with `waitUntil(promise)` —
 * which tells Vercel "the response is ready, but please keep this
 * isolate alive until this promise resolves." Up to ~30 seconds.
 *
 * This helper reads that symbol directly so we don't need to add the
 * `@vercel/functions` package as a dependency. The symbol-keyed
 * context is part of the Vercel ABI and is what the official package
 * uses under the hood.
 *
 * # Usage
 *
 *     keepAlive(enrichLocations(items), 'live-news:enrich');
 *     return new Response(JSON.stringify(body), { ... });
 *
 * The promise's rejection (if any) is caught and logged with the label
 * so the isolate doesn't crash on an unhandled rejection.
 */

const REQUEST_CONTEXT_SYMBOL = Symbol.for('@vercel/request-context');

interface RequestContextStore {
  get?: () => { waitUntil?: (promise: Promise<unknown>) => void } | undefined;
}

export function keepAlive(promise: Promise<unknown>, label = 'background'): void {
  // Defang any rejection so we don't crash the isolate. We log the error
  // here rather than let `waitUntil` swallow it silently — useful for
  // diagnosing LLM/Redis failures from Vercel logs.
  const safe = promise.catch((err) => {
    console.warn(`[keepAlive] ${label} rejected:`, err instanceof Error ? err.message : err);
  });

  try {
    const store = (globalThis as Record<symbol, unknown>)[REQUEST_CONTEXT_SYMBOL] as RequestContextStore | undefined;
    const ctx = store?.get?.();
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(safe);
      return;
    }
  } catch {
    // Fall through to the unguarded path
  }

  // Local dev / non-Vercel runtimes / older Edge versions: no waitUntil
  // available. The promise still runs (we keep a strong reference via
  // `safe`) but the runtime may reclaim the isolate before it finishes.
  // We log a one-time warning so this isn't silently broken in prod.
  if (!warnedNoWaitUntil) {
    warnedNoWaitUntil = true;
    console.warn('[keepAlive] No Vercel request-context found — background promises may be cancelled');
  }
}

let warnedNoWaitUntil = false;
