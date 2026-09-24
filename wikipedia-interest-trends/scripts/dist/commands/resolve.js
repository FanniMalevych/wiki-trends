import { parseArgs } from "node:util";
import { Cache } from "../cache/db.js";
import { success } from "../output.js";
import { resolveTopic } from "../resolve.js";
import { httpStats } from "../wiki/http.js";
import { normalizeProject } from "../wiki/pageviews.js";
export const RESOLVE_HELP = `Usage: cli.js resolve (--title <title> --from <p> | --qid <Q>) [--lang <codes>]

Finds the article about one topic in each Wikipedia language edition, via Wikidata.

Options:
  --title <title>   Article title in the --from edition (redirects are followed)
  --from <p>        Edition of --title, e.g. "en"
  --qid <Q>         Wikidata item ID instead of a title, e.g. Q1666254
  --lang <codes>    Editions to report, comma-separated or repeated (e.g. pl,cs,uk).
                    Default: every edition that has the article.

Editions without an article are listed with status "missing". Their
"candidates" are unverified search results; never use them without checking.
`;
/** Parses "--lang pl,cs --lang uk" into ["pl.wikipedia", "cs.wikipedia", "uk.wikipedia"]. */
export function parseLangs(values) {
    if (!values || values.length === 0)
        return null;
    const codes = values.flatMap((v) => v.split(",")).map((c) => c.trim()).filter(Boolean);
    if (codes.includes("all"))
        return null;
    return [...new Set(codes.map(normalizeProject))];
}
export async function resolveCommand(argv, now = Date.now()) {
    const { values } = parseArgs({
        args: argv,
        strict: true,
        options: {
            title: { type: "string" },
            from: { type: "string" },
            qid: { type: "string" },
            lang: { type: "string", multiple: true },
        },
    });
    if (values.title !== undefined && values.qid !== undefined)
        throw new Error("Use either --title or --qid, not both.");
    const cache = new Cache();
    const before = httpStats();
    try {
        const topic = await resolveTopic(cache, {
            ...(values.title !== undefined ? { title: values.title } : {}),
            ...(values.from !== undefined ? { from: normalizeProject(values.from) } : {}),
            ...(values.qid !== undefined ? { qid: values.qid } : {}),
            projects: parseLangs(values.lang),
        }, now);
        const after = httpStats();
        const warnings = [];
        if (topic.source?.redirectedFrom) {
            warnings.push(`"${topic.source.redirectedFrom}" redirects to "${topic.source.title}"; using the latter.`);
        }
        const missing = topic.editions.filter((e) => e.status === "missing");
        if (missing.length)
            warnings.push(`No article in: ${missing.map((e) => e.project).join(", ")}.`);
        return success({
            ...topic,
            found: topic.editions.length - missing.length,
            missing: missing.length,
            requests: after.network + after.replayed - before.network - before.replayed,
        }, warnings);
    }
    finally {
        cache.close();
    }
}
