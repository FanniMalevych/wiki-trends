// Command-line options shared by commands that work on a topic or a list of articles.
import type { Selection } from "../dataset.js";
import { normalizeProject, normalizeTitle } from "../wiki/pageviews.js";

export const SELECTION_HELP = `Topic (the same article in several languages, matched via Wikidata):
  --qid <Q>            Wikidata item ID, e.g. Q1666254
  --title <title>      Or: a title in the --from edition
  --from <p>           Edition of --title, e.g. "en"
  --lang <codes>       Editions to use, e.g. pl,cs,uk (required with --qid/--title)

Articles (exact titles you already know):
  --project <p>        Edition, e.g. "cs". Repeatable.
  --article <title>    Title in that edition. Repeatable.
                       One project + many articles: all in that project.
                       N projects + N articles: paired in order.`;

export const SELECTION_OPTIONS = {
  qid: { type: "string" },
  title: { type: "string" },
  from: { type: "string" },
  lang: { type: "string", multiple: true },
  project: { type: "string", multiple: true },
  article: { type: "string", multiple: true },
} as const;

export function oneOf<T extends string>(name: string, value: string, allowed: readonly T[]): T {
  if ((allowed as readonly string[]).includes(value)) return value as T;
  throw new Error(`Invalid --${name} "${value}". Use one of: ${allowed.join(", ")}.`);
}

/** Parses "--lang pl,cs --lang uk" into ["pl.wikipedia", "cs.wikipedia", "uk.wikipedia"]; null for all/none. */
export function parseLangs(values: string[] | undefined): string[] | null {
  if (!values || values.length === 0) return null;
  const codes = values.flatMap((v) => v.split(",")).map((c) => c.trim()).filter(Boolean);
  if (codes.includes("all")) return null;
  return [...new Set(codes.map(normalizeProject))];
}

function pairArticles(projects: string[], articles: string[]) {
  if (projects.length === 1) return articles.map((a) => ({ project: projects[0]!, title: normalizeTitle(a) }));
  if (projects.length === articles.length) return articles.map((a, i) => ({ project: projects[i]!, title: normalizeTitle(a) }));
  throw new Error(
    `Got ${projects.length} --project and ${articles.length} --article values. ` +
      "Pass one --project for all articles, or one --project per --article.",
  );
}

export function selectionFrom(values: {
  qid?: string | undefined;
  title?: string | undefined;
  from?: string | undefined;
  lang?: string[] | undefined;
  project?: string[] | undefined;
  article?: string[] | undefined;
}): Selection {
  if (values.qid !== undefined || values.title !== undefined) {
    if (values.project || values.article) throw new Error("Use either --qid/--title with --lang, or --project with --article, not both.");
    if (values.qid !== undefined && values.title !== undefined) throw new Error("Use either --qid or --title, not both.");
    const projects = parseLangs(values.lang);
    if (!projects) throw new Error("--lang is required with --qid or --title, e.g. --lang pl,cs,uk.");
    return {
      topic: {
        ...(values.qid !== undefined && { qid: values.qid }),
        ...(values.title !== undefined && { title: values.title }),
        ...(values.from !== undefined && { from: normalizeProject(values.from) }),
        projects,
      },
    };
  }
  if (values.lang) throw new Error("--lang only works with --qid or --title. Use --project for exact articles.");
  const projects = (values.project ?? []).map(normalizeProject);
  if (projects.length === 0) throw new Error("Give --qid/--title with --lang, or --project with --article.");
  return { articles: pairArticles(projects, values.article ?? []), projects };
}

/** Parses a non-negative integer option. */
export function count(name: string, value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new Error(`Invalid --${name} "${value}". Use 0 or more.`);
  return n;
}
