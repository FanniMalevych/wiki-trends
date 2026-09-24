import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../../scripts/dist/cache/db.js";
import { loadSeries } from "../../scripts/dist/series.js";

const realFetch = globalThis.fetch;
let requested;

/** Fake Pageviews API: returns `views(period)` for every month in the range, skipping zeros like the real API. */
function fakeApi(views) {
  requested = [];
  globalThis.fetch = async (url) => {
    const [, start, end] = /monthly\/(\d{6})\d{2}\/(\d{6})\d{2}$/.exec(url);
    requested.push(`${start}-${end}`);
    const items = [];
    for (let y = +start.slice(0, 4), m = +start.slice(4); `${y}${String(m).padStart(2, "0")}` <= end; m === 12 ? (y++, (m = 1)) : m++) {
      const period = `${y}-${String(m).padStart(2, "0")}`;
      if (views(period) > 0) items.push({ timestamp: `${y}${String(m).padStart(2, "0")}0100`, views: views(period) });
    }
    return new Response(JSON.stringify({ items }), { status: items.length ? 200 : 404 });
  };
}

const key = { kind: "article", project: "cs.wikipedia", article: "Foo", access: "all-access", agent: "user", granularity: "monthly" };
const NOW = Date.parse("2026-09-24T00:00:00Z");
let cache;

beforeEach(() => {
  process.env.WIT_HTTP_MODE = "live";
  cache = new Cache(join(mkdtempSync(join(tmpdir(), "wit-series-")), "wit.sqlite"));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cache.close();
});

test("fills periods the API omits with zeros", async () => {
  fakeApi((p) => (p === "2024-02" ? 0 : 10));
  const r = await loadSeries(cache, key, "2024-01", "2024-03", NOW);
  assert.deepEqual(r.points.map((p) => p.views), [10, 0, 10]);
  assert.equal(r.fetchedPeriods, 3);
});

test("a fully cached range makes no requests", async () => {
  fakeApi(() => 5);
  await loadSeries(cache, key, "2024-01", "2024-12", NOW);
  requested = [];
  const r = await loadSeries(cache, key, "2024-03", "2024-06", NOW);
  assert.deepEqual(requested, []);
  assert.equal(r.cachedPeriods, 4);
});

test("only missing ranges are downloaded, one request per gap", async () => {
  fakeApi(() => 5);
  await loadSeries(cache, key, "2024-03", "2024-04", NOW);
  await loadSeries(cache, key, "2024-08", "2024-08", NOW);
  requested = [];
  const r = await loadSeries(cache, key, "2024-01", "2024-10", NOW);
  assert.deepEqual(requested, ["202401-202402", "202405-202407", "202409-202410"]);
  assert.equal(r.cachedPeriods, 3);
  assert.equal(r.points.length, 10);
});

test("a 404 over the whole range is cached as zeros", async () => {
  fakeApi(() => 0);
  const r = await loadSeries(cache, key, "2024-01", "2024-02", NOW);
  assert.deepEqual(r.points.map((p) => p.views), [0, 0]);
  requested = [];
  await loadSeries(cache, key, "2024-01", "2024-02", NOW);
  assert.deepEqual(requested, []);
});

test("recent periods are re-downloaded until they are final", async () => {
  fakeApi(() => 5);
  const early = Date.parse("2026-09-02T00:00:00Z"); // August not final until 2026-09-04
  await loadSeries(cache, key, "2026-07", "2026-08", early);
  requested = [];
  fakeApi(() => 6);
  const r = await loadSeries(cache, key, "2026-07", "2026-08", NOW);
  assert.deepEqual(requested, ["202608-202608"]);
  assert.deepEqual(r.points.map((p) => p.views), [5, 6]);
});
