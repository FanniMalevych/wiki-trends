import { mean, rank, tieGroups, twoSidedP, Z_95 } from "./basic.js";
import { theilSen } from "./theilsen.js";
/** Autocorrelation at lags 0…maxLag, normalized by n (as in pymannkendall). */
function acf(xs, maxLag) {
    const m = mean(xs);
    const y = xs.map((x) => x - m);
    const n = y.length;
    const cov = (lag) => {
        let s = 0;
        for (let t = 0; t + lag < n; t++)
            s += y[t] * y[t + lag];
        return s / n;
    };
    const c0 = cov(0);
    return Array.from({ length: maxLag + 1 }, (_, lag) => cov(lag) / c0);
}
/**
 * Mann–Kendall trend test. With `hamedRao` (default) the variance is inflated
 * for significant autocorrelation of the detrended ranks (Hamed & Rao 1998),
 * following pymannkendall's `hamed_rao_modification_test`. Monthly pageviews
 * are autocorrelated, and the plain test then overstates significance.
 */
export function mannKendall(x, { hamedRao = true } = {}) {
    const n = x.length;
    if (n < 3)
        throw new Error("Mann–Kendall needs at least 3 points.");
    let s = 0;
    for (let i = 0; i < n; i++)
        for (let j = i + 1; j < n; j++)
            s += Math.sign(x[j] - x[i]);
    const ties = tieGroups(x).reduce((acc, k) => acc + k * (k - 1) * (2 * k + 5), 0);
    let varS = (n * (n - 1) * (2 * n + 5) - ties) / 18;
    if (hamedRao) {
        const { slope } = theilSen(x);
        const ranks = rank(x.map((v, i) => v - (i + 1) * slope));
        const bound = Z_95 / Math.sqrt(n);
        if (ranks.some((r) => r !== ranks[0])) {
            const rho = acf(ranks, n - 1);
            let sum = 0;
            for (let lag = 1; lag < n; lag++) {
                if (Math.abs(rho[lag]) > bound)
                    sum += (n - lag) * (n - lag - 1) * (n - lag - 2) * rho[lag];
            }
            varS *= 1 + (2 / (n * (n - 1) * (n - 2))) * sum;
        }
    }
    const z = s > 0 ? (s - 1) / Math.sqrt(varS) : s < 0 ? (s + 1) / Math.sqrt(varS) : 0;
    return { s, varS, z, p: twoSidedP(z), tau: s / ((n * (n - 1)) / 2) };
}
