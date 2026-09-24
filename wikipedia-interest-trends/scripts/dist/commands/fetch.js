import { parseArgs } from "node:util";
import { Cache } from "../cache/db.js";
import { failure, success } from "../output.js";
import { pageProblem, resolveTopic } from "../resolve.js";
import { loadSeries } from "../series.js";
import { httpStats } from "../wiki/http.js";
import { lookupPage, rankRedirects } from "../wiki/metadata.js";
import { ACCESS_VALUES, AGENT_VALUES, normalizeProject, normalizeTitle, } from "../wiki/pageviews.js";
import { defaultRange, firstAvailablePeriod, lastCompletePeriod, toPeriod } from "../wiki/periods.js";
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
  --redirects <n>      Add views of the n most-viewed redirects to each article
                       (default 10; 0 = article title only)
  --access <a>         all-access (default) | desktop | mobile-app | mobile-web
  --agent <a>          user (default) | all-agents | spider | automated
  --skip-aggregate     Do not fetch edition totals
  --points             Include every [period, views] pair in the output
`;
const MAX_ARTICLES = 20;
const DEFAULT_REDIRECTS = 10;
function oneOf(name, value, allowed) {
    if (allowed.includes(value))
        return value;
    throw new Error(`Invalid --${name} "${value}". Use one of: ${allowed.join(", ")}.`);
}
function pairArticles(projects, articles) {
    if (articles.length === 0)
        return [];
    if (projects.length === 1)
        return articles.map((a) => ({ project: projects[0], title: normalizeTitle(a) }));
    if (projects.length === articles.length)
        return articles.map((a, i) => ({ project: projects[i], title: normalizeTitle(a) }));
    throw new Error(`Got ${projects.length} --project and ${articles.length} --article values. ` +
        "Pass one --project for all articles, or one --project per --article.");
}
function summarize(points) {
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
function sumPoints(series) {
    return series[0].map((p, i) => ({ period: p.period, views: series.reduce((sum, s) => sum + s[i].views, 0) }));
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
            redirects: { type: "string", default: String(DEFAULT_REDIRECTS) },
            access: { type: "string", default: "all-access" },
            agent: { type: "string", default: "user" },
            "skip-aggregate": { type: "boolean", default: false },
            points: { type: "boolean", default: false },
        },
    });
    const granularity = oneOf("granularity", values.granularity, ["monthly", "daily"]);
    const access = oneOf("access", values.access, ACCESS_VALUES);
    const agent = oneOf("agent", values.agent, AGENT_VALUES);
    const maxRedirects = Number(values.redirects);
    if (!Number.isInteger(maxRedirects) || maxRedirects < 0)
        throw new Error(`Invalid --redirects "${values.redirects}". Use 0 or more.`);
    const topicMode = values.qid !== undefined || values.title !== undefined;
    if (topicMode && (values.project || values.article)) {
        throw new Error("Use either --qid/--title with --lang, or --project with --article, not both.");
    }
    if (values.qid !== undefined && values.title !== undefined)
        throw new Error("Use either --qid or --title, not both.");
    const langs = parseLangs(values.lang);
    if (topicMode && !langs)
        throw new Error("--lang is required with --qid or --title, e.g. --lang pl,cs,uk.");
    if (!topicMode && values.lang)
        throw new Error("--lang only works with --qid or --title. Use --project for exact articles.");
    // Date range
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
    const cache = new Cache();
    const before = httpStats();
    try {
        // 1. Decide which articles to fetch.
        let topic;
        let targets;
        let aggregateProjects;
        const missing = [];
        if (topicMode) {
            const resolved = await resolveTopic(cache, {
                ...(values.qid !== undefined ? { qid: values.qid } : {}),
                ...(values.title !== undefined ? { title: values.title } : {}),
                ...(values.from !== undefined ? { from: normalizeProject(values.from) } : {}),
                projects: langs,
            }, now);
            topic = { qid: resolved.qid, label: resolved.label };
            targets = [];
            for (const e of resolved.editions) {
                if (e.status === "found")
                    targets.push({ project: e.project, title: e.title });
                else
                    missing.push(e);
            }
            for (const e of missing)
                warnings.push(e.note ?? `No article in ${e.project}.`);
            aggregateProjects = langs;
        }
        else {
            const projects = (values.project ?? []).map(normalizeProject);
            if (projects.length === 0)
                return failure(["Give --qid/--title with --lang, or --project with --article."]);
            targets = pairArticles(projects, values.article ?? []);
            aggregateProjects = [...new Set(projects)];
        }
        if (targets.length > MAX_ARTICLES) {
            return failure([`${targets.length} articles requested; the limit is ${MAX_ARTICLES} per call. Split the request.`], warnings);
        }
        if (targets.length === 0 && values["skip-aggregate"]) {
            return failure(["Nothing to fetch: no articles found and --skip-aggregate was given."], warnings);
        }
        const keyFor = (kind, project, article) => ({
            kind, project, article, access, agent, granularity,
        });
        // 2. Check each article exists, follow redirects, and fetch it with its top redirects.
        const series = [];
        for (const target of targets) {
            const page = await lookupPage(cache, target.project, target.title, now);
            const problem = await pageProblem(cache, page, target.title, now);
            if (problem) {
                warnings.push(problem);
                missing.push({ project: target.project, status: "missing", title: target.title, note: problem });
                continue;
            }
            const title = page.title;
            if (page.redirectedFrom)
                warnings.push(`"${page.redirectedFrom}" redirects to "${title}" on ${target.project}; using the latter.`);
            const redirects = maxRedirects > 0 && page.redirects.length > 0
                ? (await rankRedirects(cache, target.project, page.redirects, now)).slice(0, maxRedirects).map((r) => r.title)
                : [];
            const main = await loadSeries(cache, keyFor("article", target.project, title), start, end, now);
            const extra = [];
            for (const r of redirects)
                extra.push(await loadSeries(cache, keyFor("article", target.project, r), start, end, now));
            const combined = sumPoints([main.points, ...extra.map((e) => e.points)]);
            const summary = summarize(combined);
            if (summary.total === 0) {
                warnings.push(`"${title}" on ${target.project} has no recorded views in ${start}..${end}.`);
            }
            const redirectViews = summary.total - main.points.reduce((s, p) => s + p.views, 0);
            series.push({
                kind: "article",
                project: target.project,
                article: title,
                ...(page.redirectedFrom ? { redirectedFrom: page.redirectedFrom } : {}),
                ...summary,
                ...(redirects.length
                    ? {
                        redirects: {
                            included: redirects.length,
                            views: redirectViews,
                            share: summary.total ? Math.round((redirectViews / summary.total) * 1000) / 1000 : 0,
                            titles: redirects,
                        },
                    }
                    : {}),
                source: {
                    cached: main.cachedPeriods + extra.reduce((s, e) => s + e.cachedPeriods, 0),
                    fetched: main.fetchedPeriods + extra.reduce((s, e) => s + e.fetchedPeriods, 0),
                },
                ...(values.points ? { points: combined.map((p) => [p.period, p.views]) } : {}),
            });
        }
        // 3. Edition totals, for normalizing in analysis.
        if (!values["skip-aggregate"]) {
            for (const project of aggregateProjects) {
                const agg = await loadSeries(cache, keyFor("aggregate", project, ""), start, end, now);
                series.push({
                    kind: "aggregate",
                    project,
                    ...summarize(agg.points),
                    source: { cached: agg.cachedPeriods, fetched: agg.fetchedPeriods },
                    ...(values.points ? { points: agg.points.map((p) => [p.period, p.views]) } : {}),
                });
            }
        }
        const after = httpStats();
        return success({
            ...(topic ?? {}),
            granularity,
            start,
            end,
            access,
            agent,
            series,
            ...(missing.length ? { missing } : {}),
            requests: after.network + after.replayed - before.network - before.replayed,
            cacheFile: cache.path,
        }, warnings);
    }
    finally {
        cache.close();
    }
}
