#!/usr/bin/env node
import "./quiet.js";
import { CACHE_HELP, cacheCommand } from "./commands/cache.js";
import { FETCH_HELP, fetchCommand } from "./commands/fetch.js";
import { VERSION } from "./meta.js";
import { emit, failure, type Envelope } from "./output.js";

interface CommandSpec {
  summary: string;
  help?: string;
  run?: (argv: string[]) => Promise<Envelope>;
}

const COMMANDS: Record<string, CommandSpec> = {
  resolve: { summary: "Map an article title to its Wikidata QID and titles in other language editions" },
  fetch: { summary: "Download pageviews for articles (cached locally in SQLite)", help: FETCH_HELP, run: fetchCommand },
  analyze: { summary: "Normalize, deseasonalize and fit a trend with a confidence score" },
  compare: { summary: "Compare trends for one topic across language editions" },
  chart: { summary: "Render a chart (SVG/PNG) from analyzed series" },
  report: { summary: "Build a one-page shareable report (HTML/PDF)" },
  cache: { summary: "Inspect or clear the local cache", help: CACHE_HELP, run: cacheCommand },
};

function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  const rows = Object.entries(COMMANDS)
    .map(([name, spec]) => `  ${name.padEnd(width)}  ${spec.summary}${spec.run ? "" : " (not implemented yet)"}`)
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

const isHelp = (arg: string | undefined) => arg === "-h" || arg === "--help" || arg === "help";

async function main(argv: string[]): Promise<number> {
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
  if (!spec.run) {
    emit(failure([`Command "${first}" is not implemented yet.`]));
    return 2;
  }
  if (rest.some(isHelp)) {
    process.stdout.write(spec.help ?? `${spec.summary}\n`);
    return 0;
  }

  let envelope: Envelope;
  try {
    envelope = await spec.run(rest);
  } catch (err) {
    envelope = failure([(err as Error).message]);
  }
  emit(envelope);
  return envelope.ok ? 0 : 1;
}

process.exitCode = await main(process.argv.slice(2));
