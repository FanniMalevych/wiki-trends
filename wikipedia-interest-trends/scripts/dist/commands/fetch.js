import { parseArgs } from "node:util";
import { Cache } from "../cache/db.js";
import { loadDataset } from "../dataset.js";
import { success } from "../output.js";
import { httpStats } from "../wiki/http.js";
import { ACCESS_VALUES, AGENT_VALUES, normalizeProject, normalizeTitle } from "../wiki/pageviews.js";
import { parseLangs } from "./resolve.js";
export const FETCH_HELP = `Usage:
  cli.js fetch --qid <Q> --lang <codes> [options]
  cli.js fetch --title <title> --from <p> --lang <codes> [options]
  cli.js fetch --project <p> --article <title> [options]

Downloads monthly or daily pageviews (cached locally) for one topic across
editions, or for given articles, plus each edition's total views.

Topic (the same article in several languages, matched via Wikidata):
  --qid <Q>            Wikidata item ID, e.g. Q1666254
  --title <title>      Or: a title in the --from edition
  --from <p>           Edition of --title, e.g. "en"
  --lang <codes>       Editions to fetch, e.g. pl,cs,uk (required with --qid/--title)

Articles (exact titles you already know):
  --project <p>        Edition, e.g. "cs". Repeatable.
  --article <title>    Title in that edition. Repeatable.
                       One project + many articles: all in that project.
                       N projects + N articles: paired in order.

Options:
  --start <date>       YYYY-MM or YYYY-MM-DD (default: 24 months / 730 days ago)
  --end <date>         YYYY-MM or YYYY-MM-DD (default: last complete month / yesterday)
  --granularity <g>    monthly (default) | daily
  --redirects <n>      Also count views of each article's n most-viewed redirects
                       (default 0). Redirects can widen the topic (e.g. "5:2 diet"
                       -> "Intermittent fasting") and differ between languages.
  --access <a>         all-access (default) | desktop | mobile-app | mobile-web
  --agent <a>          user (default) | all-agents | spider | automated
  --skip-aggregate     Do not fetch edition totals
  --points             Include every [period, views] pair
  --verbose            Include cache and request details
`;
function oneOf(name, value, allowed) {
    if (allowed.includes(value))
        return value;
    throw new Error(`Invalid --${name} "${value}". Use one of: ${allowed.join(", ")}.`);
}
function pairArticles(projects, articles) {
    if (projects.length === 1)
        return articles.map((a) => ({ project: projects[0], title: normalizeTitle(a) }));
    if (projects.length === articles.length)
        return articles.map((a, i) => ({ project: projects[i], title: normalizeTitle(a) }));
    throw new Error(`Got ${projects.length} --project and ${articles.length} --article values. ` +
        "Pass one --project for all articles, or one --project per --article.");
}
function selectionFrom(values) {
    const topicMode = values.qid !== undefined || values.title !== undefined;
    if (topicMode) {
        if (values.project || values.article)
            throw new Error("Use either --qid/--title with --lang, or --project with --article, not both.");
        if (values.qid !== undefined && values.title !== undefined)
            throw new Error("Use either --qid or --title, not both.");
        const projects = parseLangs(values.lang);
        if (!projects)
            throw new Error("--lang is required with --qid or --title, e.g. --lang pl,cs,uk.");
        return {
            topic: {
                ...(values.qid !== undefined && { qid: values.qid }),
                ...(values.title !== undefined && { title: values.title }),
                ...(values.from !== undefined && { from: normalizeProject(values.from) }),
                projects,
            },
        };
    }
    if (values.lang)
        throw new Error("--lang only works with --qid or --title. Use --project for exact articles.");
    const projects = (values.project ?? []).map(normalizeProject);
    if (projects.length === 0)
        throw new Error("Give --qid/--title with --lang, or --project with --article.");
    return { articles: pairArticles(projects, values.article ?? []), projects };
}
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
            qid: { type: "string" },
            title: { type: "string" },
            from: { type: "string" },
            lang: { type: "string", multiple: true },
            project: { type: "string", multiple: true },
            article: { type: "string", multiple: true },
            start: { type: "string" },
            end: { type: "string" },
            granularity: { type: "string", default: "monthly" },
            redirects: { type: "string", default: "0" },
            access: { type: "string", default: "all-access" },
            agent: { type: "string", default: "user" },
            "skip-aggregate": { type: "boolean", default: false },
            points: { type: "boolean", default: false },
            verbose: { type: "boolean", default: false },
        },
    });
    const redirects = Number(values.redirects);
    if (!Number.isInteger(redirects) || redirects < 0)
        throw new Error(`Invalid --redirects "${values.redirects}". Use 0 or more.`);
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
            redirects,
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
            articles: d.articles.map((a) => {
                const summary = summarize(a.points);
                return {
                    project: a.project,
                    article: a.article,
                    ...(a.redirectedFrom !== null && { redirectedFrom: a.redirectedFrom }),
                    ...summary,
                    ...(a.redirects.length > 0 && {
                        redirects: {
                            titles: a.redirects,
                            views: a.redirectViews,
                            share: summary.total ? Math.round((a.redirectViews / summary.total) * 1000) / 1000 : 0,
                        },
                    }),
                    ...details(a),
                };
            }),
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
