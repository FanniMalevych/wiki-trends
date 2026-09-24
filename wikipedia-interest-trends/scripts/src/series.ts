import type { Cache } from "./cache/db.js";
import { fetchRange, type Point, type SeriesKey } from "./wiki/pageviews.js";
import { contiguousRuns, enumeratePeriods, isFinal } from "./wiki/periods.js";

export interface SeriesResult {
  key: SeriesKey;
  points: Point[];
  /** Periods served from the cache without a request. */
  cachedPeriods: number;
  /** Periods downloaded (or re-downloaded because they could still change). */
  fetchedPeriods: number;
}

/**
 * Returns a complete, zero-filled series for [start, end], downloading only the
 * periods that are missing from the cache or not yet final.
 */
export async function loadSeries(
  cache: Cache,
  key: SeriesKey,
  start: string,
  end: string,
  now = Date.now(),
): Promise<SeriesResult> {
  const periods = enumeratePeriods(start, end, key.granularity);
  const cached = cache.load(key, start, end);
  const stale = (p: string) => {
    const hit = cached.get(p);
    return hit === undefined || !isFinal(p, key.granularity, hit.fetchedAt);
  };

  let fetchedPeriods = 0;
  for (const [runStart, runEnd] of contiguousRuns(periods, stale)) {
    const got = new Map((await fetchRange(key, runStart, runEnd)).map((p) => [p.period, p.views]));
    const filled = enumeratePeriods(runStart, runEnd, key.granularity).map((period) => ({
      period,
      views: got.get(period) ?? 0,
    }));
    cache.save(key, filled, now);
    for (const p of filled) cached.set(p.period, { views: p.views, fetchedAt: now });
    fetchedPeriods += filled.length;
  }

  return {
    key,
    points: periods.map((period) => ({ period, views: cached.get(period)!.views })),
    cachedPeriods: periods.length - fetchedPeriods,
    fetchedPeriods,
  };
}
