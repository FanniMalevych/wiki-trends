import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeProject, normalizeTitle, seriesUrl } from "../../scripts/dist/wiki/pageviews.js";

const BASE = "https://wikimedia.org/api/rest_v1/metrics/pageviews";

test("normalizeProject accepts short and full forms", () => {
  assert.equal(normalizeProject("pl"), "pl.wikipedia");
  assert.equal(normalizeProject(" PL.wikipedia "), "pl.wikipedia");
  assert.equal(normalizeProject("uk.wikipedia.org"), "uk.wikipedia");
  assert.equal(normalizeProject("https://cs.wikipedia.org/wiki/Foo"), "cs.wikipedia");
  assert.equal(normalizeProject("de.wikiversity"), "de.wikiversity");
  assert.throws(() => normalizeProject("pl wiki"), /Invalid project/);
});

test("normalizeTitle matches how the API stores titles", () => {
  assert.equal(normalizeTitle("intermittent fasting"), "Intermittent_fasting");
  assert.equal(normalizeTitle("  Post   przerywany "), "Post_przerywany");
  assert.equal(normalizeTitle("астрономія"), "Астрономія");
  assert.equal(normalizeTitle("éducation"), "Éducation");
  assert.equal(normalizeTitle("AC/DC"), "AC/DC");
  assert.throws(() => normalizeTitle("   "), /empty/);
});

test("seriesUrl builds per-article URLs with encoded titles", () => {
  const key = { kind: "article", project: "cs.wikipedia", article: "Přerušovaný_půst", access: "all-access", agent: "user", granularity: "monthly" };
  assert.equal(
    seriesUrl(key, "2024-01", "2024-02"),
    `${BASE}/per-article/cs.wikipedia/all-access/user/P%C5%99eru%C5%A1ovan%C3%BD_p%C5%AFst/monthly/20240101/20240229`,
  );
  // "/" in a title must be encoded or the API treats it as a path separator.
  assert.match(seriesUrl({ ...key, article: "AC/DC" }, "2024-01", "2024-01"), /\/AC%2FDC\//);
});

test("seriesUrl builds aggregate URLs", () => {
  const key = { kind: "aggregate", project: "uk.wikipedia", article: "", access: "mobile-web", agent: "user", granularity: "daily" };
  assert.equal(seriesUrl(key, "2024-01-01", "2024-01-31"), `${BASE}/aggregate/uk.wikipedia/mobile-web/user/daily/20240101/20240131`);
});
