import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReport } from "../../scripts/dist/report/html.js";
import { renderChart } from "../../scripts/dist/viz/chart.js";

const periods = Array.from({ length: 40 }, (_, i) => `${2023 + Math.floor((i + 8) / 12)}-${String(((i + 8) % 12) + 1).padStart(2, "0")}`);
const series = (scale) => ({
  periods,
  perMillion: periods.map((_, i) => scale * (1 + 0.3 * Math.sin(i))),
  adjusted: periods.map(() => scale),
  trend: periods.map((_, i) => scale * (1 + i / 100)),
});
const panel = (title, scale, spikes = []) => ({ title, subtitle: "growing +12%/yr · confidence high", series: series(scale), spikes });

test("chart draws one panel per edition with its own scale, legend and hover titles", () => {
  const svg = renderChart([panel("cs.wikipedia · A", 3, [periods[5]]), panel("uk.wikipedia · <B & C>", 300)], "Title");
  assert.match(svg, /^<svg[^>]+viewBox="0 0 704 /);
  assert.equal((svg.match(/class="title"/g) ?? []).length, 2);
  assert.equal((svg.match(/class="spike"/g) ?? []).length, 2); // one marker + one legend key
  assert.equal((svg.match(/<rect class="hit"/g) ?? []).length, 2 * periods.length);
  assert.match(svg, /uk\.wikipedia · &lt;B &amp; C&gt;/); // escaped
  const ticks = [...svg.matchAll(/text-anchor="end">([^<]+)</g)].map((m) => m[1]);
  assert.deepEqual(ticks, ["0", "1", "2", "3", "4", "5", "0", "100", "200", "300", "400", "500"]); // own scale per panel, no wasted headroom
  assert.doesNotMatch(svg, /NaN|undefined|Infinity/);
});

test("chart year labels do not collide at the start", () => {
  const svg = renderChart([panel("x", 3)], "t"); // starts in September, January follows 4 months later
  const years = [...svg.matchAll(/>(20\d\d)</g)].map((m) => m[1]);
  assert.deepEqual(years, ["2024", "2025", "2026"]);
});

test("chart omits the adjusted line and legend entry for short histories", () => {
  const short = { ...panel("x", 3), series: { ...series(3), adjusted: null } };
  const svg = renderChart([short], "t");
  assert.doesNotMatch(svg, /class="adjusted"|seasonally adjusted/);
});

const edition = (project, direction, level) => ({
  project, article: "Some_Topic", months: 60, monthlyViews: 1234, perMillion: 5.5,
  trend: { direction, perYear: 12.4, ci95: [-0.3, 20], p: 0.01, rawViewsPerYear: 5 },
  yoy: { share: 8, views: 2 }, seasonality: null, spikes: [], step: null,
  confidence: { level, score: 72, reasons: ["method", "Caveat one.", "Caveat two.", "Caveat three."] },
  summary: `${project} summary`, series: series(5),
});

test("report has every section, escapes user text and ranks editions", () => {
  const html = buildReport({
    dataset: { qid: "Q1", label: "topic <x>", start: "2021-09", end: "2026-08", missing: [{ project: "pl.wikipedia", status: "missing", title: null, note: "No article." }] },
    editions: [edition("de.wikipedia", "declining", "high"), edition("cs.wikipedia", "growing", "medium")],
    chartSvg: "<svg></svg>",
    notes: ["Validate <Czech> first."],
    generatedOn: "2026-09-24",
  });
  for (const heading of ["Takeaways", "By edition, ranked for follow-up", "How far to trust it", "Not covered"]) assert.match(html, new RegExp(heading));
  assert.match(html, /Interest in topic &lt;x&gt; on Wikipedia/);
  assert.match(html, /Validate &lt;Czech&gt; first\./);
  assert.ok(html.indexOf("cs.wikipedia summary") < html.indexOf("de.wikipedia summary"), "growing ranks first");
  assert.match(html, /Caveat one\. Caveat two\./);
  assert.doesNotMatch(html, /Caveat three|>method</);
  assert.match(html, /0% to \+20%/); // −0.3 rounds to 0%, not "−0%"
  assert.match(html, /href="https:\/\/cs\.wikipedia\.org\/wiki\/Some_Topic"/);
  assert.match(html, /not willingness to pay/);
  assert.doesNotMatch(html, /<script|<link|src="http/); // self-contained, no external resources
});
