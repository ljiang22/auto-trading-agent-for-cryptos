#!/usr/bin/env node
/**
 * §7.5 + §8.5 — CI guard that mirrors the ESLint rules
 * `no-raw-trading-error-string` and `no-raw-axios-error`. Runs today because
 * the repo lints with Biome (which doesn't support custom rules); the
 * matching ESLint rules in `tools/eslint-rules/` are kept ready for the
 * future migration.
 *
 * Scope:
 *   - Trading errors: `packages/plugin-cex/src/**`,
 *     `packages/core/src/handlers/cexWorkflowMessageHandler.ts`,
 *     `client/src/components/cex/**`
 *   - Axios errors: `packages/plugin-cex/src/exchanges/services/**`
 *
 * Exit: 0 if all clean, 1 with a list of violations otherwise.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..", "..");

const TRADING_ERROR_PHRASES = [
    "Trading temporarily paused",
    "Trading is paused",
    "Order blocked by risk gate",
    "Exchange rejected the order",
    "🛑 Trading",
    "Approval rejected",
    "Approval expired",
    "Live-trading consent required",
];

const TRADING_SCOPE = [
    "packages/plugin-cex/src",
    "packages/core/src/handlers/cexWorkflowMessageHandler.ts",
    "client/src/components/cex",
];
const AXIOS_SCOPE = ["packages/plugin-cex/src/exchanges/services"];

const RAW_AXIOS_PATTERNS = [
    /\$\{(?:err|e|error)\.message\}/,
    /\binstanceof\s+Error\s*\?\s*\w+\.message\s*:\s*String\(\w+\)/,
];

function walk(dir, out = []) {
    if (!fs.existsSync(dir)) return out;
    const stat = fs.statSync(dir);
    if (stat.isFile()) {
        if (/\.(ts|tsx|js|mjs)$/.test(dir) && !dir.endsWith(".d.ts")) out.push(dir);
        return out;
    }
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === "node_modules" || ent.name === "dist" || ent.name.startsWith(".")) {
            continue;
        }
        if (ent.name === "__tests__") continue;
        walk(path.join(dir, ent.name), out);
    }
    return out;
}

function checkFile(file, phrases, regexes, kind) {
    const txt = fs.readFileSync(file, "utf8");
    const lines = txt.split("\n");
    const findings = [];
    const LOOKBEHIND = 4; // lines back to scan for the enclosing logger call
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // Allow opt-out comment on this line OR within the previous 6 lines
        // (covers cases where the allow rationale is documented in a JSDoc
        // above a long string literal that wraps).
        if (/lint-error-contracts-allow/.test(line)) continue;
        let allowed = false;
        for (let k = Math.max(0, i - 6); k < i; k++) {
            if (/lint-error-contracts-allow/.test(lines[k])) {
                allowed = true;
                break;
            }
        }
        if (allowed) continue;
        if (phrases) {
            for (const phrase of phrases) {
                if (line.includes(phrase)) {
                    if (file.endsWith("userFacingError.ts")) continue;
                    findings.push({ file, line: i + 1, kind, snippet: line.trim() });
                    break;
                }
            }
        }
        if (regexes) {
            for (const re of regexes) {
                if (!re.test(line)) continue;
                if (/formatAxiosErrorLine\(|summarizeAxiosError\(/.test(line)) continue;
                // Only flag if a `elizaLogger.<level>(` opens within the
                // 4-line lookbehind window (logger calls in this codebase
                // typically span <=4 lines).
                let inLoggerWindow = false;
                for (let j = Math.max(0, i - LOOKBEHIND); j <= i; j++) {
                    if (/elizaLogger\.\w+\(/.test(lines[j])) {
                        inLoggerWindow = true;
                        break;
                    }
                }
                if (!inLoggerWindow) continue;
                findings.push({ file, line: i + 1, kind, snippet: line.trim() });
                break;
            }
        }
    }
    return findings;
}

function collect(scopes) {
    const files = [];
    for (const s of scopes) files.push(...walk(path.join(REPO_ROOT, s)));
    return files;
}

const findings = [];
for (const f of collect(TRADING_SCOPE)) {
    findings.push(...checkFile(f, TRADING_ERROR_PHRASES, null, "trading-error-string"));
}
for (const f of collect(AXIOS_SCOPE)) {
    findings.push(...checkFile(f, null, RAW_AXIOS_PATTERNS, "raw-axios-error"));
}

if (findings.length > 0) {
    console.error("✗ Error-contract lint failures:\n");
    for (const v of findings) {
        const rel = path.relative(REPO_ROOT, v.file);
        console.error(`  [${v.kind}] ${rel}:${v.line}`);
        console.error(`     ${v.snippet}\n`);
    }
    console.error(
        `Total: ${findings.length} violation(s). Wrap with buildUserError(...) / formatAxiosErrorLine(...) or add "// lint-error-contracts-allow" with a rationale.`,
    );
    process.exit(1);
}
console.log("✓ Error-contract lint: no violations.");
