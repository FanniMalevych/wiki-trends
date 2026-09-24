import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../../scripts/dist/cache/db.js";

const key = (over = {}) => ({
  kind: "article",
  project: "cs.wikipedia",
  article: "Foo",
  access: "all-access",
  agent: "user",
  granularity: "monthly",
  ...over,
});

const tempCache = () => new Cache(join(mkdtempSync(join(tmpdir(), "wit-cache-")), "wit.sqlite"));

test("save and load round-trip within a range", () => {
  const cache = tempCache();
  cache.save(key(), [{ period: "2024-01", views: 5 }, { period: "2024-02", views: 0 }, { period: "2024-03", views: 7 }], 1000);
  const got = cache.load(key(), "2024-02", "2024-03");
  assert.deepEqual([...got], [["2024-02", { views: 0, fetchedAt: 1000 }], ["2024-03", { views: 7, fetchedAt: 1000 }]]);
  cache.close();
});

test("save overwrites earlier values for the same period", () => {
  const cache = tempCache();
  cache.save(key(), [{ period: "2024-01", views: 5 }], 1000);
  cache.save(key(), [{ period: "2024-01", views: 6 }], 2000);
  assert.deepEqual(cache.load(key(), "2024-01", "2024-01").get("2024-01"), { views: 6, fetchedAt: 2000 });
  cache.close();
});

test("series are kept apart by every key field", () => {
  const cache = tempCache();
  cache.save(key(), [{ period: "2024-01", views: 1 }], 1);
  for (const other of [{ agent: "all-agents" }, { access: "desktop" }, { granularity: "daily" }, { kind: "aggregate", article: "" }, { project: "pl.wikipedia" }]) {
    assert.equal(cache.load(key(other), "2024-01", "2024-01").size, 0, JSON.stringify(other));
  }
  cache.close();
});

test("stats and clear by project", () => {
  const cache = tempCache();
  cache.save(key(), [{ period: "2024-01", views: 1 }, { period: "2024-02", views: 2 }], 1);
  cache.save(key({ kind: "aggregate", article: "" }), [{ period: "2024-01", views: 100 }], 1);
  cache.save(key({ project: "pl.wikipedia" }), [{ period: "2024-01", views: 3 }], 1);

  const stats = cache.stats();
  assert.equal(stats.series, 3);
  assert.equal(stats.points, 4);
  const cs = stats.projects.find((p) => p.project === "cs.wikipedia");
  assert.deepEqual({ ...cs }, { project: "cs.wikipedia", granularity: "monthly", articles: 1, points: 3, first: "2024-01", last: "2024-02" });

  assert.equal(cache.clear("cs.wikipedia"), 2);
  assert.equal(cache.stats().points, 1);
  assert.equal(cache.clear(), 1);
  assert.equal(cache.stats().series, 0);
  cache.close();
});

test("reopening an existing cache file keeps its data", () => {
  const dir = mkdtempSync(join(tmpdir(), "wit-cache-"));
  const first = new Cache(join(dir, "wit.sqlite"));
  first.save(key(), [{ period: "2024-01", views: 9 }], 1);
  first.close();
  const second = new Cache(join(dir, "wit.sqlite"));
  assert.equal(second.load(key(), "2024-01", "2024-01").get("2024-01").views, 9);
  second.close();
});
