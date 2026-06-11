import type { Locale } from "../utils/languageUtils.ts";

export type DedupKind = "terminal" | "in_flight" | "unknown_state";

export interface DedupExistingOrderSummary {
    client_order_id: string;
    venue: string;
    symbol: string;
    state: string;
    submitted_at: string;
    last_seen_at: string;
    venue_order_id?: string;
}

export interface DedupContextPayload {
    kind: DedupKind;
    existing_order: DedupExistingOrderSummary;
    warning: string;
    title: string;
    action_guidance: string;
}

function extractVenueOrderId(payload: unknown): string | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const p = payload as Record<string, unknown>;
    for (const key of ["venue_order_id", "order_id", "orderId", "id"]) {
        const v = p[key];
        if (typeof v === "string" && v.trim().length > 0) return v.trim();
        if (typeof v === "number" && Number.isFinite(v)) return String(v);
    }
    return undefined;
}

export function buildDedupExistingOrderSummary(order: {
    client_order_id: string;
    venue: string;
    symbol: string;
    state: string;
    submittedAt?: string;
    lastSeenAt?: string;
    latest_payload?: unknown;
}): DedupExistingOrderSummary {
    const summary: DedupExistingOrderSummary = {
        client_order_id: order.client_order_id,
        venue: order.venue,
        symbol: order.symbol,
        state: order.state,
        submitted_at: order.submittedAt ?? "—",
        last_seen_at: order.lastSeenAt ?? "—",
    };
    const venueOrderId = extractVenueOrderId(order.latest_payload);
    if (venueOrderId) summary.venue_order_id = venueOrderId;
    return summary;
}

export function dedupWarningForKind(kind: DedupKind, locale: Locale): string {
    if (locale === "zh-CN") {
        if (kind === "terminal") {
            return "相同参数的订单已存在于账本中。继续将使用新的客户端订单 ID 再次提交。";
        }
        if (kind === "in_flight") {
            return "相同参数的订单正在处理中。继续可能产生重复实盘订单。";
        }
        return "上一笔订单的对账尚未完成，交易所结果仍未确认。若该订单已在交易所成交，继续提交可能产生重复实盘订单。";
    }
    if (kind === "terminal") {
        return "An order with the same parameters already exists in the ledger. Proceeding will submit again with a new client order ID.";
    }
    if (kind === "in_flight") {
        return "An order with the same parameters is still in flight. Proceeding may create a duplicate live order.";
    }
    return "Reconciliation for the previous order is still running and the venue outcome is unconfirmed. If that order already filled on the exchange, proceeding may create a duplicate live order.";
}

export function dedupApprovalTitleForKind(kind: DedupKind, locale: Locale): string {
    if (locale === "zh-CN") {
        if (kind === "unknown_state") return "上一笔订单状态未知";
        if (kind === "in_flight") return "检测到进行中的重复订单";
        return "检测到重复订单";
    }
    if (kind === "unknown_state") return "Previous order status unknown";
    if (kind === "in_flight") return "Duplicate in-flight order";
    return "Duplicate order detected";
}

/** @deprecated Use dedupApprovalTitleForKind */
export function dedupApprovalTitle(locale: Locale): string {
    return dedupApprovalTitleForKind("terminal", locale);
}

export function dedupActionGuidanceForKind(kind: DedupKind, locale: Locale): string {
    if (locale === "zh-CN") {
        if (kind === "unknown_state") {
            return "建议：取消并在 /orders 查看上一笔订单状态，或等待对账完成。确认后将使用新的客户端订单 ID 提交；其他风控闸门仍会生效。";
        }
        if (kind === "in_flight") {
            return "建议：取消并等待上一笔订单完成，或在 /orders 确认状态后再决定。确认后将使用新的客户端订单 ID 提交。";
        }
        return "确认后将使用新的客户端订单 ID 再次提交相同参数的订单。取消则不会提交。";
    }
    if (kind === "unknown_state") {
        return "Recommended: Cancel and check /orders for the previous order, or wait for reconciliation. Approving submits with a new client order ID; other risk gates still apply.";
    }
    if (kind === "in_flight") {
        return "Recommended: Cancel and wait for the in-flight order to settle, or check /orders first. Approving submits with a new client order ID.";
    }
    return "Approving submits the same order parameters again with a new client order ID. Cancel leaves the duplicate unsubmitted.";
}

export function buildDedupContext(
    kind: DedupKind,
    existing_order: DedupExistingOrderSummary,
    locale: Locale,
): DedupContextPayload {
    return {
        kind,
        existing_order,
        warning: dedupWarningForKind(kind, locale),
        title: dedupApprovalTitleForKind(kind, locale),
        action_guidance: dedupActionGuidanceForKind(kind, locale),
    };
}

export function dedupApprovalDescription(
    summary: DedupExistingOrderSummary,
    kind: DedupKind,
    locale: Locale,
): string {
    const warning = dedupWarningForKind(kind, locale);
    const guidance = dedupActionGuidanceForKind(kind, locale);
    const lines = [
        warning,
        "",
        guidance,
        "",
        locale === "zh-CN" ? "**上一笔订单**" : "**Previous order**",
        `| ${locale === "zh-CN" ? "字段" : "Field"} | ${locale === "zh-CN" ? "值" : "Value"} |`,
        "|-------|-------|",
        `| ${locale === "zh-CN" ? "状态" : "Status"} | ${summary.state} |`,
        `| ${locale === "zh-CN" ? "交易所" : "Venue"} | ${summary.venue} |`,
        `| ${locale === "zh-CN" ? "交易对" : "Symbol"} | ${summary.symbol} |`,
        `| ${locale === "zh-CN" ? "客户端订单 ID" : "Client order ID"} | ${summary.client_order_id} |`,
    ];
    if (summary.venue_order_id) {
        lines.push(
            `| ${locale === "zh-CN" ? "交易所订单 ID" : "Venue order ID"} | ${summary.venue_order_id} |`,
        );
    }
    lines.push(
        `| ${locale === "zh-CN" ? "提交时间" : "Submitted"} | ${summary.submitted_at} |`,
        `| ${locale === "zh-CN" ? "最后更新" : "Last seen"} | ${summary.last_seen_at} |`,
    );
    return lines.join("\n");
}

export function dedupDeclinedMessage(locale: Locale): string {
    return locale === "zh-CN"
        ? "已取消 — 未提交重复订单。"
        : "Cancelled — duplicate order was not submitted.";
}

export function dedupSubmitButtonLabel(kind: DedupKind, locale: Locale): string {
    if (locale === "zh-CN") {
        if (kind === "unknown_state") return "仍要提交（新订单 ID）";
        if (kind === "in_flight") return "仍要提交（新订单 ID）";
        return "仍要再次下单";
    }
    if (kind === "unknown_state") return "Submit new order anyway";
    if (kind === "in_flight") return "Submit new order anyway";
    return "Place another order anyway";
}
