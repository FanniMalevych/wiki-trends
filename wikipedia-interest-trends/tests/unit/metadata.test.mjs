import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cache } from "../../scripts/dist/cache/db.js";
import { parseLangs } from "../../scripts/dist/commands/selection.js";
import { normalizeQid, resolveTopic } from "../../scripts/dist/resolve.js";
import {
  LOOKUP_TTL_MS,
  looksRelated,
  lookupPage,
  rankRedirects,
  siteToProject,
} from "../../scripts/dist/wiki/metadata.js";

test("siteToProject maps Wikidata site IDs to Wikipedia editions", () => {
  assert.equal(siteToProject("plwiki"), "pl.wikipedia");
  assert.equal(siteToProject("zh_min_nanwiki"), "zh-min-nan.wikipedia");
  assert.equal(siteToProject("be_x_oldwiki"), "be-tarask.wikipedia");
  for (const other of ["plwikiquote", "commonswiki", "wikidatawiki", "abstractwiki", "specieswiki"]) {
    assert.equal(siteToProject(other), undefined, other);
  }
});

test("normalizeQid and parseLangs", () => {
  assert.equal(normalizeQid("q333"), "Q333");
  assert.equal(normalizeQid(" 42 "), "Q42");
  assert.throws(() => normalizeQid("astronomy"), /Invalid Wikidata ID/);
  assert.deepEqual(parseLangs(["pl,cs", " uk ", "pl"]), ["pl.wikipedia", "cs.wikipedia", "uk.wikipedia"]);
  assert.equal(parseLangs(undefined), null);
  assert.equal(parseLangs(["all"]), null);
});

test("looksRelated keeps look-alike titles and drops unrelated full-text hits", () => {
  assert.ok(looksRelated("Intermittent fasting", "intermitent fastin"));
  assert.ok(looksRelated("Mercury (planet)", "Mercury"));
  assert.ok(looksRelated("Język angielski", "angielski jako drugi lub obcy język"));
  assert.ok(!looksRelated("Charlie Kirk", "Post przerywany"));
  assert.ok(!looksRelated("Język polski", "angielski jako drugi lub obcy język"));
});

// ---------------------------------------------------------------------------
// Lookups against a fake MediaWiki/Wikidata API

const realFetch = globalThis.fetch;
let requested;
let cache;

function fakeApi(handler) {
  requested = [];
  globalThis.fetch = async (url) => {
    const u = new URL(url);
    requested.push(u.host + " " + (u.searchParams.get("action") === "wbgetentities" ? "entity" : u.searchParams.get("prop") ?? u.searchParams.get("list")));
    return new Response(JSON.stringify(handler(u)), { status: 200 });
  };
}

beforeEach(() => {
  process.env.WIT_HTTP_MODE = "live";
  cache = new Cache(join(mkdtempSync(join(tmpdir(), "wit-meta-")), "wit.sqlite"));
});

afterEach(() => {
  globalThis.fetch = realFetch;
  cache.close();
});

test("lookupPage follows redirects and drops section redirects", async () => {
  fakeApi(() => ({
    query: {
      redirects: [{ from: "IF diet", to: "Intermittent fasting" }],
      pages: [{
        title: "Intermittent fasting",
        pageprops: { wikibase_item: "Q1666254" },
        redirects: [{ title: "5:2 diet" }, { title: "Bolus feeding", fragment: "Intermittent feeding" }],
      }],
    },
  }));
  const page = await lookupPage(cache, "en.wikipedia", "IF diet", 0);
  assert.deepEqual(page, {
    project: "en.wikipedia",
    status: "found",
    title: "Intermittent_fasting",
    redirectedFrom: "IF_diet",
    qid: "Q1666254",
    redirects: ["5:2_diet"],
  });
});

test("lookupPage reports missing and disambiguation pages", async () => {
  fakeApi(() => ({ query: { pages: [{ title: "Nope", missing: true }] } }));
  assert.equal((await lookupPage(cache, "en.wikipedia", "Nope", 0)).status, "missing");
  fakeApi(() => ({ query: { pages: [{ title: "Mercury", pageprops: { disambiguation: "", wikibase_item: "Q48397" } }] } }));
  assert.equal((await lookupPage(cache, "en.wikipedia", "Mercury", 0)).status, "disambiguation");
});

test("lookups are cached until the TTL expires", async () => {
  fakeApi(() => ({ query: { pages: [{ title: "Foo" }] } }));
  await lookupPage(cache, "en.wikipedia", "Foo", 0);
  await lookupPage(cache, "en.wikipedia", "Foo", LOOKUP_TTL_MS - 1);
  assert.equal(requested.length, 1);
  await lookupPage(cache, "en.wikipedia", "Foo", LOOKUP_TTL_MS);
  assert.equal(requested.length, 2);
});

test("API errors inside a 200 response are raised", async () => {
  fakeApi(() => ({ error: { code: "badvalue", info: "Unrecognized value" } }));
  await assert.rejects(lookupPage(cache, "en.wikipedia", "Foo", 0), /API error badvalue/);
});

test("rankRedirects orders by recent views and drops unviewed titles", async () => {
  fakeApi((u) => ({
    query: {
      pages: u.searchParams.get("titles").split("|").map((title) => ({
        title,
        pageviews: { d1: title === "B" ? 9 : title === "A" ? 2 : 0, d2: title === "A" ? 1 : null },
      })),
    },
  }));
  assert.deepEqual(await rankRedirects(cache, "en.wikipedia", ["A", "B", "C"], 0), [
    { title: "B", views: 9 },
    { title: "A", views: 3 },
  ]);
});

test("rankRedirects batches 50 titles per request", async () => {
  fakeApi(() => ({ query: { pages: [] } }));
  await rankRedirects(cache, "en.wikipedia", Array.from({ length: 120 }, (_, i) => `T${i}`), 0);
  assert.equal(requested.length, 2); // only the first 100 are considered
});

test("resolveTopic maps a title to each edition and explains gaps", async () => {
  fakeApi((u) => {
    if (u.host === "www.wikidata.org") {
      return {
        entities: {
          Q1: {
            id: "Q1",
            labels: { en: { value: "topic" }, pl: { value: "temat" } },
            sitelinks: { cswiki: { title: "Téma x" }, dewiki: { title: "Thema" } },
          },
        },
      };
    }
    if (u.searchParams.get("list") === "search") return { query: { search: [{ title: "Temat" }, { title: "Unrelated" }] } };
    return { query: { pages: [{ title: "Topic", pageprops: { wikibase_item: "Q1" } }] } };
  });
  const topic = await resolveTopic(cache, { title: "topic", from: "en.wikipedia", projects: ["pl.wikipedia", "cs.wikipedia"] }, 0);
  assert.equal(topic.qid, "Q1");
  assert.equal(topic.label, "topic");
  assert.deepEqual(topic.source, { project: "en.wikipedia", title: "Topic", redirectedFrom: null });
  assert.deepEqual(topic.editions[1], { project: "cs.wikipedia", status: "found", title: "Téma_x" });
  assert.equal(topic.editions[0].status, "missing");
  assert.deepEqual(topic.editions[0].candidates, ["Temat"]);
  assert.equal(topic.editions.length, 2); // only the requested editions, although de exists
});

test("resolveTopic rejects a title without a Wikidata item", async () => {
  fakeApi(() => ({ query: { pages: [{ title: "Local thing" }] } }));
  await assert.rejects(
    resolveTopic(cache, { title: "Local thing", from: "en.wikipedia", projects: ["pl.wikipedia"] }, 0),
    /has no Wikidata item/,
  );
});
