/**
 * §8.5 — no-raw-axios-error
 *
 * Forbids logging raw axios `err` objects or naked `err.message` inside the
 * venue adapters. Use `formatAxiosErrorLine(err)` / `summarizeAxiosError(err)`
 * from `@elizaos/core` instead. Without this, a single CoinMetrics 403 once
 * dumped ~6,500 lines of TLS socket internals into CloudWatch in 27 s.
 *
 * Triggers on:
 *   - `elizaLogger.{debug,info,warn,error}(...)` where one of the args is a
 *     template literal containing `${err}` / `${err.message}` / a ternary like
 *     `err instanceof Error ? err.message : String(err)`.
 *
 * Allowed if:
 *   - The error is wrapped: `formatAxiosErrorLine(err)` / `summarizeAxiosError(err)`.
 *
 * Scope: `packages/plugin-cex/src/exchanges/services/**`. Other packages have
 * their own logging conventions (e.g. on-chain-data uses summarizeAxiosError
 * already; comprehensive-analysis logs use the workflow's `[Memory]` probes).
 */

"use strict";

const FORBIDDEN_PATTERNS = [
    // "${err.message}", "${err.toString()}", "${e.message}"
    /\$\{(?:err|e|error)(?:\.message|\.toString\(\))?\}/,
    // "err instanceof Error ? err.message : String(err)"
    /\binstanceof\s+Error\s*\?\s*\w+\.message\s*:\s*String\(\w+\)/,
];

const ALLOWED_HELPERS = ["formatAxiosErrorLine", "summarizeAxiosError"];

function templateContainsRawError(node) {
    if (!node || node.type !== "TemplateLiteral") return false;
    for (const quasi of node.quasis) {
        const raw = quasi.value.raw || "";
        for (const p of FORBIDDEN_PATTERNS) if (p.test(raw)) return true;
    }
    // Also check if the template has expression slots that look like raw errs
    // and NOT wrapped in an allowed helper call.
    for (const expr of node.expressions) {
        if (expr.type === "MemberExpression") {
            const objName = expr.object && expr.object.name;
            if (
                (objName === "err" || objName === "e" || objName === "error") &&
                expr.property &&
                expr.property.name === "message"
            ) {
                return true;
            }
        }
        if (expr.type === "ConditionalExpression") {
            // Match `err instanceof Error ? err.message : String(err)`
            const test = expr.test;
            if (
                test &&
                test.type === "BinaryExpression" &&
                test.operator === "instanceof"
            ) {
                return true;
            }
        }
    }
    return false;
}

module.exports = {
    meta: {
        type: "problem",
        docs: {
            description:
                "Venue adapters must wrap axios errors with formatAxiosErrorLine / summarizeAxiosError, never log raw err.message.",
            recommended: true,
        },
        schema: [],
        messages: {
            rawAxiosError:
                "Raw axios error detected in log. Wrap with formatAxiosErrorLine(err) or summarizeAxiosError(err) before logging.",
        },
    },
    create(context) {
        const filename = context.getFilename();
        if (!/packages\/plugin-cex\/src\/exchanges\/services\//.test(filename)) {
            return {};
        }
        return {
            CallExpression(node) {
                const callee = node.callee;
                if (callee.type !== "MemberExpression") return;
                const objName = callee.object && callee.object.name;
                if (objName !== "elizaLogger") return;

                // Inspect each string-ish argument for the forbidden raw-error shapes.
                for (const arg of node.arguments) {
                    if (arg.type !== "TemplateLiteral") continue;
                    // Skip if the template already routes through an allowed helper.
                    const usesAllowed = arg.expressions.some(
                        (e) =>
                            e.type === "CallExpression" &&
                            e.callee.type === "Identifier" &&
                            ALLOWED_HELPERS.includes(e.callee.name),
                    );
                    if (usesAllowed) continue;
                    if (templateContainsRawError(arg)) {
                        context.report({ node: arg, messageId: "rawAxiosError" });
                    }
                }
            },
        };
    },
};
