---
name: wikipedia-interest-trends
description: Measures whether public interest in a topic is growing, stable or declining in one or more Wikipedia language editions, using Wikipedia pageview statistics, and says how far each trend can be trusted. Use when asked whether interest in a topic is rising, to compare interest between languages or countries, or to pick which language audiences to investigate next (e.g. for a course, product or localization decision).
---

# Wikipedia Interest Trends

Pageviews show **attention**, not willingness to pay. Present results as a signal for what to validate next, never as proof of demand.

All commands run from this skill's directory and print one line of JSON: `{ok, data, warnings, errors}`. Never compute trend numbers yourself: use the command output.

## Workflow

1. **Identify the topic and languages.**
   - Topic → an English Wikipedia article title (e.g. "Intermittent fasting", "Astronomy").
   - Languages → edition codes (see the table below), e.g. Polish = `pl`, Czech = `cs`.
   - Period → `--months`: "last two years" = `--months 24`, "last year" = `--months 12`. No period given → omit it (default: 5 years, the most reliable).

2. **Run `analyze`** (it finds the article in each language automatically):
   ```bash
   node scripts/dist/cli.js analyze --title "Intermittent fasting" --from en --lang pl,cs
   ```
   Up to 20 languages per call. Do not calculate dates yourself.

3. **If `ok` is false,** read `errors[0]`. It says what to do: pick one of the suggested titles (disambiguation page or misspelling) and run again.

4. **Report each edition** in `data.editions`:
   - `summary` — one sentence; quote it or paraphrase it closely.
   - `trend.direction` (growing / declining / stable / unclear) and `trend.perYear` with `trend.ci95` (% per year).
   - `confidence.level` (high / medium / low) and the 1–3 most important `confidence.reasons`.
   - `monthlyViews` (audience size) and `perMillion` (interest relative to the edition's size, comparable across languages).

5. **Report gaps.** Every entry in `data.missing` and every item in `warnings` must be mentioned: a language with no article usually means the topic is not covered there.

6. **Several languages:** use `data.ranking` (already ordered: growing before stable before unclear before declining, then by confidence). Recommend the top 1–2 to investigate and say why, including confidence.

## When a topic has no article in some languages

First report the gap: no article usually means the topic is not covered in that language.
Then, if a result for that language matters, try **one** broader English title with `analyze` (e.g. "Intermittent fasting" → "Fasting", "English as a second or foreign language" → "English language") and say clearly that it measures the broader topic. Do not guess titles in other languages and do not use `resolve` to search: `analyze` finds each language's article itself.

## Follow-up questions

Run `analyze` again with the changed options (other languages, other period). Data already downloaded is reused from a local cache, so repeating or widening a query is cheap.

## Interpreting results

- Trends are measured as a **share of all views in that edition**, so a shrinking or growing Wikipedia does not create a fake trend. `trend.rawViewsPerYear` is the raw count trend, for reference only.
- `confidence.level` is how far the direction can be trusted. `low` or `unclear` → say the data does not support a conclusion.
- Low traffic (under ~100 views/month) is noisy: do not rank audiences on it alone.
- Data after May 2025 is affected by a Wikimedia bot-detection change. The analysis accounts for it and mentions it in the reasons; repeat that caveat briefly.
- More detail: [references/interpretation.md](references/interpretation.md). All commands and options: [references/cli.md](references/cli.md).

## Language codes

| Language | Code | Language | Code | Language | Code |
|---|---|---|---|---|---|
| English | en | Polish | pl | Ukrainian | uk |
| German | de | Czech | cs | Russian | ru |
| French | fr | Slovak | sk | Turkish | tr |
| Spanish | es | Hungarian | hu | Arabic | ar |
| Italian | it | Romanian | ro | Hindi | hi |
| Portuguese | pt | Dutch | nl | Japanese | ja |
| Swedish | sv | Greek | el | Chinese | zh |
| Norwegian (Bokmål) | no | Finnish | fi | Korean | ko |
