import { parseArgs } from "node:util";
import { analyzeEdition, loadKnownEvents, rankEditions } from "../analysis.js";
import { Cache } from "../cache/db.js";
import { loadDataset } from "../dataset.js";
import { success } from "../output.js";
import { httpStats } from "../wiki/http.js";
import { ACCESS_VALUES, AGENT_VALUES } from "../wiki/pageviews.js";
import { lastCompletePeriod, shiftPeriod } from "../wiki/periods.js";
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
  --start <month>      YYYY-MM (default: ${DEFAULT_MONTHS} months before the last complete month)
  --end <month>        YYYY-MM (default: last complete month)
  --redirects <n>      Also count views of each article's n most-viewed redirects (default 0)
  --access <a>         all-access (default) | desktop | mobile-app | mobile-web
  --agent <a>          user (default) | all-agents | spider | automated
  --verbose            Include request details

Per edition: trend.direction (growing | declining | stable | unclear),
trend.perYear and ci95 (% per year), yoy (%), confidence.level (high |
medium | low) with confidence.reasons, and a one-line summary.
`;
export async function analyzeCommand(argv, now = Date.now()) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            ...SELECTION_OPTIONS,
            start: { type: "string" },
            end: { type: "string" },
            redirects: { type: "string", default: "0" },
            access: { type: "string", default: "all-access" },
            agent: { type: "string", default: "user" },
            verbose: { type: "boolean", default: false },
        },
    });
    const selection = selectionFrom(values);
    const cache = new Cache();
    const before = httpStats();
    try {
        const d = await loadDataset(cache, selection, {
            granularity: "monthly",
            access: oneOf("access", values.access, ACCESS_VALUES),
            agent: oneOf("agent", values.agent, AGENT_VALUES),
            start: values.start ?? shiftPeriod(lastCompletePeriod("monthly", now), "monthly", -(DEFAULT_MONTHS - 1)),
            end: values.end,
            redirects: count("redirects", values.redirects),
            aggregates: true,
        }, now);
        const events = loadKnownEvents();
        const totals = new Map(d.aggregates.map((g) => [g.project, g]));
        const editions = d.articles.map((a) => analyzeEdition(a, totals.get(a.project), events));
        const after = httpStats();
        return success({
            ...(d.qid !== null && { qid: d.qid, label: d.label }),
            start: d.start,
            end: d.end,
            editions,
            ...(editions.length > 1 && { ranking: rankEditions(editions) }),
            ...(d.missing.length > 0 && { missing: d.missing }),
            ...(values.verbose && { requests: after.network + after.replayed - before.network - before.replayed }),
        }, d.warnings);
    }
    finally {
        cache.close();
    }
}
