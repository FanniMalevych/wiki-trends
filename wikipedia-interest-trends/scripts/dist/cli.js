#!/usr/bin/env node
import { ANALYZE_HELP, analyzeCommand } from "./commands/analyze.js";
import { CACHE_HELP, cacheCommand } from "./commands/cache.js";
import { FETCH_HELP, fetchCommand } from "./commands/fetch.js";
import { CHART_HELP, chartCommand, REPORT_HELP, reportCommand } from "./commands/render.js";
import { RESOLVE_HELP, resolveCommand } from "./commands/resolve.js";
import { VERSION } from "./meta.js";
import { emit, failure } from "./output.js";
const COMMANDS = {
    resolve: {
        summary: "Find the article about a topic in each language edition (via Wikidata)",
        help: RESOLVE_HELP,
        run: resolveCommand,
    },
    fetch: { summary: "Download pageviews for a topic or articles (cached locally)", help: FETCH_HELP, run: fetchCommand },
    analyze: {
        summary: "Trend and confidence per edition for a topic, ranked across editions",
        help: ANALYZE_HELP,
        run: analyzeCommand,
    },
    chart: { summary: "Write an SVG chart of the trend in each edition", help: CHART_HELP, run: chartCommand },
    report: { summary: "Write a one-page shareable HTML report (prints to one A4 page)", help: REPORT_HELP, run: reportCommand },
    cache: { summary: "Inspect or clear the local cache", help: CACHE_HELP, run: cacheCommand },
};
function helpText() {
    const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
    const rows = Object.entries(COMMANDS)
        .map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}`)
        .join("\n");
    return `wikipedia-interest-trends ${VERSION}

Usage:
  node scripts/dist/cli.js <command> [options]
  node scripts/dist/cli.js <command> --help

Commands:
${rows}

Global options:
  -h, --help     Show this help
  -v, --version  Show version

Every command prints one JSON object: {ok, data, warnings[], errors[]}.
See references/cli.md for full command reference.
`;
}
const isHelp = (arg) => arg === "-h" || arg === "--help" || arg === "help";
async function main(argv) {
    const [first, ...rest] = argv;
    if (first === undefined || isHelp(first)) {
        process.stdout.write(helpText());
        return 0;
    }
    if (first === "-v" || first === "--version") {
        process.stdout.write(VERSION + "\n");
        return 0;
    }
    const spec = Object.hasOwn(COMMANDS, first) ? COMMANDS[first] : undefined;
    if (!spec) {
        emit(failure([`Unknown command "${first}". Run with --help to list commands.`]));
        return 1;
    }
    if (rest.some(isHelp)) {
        process.stdout.write(spec.help);
        return 0;
    }
    let envelope;
    try {
        envelope = await spec.run(rest);
    }
    catch (err) {
        envelope = failure([err.message]);
    }
    emit(envelope);
    return envelope.ok ? 0 : 1;
}
process.exitCode = await main(process.argv.slice(2));
