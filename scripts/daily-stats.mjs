#!/usr/bin/env node
/**
 * Daily usage stats: active users and message count per day.
 * Reads agent/data/db.sqlite, outputs an HTML chart to agent/saved_data/Reports/
 *
 * Usage (from repo root):
 *   node scripts/daily-stats.mjs [--db path/to/db.sqlite] [--out path/to/output.html]
 */

import { createRequire } from "module";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

function loadSqlite() {
	try {
		return require("better-sqlite3");
	} catch {
		const adapterPath = path.resolve(
			__dirname,
			"../packages/adapter-sqlite/node_modules/better-sqlite3"
		);
		return require(adapterPath);
	}
}

const Database = loadSqlite();

const ROOT = path.resolve(__dirname, "..");
const DEFAULT_DB = path.join(ROOT, "agent/data/db.sqlite");
const DEFAULT_OUT = path.join(ROOT, "agent/saved_data/Reports/daily-stats.html");

/** 统计过去 N 天（含今天） */
const PAST_DAYS = 30;
const MAIN_PAGE_PATH = "/";
const SIGNUP_PAGE_PATH = "/signup";
const REGISTER_PAGE_PREFIX = "/register/";
const HOURLY_POINTS = 48;

function parseArgs() {
	const args = process.argv.slice(2);
	let dbPath = DEFAULT_DB;
	let outPath = DEFAULT_OUT;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--db" && args[i + 1]) {
			dbPath = args[++i];
		} else if (args[i] === "--out" && args[i + 1]) {
			outPath = args[++i];
		}
	}
	return { dbPath, outPath };
}

function formatLocalDate(date) {
	const y = date.getFullYear();
	const m = String(date.getMonth() + 1).padStart(2, "0");
	const d = String(date.getDate()).padStart(2, "0");
	return `${y}-${m}-${d}`;
}

function getPast30DayLabels() {
	const labels = [];
	const today = new Date();
	for (let i = PAST_DAYS - 1; i >= 0; i--) {
		const day = new Date(today);
		day.setDate(day.getDate() - i);
		labels.push(formatLocalDate(day));
	}
	return labels;
}

const SYSTEM_ACCOUNTS_SQL = `userId NOT IN (SELECT id FROM accounts WHERE name = 'Crypto Trader' OR email = id)`;

function runQueries(db) {
	const start = new Date();
	start.setDate(start.getDate() - (PAST_DAYS - 1));
	start.setHours(0, 0, 0, 0);
	const sinceMs = start.getTime();
	const tableName = "messages";

	const base = `
		SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
		       COUNT(DISTINCT userId) AS activeUsers, COUNT(*) AS messageCount
		FROM memories
		WHERE type = ? AND userId IS NOT NULL AND userId != '' AND createdAt >= ?
		  AND ${SYSTEM_ACCOUNTS_SQL}
		GROUP BY day ORDER BY day
	`;

	const rows = db.prepare(base).all(tableName, sinceMs);
	return rows;
}

/** By user type: Anonymous (clientIP stored when identified by IP), Free, Plus, Pro. */
function runSegmentQueries(db) {
	const start = new Date();
	start.setDate(start.getDate() - (PAST_DAYS - 1));
	start.setHours(0, 0, 0, 0);
	const sinceMs = start.getTime();
	const tableName = "messages";

	const base = `
		SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
		       COUNT(DISTINCT userId) AS activeUsers, COUNT(*) AS messageCount
		FROM memories
		WHERE type = ? AND userId IS NOT NULL AND userId != '' AND createdAt >= ?
		  AND ${SYSTEM_ACCOUNTS_SQL}
		  AND (
	`;
	// Anonymous = identified by anonymousId (fallback to clientIP for legacy rows)
	const anonymousSql = `
		SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
		       COUNT(DISTINCT COALESCE(NULLIF(anonymousId, ''), NULLIF(clientIP, ''))) AS activeUsers,
		       COUNT(*) AS messageCount
		FROM memories
		WHERE type = ? AND createdAt >= ?
		  AND COALESCE(NULLIF(anonymousId, ''), NULLIF(clientIP, '')) IS NOT NULL
		GROUP BY day ORDER BY day
	`;
	// Free = in accounts, not Plus/Pro, and not anonymous (exclude rows with clientIP set)
	const freeWithAnonymousExcluded = `${base} userId IN (SELECT id FROM accounts) AND userId NOT IN (SELECT userId FROM user_subscriptions WHERE subscriptionStatus IN ('active','trialing','past_due') AND (LOWER(planName) LIKE '%plus%' OR LOWER(planName) LIKE '%pro%' OR LOWER(planName) LIKE '%enterprise%')) AND (COALESCE(NULLIF(anonymousId, ''), NULLIF(clientIP, '')) IS NULL) ) GROUP BY day ORDER BY day`;
	const freeFallback = `${base} userId IN (SELECT id FROM accounts) AND userId NOT IN (SELECT userId FROM user_subscriptions WHERE subscriptionStatus IN ('active','trialing','past_due') AND (LOWER(planName) LIKE '%plus%' OR LOWER(planName) LIKE '%pro%' OR LOWER(planName) LIKE '%enterprise%')) ) GROUP BY day ORDER BY day`;

	const segmentSql = {
		pro: `${base} userId IN (SELECT userId FROM user_subscriptions WHERE subscriptionStatus IN ('active','trialing','past_due') AND (LOWER(planName) LIKE '%pro%' OR LOWER(planName) LIKE '%enterprise%')) ) GROUP BY day ORDER BY day`,
		plus: `${base} userId IN (SELECT userId FROM user_subscriptions WHERE subscriptionStatus IN ('active','trialing','past_due') AND LOWER(planName) LIKE '%plus%' AND LOWER(planName) NOT LIKE '%pro%' AND LOWER(planName) NOT LIKE '%enterprise%') ) GROUP BY day ORDER BY day`,
		free: freeWithAnonymousExcluded,
	};
	const out = {};
	try {
		out.anonymous = db.prepare(anonymousSql).all(tableName, sinceMs);
	} catch (err) {
		if (err?.code === "SQLITE_ERROR" && (err?.message?.includes("anonymousId") || err?.message?.includes("clientIP"))) {
			out.anonymous = [];
			console.warn("Note: memories.anonymousId/clientIP column missing; start the agent once to migrate. Anonymous stats will be 0 until then.");
		} else {
			throw err;
		}
	}
	for (const [key, sql] of Object.entries(segmentSql)) {
		try {
			out[key] = db.prepare(sql).all(tableName, sinceMs);
		} catch (err) {
			if (key === "free" && err?.code === "SQLITE_ERROR" && (err?.message?.includes("anonymousId") || err?.message?.includes("clientIP"))) {
				out.free = db.prepare(freeFallback).all(tableName, sinceMs);
			} else {
				throw err;
			}
		}
	}
	return out;
}

/** 将查询结果与过去 30 天日期合并，无数据日期补 0 */
function mergePast30Days(rawRows) {
	const labels = getPast30DayLabels();
	const byDay = new Map(rawRows.map((r) => [r.day, r]));
	return labels.map((day) => {
		const row = byDay.get(day);
		return {
			day,
			activeUsers: row ? row.activeUsers : 0,
			messageCount: row ? row.messageCount : 0,
		};
	});
}

/** 计算最近 n 天的平均活跃用户和平均消息数（按自然日平均） */
function computeAverages(rows, n) {
	const slice = rows.slice(-n);
	const days = slice.length;
	const sumUsers = slice.reduce((s, r) => s + r.activeUsers, 0);
	const sumMessages = slice.reduce((s, r) => s + r.messageCount, 0);
	return {
		avgActiveUsers: days ? Math.round((sumUsers / days) * 100) / 100 : 0,
		avgMessages: days ? Math.round((sumMessages / days) * 100) / 100 : 0,
	};
}

function formatDurationSeconds(ms) {
	return Math.round((ms / 1000) * 10) / 10;
}

function getPastHourLabels(hours) {
	const labels = [];
	const now = new Date();
	now.setMinutes(0, 0, 0);
	for (let i = hours - 1; i >= 0; i--) {
		const hour = new Date(now);
		hour.setHours(hour.getHours() - i);
		const y = hour.getFullYear();
		const m = String(hour.getMonth() + 1).padStart(2, "0");
		const d = String(hour.getDate()).padStart(2, "0");
		const h = String(hour.getHours()).padStart(2, "0");
		labels.push(`${y}-${m}-${d} ${h}:00`);
	}
	return labels;
}

function safeAll(db, sql, params) {
	try {
		return db.prepare(sql).all(...params);
	} catch (err) {
		if (err?.code === "SQLITE_ERROR" && err?.message?.includes("web_page_sessions")) {
			console.warn("Note: web_page_sessions table missing; page analytics will be 0 until migrations run.");
			return [];
		}
		throw err;
	}
}

function runPageSessionQueries(db) {
	const start = new Date();
	start.setDate(start.getDate() - (PAST_DAYS - 1));
	start.setHours(0, 0, 0, 0);
	const sinceMs = start.getTime();

	const baseDaily = `
		SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
		       COUNT(*) AS sessions,
		       COUNT(DISTINCT COALESCE(userId, anonymousId)) AS visitors,
		       AVG(durationMs) AS avgDurationMs
		FROM web_page_sessions
		WHERE createdAt >= ? AND path = ?
		GROUP BY day ORDER BY day
	`;

	const registerDaily = `
		SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
		       COUNT(*) AS sessions,
		       COUNT(DISTINCT COALESCE(userId, anonymousId)) AS visitors,
		       AVG(durationMs) AS avgDurationMs
		FROM web_page_sessions
		WHERE createdAt >= ? AND path LIKE ?
		GROUP BY day ORDER BY day
	`;

	const authDaily = `
		SELECT date(createdAt / 1000, 'unixepoch', 'localtime') AS day,
		       isAuthenticated AS isAuthenticated,
		       COUNT(DISTINCT COALESCE(userId, anonymousId)) AS visitors,
		       AVG(durationMs) AS avgDurationMs
		FROM web_page_sessions
		WHERE createdAt >= ? AND path = ?
		GROUP BY day, isAuthenticated ORDER BY day
	`;

	const hourly = `
		SELECT strftime('%Y-%m-%d %H:00', createdAt / 1000, 'unixepoch', 'localtime') AS hour,
		       COUNT(*) AS sessions,
		       COUNT(DISTINCT COALESCE(userId, anonymousId)) AS visitors,
		       AVG(durationMs) AS avgDurationMs
		FROM web_page_sessions
		WHERE createdAt >= ? AND path = ?
		GROUP BY hour ORDER BY hour
	`;

	const hourlySince = Date.now() - HOURLY_POINTS * 60 * 60 * 1000;

	return {
		main: safeAll(db, baseDaily, [sinceMs, MAIN_PAGE_PATH]),
		signup: safeAll(db, baseDaily, [sinceMs, SIGNUP_PAGE_PATH]),
		register: safeAll(db, registerDaily, [sinceMs, `${REGISTER_PAGE_PREFIX}%`]),
		mainAuth: safeAll(db, authDaily, [sinceMs, MAIN_PAGE_PATH]),
		mainHourly: safeAll(db, hourly, [hourlySince, MAIN_PAGE_PATH]),
	};
}

function mergePast30DaysSessions(rawRows) {
	const labels = getPast30DayLabels();
	const byDay = new Map(rawRows.map((r) => [r.day, r]));
	return labels.map((day) => {
		const row = byDay.get(day);
		return {
			day,
			sessions: row ? row.sessions : 0,
			visitors: row ? row.visitors : 0,
			avgDurationMs: row && row.avgDurationMs ? row.avgDurationMs : 0,
		};
	});
}

function mergePast30DaysAuth(rawRows) {
	const labels = getPast30DayLabels();
	const byDay = new Map();
	for (const row of rawRows) {
		const key = `${row.day}-${row.isAuthenticated}`;
		byDay.set(key, row);
	}
	const out = {
		authenticated: [],
		anonymous: [],
	};
	for (const day of labels) {
		const authRow = byDay.get(`${day}-1`);
		const anonRow = byDay.get(`${day}-0`);
		out.authenticated.push({
			day,
			visitors: authRow ? authRow.visitors : 0,
			avgDurationMs: authRow && authRow.avgDurationMs ? authRow.avgDurationMs : 0,
		});
		out.anonymous.push({
			day,
			visitors: anonRow ? anonRow.visitors : 0,
			avgDurationMs: anonRow && anonRow.avgDurationMs ? anonRow.avgDurationMs : 0,
		});
	}
	return out;
}

function mergePastHours(rawRows, hours) {
	const labels = getPastHourLabels(hours);
	const byHour = new Map(rawRows.map((r) => [r.hour, r]));
	return labels.map((hour) => {
		const row = byHour.get(hour);
		return {
			hour,
			sessions: row ? row.sessions : 0,
			visitors: row ? row.visitors : 0,
			avgDurationMs: row && row.avgDurationMs ? row.avgDurationMs : 0,
		};
	});
}

function sectionSummaryTable(a) {
	return `
    <thead>
      <tr><th>Period</th><th>Avg Active Users</th><th>Avg Messages</th></tr>
    </thead>
    <tbody>
      <tr><td>Last 7 days</td><td>${a.d7.avgActiveUsers}</td><td>${a.d7.avgMessages}</td></tr>
      <tr><td>Last 14 days</td><td>${a.d14.avgActiveUsers}</td><td>${a.d14.avgMessages}</td></tr>
      <tr><td>Last 30 days</td><td>${a.d30.avgActiveUsers}</td><td>${a.d30.avgMessages}</td></tr>
    </tbody>`;
}

const SEGMENT_COLORS = {
	anonymous: { border: "rgb(148, 163, 184)", fill: "rgba(148, 163, 184, 0.1)" },
	free: { border: "rgb(99, 102, 241)", fill: "rgba(99, 102, 241, 0.1)" },
	plus: { border: "rgb(34, 197, 94)", fill: "rgba(34, 197, 94, 0.1)" },
	pro: { border: "rgb(234, 179, 8)", fill: "rgba(234, 179, 8, 0.1)" },
};

function buildHtml(rows, averages, segmentRows, segmentAverages, pageSessions, pageAuth, hourlyMain) {
	const labels = rows.map((r) => r.day);
	const activeUsers = rows.map((r) => r.activeUsers);
	const messageCount = rows.map((r) => r.messageCount);
	const a = averages;

	const mainSessions = pageSessions.main;
	const signupSessions = pageSessions.signup;
	const registerSessions = pageSessions.register;
	const mainPageviews = mainSessions.map((r) => r.sessions);
	const mainVisitors = mainSessions.map((r) => r.visitors);
	const mainAvgDurationSec = mainSessions.map((r) => formatDurationSeconds(r.avgDurationMs));
	const signupVisitors = signupSessions.map((r) => r.visitors);
	const signupAvgDurationSec = signupSessions.map((r) => formatDurationSeconds(r.avgDurationMs));
	const registerVisitors = registerSessions.map((r) => r.visitors);
	const registerAvgDurationSec = registerSessions.map((r) => formatDurationSeconds(r.avgDurationMs));

	const authVisitors = {
		authenticated: pageAuth.authenticated.map((r) => r.visitors),
		anonymous: pageAuth.anonymous.map((r) => r.visitors),
	};
	const authAvgDurationSec = {
		authenticated: pageAuth.authenticated.map((r) => formatDurationSeconds(r.avgDurationMs)),
		anonymous: pageAuth.anonymous.map((r) => formatDurationSeconds(r.avgDurationMs)),
	};

	const hourlyLabels = hourlyMain.map((r) => r.hour);
	const hourlyPageviews = hourlyMain.map((r) => r.sessions);
	const hourlyAvgDurationSec = hourlyMain.map((r) => formatDurationSeconds(r.avgDurationMs));

	const segmentSections = Object.keys(SEGMENT_LABELS)
		.map(
			(key) => `
  <h2 class="segment-title">${SEGMENT_LABELS[key]}</h2>
  <table class="summary">
${sectionSummaryTable(segmentAverages[key])}
  </table>
  <div class="chart-wrap">
    <h3>Daily Active Users (DAU)</h3>
    <canvas id="chart-dau-${key}"></canvas>
  </div>
  <div class="chart-wrap">
    <h3>Daily Message Count</h3>
    <canvas id="chart-messages-${key}"></canvas>
  </div>`
		)
		.join("");

	const segmentChartData = {};
	for (const key of Object.keys(SEGMENT_LABELS)) {
		segmentChartData[key] = {
			labels,
			dau: segmentRows[key].map((r) => r.activeUsers),
			messages: segmentRows[key].map((r) => r.messageCount),
		};
	}

	const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Daily Usage &amp; Traffic</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; margin: 0; padding: 24px; background: #0f0f12; color: #e4e4e7; }
    h1 { font-size: 1.5rem; margin-bottom: 8px; }
    h2.segment-title { font-size: 1.25rem; margin-top: 32px; margin-bottom: 16px; color: #e4e4e7; }
    .meta { color: #71717a; font-size: 0.875rem; margin-bottom: 16px; }
    .summary { margin-bottom: 24px; }
    .chart-wrap { max-width: 900px; height: 320px; margin-bottom: 32px; }
    .chart-wrap h2, .chart-wrap h3 { font-size: 1rem; margin-bottom: 8px; color: #a1a1aa; }
    table { border-collapse: collapse; max-width: 900px; margin-top: 24px; }
    th, td { padding: 8px 12px; text-align: left; border-bottom: 1px solid #27272a; }
    th { color: #a1a1aa; font-weight: 500; }
  </style>
</head>
<body>
  <h1>Daily Usage &amp; Traffic</h1>
  <p class="meta">Last ${PAST_DAYS} days · by calendar day · Generated: ${new Date().toLocaleString("en-US")}</p>

  <h2 class="segment-title">All Users (Total)</h2>
  <table class="summary">
${sectionSummaryTable(a)}
  </table>
  <div class="chart-wrap">
    <h3>Daily Active Users (DAU)</h3>
    <canvas id="chart-dau"></canvas>
  </div>
  <div class="chart-wrap">
    <h3>Daily Message Count</h3>
    <canvas id="chart-messages"></canvas>
  </div>

  <h2 class="segment-title">Website Traffic (Main Page)</h2>
  <div class="chart-wrap">
    <h3>Daily Pageviews (Main Page)</h3>
    <canvas id="chart-main-pageviews"></canvas>
  </div>
  <div class="chart-wrap">
    <h3>Daily Visitors (Main Page)</h3>
    <canvas id="chart-main-visitors"></canvas>
  </div>
  <div class="chart-wrap">
    <h3>Average Duration (Seconds, Main Page)</h3>
    <canvas id="chart-main-duration"></canvas>
  </div>
  <div class="chart-wrap">
    <h3>Main Page Visitors (Logged In vs Anonymous)</h3>
    <canvas id="chart-main-auth-visitors"></canvas>
  </div>
  <div class="chart-wrap">
    <h3>Main Page Avg Duration (Logged In vs Anonymous, Seconds)</h3>
    <canvas id="chart-main-auth-duration"></canvas>
  </div>

  <h2 class="segment-title">Signup Page</h2>
  <div class="chart-wrap">
    <h3>Daily Visitors (Signup)</h3>
    <canvas id="chart-signup-visitors"></canvas>
  </div>
  <div class="chart-wrap">
    <h3>Average Duration (Seconds, Signup)</h3>
    <canvas id="chart-signup-duration"></canvas>
  </div>

  <h2 class="segment-title">Register Page</h2>
  <div class="chart-wrap">
    <h3>Daily Visitors (Register)</h3>
    <canvas id="chart-register-visitors"></canvas>
  </div>
  <div class="chart-wrap">
    <h3>Average Duration (Seconds, Register)</h3>
    <canvas id="chart-register-duration"></canvas>
  </div>

  <h2 class="segment-title">Hourly (Last ${HOURLY_POINTS} Hours, Main Page)</h2>
  <div class="chart-wrap">
    <h3>Hourly Pageviews (Main Page)</h3>
    <canvas id="chart-hourly-pageviews"></canvas>
  </div>
  <div class="chart-wrap">
    <h3>Hourly Avg Duration (Seconds, Main Page)</h3>
    <canvas id="chart-hourly-duration"></canvas>
  </div>
${segmentSections}

  <script>
    const labels = ${JSON.stringify(labels)};
    const dau = ${JSON.stringify(activeUsers)};
    const messages = ${JSON.stringify(messageCount)};
    const segmentData = ${JSON.stringify(segmentChartData)};
    const segmentColors = ${JSON.stringify(SEGMENT_COLORS)};
    const mainPageviews = ${JSON.stringify(mainPageviews)};
    const mainVisitors = ${JSON.stringify(mainVisitors)};
    const mainAvgDurationSec = ${JSON.stringify(mainAvgDurationSec)};
    const authVisitors = ${JSON.stringify(authVisitors)};
    const authAvgDurationSec = ${JSON.stringify(authAvgDurationSec)};
    const signupVisitors = ${JSON.stringify(signupVisitors)};
    const signupAvgDurationSec = ${JSON.stringify(signupAvgDurationSec)};
    const registerVisitors = ${JSON.stringify(registerVisitors)};
    const registerAvgDurationSec = ${JSON.stringify(registerAvgDurationSec)};
    const hourlyLabels = ${JSON.stringify(hourlyLabels)};
    const hourlyPageviews = ${JSON.stringify(hourlyPageviews)};
    const hourlyAvgDurationSec = ${JSON.stringify(hourlyAvgDurationSec)};

    const grid = { color: '#27272a' };
    const ticks = { color: '#71717a' };
    const chartOpts = { responsive: true, maintainAspectRatio: false, scales: { x: { grid }, y: { beginAtZero: true, grid, ticks } }, plugins: { legend: { display: false } } };

    new Chart(document.getElementById('chart-dau'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Active Users', data: dau, borderColor: 'rgb(99, 102, 241)', backgroundColor: 'rgba(99, 102, 241, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });
    new Chart(document.getElementById('chart-messages'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Messages', data: messages, borderColor: 'rgb(34, 197, 94)', backgroundColor: 'rgba(34, 197, 94, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });

    new Chart(document.getElementById('chart-main-pageviews'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Pageviews', data: mainPageviews, borderColor: 'rgb(56, 189, 248)', backgroundColor: 'rgba(56, 189, 248, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });
    new Chart(document.getElementById('chart-main-visitors'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Visitors', data: mainVisitors, borderColor: 'rgb(244, 114, 182)', backgroundColor: 'rgba(244, 114, 182, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });
    new Chart(document.getElementById('chart-main-duration'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Avg Duration (s)', data: mainAvgDurationSec, borderColor: 'rgb(251, 191, 36)', backgroundColor: 'rgba(251, 191, 36, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });
    new Chart(document.getElementById('chart-main-auth-visitors'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Logged In', data: authVisitors.authenticated, borderColor: 'rgb(34, 197, 94)', backgroundColor: 'rgba(34, 197, 94, 0.1)', borderWidth: 2, fill: true, tension: 0.2 },
        { label: 'Anonymous', data: authVisitors.anonymous, borderColor: 'rgb(148, 163, 184)', backgroundColor: 'rgba(148, 163, 184, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }
      ] },
      options: { ...chartOpts, plugins: { legend: { display: true, labels: { color: '#a1a1aa' } } } }
    });
    new Chart(document.getElementById('chart-main-auth-duration'), {
      type: 'line',
      data: { labels, datasets: [
        { label: 'Logged In', data: authAvgDurationSec.authenticated, borderColor: 'rgb(34, 197, 94)', backgroundColor: 'rgba(34, 197, 94, 0.1)', borderWidth: 2, fill: true, tension: 0.2 },
        { label: 'Anonymous', data: authAvgDurationSec.anonymous, borderColor: 'rgb(148, 163, 184)', backgroundColor: 'rgba(148, 163, 184, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }
      ] },
      options: { ...chartOpts, plugins: { legend: { display: true, labels: { color: '#a1a1aa' } } } }
    });
    new Chart(document.getElementById('chart-signup-visitors'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Visitors', data: signupVisitors, borderColor: 'rgb(129, 140, 248)', backgroundColor: 'rgba(129, 140, 248, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });
    new Chart(document.getElementById('chart-signup-duration'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Avg Duration (s)', data: signupAvgDurationSec, borderColor: 'rgb(45, 212, 191)', backgroundColor: 'rgba(45, 212, 191, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });
    new Chart(document.getElementById('chart-register-visitors'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Visitors', data: registerVisitors, borderColor: 'rgb(251, 113, 133)', backgroundColor: 'rgba(251, 113, 133, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });
    new Chart(document.getElementById('chart-register-duration'), {
      type: 'line',
      data: { labels, datasets: [{ label: 'Avg Duration (s)', data: registerAvgDurationSec, borderColor: 'rgb(163, 230, 53)', backgroundColor: 'rgba(163, 230, 53, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });
    new Chart(document.getElementById('chart-hourly-pageviews'), {
      type: 'line',
      data: { labels: hourlyLabels, datasets: [{ label: 'Hourly Pageviews', data: hourlyPageviews, borderColor: 'rgb(14, 165, 233)', backgroundColor: 'rgba(14, 165, 233, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });
    new Chart(document.getElementById('chart-hourly-duration'), {
      type: 'line',
      data: { labels: hourlyLabels, datasets: [{ label: 'Avg Duration (s)', data: hourlyAvgDurationSec, borderColor: 'rgb(250, 204, 21)', backgroundColor: 'rgba(250, 204, 21, 0.1)', borderWidth: 2, fill: true, tension: 0.2 }] },
      options: chartOpts
    });

    for (const key of Object.keys(segmentData)) {
      const d = segmentData[key];
      const c = segmentColors[key];
      new Chart(document.getElementById('chart-dau-' + key), {
        type: 'line',
        data: { labels: d.labels, datasets: [{ label: 'Active Users', data: d.dau, borderColor: c.border, backgroundColor: c.fill, borderWidth: 2, fill: true, tension: 0.2 }] },
        options: chartOpts
      });
      new Chart(document.getElementById('chart-messages-' + key), {
        type: 'line',
        data: { labels: d.labels, datasets: [{ label: 'Messages', data: d.messages, borderColor: c.border, backgroundColor: c.fill, borderWidth: 2, fill: true, tension: 0.2 }] },
        options: chartOpts
      });
    }
  </script>
</body>
</html>
`;
	return html;
}

const SEGMENT_LABELS = {
	anonymous: "Anonymous",
	free: "Free",
	plus: "Plus",
	pro: "Pro",
};

function main() {
	const { dbPath, outPath } = parseArgs();

	if (!fs.existsSync(dbPath)) {
		console.error("Database not found:", dbPath);
		process.exit(1);
	}

	const db = new Database(dbPath, { readonly: true });
	const rawRows = runQueries(db);
	const rawSegments = runSegmentQueries(db);
	const rawPageSessions = runPageSessionQueries(db);
	db.close();

	const rows = mergePast30Days(rawRows);
	const segmentRows = {};
	const segmentAverages = {};
	for (const key of Object.keys(SEGMENT_LABELS)) {
		segmentRows[key] = mergePast30Days(rawSegments[key]);
		segmentAverages[key] = {
			d7: computeAverages(segmentRows[key], 7),
			d14: computeAverages(segmentRows[key], 14),
			d30: computeAverages(segmentRows[key], 30),
		};
	}

	if (rawRows.length === 0) {
		console.log("No message data in past 30 days. Output HTML will show zeros.");
	}

	const averages = {
		d7: computeAverages(rows, 7),
		d14: computeAverages(rows, 14),
		d30: computeAverages(rows, 30),
	};

	const pageSessions = {
		main: mergePast30DaysSessions(rawPageSessions.main),
		signup: mergePast30DaysSessions(rawPageSessions.signup),
		register: mergePast30DaysSessions(rawPageSessions.register),
	};
	const pageAuth = mergePast30DaysAuth(rawPageSessions.mainAuth);
	const hourlyMain = mergePastHours(rawPageSessions.mainHourly, HOURLY_POINTS);

	const dir = path.dirname(outPath);
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	const html = buildHtml(rows, averages, segmentRows, segmentAverages, pageSessions, pageAuth, hourlyMain);
	fs.writeFileSync(outPath, html, "utf8");
	console.log("Wrote:", outPath);
	const totalMessages = rows.reduce((s, r) => s + r.messageCount, 0);
	console.log(
		`Past ${PAST_DAYS} days | Days with data: ${rawRows.length} | Total messages: ${totalMessages}`
	);
	console.log(
		"Avg (7d):",
		averages.d7.avgActiveUsers,
		"users,",
		averages.d7.avgMessages,
		"msgs | Avg (14d):",
		averages.d14.avgActiveUsers,
		averages.d14.avgMessages,
		"| Avg (30d):",
		averages.d30.avgActiveUsers,
		averages.d30.avgMessages
	);
}

main();
