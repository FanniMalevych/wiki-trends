# Command reference

Run from the skill directory: `node scripts/dist/cli.js <command> [options]`.
Every command prints one line of JSON: `{"ok": true|false, "data": …, "warnings": [...], "errors": [...]}`.
`<command> --help` prints the same information as this page.

## Choosing articles (analyze, fetch)

Either a **topic** matched across languages via Wikidata:

| Option | Meaning |
|---|---|
| `--title <title>` + `--from <code>` | An article title and the edition it is in, e.g. `--title "Astronomy" --from en` |
| `--qid <Q>` | Or a Wikidata item ID, e.g. `Q333` |
| `--lang <codes>` | Editions to use, comma-separated: `--lang pl,cs,uk` (required with a topic) |

or **exact articles** you already know:

| Option | Meaning |
|---|---|
| `--project <code>` | Edition, e.g. `cs`. Repeatable |
| `--article <title>` | Title in that edition. Repeatable. One `--project` applies to all articles; otherwise pair one `--project` per `--article` |

## analyze — trend and confidence (main command)

```bash
node scripts/dist/cli.js analyze --title "Astronomy" --from en --lang uk
node scripts/dist/cli.js analyze --title "Intermittent fasting" --from en --lang pl,cs --months 24
```

| Option | Default | Meaning |
|---|---|---|
| `--months <n>` | 60 | Number of months ending at `--end`; 24 = "the last two years" |
| `--start <YYYY-MM>` | | First month, instead of `--months` |
| `--end <YYYY-MM>` | last complete month | Last month |
| `--redirects <n>` | 0 | Also count views of the article's n most-viewed redirect titles (can widen the topic) |
| `--access <a>` | all-access | all-access, desktop, mobile-app, mobile-web |
| `--agent <a>` | user | user (humans), all-agents, spider, automated |
| `--verbose` | off | Adds the number of network requests made |

`data` fields:

- `qid`, `label`, `start`, `end`
- `editions[]`, one per language with an article:
  - `project`, `article`, `months`
  - `monthlyViews`: mean views per month over the last 12 months
  - `perMillion`: views per million edition views over the last 12 months (comparable across languages)
  - `trend`: `direction` (growing, declining, stable, unclear), `perYear` (%), `ci95` ([low, high] % per year), `p`, `rawViewsPerYear` (%)
  - `yoy`: `share` and `views`, last 12 months vs the 12 before (%)
  - `seasonality`: `strength` (0–1), `peak`, `low` month; null with less than 36 months
  - `spikes[]` (`period`, `ratio`) and `step` (`period`, `change` %, `event`)
  - `confidence`: `level` (high, medium, low), `score` (0–100), `reasons[]`
  - `summary`: one sentence
- `ranking[]` (only with 2+ editions): `rank`, `project`, `direction`, `perYear`, `confidence`, `monthlyViews`, `perMillion`
- `missing[]`: requested editions without a usable article, each with a `note`

## resolve — find the article in each language

```bash
node scripts/dist/cli.js resolve --title "intermittent fasting" --from en --lang pl,cs,uk
```

Options: `--title` + `--from`, or `--qid`; `--lang` (default: every edition); `--verbose`.
Returns `qid`, `label`, `source`, and `editions[]` with `status` found or missing. `candidates` on a missing edition are unverified search results.

## fetch — raw monthly or daily views

```bash
node scripts/dist/cli.js fetch --project cs --article "Přerušovaný půst" --start 2024-01 --end 2024-12 --points
```

Same article options as analyze, plus:

| Option | Default | Meaning |
|---|---|---|
| `--start`, `--end` | 24 months / 730 days back, last complete period | `YYYY-MM` or `YYYY-MM-DD` |
| `--granularity <g>` | monthly | monthly or daily |
| `--redirects`, `--access`, `--agent`, `--verbose` | | As for analyze |
| `--skip-aggregate` | off | Do not fetch each edition's total views |
| `--points` | off | Include every `[period, views]` pair |

## cache — local data store

```bash
node scripts/dist/cli.js cache stats
node scripts/dist/cli.js cache clear [--project <code>]
```

Downloaded data is kept in `.cache/wit.sqlite` in the skill directory (or `~/.cache/wikipedia-interest-trends` if that is not writable; override with the `WIT_CACHE_DIR` environment variable). Past months are never re-downloaded; title lookups are kept for 30 days.

## Errors

`ok: false` with a message in `errors[0]` that says what to do, for example a disambiguation page with specific titles to pick from, or a misspelled title with a suggestion. Exit code 1 for errors, 0 otherwise.
