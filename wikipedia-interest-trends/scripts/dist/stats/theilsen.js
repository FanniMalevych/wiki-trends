import { median, roundHalfEven, tieGroups, Z_95 } from "./basic.js";
/**
 * Theil–Sen slope of y against x = 0, 1, …, n-1, with the confidence interval
 * computed as in SciPy's `theilslopes` (Sen 1968, eq. 2.6). Robust to outliers:
 * a single extreme point cannot move the slope much.
 *
 * `varS` replaces the variance of Kendall's S used for the interval; pass the
 * autocorrelation-corrected value from `mannKendall` so the interval agrees
 * with that test's p-value.
 */
export function theilSen(y, { varS } = {}) {
    const n = y.length;
    if (n < 2)
        throw new Error("Theil–Sen needs at least 2 points.");
    const slopes = [];
    for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++)
            slopes.push((y[j] - y[i]) / (j - i));
    slopes.sort((a, b) => a - b);
    const slope = median(slopes);
    const intercept = median(y) - slope * ((n - 1) / 2);
    const ties = tieGroups(y).reduce((s, k) => s + k * (k - 1) * (2 * k + 5), 0);
    const sigma = Math.sqrt(varS ?? (n * (n - 1) * (2 * n + 5) - ties) / 18);
    const nt = slopes.length;
    const upper = Math.min(roundHalfEven((nt + Z_95 * sigma) / 2), nt - 1);
    const lower = Math.max(roundHalfEven((nt - Z_95 * sigma) / 2) - 1, 0);
    return { slope, intercept, low: slopes[lower], high: slopes[upper] };
}
