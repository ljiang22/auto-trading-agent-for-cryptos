/**
 * Language Matching Feature Test Script
 *
 * Tests that LLM responses match the language setting (en / zh-CN).
 *
 * Usage:
 *   1. Start the agent: pnpm start
 *   2. Run this script: npx tsx scripts/test-language-matching.ts
 *
 * Tests 4 categories × 5 questions × 2 languages = 40 test cases
 */

const BASE_URL = process.env.SERVER_URL || "http://localhost:3000";
const USER_EMAIL = process.env.TEST_USER_EMAIL || "test@test.com";
const AUTH_COOKIE = `user_info=${encodeURIComponent(JSON.stringify({ email: USER_EMAIL }))}`;

// ─── Test Questions by Category ────────────────────────────────────

// Set FULL_TEST=1 to run all categories; default is quick mode (regular only)
const FULL_TEST = process.env.FULL_TEST === "1";

const REGULAR_QUESTIONS = [
    "What is Bitcoin?",
    "Explain the difference between proof of work and proof of stake",
    "What are the top 3 cryptocurrencies by market cap?",
    "How does a blockchain work?",
    "What is DeFi?",
];

const TEST_CASES: Record<string, string[]> = {
    regular: REGULAR_QUESTIONS,
    ...(FULL_TEST
        ? {
              comprehensive: [
                  "Give me a comprehensive analysis of BTC",
                  "Provide a full comprehensive analysis of Ethereum",
                  "comprehensive analysis of SOL",
                  "Do a comprehensive analysis of DOGE",
                  "comprehensive analysis of XRP",
              ],
              taskChain: [
                  "Get Bitcoin news and analyze the sentiment",
                  "Compare Bitcoin and Ethereum technical indicators",
                  "Research Solana news and plot its price chart",
                  "Get the fear and greed index and BTC price data",
                  "Analyze BTC on-chain data and get latest news",
              ],
              trading: [
                  "I want to buy some Bitcoin",
                  "Place a market order for ETH",
                  "Can you help me sell my BTC position?",
                  "What's the best price to set a limit order for SOL?",
                  "Show me my open orders on Binance",
              ],
          }
        : {}),
};

// ─── Helpers ───────────────────────────────────────────────────────

interface TestResult {
    category: string;
    question: string;
    language: string;
    passed: boolean;
    responseSnippet: string;
    error?: string;
    chineseRatio?: number;
}

async function getAgentId(): Promise<string> {
    const res = await fetch(`${BASE_URL}/agents`, {
        headers: { Cookie: AUTH_COOKIE },
    });
    if (!res.ok) throw new Error(`Failed to fetch agents: ${res.status}`);
    const data = await res.json() as { agents: { id: string; name: string }[] };
    if (!data.agents?.length) throw new Error("No agents found");
    console.log(`  Using agent: ${data.agents[0].name} (${data.agents[0].id})`);
    return data.agents[0].id;
}

async function sendMessage(
    agentId: string,
    text: string,
    language: string,
    roomId: string
): Promise<string> {
    const res = await fetch(`${BASE_URL}/${agentId}/message/stream`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            Cookie: AUTH_COOKIE,
        },
        body: JSON.stringify({ text, roomId, language }),
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);

    const reader = res.body?.getReader();
    if (!reader) throw new Error("No response body");

    const decoder = new TextDecoder();
    let buffer = "";
    let responseText = "";

    while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events (split on double newline)
        const parts = buffer.split("\n");
        buffer = parts.pop() || "";

        for (const line of parts) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data: ")) continue;
            const payload = trimmed.slice(6).trim();
            if (payload === "[DONE]" || !payload) continue;

            try {
                const event = JSON.parse(payload);

                // Extract text from any event type that carries response content
                const candidates = [
                    event.response?.content?.text,
                    event.response?.text,
                    event.text,
                    event.content?.text,
                ];
                // Also handle final_response with responses array
                if (event.responses && Array.isArray(event.responses)) {
                    for (const r of event.responses) {
                        candidates.push(r?.content?.text, r?.text);
                    }
                }

                for (const c of candidates) {
                    if (c && typeof c === "string" && c.length > (responseText?.length || 0)) {
                        responseText = c;
                    }
                }
            } catch {
                // Skip unparseable lines
            }
        }
    }

    return responseText;
}

/**
 * Heuristic: estimate what fraction of the text is Chinese characters.
 * Chinese Unicode ranges: \u4e00-\u9fff (CJK Unified Ideographs)
 */
function chineseCharRatio(text: string): number {
    if (!text) return 0;
    const stripped = text.replace(/[\s\p{P}\p{S}\d\n\r]/gu, ""); // Remove spaces, punctuation, symbols, digits
    if (!stripped.length) return 0;
    const chineseChars = stripped.match(/[\u4e00-\u9fff]/g) || [];
    return chineseChars.length / stripped.length;
}

function isLanguageMatch(text: string, language: string): { passed: boolean; ratio: number } {
    const ratio = chineseCharRatio(text);
    if (language === "zh-CN") {
        // For Chinese, expect at least 40% Chinese characters (allowing for English proper nouns, numbers, etc.)
        return { passed: ratio >= 0.4, ratio };
    }
    // For English, expect less than 10% Chinese characters
    return { passed: ratio < 0.1, ratio };
}

// ─── Main Test Runner ──────────────────────────────────────────────

async function runTests() {
    const mode = FULL_TEST ? "FULL (all categories)" : "QUICK (regular only)";
    console.log("╔══════════════════════════════════════════════════════════╗");
    console.log("║       Language Matching Feature Test                     ║");
    console.log("╚══════════════════════════════════════════════════════════╝");
    console.log(`  Mode: ${mode}`);
    console.log(`  Auth: ${USER_EMAIL}\n`);

    let agentId: string;
    try {
        console.log("🔍 Finding agent...");
        agentId = await getAgentId();
    } catch (e) {
        console.error(`\n❌ Cannot connect to agent at ${BASE_URL}`);
        console.error("   Make sure the agent is running: pnpm start\n");
        console.error(`   Error: ${(e as Error).message}`);
        process.exit(1);
    }

    const results: TestResult[] = [];
    const languages = ["en", "zh-CN"] as const;
    const categories = Object.keys(TEST_CASES) as (keyof typeof TEST_CASES)[];

    let totalTests = 0;
    let passedTests = 0;

    for (const lang of languages) {
        console.log(`\n${"═".repeat(60)}`);
        console.log(`  Testing language: ${lang === "zh-CN" ? "简体中文 (zh-CN)" : "English (en)"}`);
        console.log(`${"═".repeat(60)}`);

        for (const category of categories) {
            console.log(`\n  📁 Category: ${category}`);
            console.log(`  ${"─".repeat(50)}`);

            const questions = TEST_CASES[category];
            const qCount = questions.length;

            for (let i = 0; i < qCount; i++) {
                const question = questions[i];
                totalTests++;

                // Use unique room per test to avoid context interference
                const roomId = `test-lang-${lang}-${category}-${i}-${Date.now()}`;

                process.stdout.write(`    [${i + 1}/${qCount}] "${question.substring(0, 40)}..." `);

                try {
                    const response = await Promise.race([
                        sendMessage(agentId, question, lang, roomId),
                        new Promise<string>((_, reject) =>
                            setTimeout(() => reject(new Error("Timeout (120s)")), 120_000)
                        ),
                    ]);

                    if (!response) {
                        console.log("⚠️  No response text received");
                        results.push({
                            category,
                            question,
                            language: lang,
                            passed: false,
                            responseSnippet: "(empty)",
                            error: "No response text",
                        });
                        continue;
                    }

                    const { passed, ratio } = isLanguageMatch(response, lang);
                    const snippet = response.substring(0, 80).replace(/\n/g, " ");

                    if (passed) {
                        passedTests++;
                        console.log(`✅ (zh: ${(ratio * 100).toFixed(0)}%) "${snippet}..."`);
                    } else {
                        console.log(`❌ (zh: ${(ratio * 100).toFixed(0)}%) "${snippet}..."`);
                    }

                    results.push({
                        category,
                        question,
                        language: lang,
                        passed,
                        responseSnippet: snippet,
                        chineseRatio: ratio,
                    });
                } catch (e) {
                    console.log(`❌ Error: ${(e as Error).message}`);
                    results.push({
                        category,
                        question,
                        language: lang,
                        passed: false,
                        responseSnippet: "",
                        error: (e as Error).message,
                    });
                }
            }
        }
    }

    // ─── Summary ───────────────────────────────────────────────

    console.log(`\n\n${"═".repeat(60)}`);
    console.log("  TEST SUMMARY");
    console.log(`${"═".repeat(60)}\n`);

    // Per-category breakdown
    for (const lang of languages) {
        console.log(`  Language: ${lang}`);
        for (const category of categories) {
            const catResults = results.filter(r => r.language === lang && r.category === category);
            const catPassed = catResults.filter(r => r.passed).length;
            const icon = catPassed === catResults.length ? "✅" : "❌";
            console.log(`    ${icon} ${category}: ${catPassed}/${catResults.length} passed`);
        }
        console.log();
    }

    console.log(`  Total: ${passedTests}/${totalTests} passed`);
    console.log(`  Pass rate: ${((passedTests / totalTests) * 100).toFixed(1)}%`);

    if (passedTests < totalTests) {
        console.log(`\n  ❌ Failed tests:`);
        for (const r of results.filter(r => !r.passed)) {
            console.log(`    - [${r.language}/${r.category}] "${r.question.substring(0, 40)}"`);
            if (r.error) console.log(`      Error: ${r.error}`);
            else console.log(`      Chinese ratio: ${((r.chineseRatio || 0) * 100).toFixed(0)}% | "${r.responseSnippet}"`);
        }
    }

    console.log();
    process.exit(passedTests === totalTests ? 0 : 1);
}

runTests();
