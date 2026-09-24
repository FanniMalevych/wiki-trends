# Wikipedia Interest Trends: an Agent Skill

An [Agent Skill](https://agentskills.io) that lets an AI agent answer questions like:

- *Compare growth of interest in intermittent fasting in Polish vs. Czech Wikipedia over the last two years.*
- *We're considering an astronomy course: is interest growing in Ukrainian Wikipedia, and how much can we trust that trend?*
- *Compare interest in "learning English" across several language editions and recommend which audiences to investigate next.*

It finds the topic's article in each language (via Wikidata), downloads monthly pageviews (Wikimedia Pageviews API), measures the trend as a share of each edition's total views, rates how far the trend can be trusted, and can write a one-page shareable report.

Pageviews measure **attention, not willingness to pay**. The results are a signal for what to validate next.

## Requirements

- Node.js 22.13 or later (`.nvmrc` pins 24). Nothing else: the skill has **no runtime dependencies**, and the compiled code in `scripts/dist/` is committed, so it runs without `npm install` or a build step.
- Internet access to `wikimedia.org`, `*.wikipedia.org` and `www.wikidata.org`.

## Use it with an agent

The skill is this folder. For Claude Code, copy or link it into a skills directory:

```bash
ln -s "$PWD" ~/.claude/skills/wikipedia-interest-trends
```

Other agents that support Agent Skills: point them at this folder. The agent reads `SKILL.md` and runs the commands itself.

## Use it directly

```bash
node scripts/dist/cli.js analyze --title "Astronomy" --from en --lang uk
node scripts/dist/cli.js analyze --title "Intermittent fasting" --from en --lang pl,cs --months 24
node scripts/dist/cli.js report --title "Astronomy" --from en --lang uk,pl,cs --note "Your recommendation"
```

Every command prints one line of JSON. `node scripts/dist/cli.js --help` lists the commands; [references/cli.md](references/cli.md) documents them, and [references/interpretation.md](references/interpretation.md) explains the method and the confidence score.

Downloaded data is cached in `.cache/wit.sqlite` (or `~/.cache/wikipedia-interest-trends` if this folder is read-only), so repeated and follow-up questions are fast. Reports and charts go to `wit-output/` in the current directory.

## Development

```bash
nvm use
npm ci              # development only: TypeScript, Node types, Anthropic SDK (for npm run e2e)
npm run build       # scripts/src → scripts/dist (commit the result)
npm test            # unit + integration tests, offline
npm run check       # fails if scripts/dist does not match the source
```

| Command | What it does |
|---|---|
| `npm test` | Unit tests plus integration tests that run the real CLI against recorded API responses in `tests/fixtures/http/` |
| `npm run fixtures:record` | Re-records those responses from the live APIs |
| `npm run e2e` | End-to-end test: a real model uses the skill on the prompts in `tests/evals/evals.json`. Default: Claude Haiku 4.5, about $0.09 per full run; needs `ANTHROPIC_API_KEY` in `.env`, see `.env.example`. Options: `--case <id>`, `--provider anthropic\|gemini\|openrouter`, `--model <id>`, `--list-models`, `--dry-run` |
| `python3 tests/reference/stats_reference.py` | Regenerates the independent reference values for the statistics tests |

How AI tools were used to build this, and how their output was verified: [DEVELOPMENT.md](DEVELOPMENT.md).

## Layout

```
SKILL.md                 instructions the agent reads
references/              command reference and interpretation guide (read on demand)
assets/known-events.json dated events that distort pageviews (e.g. May 2025 bot detection)
scripts/src/             TypeScript source
  wiki/                  Pageviews, MediaWiki and Wikidata clients, HTTP with retries
  cache/                 SQLite cache (node:sqlite)
  stats/                 Theil–Sen, Mann–Kendall (Hamed–Rao), seasonal adjustment, spikes, steps
  analysis.ts            trend, confidence score and reasons per edition
  viz/, report/          SVG charts and the HTML report
  commands/              one file per CLI command
scripts/dist/            compiled JavaScript the agent runs
tests/                   unit, integration, e2e harness, eval prompts, fixtures, stats reference
```
