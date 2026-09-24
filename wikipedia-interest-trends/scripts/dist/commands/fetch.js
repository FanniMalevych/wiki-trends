import { parseArgs } from "node:util";
import { Cache } from "../cache/db.js";
import { failure, success } from "../output.js";
import { loadSeries } from "../series.js";
import { httpStats } from "../wiki/http.js";
import { ACCESS_VALUES, AGENT_VALUES, normalizeProject, normalizeTitle, } from "../wiki/pageviews.js";
import { defaultRange, firstAvailablePeriod, lastCompletePeriod, toPeriod } from "../wiki/periods.js";
export const FETCH_HELP = `Usage: cli.js fetch --project <p> --article <title> [options]

Downloads pageviews (cached locally) for one or more articles, plus each
edition's total views for later normalization.

Options:
  --project <p>        Edition, e.g. "cs" or "cs.wikipedia". Repeatable.
  --article <title>    Exact article title in that edition. Repeatable.
                       One project + many articles: all articles in that project.
                       N projects + N articles: paired in order.
  --start <date>       YYYY-MM or YYYY-MM-DD (default: 24 months / 730 days ago)
  --end <date>         YYYY-MM or YYYY-MM-DD (default: last complete month / yesterday)
  --granularity <g>    monthly (default) | daily
  --access <a>         all-access (default) | desktop | mobile-app | mobile-web
  --agent <a>          user (default) | all-agents | spider | automated
  --skip-aggregate     Do not fetch edition totals
  --points             Include every [period, views] pair in the output
`;
function oneOf(name, value, allowed) {
    if (allowed.includes(value))
        return value;
    throw new Error(`Invalid --${name} "${value}". Use one of: ${allowed.join(", ")}.`);
}
function pairArticles(projects, articles) {
    if (articles.length === 0)
        return [];
    if (projects.length === 1)
        return articles.map((a) => [projects[0], a]);
    if (projects.length === articles.length)
        return articles.map((a, i) => [projects[i], a]);
    throw new Error(`Got ${projects.length} --project and ${articles.length} --article values. ` +
        "Pass one --project for all articles, or one --project per --article.");
}
function summarize(result, includePoints) {
    const { key, points } = result;
    let total = 0;
    let zeroPeriods = 0;
    let min = points[0];
    let max = points[0];
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
        kind: key.kind,
        project: key.project,
        ...(key.kind === "article" ? { article: key.article } : {}),
        periods: points.length,
        total,
        mean: Math.round((total / points.length) * 10) / 10,
        first: points[0],
        last: points.at(-1),
        min,
        max,
        zeroPeriods,
        source: { cached: result.cachedPeriods, fetched: result.fetchedPeriods },
        ...(includePoints ? { points: points.map((p) => [p.period, p.views]) } : {}),
    };
}
export async function fetchCommand(argv, now = Date.now()) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            project: { type: "string", multiple: true },
            article: { type: "string", multiple: true },
            start: { type: "string" },
            end: { type: "string" },
            granularity: { type: "string", default: "monthly" },
            access: { type: "string", default: "all-access" },
            agent: { type: "string", default: "user" },
            "skip-aggregate": { type: "boolean", default: false },
            points: { type: "boolean", default: false },
        },
    });
    const granularity = oneOf("granularity", values.granularity, ["monthly", "daily"]);
    const access = oneOf("access", values.access, ACCESS_VALUES);
    const agent = oneOf("agent", values.agent, AGENT_VALUES);
    const projects = (values.project ?? []).map(normalizeProject);
    if (projects.length === 0)
        return failure(["--project is required."]);
    const pairs = pairArticles(projects, values.article ?? []).map(([p, a]) => [p, normalizeTitle(a)]);
    if (pairs.length === 0 && values["skip-aggregate"])
        return failure(["Nothing to fetch: give --article or drop --skip-aggregate."]);
    const warnings = [];
    const defaults = defaultRange(granularity, now);
    let start = values.start ? toPeriod(values.start, granularity, "start") : defaults.start;
    let end = values.end ? toPeriod(values.end, granularity, "end") : defaults.end;
    const earliest = firstAvailablePeriod(granularity);
    const latest = lastCompletePeriod(granularity, now);
    if (start < earliest) {
        warnings.push(`Start moved from ${start} to ${earliest}: pageview data begins in July 2015.`);
        start = earliest;
    }
    if (end > latest) {
        warnings.push(`End moved from ${end} to ${latest}, the last complete ${granularity === "monthly" ? "month" : "day"}.`);
        end = latest;
    }
    if (start > end)
        return failure([`Start ${start} is after end ${end}.`], warnings);
    const keys = pairs.map(([project, article]) => ({ kind: "article", project, article, access, agent, granularity }));
    if (!values["skip-aggregate"]) {
        for (const project of new Set(projects)) {
            keys.push({ kind: "aggregate", project, article: "", access, agent, granularity });
        }
    }
    const cache = new Cache();
    const requestsBefore = httpStats();
    try {
        const series = [];
        for (const key of keys) {
            const result = await loadSeries(cache, key, start, end, now);
            if (key.kind === "article" && result.points.every((p) => p.views === 0)) {
                warnings.push(`No views for "${key.article}" on ${key.project} in ${start}..${end}. The title may be misspelled, ` +
                    "be a redirect (redirect views are not counted), or the article may not exist in this edition.");
            }
            series.push(summarize(result, values.points));
        }
        const requestsAfter = httpStats();
        return success({
            granularity,
            start,
            end,
            access,
            agent,
            series,
            requests: requestsAfter.network + requestsAfter.replayed - requestsBefore.network - requestsBefore.replayed,
            cacheFile: cache.path,
        }, warnings);
    }
    finally {
        cache.close();
    }
}
