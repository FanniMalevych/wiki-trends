# How this skill was built, and how the AI's work was checked

The assignment asks how AI tools were used during development and how their output was verified. Short version: an AI coding assistant wrote most of the code, tests and documentation under the developer's direction; nothing was accepted on its word. Every part was checked against something independent of the AI: the live APIs, recorded real data, an independent reference implementation, synthetic data with known answers, rendered output, or a different AI model actually using the skill.

## Tools and roles

| Who / what | Role |
|---|---|
| Developer | Goals and priorities, all product decisions (stack, scope, defaults, which model to test on), approving each phase's plan, reviewing its results, commits |
| Claude Code (Claude Opus 5.5, in the Claude desktop app) | Implementation, tests, documentation, design proposals and self-review, running the checks listed below |
| Gemini 3.5 Flash (Google AI Studio, free tier) | End-to-end test agent: a different, cheap model that had to use the skill from `SKILL.md` alone |
| Python standard library | Independent reference for the statistics (`tests/reference/stats_reference.py`) |
| Anthropic's data-visualization guidance and palette validator | Chart colors checked for color-blind separation and contrast |

**Research phase.** _To be completed by the author: how the brief and the research notes (Agent Skills format, Pageviews API, statistical methods, tooling choices) were produced, and with which tools._

## How the work was organised

Work went in phases, each proposed as a plan, approved by the developer, implemented, verified and committed:

| Phase | Result |
|---|---|
| 0 | TypeScript skeleton, build to committed `scripts/dist/`, Node pin |
| 1 | Pageviews client, SQLite cache that only downloads missing months, recorded-response tests |
| 2 | Topic → article in each language via Wikidata; misspelling and disambiguation handling |
| Review | The AI reviewed its own code at the developer's request; the fixes are listed below |
| 3 | Trend analysis with a confidence score and reasons |
| — | `SKILL.md`, references and an end-to-end harness, tested early on a cheap model |
| 4 | SVG charts and a one-page HTML report |

## How each part was verified

**External APIs: probed live before writing code.** Assumptions about the Wikimedia and Wikidata APIs were tested with real requests first. This caught behaviour the AI would otherwise have guessed wrong:
- Monthly requests return partial months, so ranges are always requested as whole months.
- A missing article returns 404 for the whole range, and zero-view months are simply absent.
- Polish Wikipedia has **no** "intermittent fasting" article: one of the assignment's own examples.
- Title-only search is disabled on Wikipedia; full-text search returns unrelated pages ("Charlie Kirk" for "post przerywany").
- Disambiguation pages list links alphabetically, so they could not be used as suggestions.
- Wikidata lists Abstract Wikipedia among language editions.

**Integration tests use recorded real responses.** `npm run fixtures:record` saves real API responses; tests replay them offline, so they are realistic and deterministic. Integration tests run the real CLI and check that nothing is printed to stderr (agents often read both streams).

**Statistics: checked against an independent implementation.** `tests/reference/stats_reference.py` is a plain-Python transcription of SciPy's `theilslopes` and pymannkendall's Hamed–Rao test, written from their published source rather than from our TypeScript. On seven series, including real Czech pageviews, our results match to 1e-12 (slopes, intervals, variances) and 2e-7 (p-values; the gap is our `erfc` approximation, checked against Python's exact `math.erfc`). Small cases were also checked by hand. Its `--check` mode compares the reference with the real SciPy and pymannkendall packages; **that has not been run yet** because it needs those packages installed.

**Analysis: synthetic data with known answers,** plus real data inspected by eye. Unit tests plant a trend, seasonality, spikes, a level shift, a shrinking edition, low traffic and short histories, and check each is recovered. The surprising Ukrainian astronomy result (declining about 29% a year) was checked against the raw monthly numbers before it was accepted.

**Reports: rendered and looked at** in a browser, in light and dark mode and at A4 proportions.

**Skill usability: a different, cheap model used it.** `npm run e2e` gives a model only the skill's name and description plus two tools (read a file, run the CLI) and checks what it does. See [End-to-end results](#end-to-end-results).

**Consistency checks:** a test fails if any command option is missing from `references/cli.md`, if `SKILL.md` breaks the Agent Skills format rules, or if a link is broken. `npm run check` fails if the committed `scripts/dist/` does not match the source; CI runs the tests and this check on Node 22 and 24.

## Mistakes the checks caught

The AI's output was wrong in these cases; each was caught by the check named, and fixed:

| Mistake | Caught by |
|---|---|
| The AI typed "real" Czech pageview numbers into the reference script from memory; most were invented | Its own re-check against the recorded data; replaced with the recorded values |
| The warning filter for `node:sqlite` never worked (ES modules load built-ins before any code runs) | Running on Node 22.6; now loaded on demand |
| Step detector missed a planted +65% level shift (it removed the trend first, which absorbed the step) | Synthetic unit test; now fits trend and step together |
| The 95% interval could exclude zero while the trend test said "not significant" | Live output for Spanish; the interval now uses the same autocorrelation-corrected variance |
| Short histories could still get "high" confidence | Unit test; capped at medium without seasonal adjustment |
| A follow-up question in other languages repeated a Wikidata request | Integration test; the item is now fetched once for all languages |
| Redirect ranking by the last 60 days missed renamed articles, the case it was meant for | Design review; redirects are now opt-in |
| `cache stats` counted data points as articles | Manual run |
| Chart: overlapping year labels, "−0%", an over-stretched single panel, wasted axis range | Rendering the report and looking at it |
| Test harness: a grader regex that never matched, retrying for 8 minutes on an exhausted daily quota, no request timeout | Unit tests and the first live runs |

## End-to-end results

On Gemini 3.5 Flash (free tier):

- **Astronomy in Ukrainian: passed.** The model read `SKILL.md`, ran `analyze` once and reported the decline with its confidence and reasons, using 2 tool calls.
- **Intermittent fasting, Polish vs Czech: correct answer, but inefficient.** It computed a 25-month window instead of 24 and guessed four Polish titles. This led to the `--months` option and clearer rules for missing articles in `SKILL.md`.
- **Remaining cases: not run yet.** The free tier's daily quota ran out.

_To be updated after the full run of `tests/evals/evals.json`, with the model, date and pass rate._

## Known limitations

- **Language matching** relies on Wikidata links. A topic covered inside a broader article in some language is reported as missing; the skill tells the agent to try one broader title.
- **Suggestions for misspelled or missing titles** use a word-stem heuristic that works for space-separated languages. For Chinese, Japanese or Thai it tends to offer nothing rather than something wrong.
- **Level changes are detected, not explained.** The analysis only names a cause when a change matches a known measurement event.
- **Language is not country:** Spanish, English, French and Arabic editions are read in many countries.
