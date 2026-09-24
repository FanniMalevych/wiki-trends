import { MAD_SCALE, mad, mean, rollingMedian } from "./basic.js";

export interface Spike {
  index: number;
  /** Robust z-score of the value against its neighbourhood; negative for dips. */
  z: number;
  /** Deviation from the local level in the series' units (a log ratio for log data). */
  excess: number;
}

/**
 * Points far from a centered 5-point rolling median: more than `threshold`
 * robust standard deviations (MAD) away, and at least `minExcess` in size, so a
 * very smooth series does not turn small wobbles into "spikes". On log data the
 * default minimum is a factor of 1.5. The window ignores up to two unusual
 * neighbours, so short bursts are still caught.
 */
export function detectSpikes(y: readonly number[], { threshold = 3.5, minExcess = Math.log(1.5) } = {}): Spike[] {
  const level = rollingMedian(y, 5);
  const residuals = y.map((v, i) => v - level[i]!);
  const scale = MAD_SCALE * mad(residuals);
  if (scale === 0) return [];
  return residuals.flatMap((r, index) =>
    Math.abs(r) / scale > threshold && Math.abs(r) >= minExcess ? [{ index, z: r / scale, excess: r }] : [],
  );
}

export interface Step {
  /** First index of the new level. */
  index: number;
  /** Level change in the series' units (a log ratio for log data). */
  shift: number;
  /** t statistic of the shift. */
  t: number;
}

/** Residuals of v after least-squares regression on [1, i]. */
function residualizeOnLine(v: readonly number[]): number[] {
  const n = v.length;
  const mi = (n - 1) / 2;
  const mv = mean(v);
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < n; i++) {
    sxy += (i - mi) * (v[i]! - mv);
    sxx += (i - mi) ** 2;
  }
  const b = sxy / sxx;
  return v.map((x, i) => x - mv - b * (i - mi));
}

/**
 * Looks for one sudden change of level on top of a linear trend. For each split
 * k it fits y = a + b·i + c·[i ≥ k] by least squares and keeps the split with the
 * largest |t| of c. Thresholds are conservative because the maximum is taken
 * over every split and monthly values are autocorrelated; this flags clear
 * breaks, not gradual change.
 */
export function detectStep(
  y: readonly number[],
  { minSegment = 6, minT = 5, minShift = Math.log(1.25) } = {},
): Step | null {
  const n = y.length;
  if (n < 2 * minSegment) return null;
  // Frisch–Waugh: the step coefficient equals the regression of the
  // line-residualized y on the line-residualized step indicator.
  const ry = residualizeOnLine(y);
  const sse0 = ry.reduce((s, r) => s + r * r, 0);

  let best: Step | null = null;
  for (let k = minSegment; k <= n - minSegment; k++) {
    const rd = residualizeOnLine(y.map((_, i) => (i >= k ? 1 : 0)));
    const sdd = rd.reduce((s, r) => s + r * r, 0);
    const c = rd.reduce((s, r, i) => s + r * ry[i]!, 0) / sdd;
    const sse = sse0 - c * c * sdd;
    const t = sse <= 0 ? Math.sign(c) * Infinity : c / Math.sqrt(sse / (n - 3) / sdd);
    if (!best || Math.abs(t) > Math.abs(best.t)) best = { index: k, shift: c, t };
  }
  return best && Math.abs(best.t) >= minT && Math.abs(best.shift) >= minShift ? best : null;
}
