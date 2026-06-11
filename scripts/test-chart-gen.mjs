/**
 * Standalone chart generation test — no LLM calls.
 * Fetches real sentiment data from S3, price data from CoinGlass,
 * normalizes everything, and generates the chart HTML.
 *
 * Usage:
 *   export $(grep -E '^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|SENTISCORE_S3_BUCKET|SENTISCORE_S3_REGION|COINGLASS_API_KEY)=' .env | xargs)
 *   node scripts/test-chart-gen.mjs
 */
import { S3Client, ListObjectsV2Command, GetObjectCommand } from "@aws-sdk/client-s3";
import csvtojson from "csvtojson";
import fs from "node:fs";
import path from "node:path";

const BUCKET = process.env.SENTISCORE_S3_BUCKET || "sentiscoredata-new";
const REGION = process.env.SENTISCORE_S3_REGION || "us-east-2";
const SYMBOL = "BTC";

const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;

const s3 = new S3Client({
    region: REGION,
    ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
});

async function streamToString(stream) {
    const chunks = [];
    for await (const chunk of stream) {
        chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
    }
    return Buffer.concat(chunks).toString("utf-8");
}

// ─── Normalization (mirrors normalizeSentiScoreRow.ts) ───────────────────────

const SEVEN_CAT = ["strongly_negative", "moderately_negative", "mildly_negative",
    "mildly_positive", "moderately_positive", "strongly_positive"];
const PRECOMP = ["value", "sentiment", "sentiscore", "score"];

function lower(row) {
    const o = {};
    for (const [k, v] of Object.entries(row)) o[k.trim().toLowerCase()] = String(v ?? "").trim();
    return o;
}

function inferFormat(row) {
    const keys = new Set(Object.keys(row).map(k => k.trim().toLowerCase()));
    if (SEVEN_CAT.some(m => keys.has(m))) return "seven_category";
    if (PRECOMP.some(k => keys.has(k))) return "precomputed";
    return "count";
}

function parseDateHour(d, h) {
    const [y, m, dy] = d.split("-").map(Number);
    const [hr, mn] = h.split(":").map(Number);
    return Math.floor(Date.UTC(y, m - 1, dy, hr || 0, mn || 0) / 1000);
}

function normalizeRow(row, fmt) {
    const low = lower(row);
    let time = null;
    for (const c of ["time", "ts", "timestamp"]) {
        const n = Number(low[c]);
        if (Number.isFinite(n)) { time = n > 1e12 ? Math.floor(n / 1000) : Math.floor(n); break; }
    }
    if (time === null && low.date && low.hour) time = parseDateHour(low.date, low.hour);
    if (time === null) return null;

    if (fmt === "seven_category") {
        const sn = parseFloat(low.strongly_negative || "0") || 0;
        const mn_ = parseFloat(low.moderately_negative || "0") || 0;
        const miln = parseFloat(low.mildly_negative || "0") || 0;
        const neu = parseFloat(low.neutral || "0") || 0;
        const milp = parseFloat(low.mildly_positive || "0") || 0;
        const mp = parseFloat(low.moderately_positive || "0") || 0;
        const sp = parseFloat(low.strongly_positive || "0") || 0;
        let total = parseFloat(low.total || "0") || 0;
        const sum = sn + mn_ + miln + neu + milp + mp + sp;
        if (total <= 0 && sum > 0) total = sum;
        const coarseNeg = sn + mn_ + miln;
        const coarsePos = milp + mp + sp;
        const expRaw = low.expected_positive;
        let value;
        if (expRaw !== undefined && expRaw !== "") {
            const p = parseFloat(expRaw);
            value = Number.isFinite(p) ? Math.max(-1, Math.min(1, p))
                : (total > 0 ? (-1*sn + (-2/3)*mn_ + (-1/3)*miln + (1/3)*milp + (2/3)*mp + sp) / total : 0);
        } else {
            value = total > 0 ? (-1*sn + (-2/3)*mn_ + (-1/3)*miln + (1/3)*milp + (2/3)*mp + sp) / total : 0;
        }
        return { time, value: Math.max(-1, Math.min(1, value)), negative: coarseNeg, neutral: neu, positive: coarsePos, total: total > 0 ? total : 1, expected_negative: 0 };
    }

    const neg = parseFloat(low.negative || "0") || 0;
    const neu = parseFloat(low.neutral || "0") || 0;
    const pos = parseFloat(low.positive || "0") || 0;
    let total = parseFloat(low.total || "0") || 0;
    if (total <= 0) { const s = neg + neu + pos; if (s > 0) total = s; }
    const value = total > 0 ? (pos - neg) / total : 0;
    return { time, value, negative: neg, neutral: neu, positive: pos, total, expected_negative: parseFloat(low.expected_negative || "0") || 0 };
}

function normalizeRows(rows) {
    if (!rows.length) return [];
    const fmt = inferFormat(rows[0]);
    return rows.map(r => normalizeRow(r, fmt)).filter(Boolean);
}

// ─── S3 fetch ────────────────────────────────────────────────────────────────

async function fetchSentiScores(prefixRoot, symbol, startDate, endDate) {
    const listRes = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefixRoot, Delimiter: "/" }));
    const dateStrings = (listRes.CommonPrefixes || []).map(cp => {
        const m = cp.Prefix?.match(new RegExp(`^${prefixRoot}(\\d{4}-\\d{2}-\\d{2})/`));
        return m ? m[1] : null;
    }).filter(Boolean).sort().filter(d => d >= startDate && d <= endDate);

    console.log(`  ${prefixRoot}: ${dateStrings.length} dates in range`);
    const allScores = [];
    for (const date of dateStrings) {
        const hourlyPrefix = `${prefixRoot}${date}/hourly_score/${symbol}/`;
        const listHourly = await s3.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: hourlyPrefix }));
        const csvFiles = (listHourly.Contents || []).filter(o => o.Key?.endsWith(".csv"));
        if (!csvFiles.length) continue;
        csvFiles.sort((a, b) => new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime());
        const getRes = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: csvFiles[0].Key }));
        const csvStr = await streamToString(getRes.Body);
        const rows = await csvtojson().fromString(csvStr);
        const normalized = normalizeRows(rows);
        allScores.push(...normalized);
    }
    allScores.sort((a, b) => a.time - b.time);
    return allScores;
}

// ─── CoinGlass ───────────────────────────────────────────────────────────────

async function getCryptoData(symbol, startDate, endDate) {
    const apiKey = process.env.COINGLASS_API_KEY;
    if (!apiKey) { console.error("COINGLASS_API_KEY not set"); return []; }
    const startTime = new Date(`${startDate}T00:00:00Z`).getTime();
    const endTime = new Date(`${endDate}T23:59:59Z`).getTime();
    const limit = Math.min(1000, Math.ceil((endTime - startTime) / 86400000) + 1);
    const url = new URL("https://open-api-v4.coinglass.com/api/futures/price/history");
    url.searchParams.set("exchange", "Binance");
    url.searchParams.set("symbol", `${symbol}USDT`);
    url.searchParams.set("interval", "1d");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("start_time", String(startTime));
    url.searchParams.set("end_time", String(endTime));
    const resp = await fetch(url.toString(), {
        headers: { accept: "application/json", "CG-API-KEY": apiKey },
    });
    const data = await resp.json();
    if (!data || data.code !== "0" || !data.data) { console.error("CoinGlass error:", data?.msg); return []; }
    return data.data.map(item => ({
        date: new Date(item.time).toISOString().split("T")[0],
        price: Number(item.close), high: Number(item.high), low: Number(item.low),
        open: Number(item.open), volume: Number(item.volume_usd),
    })).filter(i => Number.isFinite(i.price));
}

// ─── Chart HTML (mirrors combine.ts generateChartHTML with FIXED averaging) ──

function generateChartHTML(cryptoData, newsSentiScores, xSentiScores, symbol) {
    if (!cryptoData.length) return "<html><body><h1>No price data</h1></body></html>";

    let priceMax = cryptoData[0].price, priceMin = cryptoData[0].price;
    for (const p of cryptoData) { if (p.price > priceMax) priceMax = p.price; if (p.price < priceMin) priceMin = p.price; }

    const dates = cryptoData.map(p => `"${p.date}"`).join(",");
    const prices = cryptoData.map(p => p.price).join(",");
    const volumes = cryptoData.map(p => p.volume / 1e6).join(",");

    function dailyWeightedAvg(scores) {
        const sums = new Map(), totals = new Map();
        for (const s of scores) {
            const d = new Date(s.time * 1000).toISOString().split("T")[0];
            const w = s.total > 0 ? s.total : 1;
            sums.set(d, (sums.get(d) ?? 0) + s.value * w);
            totals.set(d, (totals.get(d) ?? 0) + w);
        }
        const out = new Map();
        for (const [d, sum] of sums) out.set(d, sum / totals.get(d));
        return out;
    }

    const newsMap = dailyWeightedAvg(newsSentiScores);
    const xMap = dailyWeightedAvg(xSentiScores);

    const newsVals = cryptoData.map(p => newsMap.has(p.date) ? newsMap.get(p.date) : null).join(",");
    const xVals = cryptoData.map(p => xMap.has(p.date) ? xMap.get(p.date) : null).join(",");
    const hasNews = newsSentiScores.length > 0, hasX = xSentiScores.length > 0;
    const currentDate = new Date().toISOString().split("T")[0];

    let sentimentDatasets = "";
    if (hasNews) sentimentDatasets += `{label:'Crypto News SentiScore',data:[${newsVals}],borderColor:'rgb(255,99,132)',backgroundColor:'rgba(255,99,132,0.1)',borderWidth:2,pointRadius:0,pointHoverRadius:0,yAxisID:'y2'},`;
    if (hasX) sentimentDatasets += `{label:'X/Twitter SentiScore',data:[${xVals}],borderColor:'rgb(54,162,235)',backgroundColor:'rgba(54,162,235,0.1)',borderWidth:2,pointRadius:0,pointHoverRadius:0,yAxisID:'y2'},`;

    return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${symbol} Price and Sentiment Chart ${currentDate}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
<style>body{font-family:Arial,sans-serif;margin:20px}.chart-container{position:relative;height:80vh;width:90vw;margin:auto}h1{text-align:center;color:#333}.summary{margin:20px 0;padding:15px;background:#f5f5f5;border-radius:5px}.summary p{margin:5px 0}</style></head>
<body>
<h1>${symbol} Price and SentiScore Chart ${currentDate}</h1>
<div class="summary">
<p><strong>Start Date:</strong> ${cryptoData[0].date}</p>
<p><strong>End Date:</strong> ${cryptoData[cryptoData.length - 1].date}</p>
<p><strong>Starting Price:</strong> $${cryptoData[0].price.toLocaleString()}</p>
<p><strong>Ending Price:</strong> $${cryptoData[cryptoData.length - 1].price.toLocaleString()}</p>
<p><strong>Highest Price:</strong> $${priceMax.toLocaleString()}</p>
<p><strong>Lowest Price:</strong> $${priceMin.toLocaleString()}</p>
${hasNews ? `<p><strong>News Sentiment Points:</strong> ${newsSentiScores.length} (${newsMap.size} days)</p>` : ""}
${hasX ? `<p><strong>X Sentiment Points:</strong> ${xSentiScores.length} (${xMap.size} days)</p>` : ""}
</div>
<div class="chart-container"><canvas id="cryptoChart"></canvas></div>
<script>
const ctx=document.getElementById('cryptoChart').getContext('2d');
new Chart(ctx,{type:'line',data:{labels:[${dates}],datasets:[
{label:'${symbol} Price (USD)',data:[${prices}],borderColor:'rgb(75,192,192)',backgroundColor:'rgba(75,192,192,0.1)',borderWidth:2,tension:0.1,pointRadius:0,pointHoverRadius:0,yAxisID:'y'},
{label:'Volume (M USD)',data:[${volumes}],borderColor:'rgb(153,102,255)',backgroundColor:'rgba(153,102,255,0.2)',borderWidth:1,type:'bar',yAxisID:'y1'},
${sentimentDatasets}
]},options:{responsive:true,maintainAspectRatio:false,interaction:{mode:'index',intersect:false},elements:{point:{radius:0,hoverRadius:0}},scales:{x:{ticks:{maxRotation:45,minRotation:45}},y:{type:'linear',display:true,position:'left',title:{display:true,text:'Price (USD)'}},y1:{type:'linear',display:true,position:'right',grid:{drawOnChartArea:false},title:{display:true,text:'Volume (M USD)'}},y2:{type:'linear',display:true,position:'right',grid:{drawOnChartArea:false},title:{display:true,text:'SentiScore'},min:-1.2,max:1.2}}}});
</script></body></html>`;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const endDate = "2026-05-01";
    const startDate = "2025-11-01";
    console.log(`\nFetching BTC sentiment data (${startDate} → ${endDate})...\n`);

    const [newsScores, xScores] = await Promise.all([
        fetchSentiScores("crypto_news/", SYMBOL, startDate, endDate),
        fetchSentiScores("X/", SYMBOL, startDate, endDate),
    ]);
    console.log(`\nNews scores: ${newsScores.length} hourly points`);
    console.log(`X scores:    ${xScores.length} hourly points`);

    // Show a few scores around the format boundary (Feb 28 vs Mar 1)
    console.log("\n--- Format boundary check ---");
    for (const s of newsScores) {
        const d = new Date(s.time * 1000).toISOString().split("T")[0];
        if (d === "2026-02-28" || d === "2026-03-01") {
            const h = new Date(s.time * 1000).toISOString().split("T")[1].substring(0, 5);
            console.log(`  ${d} ${h} | value=${s.value.toFixed(4)} total=${s.total}`);
        }
    }

    console.log("\nFetching CoinGlass price data...");
    const cryptoData = await getCryptoData(SYMBOL, startDate, endDate);
    console.log(`Price data: ${cryptoData.length} daily points (${cryptoData[0]?.date} → ${cryptoData[cryptoData.length - 1]?.date})`);

    const html = generateChartHTML(cryptoData, newsScores, xScores, SYMBOL);

    const outDir = path.join(process.cwd(), "agent", "saved_data", "Charts");
    if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `Test Sentiment Chart BTC ${startDate}~${endDate}.html`);
    fs.writeFileSync(outFile, html, "utf-8");
    console.log(`\nChart saved to:\n  ${outFile}`);

    // Print daily average comparison around boundary
    console.log("\n--- Daily weighted averages around format boundary ---");
    const sums = new Map(), totals = new Map();
    for (const s of newsScores) {
        const d = new Date(s.time * 1000).toISOString().split("T")[0];
        const w = s.total > 0 ? s.total : 1;
        sums.set(d, (sums.get(d) ?? 0) + s.value * w);
        totals.set(d, (totals.get(d) ?? 0) + w);
    }
    const checkDates = ["2026-02-26", "2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02", "2026-03-03"];
    for (const d of checkDates) {
        if (sums.has(d)) {
            console.log(`  ${d}: avg=${(sums.get(d) / totals.get(d)).toFixed(4)}  (${totals.get(d)} articles)`);
        } else {
            console.log(`  ${d}: no data`);
        }
    }
}

main().catch(e => { console.error(e); process.exit(1); });
