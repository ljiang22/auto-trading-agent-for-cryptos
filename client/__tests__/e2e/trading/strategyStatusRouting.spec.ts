import { test, expect, type Page } from "@playwright/test";

/**
 * Regression: "show me the running strategy" (and variants) must execute
 * list_strategies (a status read), NOT freelance a strategy *suggestion*.
 * Root cause: single-step strategy plans fell through to the legacy LLM, which
 * regenerated suggestions. Fix routes strategy actions through the plan runner.
 */
const SHOTS = "/tmp/pw-screens";

async function ask(page: Page, prompt: string) {
  await page.goto("/", { waitUntil: "domcontentloaded" });
  const landing = page.locator('[data-tour="landing-search"]');
  await expect(landing).toBeVisible({ timeout: 20_000 });
  await landing.click();
  await landing.fill(prompt);
  await landing.press("Enter");
  await expect(page.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 });
}

async function mainLower(page: Page): Promise<string> {
  const main = page.locator("main").first();
  return ((await main.count()) ? await main.innerText() : await page.evaluate(() => document.body.innerText)).toLowerCase();
}

// Markers that ONLY appear in a freelanced strategy *suggestion* (the bug).
const SUGGESTION_MARKERS = ["recommended strategy", "alternative strateg", "entry rules", "i recommend", "take-profit rules", "general risk management"];
// Markers of a real list_strategies status answer — either the plan card that
// executed the action (`list_strategies` step) or a natural-language status.
const STATUS_MARKERS = ["list_strategies", "no active", "no strategies", "no running", "currently running", "running strategies", "realized pnl", "armed", "next eval"];

for (const prompt of ["show me the running strategy", "show me my running strategies", "what strategies are running"]) {
  test(`"${prompt}" returns a status, not a suggestion`, async ({ page }) => {
    test.setTimeout(180_000);
    await ask(page, prompt);
    await page
      .waitForFunction(
        (markers) => {
          const t = (document.querySelector("main")?.innerText ?? "").toLowerCase();
          return markers.some((m) => t.includes(m));
        },
        [...STATUS_MARKERS, ...SUGGESTION_MARKERS],
        { timeout: 150_000 },
      )
      .catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: `${SHOTS}/routing-${prompt.replace(/[^a-z]+/gi, "-")}.png`, fullPage: true });
    const t = await mainLower(page);
    // eslint-disable-next-line no-console
    console.log(`ROUTING [${prompt}] >>>`, t.slice(-500).replace(/\s+/g, " "));
    const suggestionLeak = SUGGESTION_MARKERS.filter((m) => t.includes(m));
    const statusHit = STATUS_MARKERS.some((m) => t.includes(m));
    expect(suggestionLeak, `freelanced a suggestion: ${suggestionLeak.join(", ")}`).toEqual([]);
    expect(statusHit, "expected a list_strategies status answer").toBe(true);
  });
}
