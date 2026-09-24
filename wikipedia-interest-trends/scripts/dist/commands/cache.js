import { parseArgs } from "node:util";
import { Cache } from "../cache/db.js";
import { failure, success } from "../output.js";
import { normalizeProject } from "../wiki/pageviews.js";
export const CACHE_HELP = `Usage: cli.js cache <stats|clear> [options]

  stats                     Show what is cached (series, periods, title lookups, size)
  clear [--project <p>]     Delete cached data (everything, or one edition)

The cache lives in <skill>/.cache/wit.sqlite unless WIT_CACHE_DIR is set.
`;
export async function cacheCommand(argv) {
    const { values, positionals } = parseArgs({
        args: argv,
        strict: true,
        allowPositionals: true,
        options: { project: { type: "string" } },
    });
    const [action] = positionals;
    const cache = new Cache();
    try {
        if (action === "stats")
            return success(cache.stats());
        if (action === "clear") {
            const project = values.project ? normalizeProject(values.project) : undefined;
            const removed = cache.clear(project);
            return success({ removedSeries: removed.series, removedLookups: removed.lookups, project: project ?? "all" });
        }
        return failure([`Unknown cache action "${action ?? ""}". Use "stats" or "clear".`]);
    }
    finally {
        cache.close();
    }
}
