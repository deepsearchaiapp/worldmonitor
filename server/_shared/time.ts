/**
 * Clamp an untrusted publisher timestamp into the past.
 *
 * Some outlets ship pubDates from broken clocks (observed: +2 weeks). A
 * future timestamp poisons everything ranked or windowed by recency: it
 * pins the item to the top of every feed, survives rolling-window cutoffs
 * far longer than intended, and surfaces a future date in the UI. Anything
 * past `now` is stored as `now` — the moment we first saw the item is the
 * best truthful estimate we have.
 */
export function clampFutureMs(ms: number, nowMs: number = Date.now()): number {
  return ms > nowMs ? nowMs : ms;
}
