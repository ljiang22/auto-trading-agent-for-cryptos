#!/usr/bin/env node
/**
 * Render static HTML dashboard for trading-prod analysis.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
    TABLE_PHASE_DEFINITIONS,
    PHASE_DEFINITIONS,
    buildCaseTitleMap,
    resolveCaseTitle,
    formatMs,
    buildLatencyBarSegments,
} from "./lib/trading-case-meta.mjs";

function parseArgs(argv) {
    const out = { runDir: null };
    for (let i = 2; i < argv.length; i++) {
        if (argv[i] === "--run-dir") out.runDir = argv[++i];
    }
    if (!out.runDir) {
        console.error("usage: render-trading-analysis-html.mjs --run-dir <path>");
        process.exit(2);
    }
    return out;
}

function esc(s) {
    return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function badge(pass, label) {
    const cls = pass ? "badge pass" : "badge fail";
    return `<span class="${cls}">${esc(label)}</span>`;
}

function safeCaseFile(id) {
    return String(id).replace(/[^a-zA-Z0-9._-]+/g, "_");
}

function renderLatencyBar(c) {
    const segments = buildLatencyBarSegments(c);
    if (!segments) {
        return '<span class="latency-bar empty">—</span>';
    }
    const inner = segments
        .map(
            (s) =>
                `<span class="seg" style="width:${s.pct.toFixed(1)}%;background:${s.color}" title="${esc(s.key)}: ${formatMs(s.ms)}"></span>`,
        )
        .join("");
    return `<div class="latency-bar" title="Relative phase breakdown">${inner}</div>`;
}

function renderPhaseCards() {
    return TABLE_PHASE_DEFINITIONS.map(
        (p) => `<div class="phase-card">
      <div class="phase-dot" style="background:${p.color}"></div>
      <div>
        <div class="phase-label">${esc(p.label)}</div>
        <div class="phase-desc">${esc(p.description)}</div>
      </div>
    </div>`,
    ).join("\n");
}

function renderPipelineSteps() {
    const steps = [
        { label: "User message", color: "#9aa0a6" },
        ...TABLE_PHASE_DEFINITIONS.map((p) => ({ label: p.shortLabel, color: p.color })),
        { label: "Final response", color: "#9aa0a6" },
    ];
    return steps
        .map((s, i) => {
            const arrow = i < steps.length - 1 ? '<span class="pipe-arrow">→</span>' : "";
            return `<div class="pipe-step">
        <span class="pipe-chip" style="border-color:${s.color}">${esc(s.label)}</span>
        ${arrow}
      </div>`;
        })
        .join("");
}

function renderKpiCards(correctness) {
    const teardown = correctness.teardown;
    const teardownPass = correctness.teardownPassed !== false;
    const teardownLabel = teardown
        ? teardownPass
            ? "PASS"
            : "FAIL"
        : "not run";
    const teardownClass = teardownPass ? "pass" : "fail";

    return `<div class="kpi-grid">
    <div class="kpi-card">
      <div class="kpi-label">Harness</div>
      <div class="kpi-value">${correctness.harnessPassed} <span class="kpi-sub">pass</span> / ${correctness.harnessFailed ?? 0} <span class="kpi-sub">fail</span></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Analysis</div>
      <div class="kpi-value">${correctness.analysisPassed} <span class="kpi-sub">pass</span> / ${correctness.analysisFailed ?? 0} <span class="kpi-sub">fail</span></div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Teardown</div>
      <div class="kpi-value ${teardownClass}">${esc(teardownLabel)}</div>
    </div>
    <div class="kpi-card">
      <div class="kpi-label">Analyzed</div>
      <div class="kpi-value kpi-small">${esc(correctness.analyzedAt)}</div>
    </div>
  </div>`;
}

function renderTeardownAlert(correctness) {
    const teardown = correctness.teardown;
    if (!teardown || correctness.teardownPassed !== false) {
        return "";
    }
    const failures = teardown.failures ?? [];
    const preview = failures.slice(0, 5).map((f) => `<li>${esc(f)}</li>`).join("");
    const more =
        failures.length > 5
            ? `<li>…and ${failures.length - 5} more</li>`
            : "";
    return `<div class="alert alert-fail">
    <strong>Teardown failed</strong> — harness orders may still be open.
    <ul>${preview}${more}</ul>
  </div>`;
}

function renderTableRow(c, titleMap) {
    const meta = c.title
        ? { title: c.title, section: c.section ?? "" }
        : resolveCaseTitle(c.id, titleMap);
    const safeId = safeCaseFile(c.id);
    const sectionTag = meta.section
        ? `<span class="section-tag">${esc(meta.section)}</span>`
        : "";

    const phaseCells = TABLE_PHASE_DEFINITIONS.map((p) => {
        const value =
            p.key === "venueCallMaxMs"
                ? c.venueCallMaxMs
                : c.latencyPhases?.[p.key];
        return `<td class="num" title="${esc(p.description)}">${formatMs(value)}</td>`;
    }).join("\n        ");

    return `<tr>
        <td class="case-cell sticky-col">
          <div class="case-title">${esc(meta.title)}</div>
          <div class="case-id">${esc(c.id)}</div>
          ${sectionTag}
        </td>
        <td>${esc(c.roomGroup ?? "-")}</td>
        <td>${badge(c.harnessPassed, c.harnessPassed ? "PASS" : "FAIL")}</td>
        <td>${badge(c.analysisPassed, c.analysisPassed ? "PASS" : "FAIL")}</td>
        <td class="num">${formatMs(c.durationMs)}</td>
        ${phaseCells}
        <td class="bar-cell">${renderLatencyBar(c)}</td>
        <td>${esc(c.riskFromCw ?? c.riskFromStream ?? "-")}</td>
        <td class="num">${c.auditEventCount}</td>
        <td class="issues">${esc((c.issues || []).join("; ") || "-")}</td>
        <td><a href="../cases/${esc(safeId)}.jsonl">jsonl</a></td>
        <td><a href="../audit/${esc(safeId)}.json">audit</a></td>
      </tr>`;
}

function phaseChartData(latencySummary) {
    const labels = [];
    const p50 = [];
    const p95 = [];
    const counts = [];
    const descriptions = [];

    for (const def of TABLE_PHASE_DEFINITIONS) {
        const key = def.chartKey ?? def.key;
        const stats = latencySummary.byPhase?.[key];
        if (!stats) {
            continue;
        }
        labels.push(def.label);
        p50.push(stats.p50 ?? 0);
        p95.push(stats.p95 ?? 0);
        counts.push(stats.count ?? 0);
        descriptions.push(def.description);
    }

    return { labels, p50, p95, counts, descriptions };
}

async function main() {
    const args = parseArgs(process.argv);
    const runDir = path.resolve(args.runDir);
    const analysisDir = path.join(runDir, "analysis");

    const correctness = JSON.parse(
        await fs.readFile(path.join(analysisDir, "correctness.json"), "utf8"),
    );
    const latencySummary = JSON.parse(
        await fs.readFile(path.join(analysisDir, "latency-summary.json"), "utf8"),
    );
    const titleMap = buildCaseTitleMap();

    const byGroup = {};
    for (const c of correctness.cases) {
        const g = c.roomGroup || "unknown";
        if (!byGroup[g]) {
            byGroup[g] = { pass: 0, fail: 0 };
        }
        if (c.analysisPassed) {
            byGroup[g].pass += 1;
        } else {
            byGroup[g].fail += 1;
        }
    }

    const groupLabels = Object.keys(byGroup);
    const passCounts = groupLabels.map((g) => byGroup[g].pass);
    const failCounts = groupLabels.map((g) => byGroup[g].fail);

    const latencyGroups = Object.keys(latencySummary.byRoomGroup);
    const roomP50 = latencyGroups.map(
        (g) => latencySummary.byRoomGroup[g].p50 ?? 0,
    );
    const roomP95 = latencyGroups.map(
        (g) => latencySummary.byRoomGroup[g].p95 ?? 0,
    );

    const phaseChart = phaseChartData(latencySummary);

    const latencyHeaderCells = TABLE_PHASE_DEFINITIONS.map(
        (p) =>
            `<th class="num" title="${esc(p.description)}">${esc(p.shortLabel)}</th>`,
    ).join("\n          ");

    const tableRows = correctness.cases
        .map((c) => renderTableRow(c, titleMap))
        .join("\n");

    const chartTheme = {
        grid: "#2d3139",
        text: "#9aa0a6",
        font: "system-ui, sans-serif",
    };

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Trading prod analysis</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    :root {
      --bg: #0f1115;
      --surface: #1a1d24;
      --surface-alt: #14171c;
      --border: #2d3139;
      --text: #e8eaed;
      --text-muted: #9aa0a6;
      --accent: #7eb8ff;
      --pass: #34a853;
      --fail: #ea4335;
      --warn: #fbbc04;
    }
    * { box-sizing: border-box; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      margin: 0;
      padding: 24px 32px 48px;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
    }
    .page { max-width: 1600px; margin: 0 auto; }
    h1 { color: #fff; margin: 0 0 8px; font-size: 1.75rem; }
    h2 { color: #fff; margin: 32px 0 16px; font-size: 1.15rem; font-weight: 600; }
    h3 { color: #fff; margin: 0 0 12px; font-size: 1rem; font-weight: 600; }
    .subtitle { color: var(--text-muted); margin: 0 0 24px; }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }

    .kpi-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 16px;
      margin-bottom: 24px;
    }
    .kpi-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px 18px;
    }
    .kpi-label {
      color: var(--text-muted);
      font-size: 0.8rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
      margin-bottom: 6px;
    }
    .kpi-value { font-size: 1.35rem; font-weight: 600; color: #fff; }
    .kpi-value.pass { color: var(--pass); }
    .kpi-value.fail { color: var(--fail); }
    .kpi-value.kpi-small { font-size: 0.85rem; font-weight: 400; color: var(--text-muted); }
    .kpi-sub { font-size: 0.85rem; font-weight: 400; color: var(--text-muted); }

    .alert {
      border-radius: 10px;
      padding: 14px 18px;
      margin-bottom: 24px;
      font-size: 0.9rem;
    }
    .alert-fail {
      background: rgba(234, 67, 53, 0.12);
      border: 1px solid rgba(234, 67, 53, 0.35);
      color: #f8b4b0;
    }
    .alert ul { margin: 8px 0 0; padding-left: 20px; }

    .latency-guide {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 20px 24px;
      margin-bottom: 28px;
    }
    .latency-guide p { color: var(--text-muted); margin: 0 0 16px; font-size: 0.9rem; }
    .pipeline {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      gap: 4px 0;
      margin-bottom: 20px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .pipe-step { display: flex; align-items: center; }
    .pipe-chip {
      display: inline-block;
      padding: 6px 10px;
      border-radius: 6px;
      border: 2px solid;
      background: var(--surface-alt);
      font-size: 0.78rem;
      font-weight: 500;
      white-space: nowrap;
    }
    .pipe-arrow { color: var(--text-muted); margin: 0 6px; font-size: 0.9rem; }
    .phase-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 12px;
    }
    .phase-card {
      display: flex;
      gap: 10px;
      padding: 10px 12px;
      background: var(--surface-alt);
      border-radius: 8px;
      border: 1px solid var(--border);
    }
    .phase-dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      margin-top: 5px;
      flex-shrink: 0;
    }
    .phase-label { font-weight: 600; font-size: 0.88rem; color: #fff; }
    .phase-desc { font-size: 0.8rem; color: var(--text-muted); margin-top: 2px; }

    .charts {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 20px;
      margin-bottom: 8px;
    }
    @media (max-width: 1100px) { .charts { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 700px) { .charts { grid-template-columns: 1fr; } }
    .chart-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
    }
    .chart-card h3 { margin-bottom: 12px; }
    .chart-card canvas { width: 100% !important; }

    .table-wrap {
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--surface);
    }
    table {
      border-collapse: collapse;
      width: 100%;
      font-size: 0.85rem;
      min-width: 1200px;
    }
    th, td {
      border-bottom: 1px solid var(--border);
      padding: 10px 12px;
      text-align: left;
      vertical-align: top;
    }
    th {
      background: var(--surface-alt);
      color: var(--text-muted);
      font-weight: 600;
      font-size: 0.78rem;
      text-transform: uppercase;
      letter-spacing: 0.03em;
      white-space: nowrap;
    }
    th.group-header {
      text-align: center;
      background: #1e2229;
      color: #fff;
      font-size: 0.72rem;
      letter-spacing: 0.06em;
    }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(126, 184, 255, 0.04); }
    .sticky-col {
      position: sticky;
      left: 0;
      background: var(--surface);
      z-index: 1;
      min-width: 220px;
      border-right: 1px solid var(--border);
    }
    tr:hover .sticky-col { background: #1c2028; }
    .case-title { font-weight: 600; color: #fff; line-height: 1.3; }
    .case-id {
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
      font-size: 0.72rem;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .section-tag {
      display: inline-block;
      margin-top: 4px;
      padding: 2px 6px;
      border-radius: 4px;
      background: rgba(126, 184, 255, 0.12);
      color: var(--accent);
      font-size: 0.68rem;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    .badge {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.72rem;
      font-weight: 700;
      letter-spacing: 0.04em;
    }
    .badge.pass { background: rgba(52, 168, 83, 0.2); color: #81c995; }
    .badge.fail { background: rgba(234, 67, 53, 0.2); color: #f28b82; }
    td.num { font-variant-numeric: tabular-nums; white-space: nowrap; }
    td.issues { max-width: 240px; font-size: 0.8rem; color: var(--text-muted); }
    .latency-bar {
      display: flex;
      height: 8px;
      border-radius: 4px;
      overflow: hidden;
      background: var(--border);
      min-width: 80px;
    }
    .latency-bar.empty { background: transparent; color: var(--text-muted); font-size: 0.8rem; }
    .latency-bar .seg { display: block; height: 100%; min-width: 2px; }
    .bar-cell { min-width: 90px; }
  </style>
</head>
<body>
  <div class="page">
    <h1>Trading prod harness analysis</h1>
    <p class="subtitle">Live Binance trading suite — correctness, latency breakdown, and audit coverage.</p>

    ${renderKpiCards(correctness)}
    ${renderTeardownAlert(correctness)}

    <section class="latency-guide">
      <h3>How latency is measured</h3>
      <p>
        Phases are derived from SSE transcript <code>at</code> offsets, harness approval HTTP calls,
        and CloudWatch <code>[Trading]</code> audit events. Cases without approval (risk deny, unsupported, blocked)
        show <strong>—</strong> for missing phases. Use the <em>jsonl</em> and <em>audit</em> links per case to inspect raw data.
      </p>
      <div class="pipeline">${renderPipelineSteps()}</div>
      <div class="phase-grid">${renderPhaseCards()}</div>
    </section>

    <h2>Charts</h2>
    <div class="charts">
      <div class="chart-card">
        <h3>Pass / fail by room group</h3>
        <canvas id="passChart"></canvas>
      </div>
      <div class="chart-card">
        <h3>Total latency p50 / p95</h3>
        <canvas id="latencyChart"></canvas>
      </div>
      <div class="chart-card">
        <h3>Phase latency p50 / p95</h3>
        <canvas id="phaseChart"></canvas>
      </div>
    </div>

    <h2>Cases</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th rowspan="2" class="sticky-col">Case</th>
            <th rowspan="2">Room</th>
            <th colspan="2" class="group-header">Results</th>
            <th colspan="${TABLE_PHASE_DEFINITIONS.length + 2}" class="group-header">Latency breakdown</th>
            <th colspan="3" class="group-header">Audit</th>
            <th colspan="2" class="group-header">Links</th>
          </tr>
          <tr>
            <th>Harness</th>
            <th>Analysis</th>
            <th class="num" title="Full harness wall-clock for the case">Total</th>
            ${latencyHeaderCells}
            <th title="Relative phase breakdown">Bar</th>
            <th>Risk</th>
            <th class="num">Events</th>
            <th>Issues</th>
            <th>Transcript</th>
            <th>CW audit</th>
          </tr>
        </thead>
        <tbody>${tableRows}</tbody>
      </table>
    </div>
  </div>
  <script>
    const chartTheme = ${JSON.stringify(chartTheme)};
    const phaseDescriptions = ${JSON.stringify(phaseChart.descriptions)};

    const baseScale = {
      ticks: { color: chartTheme.text, font: { family: chartTheme.font } },
      grid: { color: chartTheme.grid },
    };

    const groupLabels = ${JSON.stringify(groupLabels)};
    new Chart(document.getElementById("passChart"), {
      type: "bar",
      data: {
        labels: groupLabels,
        datasets: [
          { label: "Pass", data: ${JSON.stringify(passCounts)}, backgroundColor: "#34a853" },
          { label: "Fail", data: ${JSON.stringify(failCounts)}, backgroundColor: "#ea4335" }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: chartTheme.text } } },
        scales: {
          x: { ...baseScale, stacked: true },
          y: { ...baseScale, stacked: true, beginAtZero: true }
        }
      }
    });

    new Chart(document.getElementById("latencyChart"), {
      type: "bar",
      data: {
        labels: ${JSON.stringify(latencyGroups)},
        datasets: [
          { label: "p50", data: ${JSON.stringify(roomP50)}, backgroundColor: "#4285f4" },
          { label: "p95", data: ${JSON.stringify(roomP95)}, backgroundColor: "#fbbc04" }
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { labels: { color: chartTheme.text } } },
        scales: {
          x: baseScale,
          y: { ...baseScale, beginAtZero: true }
        }
      }
    });

    new Chart(document.getElementById("phaseChart"), {
      type: "bar",
      data: {
        labels: ${JSON.stringify(phaseChart.labels)},
        datasets: [
          { label: "p50", data: ${JSON.stringify(phaseChart.p50)}, backgroundColor: "#4285f4" },
          { label: "p95", data: ${JSON.stringify(phaseChart.p95)}, backgroundColor: "#fbbc04" }
        ]
      },
      options: {
        responsive: true,
        indexAxis: "y",
        plugins: {
          legend: { labels: { color: chartTheme.text } },
          tooltip: {
            callbacks: {
              afterLabel(ctx) {
                const idx = ctx.dataIndex;
                const desc = phaseDescriptions[idx];
                const count = ${JSON.stringify(phaseChart.counts)}[idx];
                return [desc, "n=" + count];
              }
            }
          }
        },
        scales: {
          x: { ...baseScale, beginAtZero: true },
          y: baseScale
        }
      }
    });
  </script>
</body>
</html>`;

    const outPath = path.join(analysisDir, "dashboard.html");
    await fs.writeFile(outPath, html, "utf8");
    console.log(`[render] ${outPath}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
