import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../../scripts/dist/cli.js", import.meta.url));
const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });

test("--help lists every command and exits 0", () => {
  const r = run("--help");
  assert.equal(r.status, 0);
  for (const cmd of ["resolve", "fetch", "analyze", "chart", "report", "cache"]) {
    assert.match(r.stdout, new RegExp(`^  ${cmd}\\b`, "m"));
  }
});

test("unknown command returns a JSON error envelope", () => {
  const r = run("bogus");
  assert.equal(r.status, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.data, null);
  assert.deepEqual(out.warnings, []);
  assert.match(out.errors[0], /Unknown command "bogus"/);
});

test("known but unimplemented command returns a JSON error envelope", () => {
  const r = run("chart");
  assert.equal(r.status, 2);
  assert.equal(JSON.parse(r.stdout).ok, false);
});
