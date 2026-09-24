import { languageOf, lookupEntity, lookupPage, searchTitles, } from "./wiki/metadata.js";
const quoteList = (titles) => titles.map((t) => `"${t}"`).join(", ");
export function normalizeQid(input) {
    const match = /^q?(\d+)$/i.exec(input.trim());
    if (!match)
        throw new Error(`Invalid Wikidata ID "${input}". Use e.g. Q1666254.`);
    return `Q${match[1]}`;
}
/**
 * Explains why a page cannot be used (missing or disambiguation) with concrete
 * alternatives, or returns null when the page is a normal article.
 */
export async function pageProblem(cache, page, requested, now) {
    if (page.status === "missing") {
        const suggestions = await searchTitles(cache, page.project, requested.replaceAll("_", " "), now);
        return (`"${requested}" does not exist on ${page.project}.` +
            (suggestions.length ? ` Search suggests: ${quoteList(suggestions)} (verify before using).` : ""));
    }
    if (page.status === "disambiguation") {
        // Search ranks the main meanings first, unlike the page's own (alphabetical) link list.
        const options = (await searchTitles(cache, page.project, page.title.replaceAll("_", " "), now, 8)).filter((t) => t !== page.title);
        return (`"${page.title}" on ${page.project} is a disambiguation page, not an article.` +
            (options.length ? ` Pick a specific one, e.g. ${quoteList(options)}.` : ""));
    }
    return null;
}
async function missingEdition(cache, project, qid, labels, now) {
    const lang = languageOf(project);
    const label = labels[lang];
    if (!label) {
        return {
            project,
            status: "missing",
            title: null,
            note: `No ${project} article is linked to ${qid} and the item has no "${lang}" name, so the topic is probably not covered there.`,
        };
    }
    const candidates = await searchTitles(cache, project, label, now);
    return {
        project,
        status: "missing",
        title: null,
        candidates,
        note: `No ${project} article is linked to ${qid}. ` +
            (candidates.length
                ? `Search results for its local name "${label}" are unverified; check one covers the same topic before using it.`
                : `A search for its local name "${label}" found nothing.`),
    };
}
/** Maps a title in one edition, or a Wikidata ID, to the matching article in each edition. */
export async function resolveTopic(cache, input, now) {
    let qid;
    let source = null;
    if (input.title !== undefined) {
        if (!input.from)
            throw new Error("--title needs --from, the edition the title is in (e.g. --from en).");
        const page = await lookupPage(cache, input.from, input.title, now);
        const problem = await pageProblem(cache, page, input.title, now);
        if (problem)
            throw new Error(problem);
        if (!page.qid) {
            throw new Error(`"${page.title}" on ${input.from} has no Wikidata item, so it cannot be matched to other editions. ` +
                `Use fetch --project ${input.from} --article "${page.title}" for this edition only.`);
        }
        qid = page.qid;
        source = { project: input.from, title: page.title, redirectedFrom: page.redirectedFrom };
    }
    else if (input.qid !== undefined) {
        qid = normalizeQid(input.qid);
    }
    else {
        throw new Error("Give --title with --from, or --qid.");
    }
    const entity = await lookupEntity(cache, qid, input.projects, now);
    const projects = input.projects ?? [...entity.sitelinks.keys()].sort();
    const editions = [];
    for (const project of projects) {
        const title = entity.sitelinks.get(project);
        editions.push(title ? { project, status: "found", title } : await missingEdition(cache, project, entity.qid, entity.labels, now));
    }
    return {
        qid: entity.qid,
        label: entity.labels.en ?? Object.values(entity.labels)[0] ?? null,
        source,
        editions,
    };
}
