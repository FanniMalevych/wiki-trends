import { mean, median, rollingMedian } from "./basic.js";
/** Seasonal adjustment needs three full years to tell a yearly pattern from noise. */
export const MIN_SEASONAL_MONTHS = 36;
function variance(xs) {
    const m = mean(xs);
    return xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1);
}
/**
 * Classical additive decomposition made robust: the trend is a centered
 * 13-month rolling median and each month's effect is the median of its
 * detrended values, so a one-off spike does not become "seasonality".
 * Apply to log values to get a multiplicative adjustment.
 *
 * @param firstMonth calendar month of y[0] (0 = January)
 */
export function seasonalAdjust(y, firstMonth) {
    if (y.length < MIN_SEASONAL_MONTHS)
        throw new Error(`Seasonal adjustment needs ${MIN_SEASONAL_MONTHS}+ months.`);
    const monthOf = (i) => (firstMonth + i) % 12;
    const trend = rollingMedian(y, 13);
    // Only positions with a full 13-month window give an unbiased trend.
    const byMonth = Array.from({ length: 12 }, () => []);
    const detrended = [];
    for (let i = 6; i < y.length - 6; i++) {
        const d = y[i] - trend[i];
        byMonth[monthOf(i)].push(d);
        detrended.push({ i, d });
    }
    const raw = byMonth.map((ds) => median(ds));
    const center = mean(raw);
    const effects = raw.map((e) => e - center);
    const remainder = detrended.map(({ i, d }) => d - effects[monthOf(i)]);
    const strength = Math.max(0, 1 - variance(remainder) / variance(detrended.map(({ d }) => d)));
    return { adjusted: y.map((v, i) => v - effects[monthOf(i)]), effects, strength };
}
