// A self-contained one-page HTML report: takeaways, chart, table, caveats and
// method. Prints to a single A4 page (use the browser's "Save as PDF").
import { rankEditions, type EditionAnalysis } from "../analysis.js";
import type { Dataset } from "../dataset.js";
import { VERSION } from "../meta.js";

export interface ReportInput {
  dataset: Dataset;
  editions: EditionAnalysis[];
  chartSvg: string;
  /** Optional paragraphs written by the agent or analyst, shown as "Analyst note". */
  notes: string[];
  generatedOn: string;
}

const esc = (s: string) => s.replace(/[<>&"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[c]!);
const pct = (x: number) => {
  const r = Math.round(x);
  return `${r > 0 ? "+" : r < 0 ? "−" : ""}${Math.abs(r)}%`;
};
const display = (title: string) => title.replaceAll("_", " ");
const articleUrl = (project: string, title: string) => `https://${project}.org/wiki/${encodeURIComponent(title)}`;

const CSS = `
:root { color-scheme: light dark; --bg: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --rule: #e6e5e1; --panel: #f4f3f0;
  --accent: #2a78d6; font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { :root { --bg: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --rule: #383835;
  --panel: #242423; --accent: #3987e5; } }
body { background: var(--bg); color: var(--ink); margin: 0; }
main { max-width: 760px; margin: 0 auto; padding: 24px 16px 40px; }
h1 { font-size: 22px; margin: 0 0 4px; line-height: 1.2; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--ink-2); margin: 18px 0 6px; }
.meta, .small { color: var(--ink-2); font-size: 12px; }
.note { background: var(--panel); border-left: 3px solid var(--accent); padding: 8px 12px; margin: 12px 0 0; }
.note p { margin: 0 0 6px; } .note p:last-child { margin: 0; }
ul { margin: 0; padding-left: 18px; } li { margin: 2px 0; }
.chart svg { width: 100%; height: auto; display: block; }
table { width: 100%; border-collapse: collapse; font-size: 12px; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--rule); vertical-align: top; }
th { color: var(--ink-2); font-weight: 600; } td.num, th.num { text-align: right; }
a { color: inherit; }
.level { font-weight: 600; }
footer { margin-top: 18px; border-top: 1px solid var(--rule); padding-top: 8px; }
@page { size: A4; margin: 11mm; }
@media print {
  :root { --bg: #fff; --ink: #000; --ink-2: #444; --rule: #ccc; --panel: #f3f3f3; font-size: 10.5px; }
  main { max-width: none; padding: 0; } h1 { font-size: 18px; } h2 { margin-top: 10px; }
  section, table, .chart { break-inside: avoid; }
}
`;

export function buildReport({ dataset: d, editions, chartSvg, notes, generatedOn }: ReportInput): string {
  const topic = d.label ?? (editions[0] ? display(editions[0].article) : "the selected articles");
  const languages = [...editions.map((e) => e.project), ...d.missing.map((m) => m.project)];
  const ranked = editions.length > 1 ? rankEditions(editions) : null;
  const order = ranked ? ranked.map((r) => editions.find((e) => e.project === r.project)!) : editions;

  const takeaways = order.map((e) => `<li>${esc(e.summary)}</li>`).join("");
  const gaps = d.missing.map((m) => `<li><b>${esc(m.project)}</b>: ${esc(m.note ?? "no article")}</li>`).join("");

  const rows = order
    .map((e, i) => {
      const t = e.trend;
      return (
        "<tr>" +
        (ranked ? `<td class="num">${i + 1}</td>` : "") +
        `<td>${esc(e.project)}<br><a class="small" href="${articleUrl(e.project, e.article)}">${esc(display(e.article))}</a></td>` +
        `<td>${t ? esc(t.direction) : "–"}</td>` +
        `<td class="num">${t ? `${pct(t.perYear)}<br><span class="small">${pct(t.ci95[0])} to ${pct(t.ci95[1])}</span>` : "–"}</td>` +
        `<td><span class="level">${esc(e.confidence.level)}</span> <span class="small">(${e.confidence.score})</span></td>` +
        `<td class="num">${e.monthlyViews.toLocaleString("en-US")}</td>` +
        `<td class="num">${e.perMillion}</td>` +
        `<td class="num">${e.yoy ? pct(e.yoy.share) : "–"}</td>` +
        "</tr>"
      );
    })
    .join("");

  // The first reason restates the method; the next two are the most useful caveats.
  const reliability = order
    .map((e) => `<li><b>${esc(e.project)}</b>: ${e.confidence.reasons.slice(1, 3).map(esc).join(" ") || "No specific caveats."}</li>`)
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(`Interest in ${topic}`)}</title>
<style>${CSS}</style>
</head>
<body>
<main>
<header>
  <h1>Interest in ${esc(topic)} on Wikipedia</h1>
  <div class="meta">${esc(languages.join(", "))} · ${d.start} to ${d.end} · generated ${generatedOn}${d.qid ? ` · Wikidata ${esc(d.qid)}` : ""}</div>
  ${notes.length ? `<div class="note"><b>Analyst note</b>${notes.map((n) => `<p>${esc(n)}</p>`).join("")}</div>` : ""}
</header>
<section><h2>Takeaways</h2><ul>${takeaways || "<li>No edition has an article on this topic.</li>"}</ul></section>
${editions.length ? `<section class="chart"><h2>Share of each edition's views</h2>${chartSvg}</section>` : ""}
${
  editions.length
    ? `<section><h2>By edition${ranked ? ", ranked for follow-up" : ""}</h2><table>
<thead><tr>${ranked ? '<th class="num">#</th>' : ""}<th>Edition / article</th><th>Direction</th><th class="num">Trend / yr<br><span class="small">95% CI</span></th><th>Confidence</th><th class="num">Views / month</th><th class="num">Per million</th><th class="num">Last 12 mo vs prior</th></tr></thead>
<tbody>${rows}</tbody></table></section>`
    : ""
}
${editions.length ? `<section><h2>How far to trust it</h2><ul>${reliability}</ul></section>` : ""}
${gaps ? `<section><h2>Not covered</h2><ul>${gaps}</ul></section>` : ""}
<footer class="small">
  <b>Method.</b> Monthly human pageviews from the Wikimedia Pageviews API, divided by each edition's total views so that
  edition-wide changes (search and AI answer engines, bot filtering) do not create trends. With 36+ months the yearly
  pattern is removed; the trend is a Theil–Sen slope with a Mann–Kendall test corrected for autocorrelation (Hamed–Rao).
  <b>Pageviews measure attention, not willingness to pay</b>: use this to choose what to validate next.
  Wikimedia's May 2025 bot-detection change lowered raw counts; shares are affected much less.
  Generated by wikipedia-interest-trends ${VERSION}.
</footer>
</main>
</body>
</html>
`;
}
