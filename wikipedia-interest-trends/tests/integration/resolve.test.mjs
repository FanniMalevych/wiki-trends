// Runs `resolve` against recorded MediaWiki/Wikidata responses (tests/fixtures/http).
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
    const r = spawnSync(process.execPath, [cli, "resolve", ...args], { encoding: "utf8", env });
    assert.equal(r.stderr, "");
    return { status: r.status, out: JSON.parse(r.stdout) };
  };
}

test("a title maps to each requested edition; missing ones are explained", () => {
  const run = makeRunner();
  const r = run("--title", "intermittent fasting", "--from", "en", "--lang", "pl,cs,uk");
  assert.equal(r.status, 0);
  const d = r.out.data;
  assert.equal(d.qid, "Q1666254");
  assert.deepEqual(d.source, { project: "en.wikipedia", title: "Intermittent_fasting", redirectedFrom: null });
  assert.deepEqual(d.editions.map((e) => [e.project, e.status, e.title]), [
    ["pl.wikipedia", "missing", null],
    ["cs.wikipedia", "found", "Přerušovaný_půst"],
    ["uk.wikipedia", "found", "Інтервальне_голодування"],
  ]);
  assert.match(d.editions[0].note, /probably not covered/);
  assert.deepEqual([d.found, d.missing], [2, 1]);
  assert.match(r.out.warnings[0], /No article in: pl\.wikipedia/);

  assert.equal(run("--title", "intermittent fasting", "--from", "en", "--lang", "pl,cs,uk", "--verbose").out.data.requests, 0);
});

test("a Wikidata ID without --lang lists every edition", () => {
  const r = makeRunner()("--qid", "Q333");
  assert.ok(r.out.data.found > 200);
  const projects = r.out.data.editions.map((e) => e.project);
  assert.ok(projects.includes("uk.wikipedia") && projects.includes("zh-min-nan.wikipedia"));
  assert.ok(projects.every((p) => p.endsWith(".wikipedia") && !p.startsWith("abstract.")));
});

test("a disambiguation page is an error that lists specific articles", () => {
  const r = makeRunner()("--title", "Mercury", "--from", "en");
  assert.equal(r.status, 1);
  assert.match(r.out.errors[0], /disambiguation page/);
  assert.match(r.out.errors[0], /"Mercury_\(planet\)"/);
});

test("a misspelled title gets a did-you-mean suggestion", () => {
  const r = makeRunner()("--title", "Intermitent fastin", "--from", "en");
  assert.equal(r.status, 1);
  assert.match(r.out.errors[0], /does not exist on en\.wikipedia\. Search suggests: "Intermittent_fasting"/);
});

test("a missing edition is explained, without guessed titles", () => {
  const r = makeRunner()("--title", "English as a second or foreign language", "--from", "en", "--lang", "pl,de");
  const [pl, de] = r.out.data.editions;
  assert.equal(de.status, "found");
  assert.deepEqual(Object.keys(pl).sort(), ["note", "project", "status", "title"]);
  assert.match(pl.note, /No pl\.wikipedia article is linked to Q\d+/);
});
