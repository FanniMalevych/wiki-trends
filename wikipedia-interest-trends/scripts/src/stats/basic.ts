/** Two-sided 95% critical value of the standard normal distribution. */
export const Z_95 = 1.959963984540054;

/** Scales the median absolute deviation to estimate a normal standard deviation. */
export const MAD_SCALE = 1.4826;

export function mean(xs: readonly number[]): number {
  return xs.reduce((s, x) => s + x, 0) / xs.length;
}

export function median(xs: readonly number[]): number {
  if (xs.length === 0) return NaN;
  const s = xs.toSorted((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** Median absolute deviation (unscaled). */
export function mad(xs: readonly number[]): number {
  const m = median(xs);
  return median(xs.map((x) => Math.abs(x - m)));
}

/** Centered rolling median; the window shrinks at the edges. */
export function rollingMedian(xs: readonly number[], window: number): number[] {
  const half = window >> 1;
  return xs.map((_, i) => median(xs.slice(Math.max(0, i - half), i + half + 1)));
}

/** Round half to even, like NumPy's round. */
export function roundHalfEven(x: number): number {
  const r = Math.round(x);
  return Math.abs(x % 1) === 0.5 && r % 2 !== 0 ? r - 1 : r;
}

/** Ranks starting at 1, with ties given their average rank (SciPy's rankdata). */
export function rank(xs: readonly number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(xs.length);
  for (let i = 0; i < order.length; ) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) ranks[order[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return ranks;
}

/** Sizes of groups of equal values, for tie corrections. */
export function tieGroups(xs: readonly number[]): number[] {
  const counts = new Map<number, number>();
  for (const x of xs) counts.set(x, (counts.get(x) ?? 0) + 1);
  return [...counts.values()].filter((c) => c > 1);
}

/**
 * Complementary error function, Numerical Recipes' Chebyshev fit
 * (fractional error below 1.2e-7 everywhere).
 */
export function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + 0.5 * z);
  const r =
    t *
    Math.exp(
      -z * z - 1.26551223 +
        t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 +
        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? r : 2 - r;
}

/** Two-sided p-value of a standard normal z score. */
export function twoSidedP(z: number): number {
  return erfc(Math.abs(z) / Math.SQRT2);
}
