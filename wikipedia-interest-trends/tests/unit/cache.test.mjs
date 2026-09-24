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

  assert.deepEqual(cache.clear("cs.wikipedia"), { series: 2, lookups: 0 });
  assert.equal(cache.stats().points, 1);
  assert.deepEqual(cache.clear(), { series: 1, lookups: 0 });
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

test("stored API responses round-trip and are cleared per edition", () => {
  const cache = tempCache();
  cache.putResponse("https://cs.wikipedia.org/w/api.php?a=1", { q: 1 }, 10);
  cache.putResponse("https://cs.wikipedia.org/w/api.php?a=1", { q: 2 }, 20);
  cache.putResponse("https://pl.wikipedia.org/w/api.php?a=1", { q: 3 }, 10);
  cache.putResponse("https://www.wikidata.org/w/api.php?ids=Q1", { e: 1 }, 10);
  assert.deepEqual(cache.getResponse("https://cs.wikipedia.org/w/api.php?a=1"), { body: { q: 2 }, fetchedAt: 20 });
  assert.equal(cache.getResponse("https://cs.wikipedia.org/w/api.php?a=2"), undefined);
  assert.equal(cache.stats().lookups, 3);

  assert.deepEqual(cache.clear("cs.wikipedia"), { series: 0, lookups: 1 });
  assert.ok(cache.getResponse("https://pl.wikipedia.org/w/api.php?a=1"));
  assert.ok(cache.getResponse("https://www.wikidata.org/w/api.php?ids=Q1"));
  assert.deepEqual(cache.clear(), { series: 0, lookups: 2 });
  cache.close();
});

test("a v1 cache file is upgraded in place without losing data", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const path = join(mkdtempSync(join(tmpdir(), "wit-cache-")), "wit.sqlite");
  const v1 = new DatabaseSync(path);
  v1.exec(`
    CREATE TABLE series (id INTEGER PRIMARY KEY, kind TEXT NOT NULL, project TEXT NOT NULL, article TEXT NOT NULL,
      access TEXT NOT NULL, agent TEXT NOT NULL, granularity TEXT NOT NULL,
      UNIQUE (kind, project, article, access, agent, granularity));
    CREATE TABLE points (series_id INTEGER NOT NULL REFERENCES series(id) ON DELETE CASCADE, period TEXT NOT NULL,
      views INTEGER NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (series_id, period)) WITHOUT ROWID;
    INSERT INTO series VALUES (1, 'article', 'cs.wikipedia', 'Foo', 'all-access', 'user', 'monthly');
    INSERT INTO points VALUES (1, '2024-01', 42, 1);
    PRAGMA user_version = 1;
  `);
  v1.close();

  const cache = new Cache(path);
  assert.equal(cache.load(key(), "2024-01", "2024-01").get("2024-01").views, 42);
  cache.putResponse("https://x.test/", {}, 1);
  assert.equal(cache.stats().lookups, 1);
  cache.close();
});
