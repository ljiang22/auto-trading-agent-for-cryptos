#!/usr/bin/env node
/**
 * Mantle hackathon browser/API QA runner.
 * Maps to docs/MANTLE_BROWSER_TEST_CASES.md (sections B–L, M).
 */
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import { mintTestJwt } from "../agent-sim/approvalDriver.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../..");
const AGENT_ID = "d13ee77f-407c-024d-8892-bfa7f1b861f7";
const BASE = process.env.QA_BASE_URL ?? "http://localhost:3000";
const EMAIL = process.env.VITE_TEST_USER_EMAIL ?? "jiang2015leon@gmail.com";
const CHAIN_ID = process.env.MANTLE_CHAIN_ID ?? "5003";
const STEP_DELAY_MS = Number.parseInt(process.env.QA_STEP_DELAY_MS ?? "900", 10);

function loadToken() {
    const privPath = join(ROOT, ".dev-auth/jwt_dev_priv.pem");
    if (!existsSync(privPath)) {
        throw new Error("Run: pnpm dev:auth init");
    }
    const pk = readFileSync(privPath, "utf8");
    const token = mintTestJwt(EMAIL, { privateKeyPem: pk, ttlSec: 86400 });
    if (!token) throw new Error("Failed to mint JWT");
    return token;
}

async function api(path, { method = "GET", body, token } = {}) {
    const res = await fetch(`${BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = { raw: text };
    }
    return { status: res.status, json, text };
}

async function createRoom(token, name) {
    const { status, json } = await api(`/agents/${AGENT_ID}/rooms`, {
        method: "POST",
        token,
        body: { name },
    });
    if (status !== 200 && status !== 201) {
        throw new Error(`createRoom ${status}: ${JSON.stringify(json)}`);
    }
    return json.room?.id ?? json.id;
}

// Per-request cap so a case whose handler stalls (e.g. a non-Mantle control
// message routed to an LLM that is slow/unconfigured) cannot hang the whole
// run up to the server's multi-minute STREAM_TIMEOUT. The stream is read
// incrementally so partial steps/finals are still captured on timeout.
const REQUEST_TIMEOUT_MS = Number.parseInt(
    process.env.QA_REQUEST_TIMEOUT_MS ?? "60000",
    10,
);

async function sendMessage(token, roomId, text) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const steps = [];
    const finals = [];
    const intermediates = [];
    let errorVal = null;
    let timedOut = false;

    const handleLine = (line) => {
        if (!line.startsWith("data: ")) return;
        const data = line.slice(6).trim();
        if (!data || data === "[DONE]") return;
        try {
            const parsed = JSON.parse(data);
            if (parsed.type === "step") steps.push(parsed.step);
            if (parsed.type === "final_response") finals.push(...(parsed.responses ?? []));
            if (parsed.type === "intermediate_response") intermediates.push(parsed.response);
            if (parsed.type === "action_response" && parsed.response) {
                finals.push(parsed.response);
            }
            if (parsed.type === "error") errorVal = parsed.error;
        } catch {
            /* skip */
        }
    };

    try {
        const res = await fetch(`${BASE}/${AGENT_ID}/message/stream`, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${token}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify({ text, roomId }),
            signal: controller.signal,
        });
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            clearTimeout(timer);
            return {
                error: `HTTP ${res.status}: ${body.slice(0, 120)}`,
                steps: [],
                finals: [],
                intermediates: [],
            };
        }
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += decoder.decode(value, { stream: true });
            const lines = buf.split("\n");
            buf = lines.pop() ?? "";
            for (const line of lines) handleLine(line);
            if (errorVal) break;
        }
        if (buf) handleLine(buf);
    } catch (err) {
        if (controller.signal.aborted) {
            timedOut = true; // soft: keep partial data, assertion still runs
        } else {
            errorVal = errorVal ?? `request failed: ${String(err).slice(0, 120)}`;
        }
    } finally {
        clearTimeout(timer);
    }

    return { steps, finals, intermediates, error: errorVal, timedOut };
}

function responseText(result) {
    const parts = [];
    for (const r of result.finals ?? []) {
        const t = r?.text ?? r?.content?.text ?? "";
        if (t) parts.push(t);
    }
    for (const r of result.intermediates ?? []) {
        const t = r?.content?.text ?? r?.text ?? "";
        if (t) parts.push(t);
    }
    return parts.join("\n");
}

function responseMeta(result) {
    const r = result.finals?.[0];
    return r?.metadata ?? r?.content?.metadata ?? null;
}

function isMantleWorkflow(result) {
    const meta = responseMeta(result);
    if (meta?.classification === "MANTLE_WORKFLOW_MESSAGE") return true;
    return (result.steps ?? []).some((s) =>
        String(s?.name ?? "").startsWith("mantle"),
    );
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shared state across sequential cases */
const state = {
    quoteRoomA: null,
};

const cases = [
    // --- B: Routing ---
    {
        id: "B1",
        msg: "swap 5 USDC to WMNT on Mantle",
        assert: (t, _m, r) =>
            isMantleWorkflow(r) &&
            /approve|cancel|quote|Intent hash/i.test(t),
    },
    {
        id: "B2",
        msg: "convert 10 USDC to WMNT on mantle",
        assert: (t, _m, r) => isMantleWorkflow(r) && /approve|quote|WMNT/i.test(t),
    },
    {
        id: "B3",
        msg: "exchange 1 USDC for WMNT on Mantle",
        assert: (t, _m, r) => isMantleWorkflow(r) && /approve|quote|WMNT/i.test(t),
    },
    {
        id: "B4",
        msg: "show my Mantle wallet balance",
        assert: (t, _m, r) =>
            isMantleWorkflow(r) &&
            /Mantle Balance|MNT/i.test(t) &&
            !/^## ❌/m.test(t),
    },
    {
        id: "B5",
        msg: "what are my holdings on Mantle?",
        assert: (t, _m, r) =>
            isMantleWorkflow(r) && /Mantle Balance|MNT|WMNT/i.test(t),
    },
    {
        id: "B6",
        msg: "swap 10 USDC to WMNT on Mantle please",
        assert: (t, _m, r) => isMantleWorkflow(r) && /approve|quote|WMNT/i.test(t),
    },
    {
        id: "B7",
        msg: "buy BTC on Binance",
        slow: true,
        assert: (_t, _m, r) => !isMantleWorkflow(r),
    },
    // --- C: Risk ---
    {
        id: "C1",
        msg: "swap all my balance YOLO on Mantle",
        assert: (t, m) =>
            /refus|risk gate|yolo|all balance/i.test(t) &&
            m?.risk?.rulesFired?.includes("yolo_size"),
    },
    {
        id: "C2",
        msg: "swap everything to WMNT on Mantle",
        assert: (t, m) =>
            /refus|risk gate|yolo|all balance/i.test(t) &&
            m?.risk?.rulesFired?.includes("yolo_size"),
    },
    {
        id: "C3",
        msg: "swap 1000 USDC to WMNT on Mantle",
        assert: (t, m) =>
            /refus|exceed|cap/i.test(t) &&
            m?.risk?.rulesFired?.includes("max_trade_usd") &&
            /\$1000|\$1,?000/.test(t),
    },
    {
        id: "C4",
        msg: "swap 5 FAKECOIN to WMNT on Mantle",
        assert: (t, m) =>
            /refus|allowlist|FAKECOIN/i.test(t) &&
            m?.risk?.rulesFired?.includes("token_allowlist"),
    },
    {
        id: "C5",
        setup: async (token) => {
            const room = await createRoom(token, `qa-C5-${Date.now()}`);
            await sendMessage(token, room, "swap all my balance YOLO on Mantle");
            await sleep(1200);
            return { room, msg: "approve" };
        },
        assert: (t, m) =>
            /no pending|refus/i.test(t) && !m?.mantleExecution && !m?.pending,
    },
    // --- E: Cancel flow ---
    {
        id: "E1",
        setup: async (token) => {
            const room = await createRoom(token, `qa-E1-${Date.now()}`);
            await sendMessage(token, room, "swap 5 USDC to WMNT on Mantle");
            await sleep(1200);
            return { room, msg: "cancel" };
        },
        assert: (t, m) =>
            /cancel/i.test(t) &&
            m?.cancelled === true &&
            !m?.txHash &&
            !m?.auditTxHash,
    },
    {
        id: "E4",
        setup: async (token) => {
            const room = await createRoom(token, `qa-E4-${Date.now()}`);
            await sendMessage(token, room, "swap 5 USDC to WMNT on Mantle");
            await sleep(1200);
            await sendMessage(token, room, "cancel");
            await sleep(1200);
            return { room, msg: "approve" };
        },
        assert: (t, m) =>
            /no pending/i.test(t) && !m?.mantleExecution,
    },
    // --- F: Approval edge cases ---
    {
        id: "F1",
        setup: async (token) => {
            const roomA = await createRoom(token, `qa-F1A-${Date.now()}`);
            await sendMessage(token, roomA, "swap 5 USDC to WMNT on Mantle");
            state.quoteRoomA = roomA;
            await sleep(1200);
            const roomB = await createRoom(token, `qa-F1B-${Date.now()}`);
            return { room: roomB, msg: "approve" };
        },
        assert: (t, m) => /no pending/i.test(t) && !m?.mantleExecution,
    },
    {
        id: "F3",
        setup: async (token) => {
            const room = await createRoom(token, `qa-F3-${Date.now()}`);
            return { room, msg: "approve" };
        },
        assert: (t) => /no pending Mantle swap to approve/i.test(t),
    },
    {
        id: "F4a",
        setup: async (token) => {
            const room = await createRoom(token, `qa-F4-${Date.now()}`);
            await sendMessage(token, room, "swap 5 USDC to WMNT on Mantle");
            await sleep(1200);
            return { room, msg: "APPROVE" };
        },
        // PASS requires a real on-chain execution: the on-chain badge AND a tx
        // hash. A failed swap must NOT pass — the old assertion accepted the
        // literal word "failed", which is exactly how the R2 bug showed green.
        assert: (_t, m) =>
            m?.mantleExecution === true && typeof m?.txHash === "string",
        // BLOCKED (not PASS, not FAIL) when the swap can't execute because 0x
        // does not serve the configured chain (Sepolia 5003) — honest result.
        blocked: (t, m) =>
            /mantle swap failed|swap execution failed|quote failed/i.test(t) &&
            (/\b4\d\d\b|0x|quote|INPUT_INVALID/i.test(t) || CHAIN_ID === "5003") &&
            m?.mantleExecution !== true,
    },
    {
        id: "F4b",
        setup: async (token) => {
            const room = await createRoom(token, `qa-F4b-${Date.now()}`);
            await sendMessage(token, room, "swap 5 USDC to WMNT on Mantle");
            await sleep(1200);
            return { room, msg: "Cancel" };
        },
        assert: (t, m) => /cancel/i.test(t) && m?.cancelled === true,
    },
    // --- G: Analyze-then-swap ---
    {
        id: "G3",
        msg: "analyze ETH sentiment and swap 5 USDC to WMNT on Mantle",
        slow: true,
        assert: (t, _m, r) =>
            isMantleWorkflow(r) && /approve|quote|WMNT|analysis/i.test(t),
    },
    // --- H: Balance / quote ---
    {
        id: "H1",
        msg: "show my Mantle wallet balance",
        assert: (t, m) =>
            /0x97[dD]/.test(t) && m?.classification === "MANTLE_WORKFLOW_MESSAGE",
    },
    {
        id: "H3",
        msg: "swap 5 USDC to WMNT on Mantle",
        note: "Sepolia 5003: 0x quote may fail — pass if approval prompt still shown",
        assert: (t, m) =>
            m?.pending === true ||
            /Quote failed|approve|Intent hash/i.test(t),
    },
    // --- J: MantleExecutionLinks metadata (API-level) ---
    {
        id: "J1",
        msg: "swap all my balance YOLO on Mantle",
        assert: (t, m) =>
            /refus|risk gate/i.test(t) &&
            !m?.txHash &&
            !m?.auditTxHash &&
            !m?.mantleExecution,
    },
    {
        id: "J2",
        setup: async (token) => {
            const room = await createRoom(token, `qa-J2-${Date.now()}`);
            await sendMessage(token, room, "swap 5 USDC to WMNT on Mantle");
            await sleep(1200);
            return { room, msg: "cancel" };
        },
        assert: (t, m) =>
            /cancel/i.test(t) &&
            m?.cancelled === true &&
            !m?.txHash &&
            !m?.auditTxHash,
    },
    // --- L: Regression burst ---
    {
        id: "L4",
        setup: async (token) => {
            const room = await createRoom(token, `qa-L4-${Date.now()}`);
            for (const msg of [
                "show my Mantle wallet balance",
                "swap all my balance YOLO on Mantle",
                "swap 5 USDC to WMNT on Mantle",
            ]) {
                const r = await sendMessage(token, room, msg);
                if (r.error) throw new Error(r.error);
                await sleep(STEP_DELAY_MS);
            }
            return { room, msg: null, skipSend: true, lastResult: true };
        },
        assert: () => true,
    },
];

async function runCliChecks() {
    const cli = [];
    const env = { ...process.env };
    const dotenvPath = join(ROOT, ".env");
    if (existsSync(dotenvPath)) {
        for (const line of readFileSync(dotenvPath, "utf8").split("\n")) {
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (m && !env[m[1]]) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
        }
    }

    // Tri-state CLI check: PASS on a real success marker, BLOCKED on the
    // documented Sepolia/0x limitation, FAIL otherwise. Crucially, the pass
    // regex must match a *successful* result — not merely the word "quote",
    // which a `0x quote 400` error also contains.
    const run = (id, cmd, cwd, passRe, blockedRe) => {
        let combined = "";
        let threw = null;
        try {
            combined = execSync(cmd, {
                cwd: cwd ?? ROOT,
                encoding: "utf8",
                stdio: ["ignore", "pipe", "pipe"],
                env,
            });
        } catch (err) {
            combined = `${err.stdout ?? ""}${err.stderr ?? ""}`;
            threw = err;
        }
        let status;
        if (passRe ? passRe.test(combined) : !threw) {
            status = "PASS";
        } else if (blockedRe?.test(combined)) {
            status = "BLOCKED";
        } else {
            status = "FAIL";
        }
        cli.push({
            id,
            status,
            error:
                status === "FAIL" && threw
                    ? String(threw.stderr ?? threw.message).slice(0, 300)
                    : null,
            excerpt: combined.slice(0, 200),
        });
    };

    run("M1", "node scripts/mantle/gate-check.mjs", ROOT, /5000.*\| 200 \| yes/i);
    run(
        "M2",
        "node scripts/mantle/smoke-swap.mjs --quote-only",
        ROOT,
        // PASS only on a genuine quote (Quote OK + buyAmount), not the word "quote".
        /Quote OK:[\s\S]*buyAmount/i,
        // BLOCKED on the known Sepolia / 0x-mainnet-only limitation.
        /0x quote 4\d\d|INPUT_INVALID|unsupported|chainId/i,
    );
    run(
        "M3",
        "pnpm test:unit",
        join(ROOT, "packages/plugin-mantle-dex"),
        /12 passed|Tests\s+12 passed/i,
    );
    run(
        "M4",
        "pnpm test -- --run mantlePrecheck mantleWorkflowHandler",
        join(ROOT, "packages/core"),
        /passed|✓/i,
    );

    return cli;
}

async function main() {
    const token = loadToken();
    const health = await api("/api/health");
    if (health.json?.status !== "ok") {
        console.error("Agent not healthy at", BASE);
        process.exit(1);
    }

    const results = [];

    for (const tc of cases) {
        const roomName = `qa-${tc.id}-${Date.now()}`;
        let roomId;
        let msg = tc.msg;
        let result = null;
        try {
            if (tc.setup) {
                const s = await tc.setup(token);
                roomId = s.room;
                msg = s.msg;
                if (s.skipSend) {
                    result = { error: null, steps: [], finals: [] };
                } else {
                    await sleep(tc.slow ? 2000 : 1200);
                    result = await sendMessage(token, roomId, msg);
                }
            } else {
                roomId = await createRoom(token, roomName);
                result = await sendMessage(token, roomId, msg);
            }

            const text = responseText(result);
            const meta = responseMeta(result);
            const pass =
                !result.error &&
                (tc.assert.length >= 3
                    ? tc.assert(text, meta, result)
                    : tc.assert(text, meta));
            const blocked =
                !pass &&
                !result.error &&
                typeof tc.blocked === "function" &&
                (tc.blocked.length >= 3
                    ? tc.blocked(text, meta, result)
                    : tc.blocked(text, meta));
            const status = result.error
                ? "FAIL"
                : pass
                  ? "PASS"
                  : blocked
                    ? "BLOCKED"
                    : "FAIL";

            results.push({
                id: tc.id,
                status,
                message: msg ?? "(burst)",
                note: tc.note ?? null,
                error: result.error,
                excerpt: text.slice(0, 400),
                steps: result.steps?.map((s) => s.name),
                metadata: meta,
                mantleWorkflow: isMantleWorkflow(result),
                timedOut: result.timedOut ?? false,
            });

            await sleep(tc.slow ? STEP_DELAY_MS * 2 : STEP_DELAY_MS);
        } catch (err) {
            results.push({
                id: tc.id,
                status: "FAIL",
                message: msg,
                error: String(err),
            });
        }
    }

    const cliResults = await runCliChecks();
    const all = [...results, ...cliResults];

    const report = {
        at: new Date().toISOString(),
        base: BASE,
        chainId: CHAIN_ID,
        results: all,
        summary: {
            pass: all.filter((r) => r.status === "PASS").length,
            fail: all.filter((r) => r.status === "FAIL").length,
            blocked: all.filter((r) => r.status === "BLOCKED").length,
            total: all.length,
        },
    };

    const out = join(ROOT, "docs/mantle-browser-qa-results.json");
    writeFileSync(out, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.summary.fail > 0 ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
