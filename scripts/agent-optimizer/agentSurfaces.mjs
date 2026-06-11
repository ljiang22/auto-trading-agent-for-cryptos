/**
 * GEAP §8 — curated map of EVERY optimizable agent surface (architecture, context, routing,
 * tools, prompts, config). Handed to the planner so it proposes real paths and cross-cutting
 * changes instead of generic or Python paths.
 */

/** @returns {string} */
export function buildAgentFileMap() {
    return [
        "This repo is TypeScript/Node (pnpm monorepo). There is NO Python.",
        "",
        "TARGET TYPES the planner may use:",
        '- "prompt" — characters/CryptoTrader.json top-level `system` (character prompt).',
        '- "config" — settings.modelConfig knobs (temperature, maxOutputTokens, …).',
        '- "architecture" — cross-cutting design (routing, context assembly, tool selection policy) spanning multiple files; describe precisely.',
        '- "context" — how conversation state / memory / RAG / user profile is composed into the model context.',
        '- "routing" — which handler/workflow a message takes (REGULAR vs CEX vs comprehensive analysis vs plan executor).',
        '- "tools" — plugin action registration, when/how tools are invoked, action descriptions/examples, tool output synthesis.',
        '- "code" — a specific source file patch (name exact paths).',
        "",
        "AUTO-APPLY (optimizer loop only, optional): prompt, config.",
        "HUMAN / CURSOR IMPLEMENT (default workflow): architecture, context, routing, tools, code.",
        "",
        "── ROUTING & HANDLERS ──",
        "- packages/core/src/core/runtime.ts — routeMessage, plugin dispatch, anonymous vs authenticated identity.",
        "- packages/core/src/handlers/langGraphPrecheck.ts — cex_trade_intent short-circuit (imperative buy/sell → CEX).",
        "- packages/core/src/handlers/regularMessageHandler.ts — standard turn/response loop, streaming buffer.",
        "- packages/core/src/handlers/cexWorkflowMessageHandler.ts — CEX approval gate, order review, step emission (SAFETY).",
        "- packages/core/src/handlers/cexPlanRunner.ts — multi-step plan card executor (chat plan, awaiting_approval).",
        "- packages/core/src/handlers/comprehensiveAnalysisWorkflowGraph.ts — 13-step comprehensive analysis LangGraph, tool concurrency.",
        "",
        "── CONTEXT & PROMPTS ──",
        "- characters/CryptoTrader.json — character definition, system prompt, plugin list.",
        "- packages/core/src/templates/cexMessageTemplate.ts — CEX workflow template + Rule-9 refusal corpus (SAFETY).",
        "- packages/core/src/ai/generation.ts — LLM generation, onToken streaming.",
        "- packages/core/src/data/memoryManager.ts / userFeatureManager.ts / ragknowledge.ts — memory, user traits, RAG.",
        "- packages/core/src/handlers/* composeState usage — how state is built per turn.",
        "",
        "── TOOLS / PLUGINS (actions the model can call) ──",
        "- packages/plugin-cex/src/actions/* — trading: get_balance, create_order, get_trading_mode, …",
        "- packages/plugin-charts, plugin-news, plugin-web-search, plugin-on_chain_data, … — market data actions.",
        "- agent/src/pluginFilter.ts — allowlist; new actions must be registered here.",
        "",
        "── EXECUTION & DATA ──",
        "- packages/plugin-cex/src/exchanges/services/binance.ts / coinbase.ts — order table field mapping.",
        "- packages/plugin-cex/src/risk/riskEngine.ts + risk/rules/* — risk gates (SAFETY).",
        "- packages/plugin-cex/src/intent/canonicalIntent.ts — order-intent validation (SAFETY).",
        "",
        "When a gap is architectural (context missing, wrong routing, tools not invoked, raw tool dump), prefer",
        "architecture/context/routing/tools steps with concrete file paths and acceptance criteria — not only a prompt tweak.",
    ].join("\n");
}
