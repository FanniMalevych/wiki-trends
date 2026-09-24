// Runs the real CLI against recorded Wikimedia responses (tests/fixtures/http).
// Offline and deterministic by default. To refresh fixtures from the live API:
//   WIT_HTTP_MODE=record npm run test:integration
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
    return { status: r.status, out: JSON.parse(r.stdout) };
  };
}

const CS = ["--project", "cs", "--article", "Přerušovaný půst"];

test("fetch returns article and edition totals, then serves repeats from cache", () => {
  const run = makeRunner();
  const first = run("fetch", ...CS, "--start", "2024-01", "--end", "2024-12");
  assert.equal(first.status, 0);
  assert.equal(first.out.ok, true);
  const [article, aggregate] = first.out.data.series;
  assert.equal(article.article, "Přerušovaný_půst");
  assert.equal(article.periods, 12);
  assert.ok(article.total > 0);
  assert.equal(aggregate.kind, "aggregate");
  assert.ok(aggregate.total > article.total * 1000);
  assert.ok(first.out.data.requests >= 3); // title lookup + article + edition total (+ redirects)

  const again = run("fetch", ...CS, "--start", "2024-01", "--end", "2024-12");
  assert.equal(again.out.data.requests, 0);
  assert.equal(again.out.data.series[0].source.fetched, 0);
  assert.equal(again.out.data.series[0].total, article.total);
});

test("a wider follow-up range only downloads the new part", () => {
  const run = makeRunner();
  run("fetch", ...CS, "--start", "2024-01", "--end", "2024-12");
  const wider = run("fetch", ...CS, "--start", "2023-01", "--end", "2024-12");
  const titles = 1 + (wider.out.data.series[0].redirects?.included ?? 0);
  // Title lookups are cached; only 2023 is downloaded, for each title and for the edition total.
  assert.equal(wider.out.data.requests, titles + 1);
  assert.deepEqual(wider.out.data.series[0].source, { cached: 12 * titles, fetched: 12 * titles });
});

test("an article missing from an edition is a warning, not an error", () => {
  const run = makeRunner();
  const r = run("fetch", "--project", "pl", "--article", "Post przerywany", "--start", "2024-01", "--end", "2024-03");
  assert.equal(r.status, 0);
  assert.deepEqual(r.out.data.series.map((s) => s.kind), ["aggregate"]);
  assert.equal(r.out.data.missing[0].project, "pl.wikipedia");
  assert.match(r.out.warnings[0], /"Post_przerywany" does not exist on pl\.wikipedia/);
});

test("fetch by topic resolves each edition and reports the gap", () => {
  const run = makeRunner();
  const r = run("fetch", "--title", "Intermittent fasting", "--from", "en", "--lang", "pl,cs,uk", "--start", "2023-09", "--end", "2025-08");
  assert.equal(r.status, 0);
  assert.equal(r.out.data.qid, "Q1666254");
  const articles = r.out.data.series.filter((s) => s.kind === "article");
  assert.deepEqual(articles.map((s) => [s.project, s.article]), [
    ["cs.wikipedia", "Přerušovaný_půst"],
    ["uk.wikipedia", "Інтервальне_голодування"],
  ]);
  assert.deepEqual(r.out.data.series.filter((s) => s.kind === "aggregate").map((s) => s.project), ["pl.wikipedia", "cs.wikipedia", "uk.wikipedia"]);
  assert.deepEqual(r.out.data.missing.map((m) => m.project), ["pl.wikipedia"]);
  assert.ok(articles.every((s) => s.periods === 24));

  assert.equal(run("fetch", "--qid", "Q1666254", "--lang", "pl,cs,uk", "--start", "2023-09", "--end", "2025-08").out.data.requests, 0);
});

test("redirect views are added to the article and reported", () => {
  const run = makeRunner();
  const r = run("fetch", "--project", "en", "--article", "Intermittent fasting", "--start", "2025-01", "--end", "2025-06", "--skip-aggregate");
  const s = r.out.data.series[0];
  assert.equal(s.redirects.included, 10);
  assert.ok(s.redirects.views > 0 && s.redirects.share < 0.5);
  assert.ok(s.redirects.titles.includes("5:2_diet"));

  const plain = run("fetch", "--project", "en", "--article", "Intermittent fasting", "--start", "2025-01", "--end", "2025-06", "--skip-aggregate", "--redirects", "0");
  assert.equal(plain.out.data.series[0].redirects, undefined);
  assert.equal(plain.out.data.series[0].total, s.total - s.redirects.views);
  assert.equal(plain.out.data.requests, 0);
});

test("daily data with points, several articles in one edition", () => {
  const run = makeRunner();
  const r = run(
    "fetch", "--project", "uk", "--article", "Астрономія", "--article", "Астрофізика",
    "--start", "2024-02", "--end", "2024-02", "--granularity", "daily", "--points", "--skip-aggregate", "--redirects", "0",
  );
  assert.equal(r.out.ok, true);
  assert.equal(r.out.data.series.length, 2);
  for (const s of r.out.data.series) {
    assert.equal(s.points.length, 29);
    assert.equal(s.points[0][0], "2024-02-01");
  }
});

test("invalid input returns a JSON error and exit code 1", () => {
  const run = makeRunner();
  const r = run("fetch", "--project", "cs", "--project", "uk", "--article", "A", "--article", "B", "--article", "C");
  assert.equal(r.status, 1);
  assert.equal(r.out.ok, false);
  assert.match(r.out.errors[0], /2 --project and 3 --article/);
});

test("cache stats reflects fetched data and clear removes it", () => {
  const run = makeRunner();
  run("fetch", ...CS, "--start", "2024-01", "--end", "2024-12");
  const stats = run("cache", "stats").out.data;
  assert.ok(stats.series >= 2);
  assert.equal(stats.points, 12 * stats.series);
  assert.ok(stats.lookups >= 1);
  const cleared = run("cache", "clear").out.data;
  assert.equal(cleared.removedSeries, stats.series);
  assert.equal(cleared.removedLookups, stats.lookups);
  assert.equal(run("cache", "stats").out.data.points, 0);
});
