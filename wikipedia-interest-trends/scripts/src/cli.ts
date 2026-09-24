#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { emit, failure } from "./output.js";

const COMMANDS = {
  resolve: "Map an article title to its Wikidata QID and titles in other language editions",
  fetch: "Download pageviews for articles (cached locally in SQLite)",
  analyze: "Normalize, deseasonalize and fit a trend with a confidence score",
  compare: "Compare trends for one topic across language editions",
  chart: "Render a chart (SVG/PNG) from analyzed series",
  report: "Build a one-page shareable report (HTML/PDF)",
  cache: "Inspect or clear the local cache",
} as const;

type Command = keyof typeof COMMANDS;

function packageVersion(): string {
  const pkgUrl = new URL("../../package.json", import.meta.url);
  return (JSON.parse(readFileSync(pkgUrl, "utf8")) as { version: string }).version;
}

function helpText(): string {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  const rows = Object.entries(COMMANDS)
    .map(([name, summary]) => `  ${name.padEnd(width)}  ${summary}`)
    .join("\n");
  return `wikipedia-interest-trends ${packageVersion()}

Usage:
  node scripts/dist/cli.js <command> [options]

Commands:
${rows}

Global options:
  -h, --help     Show this help
  -v, --version  Show version

Every command prints one JSON object: {ok, data, warnings[], errors[]}.
See references/cli.md for full command reference.
`;
}

function isCommand(value: string): value is Command {
  return Object.hasOwn(COMMANDS, value);
}

function main(argv: string[]): number {
  const [first] = argv;

  if (first === undefined || first === "-h" || first === "--help" || first === "help") {
    process.stdout.write(helpText());
    return 0;
  }
  if (first === "-v" || first === "--version") {
    process.stdout.write(packageVersion() + "\n");
    return 0;
  }
  if (!isCommand(first)) {
    emit(failure([`Unknown command "${first}". Run with --help to list commands.`]));
    return 1;
  }

  emit(failure([`Command "${first}" is not implemented yet.`]));
  return 2;
}

process.exitCode = main(process.argv.slice(2));
