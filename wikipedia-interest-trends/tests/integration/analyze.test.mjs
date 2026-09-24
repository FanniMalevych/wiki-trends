// The assignment's three example queries, run through `analyze` against recorded
// responses (tests/fixtures/http). Fixed date ranges keep the recordings valid.
// Refresh with: npm run fixtures:record
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
    const r = spawnSync(process.execPath, [cli, "analyze", ...args], { encoding: "utf8", env });
    assert.equal(r.stderr, "");
    return { status: r.status, out: JSON.parse(r.stdout) };
  };
}

const DIRECTIONS = ["growing", "declining", "stable", "unclear"];

function assertWellFormed(e) {
  assert.ok(DIRECTIONS.includes(e.trend.direction));
  assert.ok(e.trend.ci95[0] <= e.trend.perYear && e.trend.perYear <= e.trend.ci95[1]);
  assert.ok(["high", "medium", "low"].includes(e.confidence.level));
  assert.ok(e.confidence.reasons.length >= 1);
  assert.match(e.summary, new RegExp(`^${e.project} `));
}

test("Q1: intermittent fasting, Polish vs Czech, last two years", () => {
  const run = makeRunner();
  const r = run("--title", "Intermittent fasting", "--from", "en", "--lang", "pl,cs", "--start", "2024-09", "--end", "2026-08", "--verbose");
  assert.equal(r.status, 0);
  const [cs] = r.out.data.editions;
  assert.equal(r.out.data.editions.length, 1);
  assert.equal(cs.project, "cs.wikipedia");
  assert.equal(cs.months, 24);
  assertWellFormed(cs);
  assert.equal(cs.seasonality, null); // 24 months is too short
  assert.notEqual(cs.confidence.level, "high");
  assert.deepEqual(r.out.data.missing.map((m) => m.project), ["pl.wikipedia"]);
  assert.match(r.out.warnings[0], /pl\.wikipedia/);

  // A follow-up question on the same data is answered from the cache.
  const again = run("--qid", "Q1666254", "--lang", "cs", "--start", "2024-09", "--end", "2026-08", "--verbose");
  assert.equal(again.out.data.requests, 0);
  assert.deepEqual(again.out.data.editions[0].trend, cs.trend);
});

test("Q2: astronomy in Ukrainian, five years, with a reliability verdict", () => {
  const r = makeRunner()("--title", "Astronomy", "--from", "en", "--lang", "uk", "--start", "2021-09", "--end", "2026-08");
  const [uk] = r.out.data.editions;
  assertWellFormed(uk);
  assert.equal(uk.months, 60);
  assert.equal(uk.trend.direction, "declining");
  assert.ok(uk.seasonality.strength > 0.5);
  assert.equal(uk.seasonality.peak, "Sep"); // school year
  assert.ok(uk.confidence.reasons.some((x) => /bot-detection/.test(x)));
  assert.equal(r.out.data.ranking, undefined); // single edition
});

test("Q3: learning English across editions, ranked", () => {
  const r = makeRunner()(
    "--title", "English as a second or foreign language", "--from", "en", "--lang", "de,es,fr,pl",
    "--start", "2021-09", "--end", "2026-08",
  );
  assert.equal(r.status, 0);
  const found = r.out.data.editions.map((e) => e.project);
  assert.deepEqual(found, ["de.wikipedia", "es.wikipedia"]);
  r.out.data.editions.forEach(assertWellFormed);
  assert.deepEqual(r.out.data.ranking.map((x) => x.rank), [1, 2]);
  assert.deepEqual(r.out.data.ranking.map((x) => x.project).toSorted(), found);
  assert.deepEqual(r.out.data.missing.map((m) => m.project).toSorted(), ["fr.wikipedia", "pl.wikipedia"]);
});
