#!/usr/bin/env node
/**
 * Smoke test for all 9 sentiscoredata-new S3 sources.
 * Verifies listing, CSV fetch, parsing, required fields, and -3..+3 value range.
 *
 * Usage:
 *   node scripts/smoke-sentiscore-sources.mjs
 *   node scripts/smoke-sentiscore-sources.mjs --symbol ETH
 */

import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';
import { createRequire } from 'node:module';
import process from 'node:process';

const require = createRequire(import.meta.url);
const csvtojson = require('csvtojson');

const BUCKET = process.env.SENTISCORE_S3_BUCKET || 'sentiscoredata-new';
const REGION  = process.env.SENTISCORE_S3_REGION  || 'us-east-2';
const ACCESS_KEY  = process.env.AWS_ACCESS_KEY_ID;
const SECRET_KEY  = process.env.AWS_SECRET_ACCESS_KEY;

const args = process.argv.slice(2);
const symIdx = args.indexOf('--symbol');
const PER_SYMBOL = symIdx !== -1 ? args[symIdx + 1].toUpperCase() : 'BTC';

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

const REQUIRED_FIELDS = [
    'time', 'value',
    'strongly_negative', 'moderately_negative', 'mildly_negative',
    'neutral',
    'mildly_positive', 'moderately_positive', 'strongly_positive',
    'negative', 'positive', 'total',
];

function makeS3() {
    return new S3Client({
        region: REGION,
        ...(ACCESS_KEY && SECRET_KEY
            ? { credentials: { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY } }
            : {}),
    });
}

async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf-8');
}

function parseNum(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; }

function normalizeRow(row) {
    const low = {};
    for (const [k, v] of Object.entries(row)) low[k.trim().toLowerCase()] = String(v ?? '').trim();

    // resolve time
    let time = null;
    for (const col of ['time', 'ts', 'timestamp']) {
        const raw = low[col];
        if (!raw) continue;
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;
        time = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n);
        break;
    }
    if (time === null && low.date && low.hour) {
        const [y, mo, d] = low.date.split('-').map(Number);
        const [h] = low.hour.split(':').map(Number);
        time = Math.floor(Date.UTC(y, mo - 1, d, h || 0, 0, 0, 0) / 1000);
    }
    if (!time) return null;

    const sn  = parseNum(low.strongly_negative);
    const mn  = parseNum(low.moderately_negative);
    const ldn = parseNum(low.mildly_negative);
    const neu = parseNum(low.neutral);
    const ldp = parseNum(low.mildly_positive);
    const mp  = parseNum(low.moderately_positive);
    const sp  = parseNum(low.strongly_positive);
    const sumParts = sn + mn + ldn + neu + ldp + mp + sp;
    const total = parseNum(low.total) || sumParts || 1;

    // Use model output (expected_positive) directly; fall back to formula if absent
    const ep = low.expected_positive;
    let value;
    if (ep !== undefined && ep !== '') {
        const p = parseFloat(ep);
        value = Number.isFinite(p) ? p : ((-sn + (-2/3)*mn + (-1/3)*ldn + (1/3)*ldp + (2/3)*mp + sp) / total);
    } else {
        value = ((-sn + (-2/3)*mn + (-1/3)*ldn + (1/3)*ldp + (2/3)*mp + sp) / total);
    }

    return {
        time,
        value,
        strongly_negative:  sn,
        moderately_negative: mn,
        mildly_negative:    ldn,
        neutral:            neu,
        mildly_positive:    ldp,
        moderately_positive: mp,
        strongly_positive:  sp,
        negative: sn + mn + ldn,
        positive: ldp + mp + sp,
        total,
    };
}

async function testSource(s3, source) {
    const symbol = source.mode === 'ALL' ? 'ALL' : PER_SYMBOL;
    const label  = `${source.name}/${symbol}`;

    // list date folders
    const listRes = await s3.send(new ListObjectsV2Command({
        Bucket: BUCKET, Prefix: `${source.prefix}/`, Delimiter: '/',
    }));
    const dates = (listRes.CommonPrefixes || [])
        .map(cp => { const m = cp.Prefix?.match(/\/(\d{4}-\d{2}-\d{2})\//); return m?.[1]; })
        .filter(Boolean).sort();

    if (dates.length === 0)
        return { label, ok: false, error: 'No date folders found' };

    // find latest date that has CSV files
    let csvFiles = [];
    let foundDate = null;
    for (let i = dates.length - 1; i >= Math.max(0, dates.length - 5); i--) {
        const d = dates[i];
        const r = await s3.send(new ListObjectsV2Command({
            Bucket: BUCKET,
            Prefix: `${source.prefix}/${d}/hourly_score/${symbol}/`,
        }));
        const f = (r.Contents || []).filter(o => o.Key?.endsWith('.csv'));
        if (f.length > 0) {
            csvFiles = f.sort((a, b) => new Date(b.LastModified) - new Date(a.LastModified));
            foundDate = d;
            break;
        }
    }

    if (csvFiles.length === 0)
        return { label, ok: false, error: `No CSV files for ${symbol} in last 5 dates`, dates: dates.length };

    // fetch + parse
    const fileRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: csvFiles[0].Key }));
    const csvStr  = await streamToString(fileRes.Body);
    const rawRows = await csvtojson().fromString(csvStr);

    if (rawRows.length === 0)
        return { label, ok: false, error: 'CSV has 0 rows', key: csvFiles[0].Key };

    const normalized = rawRows.map(normalizeRow).filter(Boolean);
    if (normalized.length === 0)
        return { label, ok: false, error: 'All rows failed normalization', sample: rawRows[0] };

    // check required fields
    const sample = normalized[0];
    const missing = REQUIRED_FIELDS.filter(f => !(f in sample));
    if (missing.length > 0)
        return { label, ok: false, error: `Missing fields: ${missing.join(', ')}` };

    // check value is in -3..+3
    const outOfRange = normalized.filter(r => r.value < -3 || r.value > 3);
    if (outOfRange.length > 0)
        return { label, ok: false, error: `${outOfRange.length} rows have value outside [-3,3]` };

    const values = normalized.map(r => r.value);
    const minV = Math.min(...values).toFixed(2);
    const maxV = Math.max(...values).toFixed(2);

    return {
        ok: true, label,
        dates: dates.length, latestDate: foundDate,
        rows: normalized.length,
        valueRange: `[${minV}, ${maxV}]`,
        sample: { value: sample.value.toFixed(3), sn: sample.strongly_negative, sp: sample.strongly_positive, total: sample.total },
    };
}

async function main() {
    console.log(`\nSentiScore S3 source smoke test  (scale: -3..+3)`);
    console.log(`Bucket: ${BUCKET}   Region: ${REGION}   Symbol: ${PER_SYMBOL}`);
    console.log('─'.repeat(72));

    const s3 = makeS3();
    let passed = 0;

    for (const source of SOURCES) {
        process.stdout.write(`  ${source.name.padEnd(16)} ... `);
        try {
            const r = await testSource(s3, source);
            if (r.ok) {
                passed++;
                console.log(`✅  dates=${r.dates}  latest=${r.latestDate}  rows=${r.rows}  value=${r.valueRange}`);
            } else {
                console.log(`❌  ${r.error}`);
                if (r.sample) console.log(`     sample:`, JSON.stringify(r.sample).slice(0, 200));
            }
        } catch (err) {
            console.log(`❌  ERROR: ${err.message}`);
        }
    }

    console.log('─'.repeat(72));
    const total = SOURCES.length;
    console.log(`Result: ${passed}/${total} passed\n`);
    if (passed < total) process.exit(1);
}

main().catch(err => { console.error(err); process.exit(1); });
