# Balance Table Alignment & Polish — Design

**Date:** 2026-05-23
**Branch:** `fix/balance-table-alignment` (off `origin/staging`)
**Affected surface:** Chat-rendered markdown tables emitted by the CEX `get_balance` action (Spot, Funding, Cross Margin, Isolated Margin wallets).

## Problem

When a user asks "what is my balance", the agent emits a markdown table per wallet (schema defined in `packages/core/src/templates/cexMessageTemplate.ts`). The client renders these through `client/src/components/MarkdownRenderer.tsx`. In the rendered output:

- Headers `Free`, `Locked`, `Borrowed`, `Interest`, `Net`, `Est. USD` are **left-aligned**.
- Numeric data cells (`0.0011981`, `92.15`, …) are **right-aligned**.

In a full-width chat bubble each column is wide, so the header sits at the far left of its column while the value pins to the far right. Visually the value appears to be in the column *after* its header — e.g. `0.0011981` looks like it belongs under `LOCKED`, not `FREE`.

## Root cause

`MarkdownRenderer.tsx` has two independent per-cell heuristics:

- `CustomTH` (line 517–519) right-aligns headers matching a hard-coded regex: `price|quantity|qty|size|amount|value|notional|leverage|fee`. Wallet headers don't match → default `text-left`.
- `CustomTD` (line 683) right-aligns any cell whose extracted text is purely numeric.

The two heuristics don't agree about which columns are numeric — that's the bug.

## Design

### Approach: column-aware alignment

Instead of layering more keywords onto the TH regex (which would break the next time a new column header is added), we infer column type from the table's actual data and apply the same alignment to both header and body cells.

```
CustomTable(children)
  ├── columnAligns = scanColumns(children)  // string[] of "left"|"right" per column index
  └── <ColumnAlignContext.Provider value={columnAligns}>
        <ColumnIndexProvider>
          <table>{children}</table>
        </ColumnIndexProvider>
      </ColumnAlignContext.Provider>
```

**Two pieces of context**, both client-only and presentation-only:

1. `ColumnAlignContext`: array indexed by column position, value `"left" | "right"`. Computed once by `CustomTable`.
2. `ColumnIndexContext`: integer indicating *which column this cell belongs to*. Synthesized in `CustomTR` by walking its TH/TD children and wrapping each in an index-providing component.

### `scanColumns` algorithm

Input: the React children of `<table>` produced by `markdown-to-jsx`.

1. Find the `<thead>` element and count `<th>` children → `columnCount`.
2. Find the `<tbody>` element. For each `<tr>`, extract text of each `<td>` using the existing `extractText` helper.
3. For each column index `c` in `[0, columnCount)`:
   - `numericCount`: number of body cells whose trimmed text matches `/^[+-]?[\d.,e-]+$/` and parses to a finite number.
   - `nonEmptyCount`: number of body cells whose trimmed text is non-empty.
   - If `nonEmptyCount === 0` → fall back to header keyword heuristic for that column.
   - If `numericCount / nonEmptyCount >= 0.8` → `"right"`.
   - Else → `"left"`.
4. Return the array. Length is `columnCount`. Missing/malformed `<thead>`/`<tbody>` → return `[]`.

The 80% threshold tolerates the occasional `—` (em-dash) placeholder for missing USD prices without flipping a numeric column to left-align.

### Cell consumers

- `CustomTH(children)`:
  - Reads `columnIndex` from context.
  - Reads `align = aligns[columnIndex]`. If unavailable (length-0 array or out-of-range index), falls back to the **current** keyword regex — preserving order-table behaviour exactly.
  - Renders with the resolved alignment class.

- `CustomTD(children)`:
  - Reads `columnIndex` and `align` the same way.
  - If column-derived alignment is available, uses it; otherwise falls back to today's "is this cell numeric" check.
  - Badge cells (SIDE, STATUS, UUID, long_id) keep their existing left-align — those don't read alignment from context.

### Asset chip

The wallet tables' first column is always an asset ticker (`BTC`, `ETH`, `USDT`, `USDC`, `DOGE`, `SOL`, `BUSD`, `FDUSD`, `TUSD`). When `CustomTD` is rendering column `0` and the cell text matches a known-ticker allowlist (case-sensitive uppercase, length 2–6), render a lightweight chip:

```tsx
<span className="inline-flex items-center px-1.5 py-0.5 rounded text-[12px] font-mono font-semibold tracking-tight bg-muted/60 text-foreground ring-1 ring-border/40">
  {ticker}
</span>
```

This visually anchors the row without introducing color coding (BTC orange / ETH blue is out of scope — separate visual-identity decision).

The allowlist lives at the top of `MarkdownRenderer.tsx`:
```ts
const KNOWN_TICKERS = new Set([
  "BTC", "ETH", "USDT", "USDC", "BUSD", "FDUSD", "TUSD",
  "DOGE", "SOL", "BNB", "XRP", "ADA", "AVAX", "DOT", "LINK", "MATIC",
  "LTC", "BCH", "ETC", "ATOM", "NEAR", "ARB", "OP", "TON",
]);
```

If the chat ever shows a less common ticker, the cell falls through to plain text — no regression, just no chip.

### Section dividers + zebra striping

- **Section dividers**: applied via a Tailwind arbitrary variant on the `MarkdownRenderer` wrapper div, appended to the existing className string:

  ```
  [&_h3:not(:first-of-type)]:mt-6
  [&_h3:not(:first-of-type)]:pt-3
  [&_h3:not(:first-of-type)]:border-t
  [&_h3:not(:first-of-type)]:border-border/30
  ```

  Effect: the **second and subsequent** H3 inside a single rendered message gets a thin top divider and extra top margin. The wallet template already emits each wallet as its own `### Spot Wallet` / `### Funding Wallet` / `### Cross Margin` heading, so this naturally separates the sections without coupling the renderer to wallet-specific markup.

  **Trade-off accepted**: any markdown message with multiple H3s gets the divider. Daily analysis reports and news summaries already use H3 for section breaks, so the divider reads as a section separator there too. Documented under Risks below.

- **Zebra striping**: extend `CustomTR`'s className to include `even:bg-muted/30 dark:even:bg-white/[0.02]`. Pairs with the existing `hover:bg-muted/40` — hover wins over zebra on row interaction.

### Cancel-button row scanner — unchanged

`CustomTR` already runs `scanRowForCancelable` to inject a Cancel chip for open-order rows. Wallet rows can't trigger it:
- Their would-be order ID slot is an asset ticker like `BTC`, which fails both the UUID and `^[0-9]{9,}$` long-ID regex in `classifyCellValue`.
- Numeric balance cells like `0.0011981` are floats, also failing the long-ID regex.

No code change needed; the reviewer should verify by reading `CustomTR` is unchanged except for the added zebra-stripe class.

## Files changed

| File | Change type | Description |
|---|---|---|
| `client/src/components/MarkdownRenderer.tsx` | edit | Add two contexts, `scanColumns`, `KNOWN_TICKERS`, asset-chip renderer; update `CustomTable`, `CustomTR`, `CustomTH`, `CustomTD`. Add the `[&_h3:not(:first-of-type)]:mt-6 [&_h3:not(:first-of-type)]:pt-3 [&_h3:not(:first-of-type)]:border-t [&_h3:not(:first-of-type)]:border-border/30` modifier to the wrapper div. |

No server-side, template, or test-fixture changes. No DB or schema changes. No env vars.

## Testing

The `client/` package has Playwright e2e tests but **no unit-test infrastructure** (no Vitest, no @testing-library/react, no `test` script). Adding that infra is out of scope for this fix — it would more than double the diff and require a separate plumbing decision.

### Verification gate

1. **`pnpm --filter client build`** runs `tsc -b && vite build`. Must compile cleanly. This catches type errors in the new contexts and signatures.
2. **`pnpm lint`** at repo root. Biome must not flag the changes.
3. **Manual visual check** — author starts `pnpm start` + `pnpm start:client`, signs in, sends "what is my balance" in chat, and confirms:
   - Spot Wallet, Funding Wallet, Cross Margin headers and numeric values line up in their columns.
   - Asset cells (BTC, ETH, USDT, …) render as a small mono chip.
   - Wallet sections are separated by a thin top divider.
   - Even rows have a faint zebra-stripe background.
4. **Regression check** — in the same session, send a query that yields an Open Orders table (e.g., "show my open orders"). Confirm:
   - Side / Status badges still render.
   - The order-id cell still shows the truncated copy-on-click chip.
   - The Cancel chip still appears on rows with OPEN/NEW status.
5. **Code-review note** — reviewer should specifically check that `scanRowForCancelable` is **unchanged** and still runs first inside `CustomTR`.

Follow-up (out of scope for this PR): introduce Vitest + @testing-library/react under `client/`, and add unit fixtures for the wallet and orders tables. That belongs in its own infra PR.

## Out of scope (YAGNI)

- Replacing markdown-driven tables with a bespoke React `BalanceTable` component. The markdown contract is well-tested, generic, and serves multiple actions; column-aware alignment is the targeted fix.
- Asset icons / colored brand chips (BTC orange, ETH blue, etc.). Separate visual-identity question.
- Decimal-point alignment via CSS `text-align: "."`. Browser support is incomplete; tabular-nums + right-align gets us 99% of the way.
- Sticky table headers / horizontal scroll affordance. Wallet tables are short.

## Risks

- **Risk 1**: The 80% numeric threshold could mis-classify a column where the data column is dominated by `—` placeholders. Mitigation: `nonEmptyCount === 0 → header keyword fallback`. A column with mostly em-dashes will fall through to the keyword check, which is the current behavior.
- **Risk 2**: The H3-divider Tailwind modifier could affect non-wallet messages with multiple H3s. Mitigation noted above — current message shapes confirmed compatible.
- **Risk 3**: Asset-chip allowlist drift — new tokens listed on Binance/Coinbase won't get chipped. Mitigation: fall-through to plain text. Allowlist can be extended in a follow-up PR if needed.

## Migration / rollout

Single-PR change to client code only. No staged rollout, no feature flag, no migration. `pnpm build` + lint gate the merge; visual regression is the author's manual check.
