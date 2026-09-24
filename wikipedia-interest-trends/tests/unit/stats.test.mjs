import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { erfc, mad, median, rank, rollingMedian, roundHalfEven, twoSidedP } from "../../scripts/dist/stats/basic.js";
import { theilSen } from "../../scripts/dist/stats/theilsen.js";
import { mannKendall } from "../../scripts/dist/stats/mannkendall.js";
import { seasonalAdjust } from "../../scripts/dist/stats/seasonal.js";
import { detectSpikes, detectStep } from "../../scripts/dist/stats/anomalies.js";

const reference = JSON.parse(readFileSync(new URL("../fixtures/stats-reference.json", import.meta.url), "utf8"));

const close = (actual, expected, rel, label) =>
  assert.ok(Math.abs(actual - expected) <= rel * Math.max(1, Math.abs(expected)), `${label}: ${actual} vs ${expected}`);

/** Deterministic pseudo-random normal noise (LCG + Box–Muller). */
function noise(seed) {
  let s = seed >>> 0;
  const u = () => ((s = (1664525 * s + 1013904223) >>> 0) + 1) / 4294967297;
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

test("basic helpers", () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(mad([1, 1, 2, 2, 4, 6, 9]), 1);
  assert.deepEqual(rollingMedian([1, 9, 2, 3, 4], 3), [5, 2, 3, 3, 3.5]);
  assert.deepEqual([0.5, 1.5, 2.5, -0.5, 2.4].map(roundHalfEven), [0, 2, 2, -0, 2]);
  assert.deepEqual(rank([10, 20, 10, 30]), [1.5, 3, 1.5, 4]);
});

test("erfc and p-values match exact values", () => {
  // Exact values from Python's math.erfc.
  close(erfc(0), 1, 1e-7, "erfc(0)");
  close(erfc(1), 0.15729920705028513, 1.2e-7, "erfc(1)");
  close(erfc(3), 2.209049699858544e-05, 1.2e-7, "erfc(3)");
  close(erfc(-1), 1.8427007929497148, 1.2e-7, "erfc(-1)");
  close(twoSidedP(1.959963984540054), 0.05, 1e-6, "p at z=1.96");
});

test("Mann–Kendall matches a hand calculation", () => {
  // 1..5: all 10 pairs concordant, Var(S) = 5·4·15/18.
  const r = mannKendall([1, 2, 3, 4, 5], { hamedRao: false });
  assert.equal(r.s, 10);
  close(r.varS, 50 / 3, 1e-12, "varS");
  close(r.z, 9 / Math.sqrt(50 / 3), 1e-12, "z");
  assert.equal(r.tau, 1);
});

for (const c of reference.cases) {
  test(`matches the reference implementation: ${c.name}`, () => {
    const ts = theilSen(c.y);
    for (const k of ["slope", "intercept", "low", "high"]) close(ts[k], c.theilSen[k], 1e-12, `theilSen.${k}`);

    for (const [variant, hamedRao] of [["mannKendall", false], ["mannKendallHamedRao", true]]) {
      const mk = mannKendall(c.y, { hamedRao });
      assert.equal(mk.s, c[variant].s, `${variant}.s`);
      close(mk.varS, c[variant].varS, 1e-9, `${variant}.varS`);
      close(mk.z, c[variant].z, 1e-9, `${variant}.z`);
      close(mk.p, c[variant].p, 2e-7, `${variant}.p`); // erfc approximation
    }
  });
}

test("Theil–Sen ignores a single outlier", () => {
  const y = Array.from({ length: 24 }, (_, i) => 2 * i);
  y[10] = 500;
  assert.equal(theilSen(y).slope, 2);
});

test("seasonal adjustment recovers a planted yearly pattern", () => {
  const rnd = noise(1);
  const pattern = [0.3, 0.1, 0, -0.1, -0.2, -0.3, -0.35, -0.2, 0.25, 0.2, 0.15, 0.15]; // sums to 0
  const firstMonth = 8; // series starts in September
  const y = Array.from({ length: 60 }, (_, i) => 5 + 0.01 * i + pattern[(firstMonth + i) % 12] + 0.03 * rnd());
  const { effects, adjusted, strength } = seasonalAdjust(y, firstMonth);
  effects.forEach((e, m) => close(e, pattern[m], 0.06, `month ${m}`));
  assert.ok(strength > 0.9, `strength ${strength}`);
  // What remains is the trend: its slope is recovered.
  close(theilSen(adjusted).slope, 0.01, 0.002, "slope after adjustment");
});

test("seasonal adjustment reports low strength when there is no pattern", () => {
  const rnd = noise(2);
  const { strength } = seasonalAdjust(Array.from({ length: 48 }, () => rnd()), 0);
  assert.ok(strength < 0.4, `strength ${strength}`);
});

test("spike detection finds planted spikes and dips only", () => {
  const rnd = noise(3);
  const y = Array.from({ length: 48 }, (_, i) => 6 + 0.01 * i + 0.05 * rnd());
  y[20] += 1.2; // ~3.3x views
  y[33] -= 0.8;
  const spikes = detectSpikes(y);
  assert.deepEqual(spikes.map((s) => s.index), [20, 33]);
  assert.ok(spikes[0].z > 0 && spikes[1].z < 0);
  close(spikes[0].excess, 1.2, 0.1, "excess");
});

test("step detection finds a level shift but not a smooth trend", () => {
  const rnd = noise(4);
  const trend = Array.from({ length: 60 }, (_, i) => 5 + 0.02 * i + 0.05 * rnd());
  assert.equal(detectStep(trend), null);

  const stepped = trend.map((v, i) => (i >= 40 ? v + 0.5 : v));
  const step = detectStep(stepped);
  assert.ok(step, "step found");
  assert.ok(Math.abs(step.index - 40) <= 1, `index ${step.index}`);
  assert.ok(step.shift > 0.3);
});
