import { parseArgs } from "node:util";
import { Cache } from "../cache/db.js";
import { loadDataset } from "../dataset.js";
import { success } from "../output.js";
import { httpStats } from "../wiki/http.js";
import { ACCESS_VALUES, AGENT_VALUES } from "../wiki/pageviews.js";
import { oneOf, SELECTION_HELP, SELECTION_OPTIONS, selectionFrom } from "./selection.js";
export const FETCH_HELP = `Usage:
  cli.js fetch --qid <Q> --lang <codes> [options]
  cli.js fetch --title <title> --from <p> --lang <codes> [options]
  cli.js fetch --project <p> --article <title> [options]

Downloads monthly or daily pageviews (cached locally) for one topic across
editions, or for given articles, plus each edition's total views.

${SELECTION_HELP}

Options:
  --start <date>       YYYY-MM or YYYY-MM-DD (default: 24 months / 730 days ago)
  --end <date>         YYYY-MM or YYYY-MM-DD (default: last complete month / yesterday)
  --granularity <g>    monthly (default) | daily
  --access <a>         all-access (default) | desktop | mobile-app | mobile-web
  --agent <a>          user (default) | all-agents | spider | automated
  --skip-aggregate     Do not fetch edition totals
  --points             Include every [period, views] pair
  --verbose            Include cache and request details
`;
function summarize(points) {
    let total = 0;
    let zeroPeriods = 0;
    let [min, max] = [points[0], points[0]];
    for (const p of points) {
        total += p.views;
        if (p.views === 0)
            zeroPeriods++;
        if (p.views < min.views)
            min = p;
        if (p.views > max.views)
            max = p;
    }
    return {
        periods: points.length,
        total,
        mean: Math.round((total / points.length) * 10) / 10,
        first: points[0],
        last: points.at(-1),
        min,
        max,
        zeroPeriods,
    };
}
export async function fetchCommand(argv, now = Date.now()) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            ...SELECTION_OPTIONS,
            start: { type: "string" },
            end: { type: "string" },
            granularity: { type: "string", default: "monthly" },
            access: { type: "string", default: "all-access" },
            agent: { type: "string", default: "user" },
            "skip-aggregate": { type: "boolean", default: false },
            points: { type: "boolean", default: false },
            verbose: { type: "boolean", default: false },
        },
    });
    const selection = selectionFrom(values);
    if ("articles" in selection && selection.articles.length === 0 && values["skip-aggregate"]) {
        throw new Error("Nothing to fetch: give --article or drop --skip-aggregate.");
    }
    const cache = new Cache();
    const before = httpStats();
    try {
        const d = await loadDataset(cache, selection, {
            granularity: oneOf("granularity", values.granularity, ["monthly", "daily"]),
            access: oneOf("access", values.access, ACCESS_VALUES),
            agent: oneOf("agent", values.agent, AGENT_VALUES),
            start: values.start,
            end: values.end,
            aggregates: !values["skip-aggregate"],
        }, now);
        const details = (s) => ({
            ...(values.points && { points: s.points.map((p) => [p.period, p.views]) }),
            ...(values.verbose && { source: { cached: s.cachedPeriods, fetched: s.fetchedPeriods } }),
        });
        const after = httpStats();
        return success({
            ...(d.qid !== null && { qid: d.qid, label: d.label }),
            granularity: d.granularity,
            start: d.start,
            end: d.end,
            access: d.access,
            agent: d.agent,
            articles: d.articles.map((a) => ({
                project: a.project,
                article: a.article,
                ...(a.redirectedFrom !== null && { redirectedFrom: a.redirectedFrom }),
                ...summarize(a.points),
                ...details(a),
            })),
            aggregates: d.aggregates.map((g) => ({ project: g.project, ...summarize(g.points), ...details(g) })),
            ...(d.missing.length > 0 && { missing: d.missing }),
            ...(values.verbose && {
                requests: after.network + after.replayed - before.network - before.replayed,
                cacheFile: cache.path,
            }),
        }, d.warnings);
    }
    finally {
        cache.close();
    }
}
