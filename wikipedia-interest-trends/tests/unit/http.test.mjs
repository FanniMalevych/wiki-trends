import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getJson, httpStats } from "../../scripts/dist/wiki/http.js";

const realFetch = globalThis.fetch;
let calls;

/** Replaces fetch with a stub that returns the given responses in order. */
function stubFetch(...responses) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, headers: init.headers });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status, headers: next.headers });
  };
}

beforeEach(() => {
  process.env.WIT_HTTP_MODE = "live";
  process.env.WIT_HTTP_RETRY_BASE_MS = "1";
});

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.WIT_HTTP_MODE;
  delete process.env.WIT_FIXTURES_DIR;
});

test("sends a policy-compliant User-Agent", async () => {
  stubFetch({ status: 200, body: { items: [] } });
  await getJson("https://example.test/a");
  assert.match(calls[0].headers["User-Agent"], /^wikipedia-interest-trends\/\d+\.\d+\.\d+ \(https:\/\/github\.com\/.+\) node\//);
});

test("retries 429 and 5xx, then returns the success", async () => {
  stubFetch({ status: 429, headers: { "retry-after": "0" } }, { status: 503 }, new TypeError("socket hang up"), { status: 200, body: { ok: 1 } });
  const res = await getJson("https://example.test/b");
  assert.deepEqual(res, { status: 200, body: { ok: 1 } });
  assert.equal(calls.length, 4);
});

test("gives up after five attempts and returns the last status", async () => {
  stubFetch(...Array.from({ length: 5 }, () => ({ status: 500 })));
  const res = await getJson("https://example.test/c");
  assert.equal(res.status, 500);
  assert.equal(calls.length, 5);
});

test("does not retry 404", async () => {
  stubFetch({ status: 404, body: { detail: "nope" } });
  assert.equal((await getJson("https://example.test/d")).status, 404);
  assert.equal(calls.length, 1);
});

test("requests run one at a time", async () => {
  let active = 0;
  let peak = 0;
  globalThis.fetch = async () => {
    peak = Math.max(peak, ++active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return new Response("{}", { status: 200 });
  };
  await Promise.all([1, 2, 3, 4].map((i) => getJson(`https://example.test/q${i}`)));
  assert.equal(peak, 1);
});

test("record mode saves fixtures that replay mode serves without the network", async () => {
  process.env.WIT_FIXTURES_DIR = mkdtempSync(join(tmpdir(), "wit-fx-"));
  process.env.WIT_HTTP_MODE = "record";
  stubFetch({ status: 200, body: { items: [1, 2] } });
  await getJson("https://example.test/rec");
  const [file] = readdirSync(process.env.WIT_FIXTURES_DIR);
  assert.equal(JSON.parse(readFileSync(join(process.env.WIT_FIXTURES_DIR, file), "utf8")).url, "https://example.test/rec");

  process.env.WIT_HTTP_MODE = "replay";
  globalThis.fetch = () => assert.fail("replay must not use the network");
  const before = httpStats().replayed;
  assert.deepEqual(await getJson("https://example.test/rec"), { status: 200, body: { items: [1, 2] } });
  assert.equal(httpStats().replayed, before + 1);
  await assert.rejects(getJson("https://example.test/missing"), /No recorded fixture/);
});
