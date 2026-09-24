import { test } from "node:test";
import assert from "node:assert/strict";
import {
  apiRange,
  contiguousRuns,
  defaultRange,
  enumeratePeriods,
  isFinal,
  lastCompletePeriod,
  periodFromTimestamp,
  shiftPeriod,
  toPeriod,
} from "../../scripts/dist/wiki/periods.js";

const at = (iso) => Date.parse(iso);

test("toPeriod accepts several input formats", () => {
  assert.equal(toPeriod("2024-03", "monthly", "start"), "2024-03");
  assert.equal(toPeriod("2024-03-17", "monthly", "end"), "2024-03");
  assert.equal(toPeriod("20240317", "daily", "start"), "2024-03-17");
  assert.equal(toPeriod("2024-02", "daily", "start"), "2024-02-01");
  assert.equal(toPeriod("2024-02", "daily", "end"), "2024-02-29"); // leap year
  assert.equal(toPeriod("2023-02", "daily", "end"), "2023-02-28");
});

test("toPeriod rejects invalid dates", () => {
  assert.throws(() => toPeriod("2024-13", "monthly", "start"), /Invalid month/);
  assert.throws(() => toPeriod("2023-02-29", "daily", "start"), /Invalid day/);
  assert.throws(() => toPeriod("last year", "monthly", "start"), /Invalid date/);
});

test("enumeratePeriods crosses month and year boundaries", () => {
  assert.deepEqual(enumeratePeriods("2023-11", "2024-02", "monthly"), ["2023-11", "2023-12", "2024-01", "2024-02"]);
  assert.deepEqual(enumeratePeriods("2024-02-28", "2024-03-01", "daily"), ["2024-02-28", "2024-02-29", "2024-03-01"]);
  assert.deepEqual(enumeratePeriods("2024-05", "2024-04", "monthly"), []);
});

test("shiftPeriod moves by whole periods", () => {
  assert.equal(shiftPeriod("2024-01", "monthly", -1), "2023-12");
  assert.equal(shiftPeriod("2024-01", "monthly", 14), "2025-03");
  assert.equal(shiftPeriod("2024-03-01", "daily", -1), "2024-02-29");
});

test("apiRange always covers whole months for monthly data", () => {
  assert.deepEqual(apiRange("2024-01", "2024-02", "monthly"), { start: "20240101", end: "20240229" });
  assert.deepEqual(apiRange("2024-12", "2024-12", "monthly"), { start: "20241201", end: "20241231" });
  assert.deepEqual(apiRange("2024-01-05", "2024-01-09", "daily"), { start: "20240105", end: "20240109" });
});

test("periodFromTimestamp parses API timestamps", () => {
  assert.equal(periodFromTimestamp("2024020100", "monthly"), "2024-02");
  assert.equal(periodFromTimestamp("2024020700", "daily"), "2024-02-07");
});

test("last complete period and default range", () => {
  const now = at("2026-09-24T10:00:00Z");
  assert.equal(lastCompletePeriod("daily", now), "2026-09-23");
  assert.equal(lastCompletePeriod("monthly", now), "2026-08");
  assert.equal(lastCompletePeriod("monthly", at("2026-01-01T00:00:00Z")), "2025-12");
  assert.deepEqual(defaultRange("monthly", now), { start: "2024-09", end: "2026-08" });
  assert.equal(enumeratePeriods(...Object.values(defaultRange("daily", now)), "daily").length, 730);
});

test("values become final three days after their period ends", () => {
  // August ends at 2026-09-01T00:00Z, so it is final from 2026-09-04T00:00Z.
  assert.equal(isFinal("2026-08", "monthly", at("2026-09-03T23:59:59Z")), false);
  assert.equal(isFinal("2026-08", "monthly", at("2026-09-04T00:00:00Z")), true);
  assert.equal(isFinal("2026-09-20", "daily", at("2026-09-22T12:00:00Z")), false);
  assert.equal(isFinal("2026-09-20", "daily", at("2026-09-24T00:00:00Z")), true);
});

test("contiguousRuns groups flagged periods", () => {
  const periods = ["a", "b", "c", "d", "e", "f"];
  const need = new Set(["a", "b", "d", "f"]);
  assert.deepEqual(contiguousRuns(periods, (p) => need.has(p)), [["a", "b"], ["d", "d"], ["f", "f"]]);
  assert.deepEqual(contiguousRuns(periods, () => false), []);
  assert.deepEqual(contiguousRuns(periods, () => true), [["a", "f"]]);
});
