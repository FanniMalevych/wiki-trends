import { parseArgs } from "node:util";
import { analyzeEdition, loadKnownEvents, rankEditions } from "../analysis.js";
import { Cache } from "../cache/db.js";
import { loadDataset } from "../dataset.js";
import { success } from "../output.js";
import { httpStats } from "../wiki/http.js";
import { ACCESS_VALUES, AGENT_VALUES } from "../wiki/pageviews.js";
import { lastCompletePeriod, shiftPeriod, toPeriod } from "../wiki/periods.js";
import { count, oneOf, SELECTION_HELP, SELECTION_OPTIONS, selectionFrom } from "./selection.js";
const DEFAULT_MONTHS = 60;
export const ANALYZE_HELP = `Usage:
  cli.js analyze --title <title> --from <p> --lang <codes> [options]
  cli.js analyze --qid <Q> --lang <codes> [options]
  cli.js analyze --project <p> --article <title> [options]

Estimates whether interest in a topic is growing in each edition and how far
the trend can be trusted. Uses monthly views as a share of the edition's total
views, seasonally adjusted. With several editions, also ranks them.

${SELECTION_HELP}

Options:
  --months <n>         Number of months up to --end (default ${DEFAULT_MONTHS}), e.g. 24 for "the last two years"
  --start <month>      YYYY-MM, instead of --months
  --end <month>        YYYY-MM (default: last complete month)
  --redirects <n>      Also count views of each article's n most-viewed redirects (default 0)
  --access <a>         all-access (default) | desktop | mobile-app | mobile-web
  --agent <a>          user (default) | all-agents | spider | automated
  --verbose            Include request details

Per edition: trend.direction (growing | declining | stable | unclear),
trend.perYear and ci95 (% per year), yoy (%), confidence.level (high |
medium | low) with confidence.reasons, and a one-line summary.
`;
/** Options shared by every command that analyzes a topic (analyze, chart, report). */
export const ANALYSIS_OPTIONS = {
    ...SELECTION_OPTIONS,
    months: { type: "string" },
    start: { type: "string" },
    end: { type: "string" },
    redirects: { type: "string", default: "0" },
    access: { type: "string", default: "all-access" },
    agent: { type: "string", default: "user" },
    verbose: { type: "boolean", default: false },
};
/** Loads the data for the selected topic or articles and analyzes each edition. */
export async function runAnalysis(values, now) {
    const selection = selectionFrom(values);
    if (values.months !== undefined && values.start !== undefined)
        throw new Error("Use either --months or --start, not both.");
    const months = values.months === undefined ? DEFAULT_MONTHS : count("months", values.months);
    if (months < 1)
        throw new Error("--months must be at least 1.");
    const end = values.end ? toPeriod(values.end, "monthly", "end") : lastCompletePeriod("monthly", now);
    const cache = new Cache();
    const before = httpStats();
    try {
        const dataset = await loadDataset(cache, selection, {
            granularity: "monthly",
            access: oneOf("access", values.access, ACCESS_VALUES),
            agent: oneOf("agent", values.agent, AGENT_VALUES),
            start: values.start ?? shiftPeriod(end, "monthly", -(months - 1)),
            end: values.end,
            redirects: count("redirects", values.redirects),
            aggregates: true,
        }, now);
        const events = loadKnownEvents();
        const totals = new Map(dataset.aggregates.map((g) => [g.project, g]));
        const editions = dataset.articles.map((a) => analyzeEdition(a, totals.get(a.project), events));
        const after = httpStats();
        return { dataset, editions, requests: after.network + after.replayed - before.network - before.replayed };
    }
    finally {
        cache.close();
    }
}
export async function analyzeCommand(argv, now = Date.now()) {
    const { values } = parseArgs({ args: argv, strict: true, options: ANALYSIS_OPTIONS });
    const { dataset: d, editions, requests } = await runAnalysis(values, now);
    return success({
        ...(d.qid !== null && { qid: d.qid, label: d.label }),
        start: d.start,
        end: d.end,
        editions: editions.map(({ series: _, ...analysis }) => analysis),
        ...(editions.length > 1 && { ranking: rankEditions(editions) }),
        ...(d.missing.length > 0 && { missing: d.missing }),
        ...(values.verbose && { requests }),
    }, d.warnings);
}
