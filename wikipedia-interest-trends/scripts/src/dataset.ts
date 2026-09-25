// Loads everything an analysis needs for one request: which articles to use
// (resolved via Wikidata for a topic, or given exactly), their pageviews, and
// each edition's total views.
import type { Cache } from "./cache/db.js";
import { pageProblem, resolveTopic, type Edition, type TopicInput } from "./resolve.js";
import { loadSeries, type SeriesResult } from "./series.js";
import { lookupPage } from "./wiki/metadata.js";
import type { Access, Agent, Point, SeriesKey } from "./wiki/pageviews.js";
import { resolveRange, type Granularity } from "./wiki/periods.js";

export const MAX_ARTICLES = 20;

export interface ArticleRef {
  project: string;
  title: string;
}

export type Selection =
  | { topic: TopicInput & { projects: string[] } }
  | { articles: ArticleRef[]; projects: string[] };

export interface DatasetOptions {
  granularity: Granularity;
  access: Access;
  agent: Agent;
  start?: string | undefined;
  end?: string | undefined;
  /** Also load each edition's total views, for normalization. */
  aggregates: boolean;
}

export interface Loaded {
  points: Point[];
  cachedPeriods: number;
  fetchedPeriods: number;
}

export interface ArticleData extends Loaded {
  project: string;
  article: string;
  redirectedFrom: string | null;
}

export interface AggregateData extends Loaded {
  project: string;
}

export interface Dataset {
  qid: string | null;
  label: string | null;
  granularity: Granularity;
  access: Access;
  agent: Agent;
  start: string;
  end: string;
  articles: ArticleData[];
  aggregates: AggregateData[];
  /** Requested articles that could not be used, with the reason. */
  missing: Edition[];
  warnings: string[];
}

const loaded = ({ points, cachedPeriods, fetchedPeriods }: SeriesResult): Loaded => ({ points, cachedPeriods, fetchedPeriods });

export async function loadDataset(cache: Cache, selection: Selection, options: DatasetOptions, now: number): Promise<Dataset> {
  const { granularity, access, agent } = options;
  const { start, end, warnings } = resolveRange(granularity, options.start, options.end, now);
  const keyFor = (kind: SeriesKey["kind"], project: string, article = ""): SeriesKey => ({
    kind, project, article, access, agent, granularity,
  });

  // 1. Which articles to fetch.
  let qid: string | null = null;
  let label: string | null = null;
  let targets: ArticleRef[];
  const missing: Edition[] = [];
  if ("topic" in selection) {
    const topic = await resolveTopic(cache, selection.topic, now);
    ({ qid, label } = topic);
    targets = [];
    for (const e of topic.editions) {
      if (e.status === "found") targets.push({ project: e.project, title: e.title! });
      else {
        missing.push(e);
        warnings.push(e.note ?? `No article in ${e.project}.`);
      }
    }
  } else {
    targets = selection.articles;
  }
  if (targets.length > MAX_ARTICLES) {
    throw new Error(`${targets.length} articles requested; the limit is ${MAX_ARTICLES} per call. Split the request.`);
  }

  // 2. Check each article exists, follow a redirected title, and load it.
  const articles: ArticleData[] = [];
  for (const target of targets) {
    const page = await lookupPage(cache, target.project, target.title, now);
    const problem = await pageProblem(cache, page, target.title, now);
    if (problem) {
      warnings.push(problem);
      missing.push({ project: target.project, status: "missing", title: target.title, note: problem });
      continue;
    }
    const article = page.title!;
    if (page.redirectedFrom) warnings.push(`"${page.redirectedFrom}" redirects to "${article}" on ${target.project}; using the latter.`);

    const series = loaded(await loadSeries(cache, keyFor("article", target.project, article), start, end, now));
    if (series.points.every((p) => p.views === 0)) {
      warnings.push(`"${article}" on ${target.project} has no recorded views in ${start}..${end}.`);
    }
    articles.push({ project: target.project, article, redirectedFrom: page.redirectedFrom, ...series });
  }

  // 3. Edition totals.
  const aggregates: AggregateData[] = [];
  if (options.aggregates) {
    const projects = "topic" in selection ? selection.topic.projects : selection.projects;
    for (const project of new Set(projects)) {
      aggregates.push({ project, ...loaded(await loadSeries(cache, keyFor("aggregate", project), start, end, now)) });
    }
  }

  return { qid, label, granularity, access, agent, start, end, articles, aggregates, missing, warnings };
}
