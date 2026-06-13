#!/usr/bin/env node
/**
 * Smoke test for the full sentiscore combine pipeline (no LLM).
 *
 * Tests:
 *   1. S3 fetch for all 9 sources
 *   2. Row normalization (expected_positive → value)
 *   3. Date filtering (last 14 days)
 *   4. Time-aligned scoring (per-hour cross-source average)
 *   5. Per-source metrics (avg, trend, volatility, distribution)
 *   6. PNG chart generation via chartjs-node-canvas
 *   7. Prints the stats block that would be sent to the LLM
 *
 * Usage:
 *   node scripts/smoke-sentiscore-combine.mjs
 *   node scripts/smoke-sentiscore-combine.mjs --symbol ETH --days 7
 *   node scripts/smoke-sentiscore-combine.mjs --no-png
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createRequire } from 'node:module';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';

const require = createRequire(import.meta.url);
const csvtojson = require('csvtojson');

// ── CLI args ─────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => { const i = args.indexOf(flag); return i !== -1 ? args[i + 1] : null; };
const SYMBOL   = (getArg('--symbol') || 'BTC').toUpperCase();
const DAYS     = Number.parseInt(getArg('--days') || '14', 10);
const NO_PNG   = args.includes('--no-png');

// ── Config ───────────────────────────────────────────────────────────────────
const BUCKET = process.env.SENTISCORE_S3_BUCKET || 'sentiscoredata-new';
const REGION  = process.env.SENTISCORE_S3_REGION  || 'us-east-2';

const SOURCES = [
    { name: 'crypto_news',   prefix: 'crypto_news',   mode: 'per-symbol' },
    { name: 'X',             prefix: 'X',             mode: 'per-symbol' },
    { name: 'X_influencers', prefix: 'X_influencers', mode: 'per-symbol' },
    { name: 'reddit',        prefix: 'reddit',        mode: 'per-symbol' },
    { name: 'podcast',       prefix: 'podcast',       mode: 'per-symbol' },
    { name: 'research',      prefix: 'research',      mode: 'per-symbol' },
    { name: 'crypto_policy', prefix: 'crypto_policy', mode: 'ALL' },
    { name: 'youtube',       prefix: 'youtube',       mode: 'ALL' },
    { name: 'macro_news',    prefix: 'macro_news',    mode: 'ALL' },
];

// ── S3 ───────────────────────────────────────────────────────────────────────
function makeS3() {
    const ak = process.env.AWS_ACCESS_KEY_ID;
    const sk = process.env.AWS_SECRET_ACCESS_KEY;
    return new S3Client({
        region: REGION,
        ...(ak && sk ? { credentials: { accessKeyId: ak, secretAccessKey: sk } } : {}),
    });
}

async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
}

// ── Normalization (mirrors normalizeSentiScoreRow.ts) ─────────────────────────
function parseUnixSec(low) {
    for (const col of ['time', 'ts', 'timestamp']) {
        const raw = low[col];
        if (!raw) continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        return n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
    }
    return null;
}

function parseDateHour(low) {
    const d = low.date, h = low.hour;
    if (!d || !h) return null;
    const [y, mo, dy] = d.split('-').map(Number);
    const [hr] = h.split(':').map(Number);
    return Math.floor(Date.UTC(y, mo - 1, dy, hr || 0, 0, 0) / 1000);
}

function normalizeRow(row) {
    const low = {};
    for (const [k, v] of Object.entries(row)) low[k.trim().toLowerCase()] = String(v ?? '').trim();

    const time = parseUnixSec(low) ?? parseDateHour(low);
    if (!time || !Number.isFinite(time)) return null;

    const p = (k) => Number.parseFloat(low[k] || '0') || 0;
    const sn = p('strongly_negative'), mn = p('moderately_negative'), ldn = p('mildly_negative');
    const neu = p('neutral');
    const ldp = p('mildly_positive'), mp = p('moderately_positive'), sp = p('strongly_positive');
    const sumParts = sn + mn + ldn + neu + ldp + mp + sp;
    const total = p('total') || sumParts || 1;

    let value;
    const ep = low.expected_positive;
    if (ep !== undefined && ep !== '') {
        const parsed = Number.parseFloat(ep);
        value = Number.isFinite(parsed) ? parsed
            : (-sn + (-2/3)*mn + (-1/3)*ldn + (1/3)*ldp + (2/3)*mp + sp) / total;
    } else {
        value = (-sn + (-2/3)*mn + (-1/3)*ldn + (1/3)*ldp + (2/3)*mp + sp) / total;
    }

    return { time, value, sn, mn, ldn, neu, ldp, mp, sp, total };
}

// ── S3 fetch ──────────────────────────────────────────────────────────────────
async function fetchSourceRows(s3, source, symbol) {
    const sym = source.mode === 'ALL' ? 'ALL' : symbol;

    // list date folders
    const listRes = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: `${source.prefix}/`, Delimiter: '/'
    }));
    const dates = (listRes.CommonPrefixes || [])
        .map(cp => cp.Prefix?.match(/\/(\d{4}-\d{2}-\d{2})\//)?.[1])
        .filter(Boolean).sort();

    // cutoff: DAYS ago
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - DAYS);
    const cutoffStr = cutoff.toISOString().split('T')[0];
    const recentDates = dates.filter(d => d >= cutoffStr);

    if (recentDates.length === 0) return { rows: [], datesChecked: 0 };

    const allRows = [];
    for (const date of recentDates) {
        const r = await s3.send(new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: `${source.prefix}/${date}/hourly_score/${sym}/`
        }));
        const csvFiles = (r.Contents || []).filter(o => o.Key?.endsWith('.csv'));
        if (csvFiles.length === 0) continue;

        csvFiles.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
        const fileRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: csvFiles[0].Key }));
        const csvStr = await streamToString(fileRes.Body);
        const raw = await csvtojson().fromString(csvStr);
        for (const row of raw) {
            const n = normalizeRow(row);
            if (n) allRows.push(n);
        }
    }
    return { rows: allRows, datesChecked: recentDates.length };
}

// ── Metrics ───────────────────────────────────────────────────────────────────
function computeMetrics(scores) {
    if (scores.length === 0) return null;
    const vals = scores.map(s => s.value);
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    const pos = scores.filter(s => s.value > 0.05);
    const neg = scores.filter(s => s.value < -0.05);
    const neu = scores.filter(s => s.value >= -0.05 && s.value <= 0.05);

    // trend: compare first half vs second half
    const half = Math.floor(vals.length / 2);
    const firstHalfAvg = vals.slice(0, half).reduce((a, b) => a + b, 0) / (half || 1);
    const secondHalfAvg = vals.slice(half).reduce((a, b) => a + b, 0) / (vals.length - half || 1);
    const change = secondHalfAvg - firstHalfAvg;
    const trend = change > 0.02 ? 'improving' : change < -0.02 ? 'declining' : 'stable';

    const variance = vals.reduce((a, b) => a + (b - avg) ** 2, 0) / vals.length;
    const volatility = Math.sqrt(variance);

    const sorted = [...vals].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const min = sorted[0], max = sorted[sorted.length - 1];

    return { total: vals.length, avg, median, min, max, change, trend, volatility,
             posPct: (pos.length / vals.length * 100).toFixed(1),
             negPct: (neg.length / vals.length * 100).toFixed(1),
             neuPct: (neu.length / vals.length * 100).toFixed(1) };
}

// ── Time-aligned scoring ──────────────────────────────────────────────────────
function buildAlignedScores(allRows) {
    const map = new Map();
    for (const r of allRows) {
        const bucket = map.get(r.time) ?? [];
        bucket.push(r.value);
        map.set(r.time, bucket);
    }
    return Array.from(map.entries())
        .sort(([a], [b]) => a - b)
        .map(([time, vals]) => ({ time, value: vals.reduce((s, v) => s + v, 0) / vals.length }));
}

// ── PNG generation ────────────────────────────────────────────────────────────
async function generatePNG(scores, label, color = 'rgb(99, 102, 241)', outPath) {
    // dynamic import so --no-png skips the heavy module load
    // resolve from the plugin package that has chartjs-node-canvas installed
    const { createRequire: cr } = await import('node:module');
    const pluginRequire = cr(new URL('../packages/plugin-sentiscore/package.json', import.meta.url).pathname);
    const { ChartJSNodeCanvas } = pluginRequire('chartjs-node-canvas');
    const canvas = new ChartJSNodeCanvas({ width: 900, height: 360, backgroundColour: '#ffffff' });

    // hourly labels — no day-bucketing
    const sorted = [...scores].sort((a, b) => a.time - b.time);
    const labels = sorted.map(s => {
        const d = new Date(s.time * 1000);
        return `${d.toISOString().slice(0, 10)} ${String(d.getUTCHours()).padStart(2, '0')}:00`;
    });
    const values = sorted.map(s => s.value);
    const bg = color.replace('rgb(', 'rgba(').replace(')', ', 0.10)');

    const config = {
        type: 'line',
        data: {
            labels,
            datasets: [{
                label,
                data: values,
                borderColor: color,
                backgroundColor: bg,
                borderWidth: 1.5,
                pointRadius: sorted.length > 100 ? 0 : 2,
                fill: true,
                tension: 0.2,
            }],
        },
        options: {
            animation: false,
            responsive: false,
            plugins: {
                legend: { display: true },
                title: { display: true, text: label, font: { size: 13 } },
            },
            scales: {
                y: { min: -1, max: 1, title: { display: true, text: 'Sentiment (-1 to +1)' } },
                x: { ticks: { maxTicksLimit: 14, maxRotation: 45 } },
            },
        },
    };

    const buf = await canvas.renderToBuffer(config);
    writeFileSync(outPath, buf);
    return buf.length;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(`  SentiScore combine pipeline smoke test`);
    console.log(`  Symbol: ${SYMBOL}  |  Days: ${DAYS}  |  Bucket: ${BUCKET}`);
    console.log(`${'═'.repeat(72)}\n`);

    const s3 = makeS3();
    const sourceResults = {};
    const allRows = [];

    // 1. Fetch all sources
    console.log('── 1. Fetching S3 data ──────────────────────────────────────────────────\n');
    for (const src of SOURCES) {
        process.stdout.write(`  ${src.name.padEnd(16)} `);
        try {
            const { rows, datesChecked } = await fetchSourceRows(s3, src, SYMBOL);
            sourceResults[src.name] = rows;
            allRows.push(...rows);
            console.log(`✅  ${rows.length} rows  (${datesChecked} dates checked)`);
        } catch (err) {
            sourceResults[src.name] = [];
            console.log(`❌  ERROR: ${err.message}`);
        }
    }

    // 2. Per-source metrics
    console.log(`\n── 2. Per-source metrics ────────────────────────────────────────────────\n`);
    for (const src of SOURCES) {
        const rows = sourceResults[src.name];
        if (rows.length === 0) {
            console.log(`  ${src.name.padEnd(16)}  no data`);
            continue;
        }
        const m = computeMetrics(rows);
        console.log(`  ${src.name.padEnd(16)}  n=${String(m.total).padStart(4)}  avg=${m.avg.toFixed(4)}  med=${m.median.toFixed(4)}  range=[${m.min.toFixed(3)},${m.max.toFixed(3)}]  vol=${m.volatility.toFixed(4)}  trend=${m.trend}`);
        console.log(`${''.padEnd(20)}  dist: ${m.posPct}% pos / ${m.neuPct}% neu / ${m.negPct}% neg`);
    }

    // 3. Time-aligned combined scores
    const alignedScores = buildAlignedScores(allRows);
    const combinedMetrics = computeMetrics(alignedScores);

    console.log(`\n── 3. Time-aligned combined scores ─────────────────────────────────────\n`);
    if (combinedMetrics) {
        console.log(`  Total time points : ${combinedMetrics.total}`);
        console.log(`  Average           : ${combinedMetrics.avg.toFixed(4)}`);
        console.log(`  Median            : ${combinedMetrics.median.toFixed(4)}`);
        console.log(`  Range             : [${combinedMetrics.min.toFixed(4)}, ${combinedMetrics.max.toFixed(4)}]`);
        console.log(`  Volatility        : ${combinedMetrics.volatility.toFixed(4)}`);
        console.log(`  Trend             : ${combinedMetrics.trend} (Δ${combinedMetrics.change > 0 ? '+' : ''}${combinedMetrics.change.toFixed(4)})`);
        console.log(`  Distribution      : ${combinedMetrics.posPct}% pos / ${combinedMetrics.neuPct}% neu / ${combinedMetrics.negPct}% neg`);
        console.log(`\n  Overall signal    : ${combinedMetrics.avg > 0.05 ? '📈 BULLISH' : combinedMetrics.avg < -0.05 ? '📉 BEARISH' : '➡️  NEUTRAL'}`);
    } else {
        console.log('  No data across any source.');
    }

    // 4. Sample of LLM stats block for one source
    console.log(`\n── 4. Sample stats block sent to LLM (crypto_news) ─────────────────────\n`);
    const sampleRows = sourceResults['crypto_news'];
    if (sampleRows.length > 0) {
        const m = computeMetrics(sampleRows);
        const block = `📊 **SENTIMENT DATA METRICS:**
- **Total data points:** ${m.total}
- **Average sentiment score:** ${m.avg.toFixed(4)}
- **Sentiment trend:** ${m.trend} (${m.change > 0 ? '+' : ''}${m.change.toFixed(4)})
- **Sentiment volatility:** ${m.volatility.toFixed(4)}

Analyzing Crypto News sentiment for ${SYMBOL} (${m.total} data points).
Statistical details:
- Median: ${m.median.toFixed(4)}, Range: ${m.min.toFixed(4)} to ${m.max.toFixed(4)}
- Distribution: ${m.posPct}% positive, ${m.neuPct}% neutral, ${m.negPct}% negative
- Volatility level: ${m.volatility > 0.15 ? 'High' : m.volatility > 0.08 ? 'Moderate' : m.volatility > 0.03 ? 'Low' : 'Minimal'} (${m.volatility.toFixed(4)})`;
        console.log(block.split('\n').map(l => '  ' + l).join('\n'));
    } else {
        console.log('  (no crypto_news data in range)');
    }

    // 5. PNG — generate one per source + combined (hourly, no day-bucketing)
    if (!NO_PNG) {
        console.log(`\n── 5. PNG generation (hourly) ──────────────────────────────────────────\n`);
        const outDir = join(process.cwd(), 'scripts', 'smoke-output');
        if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

        const specs = [
            { key: 'crypto_news',   scores: sourceResults['crypto_news'],   label: `${SYMBOL} — Crypto News`,            color: 'rgb(239, 68, 68)'  },
            { key: 'X',             scores: sourceResults['X'],             label: `${SYMBOL} — X/Twitter`,              color: 'rgb(59, 130, 246)' },
            { key: 'X_influencers', scores: sourceResults['X_influencers'], label: `${SYMBOL} — X Influencers`,          color: 'rgb(168, 85, 247)' },
            { key: 'reddit',        scores: sourceResults['reddit'],        label: `${SYMBOL} — Reddit`,                 color: 'rgb(249, 115, 22)' },
            { key: 'podcast',       scores: sourceResults['podcast'],       label: `${SYMBOL} — Podcast`,                color: 'rgb(20, 184, 166)' },
            { key: 'research',      scores: sourceResults['research'],      label: `${SYMBOL} — Research`,               color: 'rgb(234, 179, 8)'  },
            { key: 'crypto_policy', scores: sourceResults['crypto_policy'], label: `${SYMBOL} — Crypto Policy`,          color: 'rgb(107, 114, 128)'},
            { key: 'youtube',       scores: sourceResults['youtube'],       label: `${SYMBOL} — YouTube`,                color: 'rgb(220, 38, 38)'  },
            { key: 'macro_news',    scores: sourceResults['macro_news'],    label: `${SYMBOL} — Macro News`,             color: 'rgb(16, 185, 129)' },
            { key: 'combined',      scores: alignedScores,                  label: `${SYMBOL} — Combined (all sources)`, color: 'rgb(99, 102, 241)' },
        ];

        for (const spec of specs) {
            if (spec.scores.length === 0) {
                console.log(`  ⏭️   ${spec.key.padEnd(16)} skipped (no data)`);
                continue;
            }
            const outPath = join(outDir, `sentiscore-${spec.key}-${SYMBOL}.png`);
            try {
                const bytes = await generatePNG(spec.scores, spec.label, spec.color, outPath);
                console.log(`  ✅  ${spec.key.padEnd(16)} ${outPath.split('/').pop()}  (${(bytes / 1024).toFixed(1)} KB)`);
            } catch (err) {
                console.log(`  ❌  ${spec.key.padEnd(16)} ${err.message}`);
            }
        }
    }

    console.log(`\n${'═'.repeat(72)}\n`);
}

main().catch(err => { console.error(err); process.exit(1); });
