# Interpreting the results

## What the numbers measure

- **Pageviews are attention.** Someone reading an article is curious, studying, or following news. That is a useful early signal for what to validate next, not evidence that people will pay for a product.
- **Trends use the share of all views in that edition.** Article views are divided by the edition's total human views each month. This removes changes that affect a whole Wikipedia, such as people getting answers from search engines or AI assistants instead of clicking through, or Wikimedia filtering more bot traffic. `rawViewsPerYear` shows the raw count trend for comparison.
- **`perMillion` compares interest across languages** of different sizes: 20 views per million edition views means the topic takes a bigger slice of that audience's attention than 5 per million elsewhere.
- **`monthlyViews` is audience size.** A fast-growing topic with 50 views a month is still a tiny audience.

## How the trend is estimated

1. Log of the monthly share, so change is expressed in % per year.
2. With 36+ months, the typical month-of-year pattern (e.g. September school peaks, January resolutions) is removed first.
3. Theil–Sen slope: the median of all pairwise slopes, so a single viral month cannot create a trend.
4. Mann–Kendall test with the Hamed–Rao correction for autocorrelation (neighbouring months resemble each other, which otherwise overstates significance). The 95% interval uses the same corrected variance, so interval and p-value agree.

`direction` is **growing** or **declining** only when the trend is significant (p < 0.05) and the whole interval is on one side of zero; **stable** when the interval lies within ±5% per year; otherwise **unclear**.

## Confidence

The score starts at 100 and loses points for each weakness, which is listed in `reasons`:

| Weakness | Effect |
|---|---|
| Fewer than 12 months with views | no trend at all; low |
| No clear direction | −35, and capped at low |
| Fewer than 36 months (no seasonal adjustment) | −25, and capped at medium |
| Low traffic (under 100 views/month) / modest (under 1000) | −30 / −10 |
| Only moderately significant (0.01 ≤ p < 0.05) | −10 |
| Spike months (at least 1.5× the expected level) carry over 10% / 20% of views | −10 / −20 |
| Sudden level change | −20, or −10 if it matches a known measurement event |
| Last 12 months move against the trend by over 5% | −15 |
| Raw and share trends point in opposite directions | −5 |
| Window crosses a known measurement change (May 2025) | −5 |

high ≥ 70, medium 40–69, low < 40.

## Caveats to pass on

- **Missing editions:** no article in a language usually means the topic is not covered there under that name. It can also be covered inside a broader article; see the SKILL.md advice on trying a broader title.
- **Level changes** (`step`) can be real events (a war, a pandemic, a viral story), an article rename or merge, a new link from a popular page, or a measurement change. The analysis cannot tell which unless it matches a known event.
- **Spikes** are usually news or social media. The trend is robust to them, but a topic driven by bursts is weaker evidence of steady interest.
- **May 2025 bot-detection change:** Wikimedia reported about 8% fewer human pageviews after improving bot detection. Shares are affected much less than raw counts.
- **One language is not one country:** Spanish, English, French and Arabic editions are read across many countries.
- **Redirects** are not counted by default. `--redirects n` adds the most-viewed alternative titles but can widen the topic (e.g. "5:2 diet" counted as "Intermittent fasting").
