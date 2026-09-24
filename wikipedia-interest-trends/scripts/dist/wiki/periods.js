// Period keys are plain strings that sort chronologically:
//   daily   "YYYY-MM-DD"
//   monthly "YYYY-MM"
/** First month for which the Pageviews API has per-article and aggregate data. */
export const DATA_START = "2015-07-01";
const DAY_MS = 86_400_000;
/** Views for a period can still be revised for a few days after it ends. */
export const FINALITY_LAG_MS = 3 * DAY_MS;
function pad(n, width = 2) {
    return String(n).padStart(width, "0");
}
function daysInMonth(y, m) {
    return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function parseInput(input) {
    const s = input.trim();
    const match = /^(\d{4})-?(\d{2})(?:-?(\d{2}))?$/.exec(s);
    if (!match)
        throw new Error(`Invalid date "${input}". Use YYYY-MM or YYYY-MM-DD.`);
    const y = Number(match[1]);
    const m = Number(match[2]);
    const d = match[3] === undefined ? undefined : Number(match[3]);
    if (m < 1 || m > 12)
        throw new Error(`Invalid month in "${input}".`);
    if (d !== undefined && (d < 1 || d > daysInMonth(y, m)))
        throw new Error(`Invalid day in "${input}".`);
    return { y, m, d };
}
/**
 * Converts user input to a period key. A month given for a daily range expands
 * to its first day (start) or last day (end); a day given for a monthly range
 * collapses to its month.
 */
export function toPeriod(input, granularity, edge) {
    const { y, m, d } = parseInput(input);
    if (granularity === "monthly")
        return `${y}-${pad(m)}`;
    const day = d ?? (edge === "start" ? 1 : daysInMonth(y, m));
    return `${y}-${pad(m)}-${pad(day)}`;
}
function periodStartMs(period) {
    const [y, m, d] = period.split("-").map(Number);
    return Date.UTC(y, m - 1, d ?? 1);
}
/** Start of the next period, in ms since epoch (UTC). */
export function periodEndMs(period, granularity) {
    const [y, m, d] = period.split("-").map(Number);
    return granularity === "monthly" ? Date.UTC(y, m, 1) : Date.UTC(y, m - 1, (d ?? 1) + 1);
}
function fromMs(ms, granularity) {
    const t = new Date(ms);
    const ym = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
    return granularity === "monthly" ? ym : `${ym}-${pad(t.getUTCDate())}`;
}
export function nextPeriod(period, granularity) {
    return fromMs(periodEndMs(period, granularity), granularity);
}
export function shiftPeriod(period, granularity, by) {
    if (granularity === "daily")
        return fromMs(periodStartMs(period) + by * DAY_MS, "daily");
    const [y, m] = period.split("-").map(Number);
    return fromMs(Date.UTC(y, m - 1 + by, 1), "monthly");
}
export function enumeratePeriods(start, end, granularity) {
    const out = [];
    for (let p = start; p <= end; p = nextPeriod(p, granularity))
        out.push(p);
    return out;
}
/** The newest period that has fully ended as of `now`. */
export function lastCompletePeriod(granularity, now) {
    const today = fromMs(now, "daily");
    if (granularity === "daily")
        return shiftPeriod(today, "daily", -1);
    return shiftPeriod(fromMs(now, "monthly"), "monthly", -1);
}
export function firstAvailablePeriod(granularity) {
    return toPeriod(DATA_START, granularity, "start");
}
/** Default window: the last 24 complete months, or the last 730 complete days. */
export function defaultRange(granularity, now) {
    const end = lastCompletePeriod(granularity, now);
    const span = granularity === "monthly" ? 24 : 730;
    return { start: shiftPeriod(end, granularity, -(span - 1)), end };
}
/**
 * Turns optional user dates into a period range inside the available data,
 * explaining any adjustment in `warnings`.
 */
export function resolveRange(granularity, startInput, endInput, now) {
    const defaults = defaultRange(granularity, now);
    let start = startInput ? toPeriod(startInput, granularity, "start") : defaults.start;
    let end = endInput ? toPeriod(endInput, granularity, "end") : defaults.end;
    const earliest = firstAvailablePeriod(granularity);
    const latest = lastCompletePeriod(granularity, now);
    const warnings = [];
    if (start < earliest) {
        warnings.push(`Start moved from ${start} to ${earliest}: pageview data begins in July 2015.`);
        start = earliest;
    }
    if (end > latest) {
        warnings.push(`End moved from ${end} to ${latest}, the last complete ${granularity === "monthly" ? "month" : "day"}.`);
        end = latest;
    }
    if (start > end)
        throw new Error(`Start ${start} is after end ${end}.`);
    return { start, end, warnings };
}
/** API timestamp "YYYYMMDDHH" -> period key. */
export function periodFromTimestamp(timestamp, granularity) {
    const y = timestamp.slice(0, 4);
    const m = timestamp.slice(4, 6);
    return granularity === "monthly" ? `${y}-${m}` : `${y}-${m}-${timestamp.slice(6, 8)}`;
}
/** API start/end parameters (YYYYMMDD). Monthly ranges always cover whole months. */
export function apiRange(start, end, granularity) {
    const compact = (ms) => fromMs(ms, "daily").replaceAll("-", "");
    return {
        start: compact(periodStartMs(start)),
        end: compact(periodEndMs(end, granularity) - DAY_MS),
    };
}
/** Whether a value fetched at `fetchedAt` can no longer change. */
export function isFinal(period, granularity, fetchedAt) {
    return fetchedAt >= periodEndMs(period, granularity) + FINALITY_LAG_MS;
}
/** Groups the flagged entries of an ordered period list into contiguous [first, last] runs. */
export function contiguousRuns(periods, needed) {
    const runs = [];
    let open;
    for (const p of periods) {
        if (needed(p)) {
            if (open)
                open[1] = p;
            else
                runs.push((open = [p, p]));
        }
        else {
            open = undefined;
        }
    }
    return runs;
}
