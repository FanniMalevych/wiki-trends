// `chart` and `report`: run the same analysis as `analyze`, then write files.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { EditionAnalysis } from "../analysis.js";
import type { Dataset } from "../dataset.js";
import { success, type Envelope } from "../output.js";
import { buildReport } from "../report/html.js";
import { renderChart, type Panel } from "../viz/chart.js";
import { ANALYSIS_OPTIONS, runAnalysis } from "./analyze.js";
import { SELECTION_HELP } from "./selection.js";

const COMMON_HELP = `${SELECTION_HELP}

Options:
  --months <n>         Number of months up to --end (default 60)
  --start, --end       YYYY-MM, instead of --months / last complete month
  --out <path>         Output file (default: wit-output/<topic>_<languages>_<end>.<ext>
                       in the current directory)
  --redirects, --access, --agent, --verbose   As for analyze`;

export const CHART_HELP = `Usage: cli.js chart (--title <t> --from <p> | --qid <Q>) --lang <codes> [options]

Writes an SVG chart: one panel per edition with monthly views per million edition
views, the seasonally adjusted line, the trend and spike months.

${COMMON_HELP}
`;

export const REPORT_HELP = `Usage: cli.js report (--title <t> --from <p> | --qid <Q>) --lang <codes> [options]

Writes a one-page HTML report (prints to one A4 page; save as PDF from a browser):
takeaways, chart, ranked table, reliability caveats, missing editions and method.

${COMMON_HELP}
  --note <text>        A paragraph for the "Analyst note" box, e.g. your recommendation.
                       Repeatable.
`;

function slug(d: Dataset, editions: EditionAnalysis[]): string {
  const name = (d.label ?? editions[0]?.article ?? d.qid ?? "topic")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/[\s_]+/g, "-")
    .toLowerCase()
    .slice(0, 40);
  const langs = [...editions.map((e) => e.project), ...d.missing.map((m) => m.project)].map((p) => p.split(".")[0]).join("-");
  return `${name || d.qid || "topic"}_${langs}_${d.end}`;
}

function panels(editions: EditionAnalysis[]): Panel[] {
  return editions.map((e) => ({
    title: `${e.project} · ${e.article.replaceAll("_", " ")}`,
    subtitle: e.trend
      ? `${e.trend.direction} ${e.trend.perYear > 0 ? "+" : ""}${Math.round(e.trend.perYear)}%/yr · confidence ${e.confidence.level}`
      : `no trend (too little data) · confidence ${e.confidence.level}`,
    series: e.series,
    spikes: e.spikes.map((s) => s.period),
  }));
}

function write(path: string, content: string): string {
  const file = resolve(path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
  return file;
}

/** Compact per-edition results, so the agent can describe what the file shows. */
const brief = (editions: EditionAnalysis[]) =>
  editions.map((e) => ({ project: e.project, summary: e.summary, confidence: e.confidence.level }));

export async function chartCommand(argv: string[], now = Date.now()): Promise<Envelope> {
  const { values } = parseArgs({ args: argv, strict: true, options: { ...ANALYSIS_OPTIONS, out: { type: "string" } } });
  const { dataset: d, editions, requests } = await runAnalysis(values, now);
  if (editions.length === 0) throw new Error("No edition has an article on this topic, so there is nothing to chart.");
  const title = `Interest in ${d.label ?? editions[0]!.article.replaceAll("_", " ")}, ${d.start} to ${d.end}`;
  const file = write(values.out ?? `wit-output/${slug(d, editions)}.svg`, renderChart(panels(editions), title));
  return success(
    { file, editions: brief(editions), ...(d.missing.length > 0 && { missing: d.missing.map((m) => m.project) }), ...(values.verbose && { requests }) },
    d.warnings,
  );
}

export async function reportCommand(argv: string[], now = Date.now()): Promise<Envelope> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: { ...ANALYSIS_OPTIONS, out: { type: "string" }, note: { type: "string", multiple: true } },
  });
  const { dataset: d, editions, requests } = await runAnalysis(values, now);
  const title = `Interest in ${d.label ?? editions[0]?.article.replaceAll("_", " ") ?? "topic"}, ${d.start} to ${d.end}`;
  const html = buildReport({
    dataset: d,
    editions,
    chartSvg: editions.length ? renderChart(panels(editions), title) : "",
    notes: values.note ?? [],
    generatedOn: new Date(now).toISOString().slice(0, 10),
  });
  const file = write(values.out ?? `wit-output/${slug(d, editions)}.html`, html);
  return success(
    { file, editions: brief(editions), ...(d.missing.length > 0 && { missing: d.missing.map((m) => m.project) }), ...(values.verbose && { requests }) },
    d.warnings,
  );
}
