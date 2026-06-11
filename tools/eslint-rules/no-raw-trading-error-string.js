/**
 * §7.5 — no-raw-trading-error-string
 *
 * Forbids constructing user-facing error strings inline inside the trading
 * code path. Every user-visible error MUST flow through `buildUserError(...)`
 * so it carries a stable `code`, locale-aware `title`/`body`, and a non-empty
 * `action` next-step.
 *
 * Triggers on:
 *   - `text: "..."` / `llmResponse: "..."` / `errorMessage: "..."` literals
 *     that contain `Trading` or 🛑 or one of the forbidden phrases inside
 *     a return statement in `packages/plugin-cex/src/**` or
 *     `client/src/components/cex/**`.
 *
 * Allowed if:
 *   - The string is built via `renderUserErrorMarkdown(buildUserError(...))`
 *     OR explicitly tagged with `// eslint-disable-next-line no-raw-trading-error-string`
 *     and a reviewer-visible rationale.
 *
 * Repo uses Biome today; this rule lives here so it's ready when ESLint
 * gets wired into CI. A grep-based companion (`scripts/qa/lint-error-contracts.mjs`)
 * enforces the same contract in CI today.
 */

"use strict";

const FORBIDDEN_PHRASES = [
    "Trading temporarily paused",
    "Trading is paused",
    "Order blocked by risk gate",
    "Exchange rejected the order",
    "🛑 Trading",
    "Approval rejected",
    "Approval expired",
    "Live-trading consent",
];

module.exports = {
    meta: {
        type: "problem",
        docs: {
            description:
                "All user-facing trading errors must flow through buildUserError(...)",
            recommended: true,
        },
        schema: [],
        messages: {
            rawString:
                "Raw user-facing trading error string detected: {{phrase}}. Wrap with buildUserError({ code: ... }) → renderUserErrorMarkdown(...) instead.",
        },
    },
    create(context) {
        const filename = context.getFilename();
        const inScope =
            /packages\/plugin-cex\/src\//.test(filename) ||
            /packages\/core\/src\/handlers\/cexWorkflowMessageHandler/.test(filename) ||
            /client\/src\/components\/cex\//.test(filename);
        if (!inScope) return {};
        return {
            Literal(node) {
                if (typeof node.value !== "string") return;
                const v = node.value;
                for (const phrase of FORBIDDEN_PHRASES) {
                    if (v.includes(phrase)) {
                        context.report({
                            node,
                            messageId: "rawString",
                            data: { phrase },
                        });
                        return;
                    }
                }
            },
            TemplateLiteral(node) {
                for (const quasi of node.quasis) {
                    const v = quasi.value.cooked;
                    if (!v) continue;
                    for (const phrase of FORBIDDEN_PHRASES) {
                        if (v.includes(phrase)) {
                            context.report({
                                node: quasi,
                                messageId: "rawString",
                                data: { phrase },
                            });
                            return;
                        }
                    }
                }
            },
        };
    },
};
