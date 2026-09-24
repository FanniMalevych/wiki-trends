// Turns an article's monthly views and its edition's total views into a trend
// estimate with a confidence score and plain-language reasons.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AggregateData, ArticleData } from "./dataset.js";
import { SKILL_ROOT } from "./meta.js";
import { detectSpikes, detectStep } from "./stats/anomalies.js";
import { mean } from "./stats/basic.js";
import { mannKendall } from "./stats/mannkendall.js";
import { MIN_SEASONAL_MONTHS, seasonalAdjust } from "./stats/seasonal.js";
import { theilSen } from "./stats/theilsen.js";
import { shiftPeriod } from "./wiki/periods.js";

export const MIN_TREND_MONTHS = 12;
/** Changes smaller than this (in % per year, both CI bounds) count as "stable". */
const STABLE_BAND = 5;

export interface KnownEvent {
  period: string;
  label: string;
  note: string;
}

export type Direction = "growing" | "declining" | "stable" | "unclear";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface EditionAnalysis {
  project: string;
  article: string;
  months: number;
  /** Mean article views per month over the last 12 months. */
  monthlyViews: number;
  /** Article views per million edition views over the last 12 months. */
  perMillion: number;
  /** Trend of the seasonally adjusted share of edition views, in % per year. */
  trend: { direction: Direction; perYear: number; ci95: [number, number]; p: number; rawViewsPerYear: number } | null;
  /** Last 12 months vs the 12 before, in %. */
  yoy: { share: number; views: number } | null;
  seasonality: { strength: number; peak: string; low: string } | null;
  spikes: Array<{ period: string; ratio: number }>;
  step: { period: string; change: number; event: string | null } | null;
  confidence: { level: ConfidenceLevel; score: number; reasons: string[] };
  summary: string;
}

export function loadKnownEvents(): KnownEvent[] {
  return (JSON.parse(readFileSync(join(SKILL_ROOT, "assets", "known-events.json"), "utf8")) as { events: KnownEvent[] }).events;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const round1 = (x: number) => Math.round(x * 10) / 10;
const round2 = (x: number) => Math.round(x * 100) / 100;
/** A log-scale change as a percentage. */
const pct = (logRatio: number) => (Math.exp(logRatio) - 1) * 100;
const signed = (x: number) => {
  const r = Math.round(x);
  return r === 0 ? "0%" : `${r > 0 ? "+" : "−"}${Math.abs(r)}%`;
};
const sum = (xs: readonly number[]) => xs.reduce((s, x) => s + x, 0);

function levelOf(score: number): ConfidenceLevel {
  return score >= 70 ? "high" : score >= 40 ? "medium" : "low";
}

function directionOf(perYear: number, ci: [number, number], p: number): Direction {
  if (p < 0.05 && ci[0] > 0) return "growing";
  if (p < 0.05 && ci[1] < 0) return "declining";
  if (ci[0] > -STABLE_BAND && ci[1] < STABLE_BAND) return "stable";
  return "unclear";
}

function describe(a: Pick<EditionAnalysis, "project" | "article" | "trend">, level: ConfidenceLevel): string {
  const who = `${a.project} "${a.article.replaceAll("_", " ")}"`;
  if (!a.trend) return `${who}: not enough data for a trend; confidence ${level}.`;
  const { direction, perYear, ci95 } = a.trend;
  const range = `95% CI ${signed(ci95[0])} to ${signed(ci95[1])}`;
  const phrase = {
    growing: `interest growing about ${signed(perYear)}/yr (${range}) relative to all traffic in this edition`,
    declining: `interest declining about ${signed(perYear)}/yr (${range}) relative to all traffic in this edition`,
    stable: `interest roughly stable (${range}/yr)`,
    unclear: `no clear trend (estimate ${signed(perYear)}/yr, ${range})`,
  }[direction];
  return `${who}: ${phrase}; confidence ${level}.`;
}

export function analyzeEdition(article: ArticleData, aggregate: AggregateData, events: KnownEvent[]): EditionAnalysis {
  const totals = new Map(aggregate.points.map((p) => [p.period, p.views]));
  const reasons: string[] = [];
  let score = 100;
  const penalize = (points: number, reason: string) => {
    score -= points;
    reasons.push(reason);
  };

  // Months before the article's first view are before it existed.
  const first = Math.max(0, article.points.findIndex((p) => p.views > 0));
  const points = article.points.slice(first);
  if (first > 0) reasons.push(`The article has views only from ${points[0]!.period}; earlier months are excluded.`);
  const periods = points.map((p) => p.period);
  const views = points.map((p) => p.views);
  const total = periods.map((p) => totals.get(p) ?? 0);
  const n = points.length;

  const recent = views.slice(-12);
  const base = {
    project: article.project,
    article: article.article,
    months: n,
    monthlyViews: Math.round(mean(recent)),
    perMillion: round2((sum(recent) / Math.max(1, sum(total.slice(-12)))) * 1e6),
  };

  if (n < MIN_TREND_MONTHS || sum(views) === 0) {
    penalize(80, `Only ${sum(views) === 0 ? 0 : n} months with data; a trend needs at least ${MIN_TREND_MONTHS}.`);
    const level = levelOf(score);
    const empty = { ...base, trend: null, yoy: null, seasonality: null, spikes: [], step: null };
    return { ...empty, confidence: { level, score: Math.max(0, score), reasons }, summary: describe(empty, level) };
  }

  // Work on log scale: growth becomes % per year and editions of any size compare.
  // The share of edition views cancels edition-wide swings (bot filtering, search changes).
  const share = views.map((v, i) => Math.log(((v + 0.5) / total[i]!) * 1e6));
  const raw = views.map((v) => Math.log(v + 0.5));
  const firstMonth = Number(periods[0]!.slice(5, 7)) - 1;

  let adjusted = share;
  let rawAdjusted = raw;
  let seasonality: EditionAnalysis["seasonality"] = null;
  if (n >= MIN_SEASONAL_MONTHS) {
    const s = seasonalAdjust(share, firstMonth);
    adjusted = s.adjusted;
    rawAdjusted = seasonalAdjust(raw, firstMonth).adjusted;
    const byEffect = s.effects.map((e, m) => [e, m] as const).sort((a, b) => b[0] - a[0]);
    seasonality = { strength: round2(s.strength), peak: MONTHS[byEffect[0]![1]]!, low: MONTHS[byEffect.at(-1)![1]]! };
  } else {
    penalize(25, `Only ${n} months: too short to separate the yearly pattern from the trend (needs ${MIN_SEASONAL_MONTHS}).`);
  }

  // Trend and its reliability.
  const mk = mannKendall(adjusted);
  const ts = theilSen(adjusted, { varS: mk.varS }); // interval consistent with the autocorrelation-corrected test
  const perYear = pct(12 * ts.slope);
  const ci95: [number, number] = [pct(12 * ts.low), pct(12 * ts.high)];
  const direction = directionOf(perYear, ci95, mk.p);
  const rawViewsPerYear = pct(12 * theilSen(rawAdjusted).slope);
  reasons.unshift(
    `${n} months of data${seasonality ? ", seasonally adjusted" : ""}; trend of the share of edition views ` +
      `(Theil–Sen ${signed(perYear)}/yr, Mann–Kendall p ${mk.p < 0.001 ? "< 0.001" : `= ${mk.p.toFixed(3)}`}).`,
  );

  if (base.monthlyViews < 100) penalize(30, `Low traffic (about ${base.monthlyViews} views/month): random noise is large.`);
  else if (base.monthlyViews < 1000) penalize(10, `Modest traffic (about ${base.monthlyViews} views/month).`);

  if (direction === "unclear") {
    penalize(35, `No clear direction: the 95% CI runs from ${signed(ci95[0])} to ${signed(ci95[1])} per year.`);
  } else if (direction !== "stable" && mk.p >= 0.01) {
    penalize(10, `The trend is only moderately significant (p = ${mk.p.toFixed(3)}).`);
  }

  // One-off spikes: the trend method is robust to them, but a topic driven by
  // news bursts is a weaker signal of steady interest.
  const spikes = detectSpikes(adjusted).filter((s) => s.z > 0);
  const spikeViews = sum(spikes.map((s) => views[s.index]! * (1 - Math.exp(-s.excess))));
  const spikeShare = spikeViews / sum(views);
  if (spikes.length) {
    const list = spikes.slice(0, 3).map((s) => `${periods[s.index]} (${Math.exp(s.excess).toFixed(1)}×)`).join(", ");
    const text = `${spikes.length} spike month(s), e.g. ${list}, account for ${Math.round(spikeShare * 100)}% of views`;
    if (spikeShare > 0.2) penalize(20, `${text}: interest is driven by bursts.`);
    else if (spikeShare > 0.1) penalize(10, `${text}.`);
    else reasons.push(`${text}; the trend estimate is robust to them.`);
  }

  // A sudden level change: renames, merges, links from popular pages, measurement changes.
  const found = detectStep(adjusted);
  let step: EditionAnalysis["step"] = null;
  if (found) {
    const period = periods[found.index]!;
    const event = events.find((e) => [-1, 0, 1].some((d) => shiftPeriod(e.period, "monthly", d) === period));
    step = { period, change: round1(pct(found.shift)), event: event?.label ?? null };
    penalize(
      event ? 10 : 20,
      `Sudden level change in ${period} (${signed(step.change)} relative to the trend)` +
        (event
          ? `, matching the ${event.label}.`
          : ": check for a real-world event, an article rename or merge, or a new link from a popular page."),
    );
  }

  if (Math.sign(perYear) !== Math.sign(rawViewsPerYear) && Math.abs(perYear - rawViewsPerYear) > 10) {
    penalize(
      5,
      `Raw views change ${signed(rawViewsPerYear)}/yr while the share changes ${signed(perYear)}/yr: the edition's total traffic shifted, so the share is the better measure of interest.`,
    );
  }

  let yoy: EditionAnalysis["yoy"] = null;
  if (n >= 24) {
    const shareOf = (from: number, to: number) => sum(views.slice(from, to)) / sum(total.slice(from, to));
    yoy = {
      share: round1((shareOf(n - 12, n) / shareOf(n - 24, n - 12) - 1) * 100),
      views: round1((sum(views.slice(n - 12)) / Math.max(1, sum(views.slice(n - 24, n - 12))) - 1) * 100),
    };
    const against = (direction === "growing" && yoy.share < -5) || (direction === "declining" && yoy.share > 5);
    if (against) penalize(15, `The last 12 months moved against the trend (${signed(yoy.share)} vs the year before): the trend may be changing.`);
  }

  for (const e of events) {
    const after = periods.filter((p) => p >= e.period).length;
    if (after > 0 && after < n) {
      penalize(5, `${after} of ${n} months fall after the ${e.label} (${e.period}): ${e.note}`);
    }
  }

  // "No clear direction" is never a finding to act on with confidence, and
  // without seasonal adjustment the trend can partly be the yearly pattern.
  const cap = direction === "unclear" ? 39 : seasonality ? 100 : 69;
  score = Math.max(0, Math.min(cap, score));
  const level = levelOf(score);
  const result = {
    ...base,
    trend: { direction, perYear: round1(perYear), ci95: [round1(ci95[0]), round1(ci95[1])] as [number, number], p: Number(mk.p.toPrecision(3)), rawViewsPerYear: round1(rawViewsPerYear) },
    yoy,
    seasonality,
    spikes: spikes.map((s) => ({ period: periods[s.index]!, ratio: round2(Math.exp(s.excess)) })),
    step,
  };
  return { ...result, confidence: { level, score, reasons }, summary: describe(result, level) };
}

const DIRECTION_ORDER: Record<Direction, number> = { growing: 0, stable: 1, unclear: 2, declining: 3 };
const LEVEL_ORDER: Record<ConfidenceLevel, number> = { high: 0, medium: 1, low: 2 };

/**
 * Orders editions for "which audience to look at next": growing before stable
 * before unclear before declining, then by confidence, then by growth rate.
 */
export function rankEditions(analyses: EditionAnalysis[]) {
  return analyses
    .toSorted(
      (a, b) =>
        DIRECTION_ORDER[a.trend?.direction ?? "unclear"] - DIRECTION_ORDER[b.trend?.direction ?? "unclear"] ||
        LEVEL_ORDER[a.confidence.level] - LEVEL_ORDER[b.confidence.level] ||
        (b.trend?.perYear ?? 0) - (a.trend?.perYear ?? 0),
    )
    .map((a, i) => ({
      rank: i + 1,
      project: a.project,
      direction: a.trend?.direction ?? "unclear",
      perYear: a.trend?.perYear ?? null,
      confidence: a.confidence.level,
      monthlyViews: a.monthlyViews,
      perMillion: a.perMillion,
    }));
}
