import type {
    CancelOrderParams,
    CreateOrderParams,
    GetBalanceParams,
    GetFillsParams,
    GetOrdersParams,
} from "../types";

// Lightweight output templates for trade actions.
// These depend on Coinbase response field names but are isolated from the action wrapper.

/**
 * Resolved execution mode of the action. Determines the user-visible badge
 * and copy fork in F1. Defaults to "live" when caller doesn't pass it.
 */
export type ResolvedExecutionMode = "live" | "paper" | "shadow";

function countFromResult(result: unknown, keys: string[]): number | null {
    if (typeof result !== "object" || result === null) {
        return null;
    }

    const record = result as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (Array.isArray(value)) {
            return value.length;
        }
    }

    return null;
}

function getFirstString(result: unknown, keys: string[]): string | null {
    if (typeof result !== "object" || result === null) {
        return null;
    }

    const record = result as Record<string, unknown>;
    for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim().length > 0) {
            return value;
        }
        // Binance's REST client returns `orderId` as a JS number (e.g.
        // `62016451578`). Without coercion the output template missed
        // the id entirely and the LLM formatter ad-libbed "no immediate
        // order confirmation or order ID was returned" on what was in
        // fact a successful submit (QA round-5 false-positive).
        if (typeof value === "number" && Number.isFinite(value)) {
            return String(value);
        }
        if (typeof value === "bigint") {
            return value.toString();
        }
    }

    return null;
}

export function getBalanceOutputTemplate(
    params: GetBalanceParams,
    result: unknown,
    mode: ResolvedExecutionMode = "live",
): string {
    const accountCount = countFromResult(result, ["accounts"]);
    const exchange = params.exchange ?? "the exchange";
    const venue = mode === "paper" ? "paper venue" : exchange;
    if (accountCount !== null) {
        return `Fetched ${accountCount} account balance entr${accountCount === 1 ? "y" : "ies"} from ${venue}.`;
    }

    return `Fetched balances from ${venue}.`;
}

export function getOrdersOutputTemplate(
    params: GetOrdersParams,
    result: unknown,
    mode: ResolvedExecutionMode = "live",
): string {
    const orderCount = countFromResult(result, ["orders"]);
    const exchange = params.exchange ?? "the exchange";
    const venue = mode === "paper" ? "paper venue" : exchange;
    if (orderCount !== null) {
        return `Fetched ${orderCount} order${orderCount === 1 ? "" : "s"} from ${venue}.`;
    }

    return `Fetched order data from ${venue}.`;
}

export function getCreateOrderOutputTemplate(
    params: CreateOrderParams,
    result: unknown,
    mode: ResolvedExecutionMode = "live",
): string {
    // QA round-5 — Binance's REST returns `orderId` (camelCase, numeric),
    // Coinbase returns `order_id` (snake_case). Include both shapes so the
    // template never misses the id on a successful submit. `id` is the
    // generic Coinbase fallback, `success_response` is the wrapper used
    // by some venue adapters.
    const orderId = getFirstString(result, [
        "order_id",
        "orderId",
        "id",
        "success_response",
    ]);
    const exchange = params.exchange ?? "the exchange";
    const side = params.side.toLowerCase();

    if (mode === "paper") {
        if (orderId) {
            return `Submitted PAPER ${side} order for ${params.product_id}. Paper order id: ${orderId}.`;
        }
        return `Submitted PAPER ${side} order for ${params.product_id}.`;
    }

    if (mode === "shadow") {
        if (orderId) {
            return `Logged SHADOW ${side} order for ${params.product_id}. Hypothetical order id: ${orderId}.`;
        }
        return `Logged SHADOW ${side} order for ${params.product_id}.`;
    }

    if (orderId) {
        return `Submitted ${side} order for ${params.product_id} on ${exchange}. Order id: ${orderId}.`;
    }
    return `Submitted ${side} order for ${params.product_id} on ${exchange}.`;
}

export function getCancelOrderOutputTemplate(
    params: CancelOrderParams,
    result: unknown,
    mode: ResolvedExecutionMode = "live",
): string {
    const successCount = countFromResult(result, ["results", "success_results"]);
    const exchange = params.exchange ?? "the exchange";

    if (mode === "paper") {
        // F3 paper-cancel fork: distinguish "not found" from "cancelled" so
        // the user never sees the live "no orders actively cancelled" copy
        // when their paper ledger genuinely doesn't have the order.
        if (successCount === 0) {
            const idHint = params.order_ids?.[0] ?? "";
            return idHint
                ? `No paper order with id ${idHint} found in your paper ledger.`
                : "No paper order found in your paper ledger.";
        }
        if (successCount !== null) {
            return `Paper ${successCount === 1 ? "order" : `orders (${successCount})`} cancelled.`;
        }
        return "Paper order cancelled.";
    }

    if (mode === "shadow") {
        return "Shadow cancel logged (no real venue call).";
    }

    if (successCount !== null) {
        return `Submitted cancel request for ${successCount} order(s) on ${exchange}.`;
    }

    return `Submitted cancel request for ${params.order_ids.length} order(s) on ${exchange}.`;
}

export function getFillsOutputTemplate(
    params: GetFillsParams,
    result: unknown,
    mode: ResolvedExecutionMode = "live",
): string {
    const fillCount = countFromResult(result, ["fills"]);
    const exchange = params.exchange ?? "the exchange";
    const venue = mode === "paper" ? "paper venue" : exchange;
    if (fillCount !== null) {
        return `Fetched ${fillCount} fill${fillCount === 1 ? "" : "s"} from ${venue}.`;
    }

    return `Fetched fills from ${venue}.`;
}
