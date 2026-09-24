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
  assert.equal(first.out.data.requests, 2);

  const again = run("fetch", ...CS, "--start", "2024-01", "--end", "2024-12");
  assert.equal(again.out.data.requests, 0);
  assert.deepEqual(again.out.data.series[0].source, { cached: 12, fetched: 0 });
  assert.equal(again.out.data.series[0].total, article.total);
});

test("a wider follow-up range only downloads the new part", () => {
  const run = makeRunner();
  run("fetch", ...CS, "--start", "2024-01", "--end", "2024-12");
  const wider = run("fetch", ...CS, "--start", "2023-01", "--end", "2024-12");
  assert.equal(wider.out.data.requests, 2); // 2023 for the article and for the edition total
  assert.deepEqual(wider.out.data.series[0].source, { cached: 12, fetched: 12 });
});

test("an article missing from an edition is a warning, not an error", () => {
  const run = makeRunner();
  const r = run("fetch", "--project", "pl", "--article", "Post przerywany", "--start", "2024-01", "--end", "2024-03");
  assert.equal(r.status, 0);
  assert.equal(r.out.data.series[0].total, 0);
  assert.match(r.out.warnings[0], /No views for "Post_przerywany" on pl\.wikipedia/);
});

test("daily data with points, several articles in one edition", () => {
  const run = makeRunner();
  const r = run(
    "fetch", "--project", "uk", "--article", "Астрономія", "--article", "Астрофізика",
    "--start", "2024-02", "--end", "2024-02", "--granularity", "daily", "--points", "--skip-aggregate",
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
  assert.equal(stats.series, 2);
  assert.equal(stats.points, 24);
  assert.equal(run("cache", "clear").out.data.removedSeries, 2);
  assert.equal(run("cache", "stats").out.data.points, 0);
});
