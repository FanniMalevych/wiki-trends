// `report` and `chart` end to end against recorded responses.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../scripts/dist/cli.js", import.meta.url));

function run(...args) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), "wit-render-"))); // macOS: /var is a link to /private/var
  const env = { ...process.env, WIT_CACHE_DIR: join(cwd, ".cache"), WIT_HTTP_MODE: process.env.WIT_HTTP_MODE ?? "replay" };
  const r = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8", env, cwd });
  assert.equal(r.stderr, "");
  return { status: r.status, out: JSON.parse(r.stdout), cwd };
}

const ESL = ["--title", "English as a second or foreign language", "--from", "en", "--lang", "de,es,fr,pl", "--start", "2021-09", "--end", "2026-08"];

test("report writes a self-contained HTML file to the default location", () => {
  const r = run("report", ...ESL, "--note", "German and Spanish only.");
  assert.equal(r.status, 0);
  assert.equal(r.out.data.file, join(r.cwd, "wit-output", "english-as-a-second-or-foreign-language_de-es-fr-pl_2026-08.html"));
  assert.deepEqual(r.out.data.editions.map((e) => e.project), ["de.wikipedia", "es.wikipedia"]);
  assert.deepEqual(r.out.data.missing, ["fr.wikipedia", "pl.wikipedia"]);
  const html = readFileSync(r.out.data.file, "utf8");
  assert.match(html, /German and Spanish only\./);
  assert.equal((html.match(/class="title"/g) ?? []).length, 2);
});

test("chart writes an SVG to --out", () => {
  const r = run("chart", "--title", "Astronomy", "--from", "en", "--lang", "uk", "--start", "2021-09", "--end", "2026-08", "--out", "a/b.svg");
  assert.equal(r.status, 0);
  assert.match(readFileSync(join(r.cwd, "a/b.svg"), "utf8"), /^<svg[\s\S]*Астрономія[\s\S]*<\/svg>$/);
});

test("chart fails clearly when no edition has an article", () => {
  const r = run("chart", ...ESL.slice(0, 4), "--lang", "fr,pl", "--start", "2021-09", "--end", "2026-08");
  assert.equal(r.status, 1);
  assert.match(r.out.errors[0], /nothing to chart/);
});
