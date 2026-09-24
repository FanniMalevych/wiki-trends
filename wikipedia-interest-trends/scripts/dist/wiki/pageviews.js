import { getJson, HttpError } from "./http.js";
import { apiRange, periodFromTimestamp } from "./periods.js";
const BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews";
export const ACCESS_VALUES = ["all-access", "desktop", "mobile-app", "mobile-web"];
export const AGENT_VALUES = ["all-agents", "user", "spider", "automated"];
/** Accepts "pl", "pl.wikipedia" or "pl.wikipedia.org" and returns "pl.wikipedia". */
export function normalizeProject(input) {
    let p = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    p = p.replace(/\.org$/, "");
    if (!p.includes("."))
        p += ".wikipedia";
    if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(p))
        throw new Error(`Invalid project "${input}". Use e.g. "pl" or "pl.wikipedia".`);
    return p;
}
/**
 * Canonical page title as the API stores it: underscores for spaces and an
 * upper-case first letter (Wikipedia capitalizes it automatically).
 */
export function normalizeTitle(input) {
    const t = input.trim().replace(/[\s_]+/g, "_").replace(/^_|_$/g, "");
    if (t === "")
        throw new Error("Article title is empty.");
    const first = String.fromCodePoint(t.codePointAt(0));
    return first.toUpperCase() + t.slice(first.length);
}
export function seriesUrl(key, start, end) {
    const range = apiRange(start, end, key.granularity);
    const tail = `${key.access}/${key.agent}`;
    const dates = `${key.granularity}/${range.start}/${range.end}`;
    return key.kind === "aggregate"
        ? `${BASE}/aggregate/${key.project}/${tail}/${dates}`
        : `${BASE}/per-article/${key.project}/${tail}/${encodeURIComponent(key.article)}/${dates}`;
}
/**
 * Fetches one contiguous range. Periods with no views are omitted by the API;
 * callers fill them with zeros. A 404 means no data at all for the range.
 */
export async function fetchRange(key, start, end) {
    const url = seriesUrl(key, start, end);
    const res = await getJson(url);
    if (res.status === 404)
        return [];
    if (res.status !== 200) {
        const detail = res.body?.detail;
        throw new HttpError(`Pageviews API returned ${res.status}${detail ? `: ${String(detail)}` : ""}`, url, res.status);
    }
    const items = res.body.items ?? [];
    return items.map((i) => ({ period: periodFromTimestamp(i.timestamp, key.granularity), views: i.views }));
}
