// Runs the real CLI against recorded Wikimedia responses (tests/fixtures/http).
// Offline and deterministic by default. To refresh fixtures from the live API:
//   npm run fixtures:record
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../scripts/dist/cli.js", import.meta.url));

function makeRunner() {
  const env = {
    ...process.env,
    WIT_CACHE_DIR: mkdtempSync(join(tmpdir(), "wit-int-")),
    WIT_HTTP_MODE: process.env.WIT_HTTP_MODE ?? "replay",
  };
  return (...args) => {
    const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env });
    assert.equal(r.stderr, "", "stderr must stay empty so agents see clean output");
    assert.equal(r.stdout.trimEnd().split("\n").length, 1, "output is a single JSON line");
    return { status: r.status, out: JSON.parse(r.stdout) };
  };
}

const CS = ["fetch", "--project", "cs", "--article", "Přerušovaný půst", "--verbose"];

test("fetch returns the article and edition total, then serves repeats from cache", () => {
  const run = makeRunner();
  const first = run(...CS, "--start", "2024-01", "--end", "2024-12");
  assert.equal(first.status, 0);
  const [article] = first.out.data.articles;
  const [aggregate] = first.out.data.aggregates;
  assert.equal(article.article, "Přerušovaný_půst");
  assert.equal(article.periods, 12);
  assert.ok(article.total > 0);
  assert.equal(article.redirects, undefined); // off by default
  assert.ok(aggregate.total > article.total * 1000);
  assert.equal(first.out.data.requests, 3); // title lookup + article + edition total

  const again = run(...CS, "--start", "2024-01", "--end", "2024-12");
  assert.equal(again.out.data.requests, 0);
  assert.deepEqual(again.out.data.articles[0].source, { cached: 12, fetched: 0 });
  assert.equal(again.out.data.articles[0].total, article.total);
});

test("a wider follow-up range only downloads the new part", () => {
  const run = makeRunner();
  run(...CS, "--start", "2024-01", "--end", "2024-12");
  const wider = run(...CS, "--start", "2023-01", "--end", "2024-12");
  assert.equal(wider.out.data.requests, 2); // 2023 for the article and for the edition total
  assert.deepEqual(wider.out.data.articles[0].source, { cached: 12, fetched: 12 });
});

test("debug fields appear only with --verbose", () => {
  const r = makeRunner()("fetch", "--project", "cs", "--article", "Přerušovaný půst", "--start", "2024-01", "--end", "2024-12");
  assert.equal(r.out.data.requests, undefined);
  assert.equal(r.out.data.cacheFile, undefined);
  assert.equal(r.out.data.articles[0].source, undefined);
});

test("an article missing from an edition is a warning, not an error", () => {
  const r = makeRunner()("fetch", "--project", "pl", "--article", "Post przerywany", "--start", "2024-01", "--end", "2024-03");
  assert.equal(r.status, 0);
  assert.deepEqual(r.out.data.articles, []);
  assert.equal(r.out.data.aggregates.length, 1);
  assert.equal(r.out.data.missing[0].project, "pl.wikipedia");
  assert.match(r.out.warnings[0], /"Post_przerywany" does not exist on pl\.wikipedia/);
});

test("fetch by topic resolves each edition and reports the gap", () => {
  const run = makeRunner();
  const r = run("fetch", "--title", "Intermittent fasting", "--from", "en", "--lang", "pl,cs,uk", "--start", "2023-09", "--end", "2025-08", "--verbose");
  assert.equal(r.status, 0);
  assert.equal(r.out.data.qid, "Q1666254");
  assert.deepEqual(r.out.data.articles.map((a) => [a.project, a.article, a.periods]), [
    ["cs.wikipedia", "Přerušovaný_půst", 24],
    ["uk.wikipedia", "Інтервальне_голодування", 24],
  ]);
  assert.deepEqual(r.out.data.aggregates.map((g) => g.project), ["pl.wikipedia", "cs.wikipedia", "uk.wikipedia"]);
  assert.deepEqual(r.out.data.missing.map((m) => m.project), ["pl.wikipedia"]);

  const byQid = run("fetch", "--qid", "Q1666254", "--lang", "pl,cs,uk", "--start", "2023-09", "--end", "2025-08", "--verbose");
  assert.equal(byQid.out.data.requests, 0);
});

test("--redirects adds the most-viewed redirects and reports them", () => {
  const run = makeRunner();
  const args = ["fetch", "--project", "en", "--article", "Intermittent fasting", "--start", "2025-01", "--end", "2025-06", "--skip-aggregate", "--verbose"];
  const withRedirects = run(...args, "--redirects", "10").out.data.articles[0];
  assert.equal(withRedirects.redirects.titles.length, 10);
  assert.ok(withRedirects.redirects.titles.includes("5:2_diet"));
  assert.ok(withRedirects.redirects.views > 0 && withRedirects.redirects.share < 0.5);

  const plain = run(...args);
  assert.equal(plain.out.data.articles[0].total, withRedirects.total - withRedirects.redirects.views);
  assert.equal(plain.out.data.requests, 0);
});

test("daily data with points, several articles in one edition", () => {
  const r = makeRunner()(
    "fetch", "--project", "uk", "--article", "Астрономія", "--article", "Астрофізика",
    "--start", "2024-02", "--end", "2024-02", "--granularity", "daily", "--points", "--skip-aggregate",
  );
  assert.equal(r.out.data.articles.length, 2);
  for (const a of r.out.data.articles) {
    assert.equal(a.points.length, 29);
    assert.equal(a.points[0][0], "2024-02-01");
  }
});

test("invalid input returns a JSON error and exit code 1", () => {
  const run = makeRunner();
  const mismatch = run("fetch", "--project", "cs", "--project", "uk", "--article", "A", "--article", "B", "--article", "C");
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.out.ok, false);
  assert.match(mismatch.out.errors[0], /2 --project and 3 --article/);
  assert.match(run("fetch", "--qid", "Q1").out.errors[0], /--lang is required/);
  assert.match(run("fetch", "--project", "en.wiktionary").out.errors[0], /Invalid edition/);
});

test("cache stats reflects fetched data and clear removes it", () => {
  const run = makeRunner();
  run(...CS, "--start", "2024-01", "--end", "2024-12");
  const stats = run("cache", "stats").out.data;
  assert.deepEqual([stats.series, stats.points, stats.lookups], [2, 24, 1]);
  assert.deepEqual(run("cache", "clear").out.data, { removedSeries: 2, removedLookups: 1, project: "all" });
  assert.equal(run("cache", "stats").out.data.points, 0);
});
