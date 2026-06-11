/**
 * F8 — mode-aware user-facing stream messages.
 *
 * Plain English / 中文 copy emitted at each CEX workflow stage, FORKED
 * on resolved execution mode so paper-mode users don't see "Submitting
 * request to the exchange." (a small but corrosive lie about whether
 * real money is moving).
 *
 * Used by `cexWorkflowMessageHandler.ts` when emitting ProcessingSteps
 * during the workflow. The step `name` field remains stable (from
 * `CEX_WORKFLOW_STEPS`) so the client dispatcher continues to match.
 */
import type { Locale } from "../utils/languageUtils.ts";

export type ResolvedMode = "live" | "paper" | "shadow";

interface StageMessages {
    inProgress: string;
    completed: string;
}

type Locales = "en" | "zh-CN";

function pickLocale(l: Locale | undefined): Locales {
    return l === "zh-CN" ? "zh-CN" : "en";
}

function resolveMode(m: ResolvedMode | undefined): ResolvedMode {
    return m === "paper" || m === "shadow" ? m : "live";
}

/**
 * F8 — the orderSubmit stage is the highest-trust moment in the flow.
 * Make sure paper/shadow modes never say "exchange".
 */
const ORDER_SUBMIT: Record<ResolvedMode, Record<Locales, StageMessages>> = {
    live: {
        en: {
            inProgress: "Submitting request to the exchange…",
            completed: "Request submitted",
        },
        "zh-CN": {
            inProgress: "正在向交易所提交订单…",
            completed: "订单已提交",
        },
    },
    paper: {
        en: {
            inProgress: "Submitting paper order to the simulator…",
            completed: "Paper order recorded",
        },
        "zh-CN": {
            inProgress: "正在向模拟交易簿写入纸面订单…",
            completed: "纸面订单已记录",
        },
    },
    shadow: {
        en: {
            inProgress: "Logging hypothetical order (shadow mode)…",
            completed: "Hypothetical order logged",
        },
        "zh-CN": {
            inProgress: "正在记录影子交易订单…",
            completed: "影子订单已记录",
        },
    },
};

const RISK_CHECK: Record<ResolvedMode, Record<Locales, StageMessages>> = {
    live: {
        en: { inProgress: "Running risk checks on live order…", completed: "Risk checks passed" },
        "zh-CN": { inProgress: "正在对实盘订单运行风险检查…", completed: "风险检查通过" },
    },
    paper: {
        en: { inProgress: "Running risk checks on paper order…", completed: "Risk checks passed (paper)" },
        "zh-CN": { inProgress: "正在对纸面订单运行风险检查…", completed: "风险检查通过(纸面)" },
    },
    shadow: {
        en: { inProgress: "Running risk checks on shadow order…", completed: "Risk checks passed (shadow)" },
        "zh-CN": { inProgress: "正在对影子订单运行风险检查…", completed: "风险检查通过(影子)" },
    },
};

const APPROVAL_REQUEST: Record<ResolvedMode, Record<Locales, StageMessages>> = {
    live: {
        en: { inProgress: "Waiting for your authorization…", completed: "Authorization received" },
        "zh-CN": { inProgress: "等待你的确认…", completed: "已确认" },
    },
    paper: {
        en: { inProgress: "Waiting for your authorization (paper mode)…", completed: "Paper order authorized" },
        "zh-CN": { inProgress: "等待你的确认(模拟交易)…", completed: "纸面订单已确认" },
    },
    shadow: {
        en: { inProgress: "Waiting for your authorization (shadow mode)…", completed: "Shadow order authorized" },
        "zh-CN": { inProgress: "等待你的确认(影子模式)…", completed: "影子订单已确认" },
    },
};

export interface CexStageCopyOptions {
    mode?: ResolvedMode;
    locale?: Locale;
    /** Compact canonical order summary from approval params. */
    orderSummary?: string;
}

function withOrderSummaryInProgress(
    base: StageMessages,
    orderSummary: string | undefined,
    verbEn: string,
    verbZh: string,
    locale: Locales,
): StageMessages {
    const summary = orderSummary?.trim();
    if (!summary) return base;
    if (locale === "zh-CN") {
        return {
            inProgress: `${verbZh}${summary}…`,
            completed: base.completed,
        };
    }
    return {
        inProgress: `${verbEn} ${summary}…`,
        completed: base.completed,
    };
}

export function getOrderSubmitCopy(opts: CexStageCopyOptions = {}): StageMessages {
    const m = resolveMode(opts.mode);
    const locale = pickLocale(opts.locale);
    const base = ORDER_SUBMIT[m][locale];
    const summary = opts.orderSummary?.trim();
    if (!summary) return base;
    if (locale === "zh-CN") {
        if (m === "paper") {
            return { inProgress: `正在提交纸面订单：${summary}…`, completed: base.completed };
        }
        if (m === "shadow") {
            return { inProgress: `正在记录影子订单：${summary}…`, completed: base.completed };
        }
        return { inProgress: `正在提交订单：${summary}…`, completed: base.completed };
    }
    if (m === "paper") {
        return { inProgress: `Submitting paper order: ${summary}…`, completed: base.completed };
    }
    if (m === "shadow") {
        return { inProgress: `Logging hypothetical order: ${summary}…`, completed: base.completed };
    }
    return { inProgress: `Submitting your ${summary}…`, completed: base.completed };
}

export function getRiskCheckCopy(opts: CexStageCopyOptions = {}): StageMessages {
    const m = resolveMode(opts.mode);
    const locale = pickLocale(opts.locale);
    const base = RISK_CHECK[m][locale];
    return withOrderSummaryInProgress(
        base,
        opts.orderSummary,
        "Running risk checks on your",
        "正在对你的订单运行风险检查：",
        locale,
    );
}

export function getApprovalRequestCopy(opts: CexStageCopyOptions = {}): StageMessages {
    const m = resolveMode(opts.mode);
    const locale = pickLocale(opts.locale);
    const base = APPROVAL_REQUEST[m][locale];
    return withOrderSummaryInProgress(
        base,
        opts.orderSummary,
        "Waiting for your authorization on",
        "等待你确认订单：",
        locale,
    );
}
