import { test, expect } from "@playwright/test";

/**
 * F10.2 — one-click "Compose a trade" dialog.
 *
 * The Trade button next to Send opens a dialog wearing the same
 * approval-modal chrome as `HumanInputDialog` (CONFIRM pill, "Compose &
 * Authorize Order" title, "Create Order" badge, optional venue chip,
 * embedded `TradingOrderEditor`, "I confirm…" checkbox, colored
 * "Confirm BUY/SELL" CTA). When the user clicks the CTA, the order is
 * submitted with `composedPreApproved: true` and the server skips
 * emitting a redundant `human_input_required` modal. Risk gating,
 * dep-health, idempotency, and quote-freshness recheck still gate the
 * payload server-side; the dialog only removes the second UI confirm.
 *
 * Pre-req: a chat agent is configured with paper-mode prefs.
 */

test.describe("F10.2 — Compose-trade pre-approved dialog", () => {
    test("opens approval chrome; one click submits without a second modal", async ({ page }) => {
        await page.goto("/agents");
        const agentCard = page.locator('[data-testid="agent-card"]').first();
        if (!(await agentCard.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, "no configured agent — skipping");
            return;
        }
        await agentCard.click();

        // Click Trade — the dialog should mount immediately, no server hit.
        await page.locator('[data-testid="chat-trade-compose"]').click();

        const dialog = page.locator('[data-testid="manual-compose-dialog"]');
        await expect(dialog).toBeVisible({ timeout: 3_000 });

        // Chrome assertions — these are the load-bearing differences from
        // the prior "Compose a trade" / "Use this trade" scaffold.
        await expect(dialog.locator("text=CONFIRM")).toBeVisible();
        await expect(dialog.locator("text=Compose & Authorize Order")).toBeVisible();
        await expect(
            dialog.locator("text=Edit any parameter, check the box, and submit to execute."),
        ).toBeVisible();
        await expect(dialog.locator("text=Create Order")).toBeVisible();
        await expect(
            dialog.locator("text=I confirm these inputs are correct and authorize this action."),
        ).toBeVisible();

        // The legacy "WILL SEND" preview block and "Use this trade" CTA
        // are gone — assert both as negative checks so a regression
        // would land them back here.
        await expect(dialog.locator("text=WILL SEND")).toHaveCount(0);
        await expect(dialog.locator("text=Use this trade")).toHaveCount(0);

        // Editor renders inline so the same fields the approval modal
        // shows live here too.
        await expect(dialog.locator('[data-testid="trading-order-editor"]')).toBeVisible();

        // CTA is disabled until the user ticks "I confirm…".
        const cta = page.locator('[data-testid="compose-confirm-submit"]');
        await expect(cta).toBeDisabled();

        // Tick the checkbox — CTA enables only after the form has a
        // valid size, so we fill enough to satisfy `canSubmit` first.
        // The default seed (BTC-USDT, BUY) lets us just fill Price +
        // Amount and tick the box.
        const priceInput = dialog.locator('input[aria-label*="Price"], input[placeholder*="Price"]').first();
        const amountInput = dialog.locator('input[aria-label*="Amount"], input[placeholder*="Amount"]').first();
        if (await priceInput.isVisible({ timeout: 1_500 }).catch(() => false)) {
            await priceInput.fill("75000");
        }
        if (await amountInput.isVisible({ timeout: 1_500 }).catch(() => false)) {
            await amountInput.fill("0.001");
        }
        await page.locator('[data-testid="compose-confirm-checkbox"]').click();

        // CTA label is venue-canonical and side-colored.
        await expect(cta).toHaveText(/Confirm BUY/i);

        await cta.click();

        // The dialog closes, the chat transcript captures the
        // user-visible NL preview, and crucially the second
        // human_input_required modal must NEVER appear. We poll for a
        // reasonable window then assert absence.
        await expect(dialog).toBeHidden({ timeout: 3_000 });
        await page.waitForTimeout(2_000);
        await expect(page.locator('[data-testid="human-input-dialog"]')).toHaveCount(0);
    });

    test("validation gate keeps Confirm BUY disabled when fields are blocking", async ({ page }) => {
        await page.goto("/agents");
        const agentCard = page.locator('[data-testid="agent-card"]').first();
        if (!(await agentCard.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, "no configured agent — skipping");
            return;
        }
        await agentCard.click();

        await page.locator('[data-testid="chat-trade-compose"]').click();
        const dialog = page.locator('[data-testid="manual-compose-dialog"]');
        await expect(dialog).toBeVisible({ timeout: 3_000 });

        // Without filling size, ticking the checkbox alone must not
        // enable the CTA — `canSubmit` requires either base_size or
        // quote_size in the order_configuration.
        await page.locator('[data-testid="compose-confirm-checkbox"]').click();
        const cta = page.locator('[data-testid="compose-confirm-submit"]');
        await expect(cta).toBeDisabled();
    });

    test("F10.5 — venue toggle shows Binance + Coinbase chips and switches active styling", async ({ page }) => {
        await page.goto("/agents");
        const agentCard = page.locator('[data-testid="agent-card"]').first();
        if (!(await agentCard.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, "no configured agent — skipping");
            return;
        }
        await agentCard.click();

        await page.locator('[data-testid="chat-trade-compose"]').click();
        const dialog = page.locator('[data-testid="manual-compose-dialog"]');
        await expect(dialog).toBeVisible({ timeout: 3_000 });

        const toggle = dialog.locator('[data-testid="compose-venue-toggle"]');
        await expect(toggle).toBeVisible();

        const binance = dialog.locator('[data-testid="compose-venue-binance"]');
        const coinbase = dialog.locator('[data-testid="compose-venue-coinbase"]');
        await expect(binance).toBeVisible();
        await expect(coinbase).toBeVisible();

        // One chip is active (aria-pressed=true) — defaults to Binance
        // when prefs.preferred_exchange is unset.
        await expect(binance).toHaveAttribute("aria-pressed", "true");
        await expect(coinbase).toHaveAttribute("aria-pressed", "false");

        // Switching flips aria-pressed and triggers the snapshot
        // re-fetch on the next render.
        await coinbase.click();
        await expect(coinbase).toHaveAttribute("aria-pressed", "true");
        await expect(binance).toHaveAttribute("aria-pressed", "false");
    });

    test("F10.5 — symbol-mismatch banner suppressed when no user assets to verify against", async ({ page }) => {
        await page.goto("/agents");
        const agentCard = page.locator('[data-testid="agent-card"]').first();
        if (!(await agentCard.isVisible({ timeout: 5_000 }).catch(() => false))) {
            test.skip(true, "no configured agent — skipping");
            return;
        }
        await agentCard.click();

        // Compose dialog passes promptText: "" to the market-snapshot
        // endpoint; server returns matches=false with reason
        // "no_user_assets_mentioned". The banner must STAY HIDDEN.
        await page.locator('[data-testid="chat-trade-compose"]').click();
        const dialog = page.locator('[data-testid="manual-compose-dialog"]');
        await expect(dialog).toBeVisible({ timeout: 3_000 });

        // Wait for the first market-snapshot poll to resolve.
        await page.waitForTimeout(2_000);

        await expect(
            dialog.locator('[data-testid="cex-symbol-mismatch-banner"]'),
        ).toHaveCount(0);
    });
});
