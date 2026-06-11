/**
 * §7.5 — Standardized user-facing error contract.
 *
 * Every user-visible error in the trading path MUST flow through
 * `buildUserError(...)`. Each entry has EN + zh-CN templates and a non-empty
 * `action` field that tells the user *what they can do next*.
 *
 * The ESLint rule `tools/eslint-rules/no-raw-trading-error-string` enforces
 * this in `packages/plugin-cex/src/**` and `client/src/components/cex/**`.
 */

export type UserErrorCode =
    | "risk_block"
    | "risk_kill_switch"
    | "fail_closed_audit"
    | "fail_closed_reconciliation"
    | "fail_closed_market_data"
    | "unknown_state"
    | "idempotency_hit"
    | "dep_unhealthy"
    | "venue_timeout"
    | "venue_5xx"
    | "venue_4xx"
    | "prompt_injection_refused"
    | "prompt_injection_downgrade"
    | "approval_rejected"
    | "approval_expired"
    | "consent_required"
    | "geo_restricted"
    | "kill_switch_on"
    | "rate_limited"
    | "unknown";

export type Locale = "en" | "zh-CN" | "mixed-en";

export interface UserError {
    code: UserErrorCode;
    title: string;
    body: string;
    /** Next-step that the user can actually take. Must be non-empty. */
    action: string;
}

export interface BuildUserErrorInput {
    code: UserErrorCode;
    locale?: Locale;
    /** Free-form context plumbed into the templates as `{{key}}`. */
    context?: Record<string, string | number>;
}

interface CatalogEntry {
    title: { en: string; "zh-CN": string };
    body: { en: string; "zh-CN": string };
    action: { en: string; "zh-CN": string };
}

const CATALOG: Record<UserErrorCode, CatalogEntry> = {
    risk_block: {
        title: { en: "Order blocked by risk gate", "zh-CN": "风控拦截订单" },
        body: {
            en: "{{rule}}: {{explanation}}",
            "zh-CN": "{{rule}}:{{explanation}}",
        },
        action: {
            en: "Open Settings → Trading Risk Limits to adjust, then retry.",
            "zh-CN": "前往 设置 → 交易风险限额 调整后重试。",
        },
    },
    risk_kill_switch: {
        title: { en: "Trading paused (kill switch ON)", "zh-CN": "交易已暂停 (终止开关已开启)" },
        body: {
            en: "Your kill switch is active — no new orders will be submitted.",
            "zh-CN": "您的终止开关已激活,系统不会提交任何新订单。",
        },
        action: {
            en: "Toggle the kill switch OFF in the sidebar, then retry.",
            "zh-CN": "在侧边栏关闭终止开关后重试。",
        },
    },
    fail_closed_audit: {
        title: { en: "Trading temporarily paused", "zh-CN": "交易暂时停止" },
        body: {
            en: "The risk-decision audit log is unavailable. Live trades are refused until persistence recovers. Read-only queries still work.",
            "zh-CN": "风控决策审计日志不可用。在持久化恢复之前,已拒绝实盘交易。只读查询仍然可用。",
        },
        action: {
            en: "Switch to paper mode (Settings → Trading) or retry in a minute.",
            "zh-CN": "切换到模拟模式 (设置 → 交易) 或一分钟后重试。",
        },
    },
    fail_closed_reconciliation: {
        title: { en: "Trading temporarily paused", "zh-CN": "交易暂时停止" },
        body: {
            en: "Order reconciliation is degraded. Live trades are refused until streams reconnect.",
            "zh-CN": "订单对账已降级。在数据流重新连接之前,已拒绝实盘交易。",
        },
        action: {
            en: "Switch to paper mode (Settings → Trading) or wait 30s.",
            "zh-CN": "切换到模拟模式 (设置 → 交易) 或等待 30 秒。",
        },
    },
    fail_closed_market_data: {
        title: { en: "Market data too stale", "zh-CN": "行情数据过期" },
        body: {
            en: "Latest price tick is older than the freshness cap — refusing live submit.",
            "zh-CN": "最新报价比新鲜度上限更旧。已拒绝实盘提交。",
        },
        action: {
            en: "Wait for the next tick (<30s) or relax the freshness cap in Settings.",
            "zh-CN": "等待下一报价 (<30秒) 或在 设置 中放宽新鲜度上限。",
        },
    },
    unknown_state: {
        title: {
            en: "Order outcome unknown — I'm checking your exchange state now",
            "zh-CN": "订单结果未确认 — 我正在向交易所核对",
        },
        body: {
            // C4 — explicitly tell the user we are reconciling. Avoid any
            // "retry now" phrasing: until reconciliation reports a
            // definite NOT_PLACED state, retrying risks a duplicate live
            // order against the same client_order_id (idempotency
            // protects against this for in-flight rows, but only if the
            // ledger entry exists). The reconciliation poller resolves
            // the true state every 5 s.
            en: "I couldn't confirm whether your order reached the venue. I'm checking your exchange state now — DO NOT retry until I report back. Reconciliation typically resolves within 60 seconds.",
            "zh-CN": "无法确认订单是否抵达交易所。我正在向交易所核对状态 — 在我回报前请勿重试。对账通常在 60 秒内完成。",
        },
        action: {
            en: "Wait for reconciliation. If you must check sooner, type `/orders` to see the live ledger.",
            "zh-CN": "请等待对账完成。如需立即查看,请输入 `/orders` 查看实时订单。",
        },
    },
    idempotency_hit: {
        title: { en: "Duplicate order detected", "zh-CN": "检测到重复订单" },
        body: {
            en: "An order with the same parameters already exists. Review the previous order details and confirm if you still want to place another one.",
            "zh-CN": "已有相同参数的订单。请查看上一笔订单详情,确认是否仍要再次下单。",
        },
        action: {
            en: "Confirm in the approval dialog to proceed with a new client order ID, or cancel to stop.",
            "zh-CN": "在审批对话框中确认以使用新的客户端订单 ID 继续,或取消以停止。",
        },
    },
    dep_unhealthy: {
        title: { en: "Trading temporarily paused", "zh-CN": "交易暂时停止" },
        body: {
            en: "One or more upstream systems is degraded ({{reasons}}). Live trades refused.",
            "zh-CN": "一个或多个上游系统已降级 ({{reasons}})。已拒绝实盘交易。",
        },
        action: {
            en: "Switch to paper mode (Settings → Trading) or wait for systems to recover.",
            "zh-CN": "切换到模拟模式 (设置 → 交易) 或等待系统恢复。",
        },
    },
    venue_timeout: {
        title: { en: "Exchange timeout", "zh-CN": "交易所超时" },
        body: {
            en: "The exchange took too long to respond. Your order status will be resolved by reconciliation.",
            "zh-CN": "交易所响应超时。订单状态将通过对账服务解决。",
        },
        action: {
            en: "Open `/orders` in 30s to see the final state.",
            "zh-CN": "30 秒后打开 `/orders` 查看最终状态。",
        },
    },
    venue_5xx: {
        title: { en: "Exchange degraded", "zh-CN": "交易所降级" },
        body: {
            en: "The exchange returned a server error. Your order state is uncertain — reconciliation will resolve.",
            "zh-CN": "交易所返回服务器错误。订单状态不确定,对账服务将处理。",
        },
        action: {
            en: "Open `/orders` for the resolved state; don't retry until it lands.",
            "zh-CN": "打开 `/orders` 查看已解决的状态;在解决之前请勿重试。",
        },
    },
    venue_4xx: {
        title: { en: "Exchange rejected the order", "zh-CN": "交易所拒绝订单" },
        body: {
            en: "{{message}}",
            "zh-CN": "{{message}}",
        },
        action: {
            en: "Check the parameters and submit again with corrected values.",
            "zh-CN": "检查参数后使用更正后的值重新提交。",
        },
    },
    prompt_injection_refused: {
        title: { en: "Request blocked by safety filter", "zh-CN": "请求被安全过滤器拦截" },
        body: {
            en: "Your message looked like a prompt-injection attempt against the trading agent.",
            "zh-CN": "您的消息看起来像是针对交易代理的提示注入。",
        },
        action: {
            en: "Rephrase your request in plain trading terms (e.g. \"buy 0.01 BTC\").",
            "zh-CN": "请用直接的交易语言重述请求 (例如:\"买入 0.01 BTC\")。",
        },
    },
    prompt_injection_downgrade: {
        title: { en: "Read-only mode forced", "zh-CN": "已强制为只读模式" },
        body: {
            en: "Your message contained patterns that look risky. Only read-only actions will proceed.",
            "zh-CN": "您的消息中包含风险模式。仅允许只读操作。",
        },
        action: {
            en: "Submit a write action through a fresh, unambiguous message.",
            "zh-CN": "通过一条全新、明确的消息提交写入操作。",
        },
    },
    approval_rejected: {
        title: { en: "Approval rejected", "zh-CN": "审批已拒绝" },
        body: {
            en: "You declined to authorize this trade.",
            "zh-CN": "您拒绝了本次交易的授权。",
        },
        action: {
            en: "Send a fresh message to start over.",
            "zh-CN": "发送新消息以重新开始。",
        },
    },
    approval_expired: {
        title: { en: "Approval expired", "zh-CN": "审批已过期" },
        body: {
            en: "Approval was not completed within the time limit.",
            "zh-CN": "审批未在时限内完成。",
        },
        action: {
            en: "Resubmit the request to get a fresh approval modal.",
            "zh-CN": "重新提交请求以获取新的审批弹窗。",
        },
    },
    consent_required: {
        title: { en: "Live-trading consent required", "zh-CN": "需要实盘交易同意" },
        body: {
            en: "You must accept the live-trading TOS and risk disclosure before placing live orders.",
            "zh-CN": "在下达实盘订单之前,您必须接受实盘交易条款和风险声明。",
        },
        action: {
            en: "Open Settings → Trading and accept the consent text.",
            "zh-CN": "打开 设置 → 交易 并接受同意文本。",
        },
    },
    geo_restricted: {
        title: { en: "Live trading unavailable in your region", "zh-CN": "您所在地区不支持实盘交易" },
        body: {
            en: "Live mode is not available in {{region}}.",
            "zh-CN": "{{region}} 不支持实盘模式。",
        },
        action: {
            en: "Use paper mode for testing.",
            "zh-CN": "使用模拟模式进行测试。",
        },
    },
    kill_switch_on: {
        title: { en: "Trading is paused", "zh-CN": "交易已暂停" },
        body: {
            en: "Kill switch is ON. No new trades will be submitted.",
            "zh-CN": "终止开关已开启。系统不会提交任何新交易。",
        },
        action: {
            en: "Turn the kill switch off in the sidebar to resume trading.",
            "zh-CN": "在侧边栏关闭终止开关以恢复交易。",
        },
    },
    rate_limited: {
        title: { en: "Rate limit hit", "zh-CN": "速率限制" },
        body: {
            en: "Too many requests in a short window. Backing off.",
            "zh-CN": "短时间内请求过多。正在退避。",
        },
        action: {
            en: "Retry in {{retry_in_seconds}} seconds.",
            "zh-CN": "{{retry_in_seconds}} 秒后重试。",
        },
    },
    unknown: {
        title: { en: "Something went wrong", "zh-CN": "发生了错误" },
        body: {
            en: "{{message}}",
            "zh-CN": "{{message}}",
        },
        action: {
            en: "Contact support with code {{code}}.",
            "zh-CN": "联系客服并提供错误代码 {{code}}。",
        },
    },
};

function pickLocale(locale: Locale | undefined): "en" | "zh-CN" {
    if (locale === "zh-CN") return "zh-CN";
    return "en";
}

function interpolate(template: string, ctx: Record<string, string | number>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => {
        const v = ctx[key];
        return v === undefined ? "" : String(v);
    });
}

/**
 * Build a structured user-facing error. The `action` field is guaranteed
 * non-empty — that's the contract that makes the helper safer than free-form
 * error strings.
 */
export function buildUserError(input: BuildUserErrorInput): UserError {
    const entry = CATALOG[input.code] ?? CATALOG.unknown;
    const loc = pickLocale(input.locale);
    const ctx = { ...(input.context ?? {}), code: input.code };
    const title = interpolate(entry.title[loc], ctx);
    const body = interpolate(entry.body[loc], ctx);
    const action = interpolate(entry.action[loc], ctx);
    return {
        code: input.code,
        title,
        body,
        action,
    };
}

/** Convert a {@link UserError} into a single Markdown block for chat replies. */
export function renderUserErrorMarkdown(err: UserError): string {
    return `**${err.title}**\n\n${err.body}\n\n> ${err.action}`;
}
