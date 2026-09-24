import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeEdition, loadKnownEvents, rankEditions } from "../../scripts/dist/analysis.js";
import { enumeratePeriods } from "../../scripts/dist/wiki/periods.js";

const EVENTS = [{ period: "2025-05", label: "test measurement change", note: "raw counts differ." }];

/** Deterministic pseudo-random normal noise. */
function noise(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (1664525 * s + 1013904223) >>> 0) + 1) / 4294967297;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

/**
 * Builds an article and its edition total. `share(i)` is the article's views per
 * million edition views in month i; the edition total can change independently.
 */
function series({ start = "2021-09", months = 60, share, total = () => 50e6 }) {
  const periods = enumeratePeriods(start, enumeratePeriods(start, "2099-12", "monthly")[months - 1], "monthly");
  const totals = periods.map((_, i) => Math.round(total(i)));
  const views = periods.map((_, i) => Math.max(0, Math.round((share(i) * totals[i]) / 1e6)));
  const pts = (vals) => periods.map((period, i) => ({ period, views: vals[i] }));
  return [
    { project: "xx.wikipedia", article: "Topic", redirectedFrom: null, redirects: [], redirectViews: 0, points: pts(views), cachedPeriods: 0, fetchedPeriods: 0 },
    { project: "xx.wikipedia", points: pts(totals), cachedPeriods: 0, fetchedPeriods: 0 },
  ];
}

const yearly = (i, amp = 0.3) => Math.exp(amp * Math.cos((2 * Math.PI * (i - 0)) / 12));

test("a steady +20%/yr trend with seasonality and noise is found with high confidence", () => {
  const rnd = noise(1);
  const [a, g] = series({ share: (i) => 100 * 1.2 ** (i / 12) * yearly(i) * Math.exp(0.05 * rnd()) });
  const r = analyzeEdition(a, g, EVENTS.slice(0, 0));
  assert.equal(r.trend.direction, "growing");
  assert.ok(Math.abs(r.trend.perYear - 20) < 3, `perYear ${r.trend.perYear}`);
  assert.ok(r.trend.ci95[0] < 20 && r.trend.ci95[1] > 20);
  assert.ok(r.seasonality.strength > 0.8);
  assert.equal(r.confidence.level, "high", r.confidence.reasons.join(" | "));
  assert.match(r.summary, /growing about \+2\d%\/yr/);
});

test("interest measured as a share ignores a shrinking edition", () => {
  const rnd = noise(2);
  // The edition loses 30% of its traffic per year; the topic's share is flat.
  const [a, g] = series({ share: (i) => 200 * Math.exp(0.05 * rnd()), total: (i) => 50e6 * 0.7 ** (i / 12) });
  const r = analyzeEdition(a, g, []);
  assert.equal(r.trend.direction, "stable");
  assert.ok(r.trend.rawViewsPerYear < -25, `raw ${r.trend.rawViewsPerYear}`);
  assert.ok(r.confidence.reasons.some((x) => /edition's total traffic shifted/.test(x)));
});

test("low-traffic noise gives no clear trend and low confidence", () => {
  const rnd = noise(3);
  const [a, g] = series({ share: () => 1 * Math.exp(0.6 * rnd()) }); // ~50 views/month
  const r = analyzeEdition(a, g, []);
  assert.ok(["unclear", "stable"].includes(r.trend.direction));
  assert.equal(r.confidence.level, "low");
  assert.ok(r.confidence.reasons.some((x) => /Low traffic/.test(x)));
});

test("a step at a known event is attributed to it", () => {
  const rnd = noise(4);
  const [a, g] = series({ share: (i) => 300 * (i >= 44 ? 0.55 : 1) * Math.exp(0.04 * rnd()) }); // step at 2025-05
  const r = analyzeEdition(a, g, EVENTS);
  assert.equal(r.step?.period, "2025-05");
  assert.equal(r.step.event, "test measurement change");
  assert.ok(r.step.change < -30);
});

test("spike months are reported and do not create a trend", () => {
  const rnd = noise(5);
  const [a, g] = series({ share: (i) => 300 * Math.exp(0.03 * rnd()) * (i === 30 ? 8 : 1) });
  const r = analyzeEdition(a, g, []);
  assert.deepEqual(r.spikes.map((s) => s.period), ["2024-03"]);
  assert.equal(r.trend.direction, "stable");
});

test("short histories skip seasonal adjustment and say so", () => {
  const [a, g] = series({ months: 24, share: (i) => 300 * 1.3 ** (i / 12) });
  const r = analyzeEdition(a, g, []);
  assert.equal(r.seasonality, null);
  assert.notEqual(r.confidence.level, "high");
  assert.ok(r.confidence.reasons.some((x) => /too short to separate the yearly pattern/.test(x)));
});

test("months before an article existed are excluded", () => {
  const [a, g] = series({ share: (i) => (i < 20 ? 0 : 300) });
  const r = analyzeEdition(a, g, []);
  assert.equal(r.months, 40);
  assert.ok(r.confidence.reasons.some((x) => /views only from 2023-05/.test(x)));
});

test("too little data gives no trend", () => {
  const [a, g] = series({ months: 8, share: () => 300 });
  const r = analyzeEdition(a, g, []);
  assert.equal(r.trend, null);
  assert.equal(r.confidence.level, "low");
  assert.match(r.summary, /not enough data/);
});

test("ranking puts confident growth first and decline last", () => {
  const mk = (project, direction, level, perYear) => ({
    project, monthlyViews: 1, perMillion: 1, trend: { direction, perYear }, confidence: { level },
  });
  const ranked = rankEditions([
    mk("a", "declining", "high", -20),
    mk("b", "growing", "low", 50),
    mk("c", "growing", "high", 10),
    mk("d", "stable", "high", 1),
  ]);
  assert.deepEqual(ranked.map((r) => r.project), ["c", "b", "d", "a"]);
  assert.deepEqual(ranked.map((r) => r.rank), [1, 2, 3, 4]);
});

test("the shipped known-events file loads", () => {
  const events = loadKnownEvents();
  assert.ok(events.length > 0);
  for (const e of events) assert.match(e.period, /^\d{4}-\d{2}$/);
});
