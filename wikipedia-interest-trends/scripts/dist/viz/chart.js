const GAP = 24;
/** Total chart width: two panels per row, or one panel spanning the full width. */
const CHART_W = 704;
const PANEL_H = 190;
const LEGEND_H = 28;
const M = { top: 44, right: 12, bottom: 22, left: 44 };
const STYLE = `
.wit-chart { --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --grid: #e6e5e1;
  --raw: #86b6ef; --adjusted: #2a78d6; --spike: #eb6834;
  font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
@media (prefers-color-scheme: dark) { .wit-chart:not(.light) { --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7;
  --grid: #383835; --raw: #1c5cab; --adjusted: #3987e5; --spike: #d95926; } }
@media print { .wit-chart { --surface: #ffffff; --ink: #000000; --ink-2: #444444; --grid: #dddddd;
  --raw: #86b6ef; --adjusted: #2a78d6; --spike: #eb6834; } }
.wit-chart .bg { fill: var(--surface); }
.wit-chart text { fill: var(--ink-2); font-size: 11px; }
.wit-chart .title { fill: var(--ink); font-size: 13px; font-weight: 600; }
.wit-chart .grid { stroke: var(--grid); stroke-width: 1; }
.wit-chart .raw { stroke: var(--raw); stroke-width: 1.5; fill: none; stroke-linejoin: round; stroke-linecap: round; }
.wit-chart .adjusted { stroke: var(--adjusted); stroke-width: 2; fill: none; stroke-linejoin: round; stroke-linecap: round; }
.wit-chart .trend { stroke: var(--ink-2); stroke-width: 2; fill: none; stroke-dasharray: 6 4; }
.wit-chart .spike { fill: var(--spike); stroke: var(--surface); stroke-width: 2; }
.wit-chart .hit { fill: transparent; }
.wit-chart .hit:hover { fill: var(--grid); fill-opacity: 0.5; }
`;
const escapeXml = (s) => s.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);
const fmt = (v) => (v >= 100 ? Math.round(v).toLocaleString("en-US") : v >= 10 ? v.toFixed(0) : v.toFixed(v >= 1 ? 1 : 2));
const px = (v) => Math.round(v * 10) / 10;
/** The smallest round step (1, 2 or 5 × 10^k) that covers `max` in at most 5 intervals. */
function niceScale(max) {
    const magnitude = 10 ** Math.floor(Math.log10(max / 5));
    const step = [1, 2, 5, 10].map((f) => f * magnitude).find((s) => Math.ceil(max / s) <= 5);
    return { step, top: Math.ceil(max / step) * step };
}
/** Tick labels with as many decimals as the step needs, the same for every tick. */
function tickLabel(v, step) {
    const decimals = Math.max(0, -Math.floor(Math.log10(step)));
    return v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}
function path(values, x, y) {
    return values.map((v, i) => `${i ? "L" : "M"}${px(x(i))},${px(y(v))}`).join("");
}
function panel(p, ox, oy, panelW) {
    const { periods, perMillion, adjusted, trend } = p.series;
    const n = periods.length;
    const w = panelW - M.left - M.right;
    const h = PANEL_H - M.top - M.bottom;
    const max = Math.max(...perMillion, ...(adjusted ?? []), ...(trend ?? []), 1e-9);
    const { step, top } = niceScale(max);
    const x = (i) => M.left + (n > 1 ? (i / (n - 1)) * w : w / 2);
    const y = (v) => M.top + h - (v / top) * h;
    const out = [`<g transform="translate(${ox},${oy})">`];
    out.push(`<text class="title" x="0" y="15">${escapeXml(p.title)}</text>`);
    out.push(`<text x="0" y="31">${escapeXml(p.subtitle)}</text>`);
    for (let v = 0; v <= top + step / 2; v += step) {
        out.push(`<line class="grid" x1="${M.left}" x2="${M.left + w}" y1="${px(y(v))}" y2="${px(y(v))}"/>`);
        out.push(`<text x="${M.left - 6}" y="${px(y(v)) + 4}" text-anchor="end">${tickLabel(v, step)}</text>`);
    }
    // Year labels at each January; the first month is labelled only when no
    // January follows closely, so the two labels cannot collide.
    const firstJanuary = periods.findIndex((p) => p.endsWith("-01"));
    periods.forEach((period, i) => {
        if (period.endsWith("-01") || (i === 0 && (firstJanuary < 0 || firstJanuary > 8))) {
            out.push(`<text x="${px(x(i))}" y="${M.top + h + 16}" text-anchor="${i === 0 ? "start" : "middle"}">${period.slice(0, 4)}</text>`);
        }
    });
    out.push(`<path class="raw" d="${path(perMillion, x, y)}"/>`);
    if (adjusted)
        out.push(`<path class="adjusted" d="${path(adjusted, x, y)}"/>`);
    if (trend)
        out.push(`<path class="trend" d="M${px(x(0))},${px(y(trend[0]))}L${px(x(n - 1))},${px(y(trend[n - 1]))}"/>`);
    for (const period of p.spikes) {
        const i = periods.indexOf(period);
        if (i >= 0)
            out.push(`<circle class="spike" cx="${px(x(i))}" cy="${px(y(perMillion[i]))}" r="4"/>`);
    }
    // Hover targets: one full-height band per month, wider than the line itself.
    const band = n > 1 ? w / (n - 1) : w;
    periods.forEach((period, i) => {
        const detail = `${period}: ${fmt(perMillion[i])} per million` + (adjusted ? `, seasonally adjusted ${fmt(adjusted[i])}` : "");
        out.push(`<rect class="hit" x="${px(x(i) - band / 2)}" y="${M.top}" width="${px(band)}" height="${h}"><title>${escapeXml(detail)}</title></rect>`);
    });
    out.push("</g>");
    return out.join("");
}
function legend(hasAdjusted, hasSpikes) {
    const items = [
        [`<line class="raw" x1="0" x2="18" y1="0" y2="0"/>`, "monthly views per million edition views"],
        ...(hasAdjusted ? [[`<line class="adjusted" x1="0" x2="18" y1="0" y2="0"/>`, "seasonally adjusted"]] : []),
        [`<line class="trend" x1="0" x2="18" y1="0" y2="0"/>`, "trend"],
        ...(hasSpikes ? [[`<circle class="spike" cx="9" cy="0" r="4"/>`, "spike month"]] : []),
    ];
    let xPos = 0;
    const parts = items.map(([mark, label]) => {
        const g = `<g transform="translate(${xPos},10)">${mark}<text x="24" y="4">${label}</text></g>`;
        xPos += 32 + label.length * 5.8;
        return g;
    });
    return `<g>${parts.join("")}</g>`;
}
/** Renders one panel per edition, two per row (one full-width panel for a single edition). */
export function renderChart(panels, title) {
    const cols = panels.length > 1 ? 2 : 1;
    const rows = Math.ceil(panels.length / cols);
    const panelW = (CHART_W - (cols - 1) * GAP) / cols;
    const width = CHART_W;
    const height = LEGEND_H + rows * PANEL_H + (rows - 1) * GAP;
    const body = panels
        .map((p, k) => panel(p, (k % cols) * (panelW + GAP), LEGEND_H + Math.floor(k / cols) * (PANEL_H + GAP), panelW))
        .join("");
    const desc = panels.map((p) => `${p.title}: ${p.subtitle}`).join("; ");
    return (`<svg xmlns="http://www.w3.org/2000/svg" class="wit-chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-labelledby="wit-t wit-d">` +
        `<title id="wit-t">${escapeXml(title)}</title><desc id="wit-d">${escapeXml(desc)}</desc>` +
        `<style>${STYLE}</style><rect class="bg" width="100%" height="100%"/>` +
        legend(panels.some((p) => p.series.adjusted), panels.some((p) => p.spikes.length > 0)) +
        body +
        "</svg>");
}
