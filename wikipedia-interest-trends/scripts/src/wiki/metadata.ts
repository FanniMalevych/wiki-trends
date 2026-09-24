// Title and cross-language lookups via the MediaWiki Action API and Wikidata.
// Responses are cached by URL for LOOKUP_TTL_MS so follow-up questions reuse them.
import type { Cache } from "../cache/db.js";
import { getJson, HttpError } from "./http.js";
import { normalizeTitle } from "./pageviews.js";

export const LOOKUP_TTL_MS = 30 * 86_400_000;

const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const MAX_RANKED_REDIRECTS = 100;
const TITLES_PER_QUERY = 50; // MediaWiki limit for anonymous clients

// Wikidata site IDs whose language code does not map mechanically to a subdomain.
const SITE_TO_PROJECT: Record<string, string> = { be_x_oldwiki: "be-tarask.wikipedia" };
const PROJECT_TO_SITE = Object.fromEntries(Object.entries(SITE_TO_PROJECT).map(([s, p]) => [p, s]));

// "<code>wiki" site IDs that are not language editions of Wikipedia.
const NON_WIKIPEDIA_SITES = new Set([
  "abstractwiki", "commonswiki", "specieswiki", "metawiki", "wikidatawiki", "mediawikiwiki", "sourceswiki",
  "incubatorwiki", "outreachwiki", "wikimaniawiki", "foundationwiki", "wikifunctionswiki",
  "testwiki", "test2wiki", "testwikidatawiki",
]);

/** "plwiki" -> "pl.wikipedia"; undefined for non-Wikipedia sites such as "plwikiquote" or "commonswiki". */
export function siteToProject(site: string): string | undefined {
  if (SITE_TO_PROJECT[site]) return SITE_TO_PROJECT[site];
  if (NON_WIKIPEDIA_SITES.has(site)) return undefined;
  const match = /^([a-z0-9_]+)wiki$/.exec(site);
  return match ? `${match[1]!.replaceAll("_", "-")}.wikipedia` : undefined;
}

/** "pl.wikipedia" -> "plwiki". */
export function projectToSite(project: string): string {
  if (PROJECT_TO_SITE[project]) return PROJECT_TO_SITE[project];
  const match = /^([a-z0-9-]+)\.wikipedia$/.exec(project);
  if (!match) throw new Error(`Only Wikipedia editions can be matched across languages (got "${project}").`);
  return `${match[1]!.replaceAll("-", "_")}wiki`;
}

export function languageOf(project: string): string {
  return project.split(".")[0]!;
}

function apiUrl(base: string, params: Record<string, string>): string {
  return `${base}?${new URLSearchParams({ format: "json", formatversion: "2", ...params })}`;
}

const actionApi = (project: string) => `https://${project}.org/w/api.php`;
const displayTitle = (title: string) => title.replaceAll("_", " ");

async function cachedQuery<T>(cache: Cache, url: string, now: number): Promise<T> {
  const hit = cache.getResponse(url);
  if (hit && now - hit.fetchedAt < LOOKUP_TTL_MS) return hit.body as T;

  const res = await getJson(url);
  const host = new URL(url).host;
  if (res.status !== 200) throw new HttpError(`${host} returned HTTP ${res.status}`, url, res.status);
  const error = (res.body as { error?: { code: string; info: string } }).error;
  if (error) throw new HttpError(`${host} API error ${error.code}: ${error.info}`, url, res.status);

  cache.putResponse(url, res.body, now);
  return res.body as T;
}

// ---------------------------------------------------------------------------
// Pages

export interface PageInfo {
  project: string;
  status: "found" | "missing" | "disambiguation";
  /** Canonical title with underscores, or null when the page does not exist. */
  title: string | null;
  /** Set when the requested title was itself a redirect. */
  redirectedFrom: string | null;
  qid: string | null;
  /** Titles that redirect to this page, excluding redirects to a section. */
  redirects: string[];
}

interface QueryPage {
  title: string;
  missing?: boolean;
  invalid?: boolean;
  pageprops?: { wikibase_item?: string; disambiguation?: string };
  redirects?: Array<{ title: string; fragment?: string }>;
  pageviews?: Record<string, number | null>;
}

interface QueryResponse {
  continue?: Record<string, string>;
  query?: {
    pages?: QueryPage[];
    redirects?: Array<{ from: string; to: string }>;
    search?: Array<{ title: string }>;
    searchinfo?: { suggestion?: string };
  };
}

export async function lookupPage(cache: Cache, project: string, title: string, now: number): Promise<PageInfo> {
  const url = apiUrl(actionApi(project), {
    action: "query",
    redirects: "1",
    titles: displayTitle(title),
    prop: "pageprops|redirects",
    ppprop: "wikibase_item|disambiguation",
    rdnamespace: "0",
    rdprop: "title|fragment",
    rdlimit: "max",
  });
  const body = await cachedQuery<QueryResponse>(cache, url, now);
  const page = body.query?.pages?.[0];
  const redirect = body.query?.redirects?.[0];
  const redirectedFrom = redirect ? normalizeTitle(redirect.from) : null;

  if (!page || page.missing || page.invalid) {
    return { project, status: "missing", title: null, redirectedFrom, qid: null, redirects: [] };
  }
  return {
    project,
    status: page.pageprops?.disambiguation !== undefined ? "disambiguation" : "found",
    title: normalizeTitle(page.title),
    redirectedFrom,
    qid: page.pageprops?.wikibase_item ?? null,
    redirects: (page.redirects ?? []).filter((r) => !r.fragment).map((r) => normalizeTitle(r.title)),
  };
}

/**
 * Orders redirect titles by their views over the last 60 days and drops those
 * with none. Only the first MAX_RANKED_REDIRECTS titles are considered.
 */
export async function rankRedirects(
  cache: Cache,
  project: string,
  titles: string[],
  now: number,
): Promise<Array<{ title: string; views: number }>> {
  const ranked: Array<{ title: string; views: number }> = [];
  const considered = titles.slice(0, MAX_RANKED_REDIRECTS);
  for (let i = 0; i < considered.length; i += TITLES_PER_QUERY) {
    const batch = considered.slice(i, i + TITLES_PER_QUERY).map(displayTitle).join("|");
    let cont: Record<string, string> = {};
    do {
      const url = apiUrl(actionApi(project), { action: "query", prop: "pageviews", pvipdays: "60", titles: batch, ...cont });
      const body = await cachedQuery<QueryResponse>(cache, url, now);
      for (const page of body.query?.pages ?? []) {
        if (!page.pageviews) continue;
        const views = Object.values(page.pageviews).reduce<number>((sum, v) => sum + (v ?? 0), 0);
        if (views > 0) ranked.push({ title: normalizeTitle(page.title), views });
      }
      cont = body.continue ?? {};
    } while (Object.keys(cont).length > 0);
  }
  return ranked.sort((a, b) => b.views - a.views || a.title.localeCompare(b.title));
}

const stems = (text: string) =>
  new Set(
    text
      .toLocaleLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3)
      .map((w) => w.slice(0, 4)),
  );

/**
 * True when the title shares word stems (first 4 letters) with the query:
 * one for a one-word query, otherwise at least two.
 */
export function looksRelated(title: string, query: string): boolean {
  const q = stems(query);
  const shared = [...stems(title)].filter((s) => q.has(s)).length;
  return shared >= Math.min(2, q.size) && shared > 0;
}

/**
 * Full-text search ranked by relevance. When nothing matches, retries once with
 * the search engine's spelling suggestion ("did you mean"). Full-text search also
 * matches article bodies, so results whose titles share no word stem with the
 * query are dropped rather than offered as look-alikes.
 */
export async function searchTitles(cache: Cache, project: string, query: string, now: number, limit = 3): Promise<string[]> {
  const search = (q: string) =>
    cachedQuery<QueryResponse>(
      cache,
      apiUrl(actionApi(project), {
        action: "query",
        list: "search",
        srsearch: q,
        srnamespace: "0",
        srlimit: "10", // filtered below, so ask for more than we return
        srprop: "",
        srinfo: "suggestion",
      }),
      now,
    );
  let body = await search(query);
  let matched = query;
  const suggestion = body.query?.searchinfo?.suggestion;
  if (!body.query?.search?.length && suggestion) {
    body = await search(suggestion);
    matched = suggestion;
  }
  return (body.query?.search ?? [])
    .filter((s) => looksRelated(s.title, matched))
    .slice(0, limit)
    .map((s) => normalizeTitle(s.title));
}

// ---------------------------------------------------------------------------
// Wikidata

export interface EntityInfo {
  qid: string;
  /** Labels by language code, for the requested languages plus English. */
  labels: Record<string, string>;
  /** Canonical article title per Wikipedia project, e.g. "cs.wikipedia" -> "Přerušovaný_půst". */
  sitelinks: Map<string, string>;
}

interface EntitiesResponse {
  entities?: Record<
    string,
    {
      id?: string;
      missing?: string | boolean;
      labels?: Record<string, { value: string }>;
      sitelinks?: Record<string, { title: string }>;
    }
  >;
}

/** Looks up a Wikidata item's labels and Wikipedia articles, optionally only for the given projects. */
export async function lookupEntity(cache: Cache, qid: string, projects: string[] | null, now: number): Promise<EntityInfo> {
  const languages = new Set(["en", ...(projects ?? []).map(languageOf)]);
  const url = apiUrl(WIKIDATA_API, {
    action: "wbgetentities",
    ids: qid,
    props: "sitelinks|labels",
    languages: [...languages].join("|"),
    ...(projects ? { sitefilter: projects.map(projectToSite).join("|") } : {}),
  });
  const body = await cachedQuery<EntitiesResponse>(cache, url, now);
  const entity = Object.values(body.entities ?? {})[0];
  if (!entity || entity.missing !== undefined) throw new Error(`Wikidata item ${qid} does not exist.`);

  const sitelinks = new Map<string, string>();
  for (const [site, link] of Object.entries(entity.sitelinks ?? {})) {
    const project = siteToProject(site);
    if (project) sitelinks.set(project, normalizeTitle(link.title));
  }
  const labels = Object.fromEntries(Object.entries(entity.labels ?? {}).map(([lang, l]) => [lang, l.value]));
  return { qid: entity.id ?? qid, labels, sitelinks };
}
