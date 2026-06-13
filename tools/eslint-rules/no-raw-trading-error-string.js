

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
