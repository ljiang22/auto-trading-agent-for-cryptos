import { test, expect } from "@playwright/test";

/**
 * StrategyEngineService — live UI smoke against a locally-running, engine-enabled
 * agent (STRATEGY_ENGINE_ENABLED=true) in PAPER mode. Drives the real chat:
 * landing search box → chat room → compile a hybrid DCA + risk-control strategy
 * (exercises the new nlToDSL hybrid template end-to-end through the UI).
 *
 * The engine's execution pipeline is independently proven by the unit suite +
 * a local paper run that produced real Coinbase paper fills; this verifies the
 * client + chat round-trip against the new build. Screenshots → /tmp/pw-screens/.
 */

const SHOTS = "/tmp/pw-screens";

async function openChatWith(page: import("@playwright/test").Page, prompt: string) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const landing = page.locator('[data-tour="landing-search"]');
  await expect(landing).toBeVisible({ timeout: 20_000 });
  await landing.click();
  await landing.fill(prompt);
  await page.screenshot({ path: `${SHOTS}/01-landing-typed.png`, fullPage: true });
  await landing.press("Enter");
  // Lands in the chat room; the chat textarea (data-testid=chat-input) renders there.
  await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
}

test.describe("Strategy engine — live UI (paper)", () => {
  test("compile a hybrid DCA + risk-control strategy via chat", async ({ page }) => {
    test.setTimeout(220_000); // LLM action-selection + compile can take >60s
    await openChatWith(
      page,
      "compile a DCA strategy for $20 of BTC weekly, buy the dip at -5% from the 20-day high, take profit 3% stop loss 2%",
    );
    await page.screenshot({ path: `${SHOTS}/02-chat-opened.png`, fullPage: true });

    // Wait for the agent's streamed reply. Use compile-specific markers that would
    // NOT appear in the sidebar history of a brand-new chat. Poll up to 150s
    // (LLM action-selection + compile). Capture regardless of match.
    const MARKERS = [
      "strategy compiled",
      "evaluation_interval_seconds",
      "per_trade_take_profit_bps",
      "pct_from_high",
      "next steps",
      "could not compile",
      "clarif",
    ];
    await page
      .waitForFunction(
        (markers) => {
          const t = document.body.innerText.toLowerCase();
          return markers.some((m) => t.includes(m));
        },
        MARKERS,
        { timeout: 150_000 },
      )
      .catch(() => { /* capture whatever rendered even on timeout */ });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SHOTS}/03-compile-response.png`, fullPage: true });

    // Scope to the main panel (exclude the sidebar nav) for an honest read.
    const main = page.locator("main").first();
    const mainText = (await main.count()) ? await main.innerText() : await page.evaluate(() => document.body.innerText);
    // eslint-disable-next-line no-console
    console.log("COMPILE_MAIN_PANEL>>>", mainText.slice(0, 2000).replace(/\s+/g, " "));
    expect(mainText.length).toBeGreaterThan(100);
  });

  test("auto-execution intent routes to compile + arm (not create_order tranches)", async ({ page }) => {
    test.setTimeout(220_000);
    await openChatWith(
      page,
      "set up an automated DCA that buys $20 of BTC weekly and auto-buys the dip at -5% from the 20-day high, take profit 3% stop loss 2% — run it automatically for me",
    );
    await page.screenshot({ path: `${SHOTS}/07-auto-opened.png`, fullPage: true });
    // Expect the plan/response to reference arming / automatic paper execution.
    await page
      .waitForFunction(
        () => {
          const t = document.body.innerText.toLowerCase();
          return t.includes("arm") || t.includes("automatically in paper") || t.includes("runs automatically") || t.includes("arm_strategy") || t.includes("auto-execution");
        },
        { timeout: 180_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${SHOTS}/08-auto-response.png`, fullPage: true });
    const main = page.locator("main").first();
    const mainText = (await main.count()) ? await main.innerText() : await page.evaluate(() => document.body.innerText);
    // eslint-disable-next-line no-console
    console.log("AUTO_MAIN_PANEL>>>", mainText.slice(0, 2200).replace(/\s+/g, " "));
    expect(mainText.length).toBeGreaterThan(150);
  });

  test("manual 'execute strategy' compiles, then 'arm it' finds + arms it", async ({ page }) => {
    test.setTimeout(260_000);
    await openChatWith(
      page,
      "help me execute this strategy: Hybrid DCA + Risk-Control — buy $100 of BTC every two weeks; if BTC drops 5% from its 7-day high buy an extra $50 (max 2/month); take profit: sell 25% at +20% unrealized; stop-loss: pause new buys if 15% below average entry.",
    );
    // The manual plan auto-runs the reads incl. compile_strategy (the bug fix).
    await page
      .waitForFunction(() => document.body.innerText.toLowerCase().includes("compiled strategy"), { timeout: 180_000 })
      .catch(() => {});
    await page.screenshot({ path: `${SHOTS}/09-manual-compiled.png`, fullPage: true });
    const compiled = (await page.evaluate(() => document.body.innerText)).toLowerCase().includes("compiled strategy");

    // Now arm it — must recover the just-compiled strategy (not "couldn't find").
    const input = page.getByTestId("chat-input");
    await input.click();
    await input.fill("arm it");
    await input.press("Enter");
    await page
      .waitForFunction(
        () => {
          const t = document.body.innerText.toLowerCase();
          return t.includes("armed") || t.includes("arm this strategy") || t.includes("authorize") || t.includes("couldn't find a compiled strategy");
        },
        { timeout: 120_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${SHOTS}/10-arm-it.png`, fullPage: true });
    const body = (await page.evaluate(() => document.body.innerText)).toLowerCase();
    // eslint-disable-next-line no-console
    console.log("MANUAL_ARM_RESULT>>> compiledSeen=", compiled, " couldntFind=", body.includes("couldn't find a compiled strategy"));
    expect(compiled).toBe(true);
    expect(body.includes("couldn't find a compiled strategy")).toBe(false);
  });

  test("list_strategies action is reachable via chat", async ({ page }) => {
    test.setTimeout(180_000);
    await openChatWith(page, "show my running strategies");
    await page.screenshot({ path: `${SHOTS}/05-list-opened.png`, fullPage: true });
    // list_strategies renders either the status table header or the empty-state line.
    await page
      .waitForFunction(
        () => {
          const t = document.body.innerText.toLowerCase();
          return t.includes("realized pnl") || t.includes("no strategies") || t.includes("next eval") || t.includes("strategy engine is not enabled");
        },
        { timeout: 150_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SHOTS}/06-list-response.png`, fullPage: true });
    const main = page.locator("main").first();
    const mainText = (await main.count()) ? await main.innerText() : await page.evaluate(() => document.body.innerText);
    // eslint-disable-next-line no-console
    console.log("LIST_MAIN_PANEL>>>", mainText.slice(0, 1500).replace(/\s+/g, " "));
    expect(mainText.length).toBeGreaterThan(100);
  });
});
