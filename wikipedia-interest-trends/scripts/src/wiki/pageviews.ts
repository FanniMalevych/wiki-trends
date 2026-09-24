import { getJson, HttpError } from "./http.js";
import { apiRange, periodFromTimestamp, type Granularity } from "./periods.js";

const BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews";

export const ACCESS_VALUES = ["all-access", "desktop", "mobile-app", "mobile-web"] as const;
export const AGENT_VALUES = ["all-agents", "user", "spider", "automated"] as const;
export type Access = (typeof ACCESS_VALUES)[number];
export type Agent = (typeof AGENT_VALUES)[number];

/** Identifies one time series: an article's views, or an edition's total views ("aggregate"). */
export interface SeriesKey {
  kind: "article" | "aggregate";
  project: string;
  article: string; // "" for aggregate
  access: Access;
  agent: Agent;
  granularity: Granularity;
}

export interface Point {
  period: string;
  views: number;
}

/**
 * Accepts "pl", "pl.wikipedia", "pl.wikipedia.org" or a Wikipedia URL and returns
 * "pl.wikipedia". Only Wikipedia is supported: title handling and the Wikidata
 * mapping assume Wikipedia's conventions (e.g. Wiktionary keeps lower-case titles).
 */
export function normalizeProject(input: string): string {
  const host = input.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/[/?#].*$/, "").replace(/\.org$/, "");
  const lang = host.endsWith(".wikipedia") ? host.slice(0, -".wikipedia".length) : host;
  if (!/^[a-z][a-z0-9-]*$/.test(lang)) {
    throw new Error(`Invalid edition "${input}". Use a Wikipedia language code such as "pl" or "pl.wikipedia".`);
  }
  return `${lang}.wikipedia`;
}

/**
 * Canonical page title as the API stores it: underscores for spaces and an
 * upper-case first letter (Wikipedia capitalizes it automatically).
 */
export function normalizeTitle(input: string): string {
  const t = input.trim().replace(/[\s_]+/g, "_").replace(/^_|_$/g, "");
  if (t === "") throw new Error("Article title is empty.");
  const first = String.fromCodePoint(t.codePointAt(0)!);
  return first.toUpperCase() + t.slice(first.length);
}

export function seriesUrl(key: SeriesKey, start: string, end: string): string {
  const range = apiRange(start, end, key.granularity);
  const tail = `${key.access}/${key.agent}`;
  const dates = `${key.granularity}/${range.start}/${range.end}`;
  return key.kind === "aggregate"
    ? `${BASE}/aggregate/${key.project}/${tail}/${dates}`
    : `${BASE}/per-article/${key.project}/${tail}/${encodeURIComponent(key.article)}/${dates}`;
}

interface ApiItem {
  timestamp: string;
  views: number;
}

/**
 * Fetches one contiguous range. Periods with no views are omitted by the API;
 * callers fill them with zeros. A 404 means no data at all for the range.
 */
export async function fetchRange(key: SeriesKey, start: string, end: string): Promise<Point[]> {
  const url = seriesUrl(key, start, end);
  const res = await getJson(url);
  if (res.status === 404) return [];
  if (res.status !== 200) {
    const detail = (res.body as { detail?: unknown } | null)?.detail;
    throw new HttpError(`Pageviews API returned ${res.status}${detail ? `: ${String(detail)}` : ""}`, url, res.status);
  }
  const items = (res.body as { items?: ApiItem[] }).items ?? [];
  return items.map((i) => ({ period: periodFromTimestamp(i.timestamp, key.granularity), views: i.views }));
}
