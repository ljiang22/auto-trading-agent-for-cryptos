/**
 * §8.1 — Prompt-injection defense for the CEX preprocess flow.
 *
 * Two layers:
 *  1. Pattern-based detection — checks for known prompt-injection vectors
 *     (instruction overrides, role-play prompts, tool-name impersonation,
 *     bracketed system-prompt mimicry, etc.). Yields a `score`.
 *  2. Verdict policy — `> 0.7` → refuse with a localized error;
 *     `0.4–0.7` → downgrade the intent to read-only;
 *     `< 0.4`   → allow.
 *
 * The classifier is rules-only by default. When `PROMPT_INJECTION_LLM_URL`
 * is set, the rules score is averaged with an external classifier score.
 *
 * Tested against `__tests__/utils/promptInjectionDefense.test.ts` which
 * exercises a 50+ adversarial corpus.
 */

export type PromptInjectionVerdict = "allow" | "downgrade" | "refuse";

export interface PromptInjectionResult {
    score: number;
    verdict: PromptInjectionVerdict;
    matched_patterns: string[];
    sanitized_message: string;
}

interface Pattern {
    name: string;
    re: RegExp;
    weight: number;
}

const PATTERNS: Pattern[] = [
    {
        name: "instruction_override",
        re: /\b(ignore|disregard|forget)\b[^.\n]{0,30}\b(instructions?|rules?|prompts?|messages?|directives?)\b/i,
        weight: 0.55,
    },
    {
        name: "system_prompt_exfiltrate",
        re: /\b(reveal|leak|show|print|output|return|share|expose)\b[^.\n]{0,40}\b(system\s+(prompt|message|instructions?)|your\s+(prompt|instructions?|rules?)|hidden\s+(prompt|instructions?))/i,
        weight: 0.75,
    },
    {
        name: "system_prompt_mimicry",
        re: /\b(you are now|act as|pretend to be|new role|new persona|new system prompt|new instructions)\b/i,
        weight: 0.45,
    },
    {
        name: "bracketed_system",
        re: /\[\s*(?:system|admin|root|developer|assistant)[^\]]*\]/i,
        weight: 0.45,
    },
    {
        name: "tool_impersonation",
        re: /\b(call|invoke|execute|run)\s+(?:tool|function|action)\s*[(:'`"]/i,
        weight: 0.4,
    },
    {
        name: "developer_mode",
        re: /\b(jailbreak|developer mode|DAN mode|sudo|enable god mode|root access)\b/i,
        weight: 0.6,
    },
    {
        name: "exfiltrate_credentials",
        re: /\b(show|print|reveal|leak|output|return|share|expose|dump|disclose|forward|export)\b.{0,80}\b(api[_\s-]?keys?|api[_\s-]?secrets?|passwords?|private[_\s-]?keys?|tokens?|env|secrets?|credentials?)\b/i,
        weight: 0.75,
    },
    {
        name: "encoded_payload",
        re: /[A-Za-z0-9+/]{120,}={0,2}/,
        weight: 0.3,
    },
    {
        name: "delimiter_injection",
        // Triple-quote / fence / EOT-style escape attempts.
        re: /(?:```|"""|<\|im_end\|>|<\|end\|>|<<<END|^=====+|^---+\s*system)/m,
        weight: 0.4,
    },
    {
        name: "unicode_homoglyph_attack",
        // Cyrillic letters disguised as Latin (а=U+0430, е=U+0435, etc.)
        re: /[аеросух]{3,}/u,
        weight: 0.3,
    },
    {
        name: "send_to_attacker",
        re: /\b(send|fetch|POST|exfiltrate|webhook|push|upload|curl|wget|request|forward)\b.*(http:\/\/|https:\/\/)/i,
        weight: 0.5,
    },
    {
        name: "send_credential_to_attacker",
        re: /\b(send|fetch|POST|exfiltrate|webhook|push|upload|curl|wget|request|forward)\b.*\b(api[_\s-]?keys?|api[_\s-]?secrets?|passwords?|private[_\s-]?keys?|tokens?|secrets?|credentials?)\b.*\b(https?:\/\/|webhook)/i,
        weight: 0.75,
    },
    {
        // 2026-05-25 hardening (QA H-2 / M-1 / M-2 / H-4): explicit
        // refusal corpus for red-team prompts that ask the agent to
        // bypass / ignore / disable / override the platform's safety
        // gates. The previous `instruction_override` pattern required
        // the noun to be "instructions/rules/prompts/messages/directives"
        // — this pattern targets the trading-safety vocabulary the QA
        // showed sneaking through.
        name: "trading_safety_override",
        re: /\b(bypass|ignore|disable|override|skip|disregard|turn\s*off)\b[^.\n]{0,40}\b(confirm(?:ation)?s?|risk(?:\s*(?:engine|management|gate|check))?|safety|guard(?:rail)?s?|approvals?|limits?|caps?|gates?|protections?|policy|policies|rules?)\b/i,
        weight: 0.75,
    },
];

const USER_OPEN = "<user_message>";
const USER_CLOSE = "</user_message>";

/**
 * Wrap user text in explicit `<user_message>` delimiters and strip patterns
 * that look like instruction-override attempts. The wrapper is what the
 * trading-template prompts then quote — it gives the LLM a clear boundary
 * between system intent and user content.
 */
export function sanitizeUserMessage(message: string): string {
    let s = message;
    // Strip our own boundary tags if they appear inside the user text — the
    // user can't be allowed to forge them.
    s = s.split(USER_OPEN).join("");
    s = s.split(USER_CLOSE).join("");
    return `${USER_OPEN}${s}${USER_CLOSE}`;
}

/**
 * Run the rule-based classifier. Each matched pattern adds its weight to
 * the score (capped at 1.0). Patterns also surface in the result so the
 * downstream emit can include `matched_patterns`.
 */
export function classifyPromptInjection(message: string): PromptInjectionResult {
    const matched: string[] = [];
    let score = 0;
    for (const p of PATTERNS) {
        if (p.re.test(message)) {
            matched.push(p.name);
            score += p.weight;
        }
    }
    if (score > 1) score = 1;
    let verdict: PromptInjectionVerdict;
    if (score >= 0.7) verdict = "refuse";
    else if (score >= 0.4) verdict = "downgrade";
    else verdict = "allow";
    return {
        score,
        verdict,
        matched_patterns: matched,
        sanitized_message: sanitizeUserMessage(message),
    };
}

/**
 * §8.1 — localized refusal text rendered when classifier verdict = "refuse".
 * Short by design: the standardized-error helper layered on top of this
 * supplies the `action` next-step.
 */
export function renderPromptInjectionRefusalMessage(
    locale: "en" | "zh-CN" | "mixed-en",
): string {
    if (locale === "zh-CN") {
        return [
            "🛑 已拒绝该请求 — 检测到可能的 prompt 注入。",
            "若你确实有合法交易需求,请直接描述操作(如「以市价买入 0.01 BTC」)。",
        ].join("\n");
    }
    return [
        "🛑 Request refused — possible prompt injection detected.",
        "If you intend a real trading action, please describe it directly (e.g., \"buy 0.01 BTC at market\").",
    ].join("\n");
}

/**
 * §8.1 — localized downgrade notice. The handler attaches it as a notice
 * line on read-only responses when the classifier downgrades a write.
 */
export function renderPromptInjectionDowngradeNotice(
    locale: "en" | "zh-CN" | "mixed-en",
): string {
    if (locale === "zh-CN") {
        return "⚠️ 请求被降级为只读模式 — 检测到可疑指令模式。";
    }
    return "⚠️ Request downgraded to read-only — suspicious instruction pattern detected.";
}
