import { parseArgs } from "node:util";
import { Cache } from "../cache/db.js";
import { success, type Envelope } from "../output.js";
import { resolveTopic } from "../resolve.js";
import { httpStats } from "../wiki/http.js";
import { normalizeProject } from "../wiki/pageviews.js";
import { parseLangs } from "./selection.js";

export const RESOLVE_HELP = `Usage: cli.js resolve (--title <title> --from <p> | --qid <Q>) [--lang <codes>]

Finds the article about one topic in each Wikipedia language edition, via Wikidata.

Options:
  --title <title>   Article title in the --from edition (redirects are followed)
  --from <p>        Edition of --title, e.g. "en"
  --qid <Q>         Wikidata item ID instead of a title, e.g. Q1666254
  --lang <codes>    Editions to report, comma-separated or repeated (e.g. pl,cs,uk).
                    Default: every edition that has the article.
  --verbose         Include request details

Editions without an article are listed with status "missing".
`;

export async function resolveCommand(argv: string[], now = Date.now()): Promise<Envelope> {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    options: {
      title: { type: "string" },
      from: { type: "string" },
      qid: { type: "string" },
      lang: { type: "string", multiple: true },
      verbose: { type: "boolean", default: false },
    },
  });
  if (values.title !== undefined && values.qid !== undefined) throw new Error("Use either --title or --qid, not both.");

  const cache = new Cache();
  const before = httpStats();
  try {
    const topic = await resolveTopic(
      cache,
      {
        ...(values.title !== undefined && { title: values.title }),
        ...(values.from !== undefined && { from: normalizeProject(values.from) }),
        ...(values.qid !== undefined && { qid: values.qid }),
        projects: parseLangs(values.lang),
      },
      now,
    );
    const after = httpStats();
    const warnings: string[] = [];
    if (topic.source?.redirectedFrom) {
      warnings.push(`"${topic.source.redirectedFrom}" redirects to "${topic.source.title}"; using the latter.`);
    }
    const missing = topic.editions.filter((e) => e.status === "missing");
    if (missing.length) warnings.push(`No article in: ${missing.map((e) => e.project).join(", ")}.`);

    return success(
      {
        ...topic,
        found: topic.editions.length - missing.length,
        missing: missing.length,
        ...(values.verbose && { requests: after.network + after.replayed - before.network - before.replayed }),
      },
      warnings,
    );
  } finally {
    cache.close();
  }
}
