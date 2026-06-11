import type {
    CancelOrderParams,
    CreateOrderParams,
    GetBalanceParams,
    GetFillsParams,
    GetOrdersParams,
} from "../types";
import type { ResolvedExecutionMode } from "./output";

// Lightweight error templates for trade actions.
// These keep user-facing error text consistent while the raw error still travels in metadata.
function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : "Unknown error";
}

function modePrefix(mode: ResolvedExecutionMode | undefined): string {
    if (mode === "paper") return "Paper ";
    if (mode === "shadow") return "Shadow ";
    return "";
}

export function getBalanceErrorTemplate(
    params: Partial<GetBalanceParams>,
    error: unknown,
    mode: ResolvedExecutionMode = "live",
): string {
    return `${modePrefix(mode)}Failed to fetch balances from ${params.exchange ?? "the exchange"}: ${getErrorMessage(error)}`;
}

export function getOrdersErrorTemplate(
    params: Partial<GetOrdersParams>,
    error: unknown,
    mode: ResolvedExecutionMode = "live",
): string {
    return `${modePrefix(mode)}Failed to fetch orders from ${params.exchange ?? "the exchange"}: ${getErrorMessage(error)}`;
}

export function getCreateOrderErrorTemplate(
    params: Partial<CreateOrderParams>,
    error: unknown,
    mode: ResolvedExecutionMode = "live",
): string {
    return `${modePrefix(mode)}Failed to create order${params.product_id ? ` for ${params.product_id}` : ""}: ${getErrorMessage(error)}`;
}

export function getCancelOrderErrorTemplate(
    params: Partial<CancelOrderParams>,
    error: unknown,
    mode: ResolvedExecutionMode = "live",
): string {
    return `${modePrefix(mode)}Failed to cancel order${params.order_ids?.length ? "s" : ""}: ${getErrorMessage(error)}`;
}

export function getFillsErrorTemplate(
    params: Partial<GetFillsParams>,
    error: unknown,
    mode: ResolvedExecutionMode = "live",
): string {
    return `${modePrefix(mode)}Failed to fetch fills from ${params.exchange ?? "the exchange"}: ${getErrorMessage(error)}`;
}
