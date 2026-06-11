# Balance Table Alignment & Polish — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the visual misalignment between headers and numeric values in CEX wallet-balance markdown tables, and add polish (asset chips, even-row striping, H3 section dividers) so the rendered output reads as a clean, organized balance view.

**Architecture:** Single-file change to `client/src/components/MarkdownRenderer.tsx`. Two new React contexts (`ColumnAlignContext` for per-column right/left alignment, `ColumnIndexContext` for the current cell's column index) replace the brittle TH-keyword regex with column-aware alignment derived from the actual data. The same file gains a `KNOWN_TICKERS` allowlist + asset-chip render, an `even:bg-muted/30` zebra rule on `CustomTR`, and a Tailwind arbitrary variant on the wrapper that gives second-and-later H3s a top divider.

**Tech Stack:** React 19, TypeScript 5.6, `markdown-to-jsx` 7.7, Tailwind 3.4, Biome (linter/formatter), Vite (build).

**Branch:** `fix/balance-table-alignment` (off `origin/staging`, already created).

**Spec:** [docs/superpowers/specs/2026-05-23-balance-table-alignment-design.md](../specs/2026-05-23-balance-table-alignment-design.md)

---

## Task 1: Add the two React contexts and the column-scan helper

**Files:**
- Modify: `client/src/components/MarkdownRenderer.tsx` (add new code near the top, before `CustomTable`)

- [ ] **Step 1: Inspect the current state of the file**

Read `client/src/components/MarkdownRenderer.tsx` lines 1-40 to see the existing imports. Confirm `React` is already imported (it is, see existing `React.FC`, `React.useMemo`, `React.useState` usages).

- [ ] **Step 2: Add types and contexts above the existing `CustomParagraph` declaration (around line 193)**

Insert:

```tsx
type ColumnAlign = "left" | "right";

const ColumnAlignContext = React.createContext<readonly ColumnAlign[] | null>(null);
const ColumnIndexContext = React.createContext<number>(-1);

const KNOWN_TICKERS = new Set([
    "BTC", "ETH", "USDT", "USDC", "BUSD", "FDUSD", "TUSD",
    "DOGE", "SOL", "BNB", "XRP", "ADA", "AVAX", "DOT", "LINK", "MATIC",
    "LTC", "BCH", "ETC", "ATOM", "NEAR", "ARB", "OP", "TON",
]);

const NUMERIC_CELL_REGEX = /^[+-]?(?:\d+(?:,\d{3})*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Walk the React children of a <table> produced by markdown-to-jsx and
 * decide, per column, whether body cells are predominantly numeric.
 *
 * Returns an array of ColumnAlign whose length matches the number of
 * <th> cells in the table's <thead>. Returns [] for malformed tables
 * (no thead / no tbody), in which case TH/TD fall back to their legacy
 * keyword/regex heuristic — same behavior as before this change.
 *
 * Threshold: a column is "right" when at least 80% of its non-empty
 * body cells parse as finite numbers. The 80% slack tolerates the
 * occasional "—" placeholder for missing USD price.
 */
function scanColumns(tableChildren: React.ReactNode): ColumnAlign[] {
    // markdown-to-jsx always emits a table as `[<thead>...</thead>, <tbody>...</tbody>]`
    // (the GFM table parser produces exactly those two children, in that order).
    // We don't try to detect by `child.type` because the overrides replace
    // `thead`/`tbody` with `CustomTHead`/`CustomTBody`, and those components have
    // no displayName set — type-based detection would require coupling scanColumns
    // to component identifiers defined later in the file. Position-based access
    // is robust against the override system and unaffected by re-orderings of
    // helper definitions in this file.
    const tableKids = React.Children.toArray(tableChildren).filter(React.isValidElement);
    if (tableKids.length < 2) return [];

    const thead = tableKids[0] as React.ReactElement<{ children?: React.ReactNode }>;
    const tbody = tableKids[1] as React.ReactElement<{ children?: React.ReactNode }>;

    const theadRows = React.Children.toArray(thead.props.children).filter(React.isValidElement);
    if (theadRows.length === 0) return [];

    const headRow = theadRows[0] as React.ReactElement<{ children?: React.ReactNode }>;
    const columnCount = React.Children.count(headRow.props.children);
    if (columnCount === 0) return [];

    const bodyRows = React.Children.toArray(tbody.props.children).filter(React.isValidElement);
    const numeric: number[] = new Array(columnCount).fill(0);
    const nonEmpty: number[] = new Array(columnCount).fill(0);

    for (const row of bodyRows) {
        const rowEl = row as React.ReactElement<{ children?: React.ReactNode }>;
        const cells = React.Children.toArray(rowEl.props.children);
        for (let col = 0; col < columnCount && col < cells.length; col++) {
            const text = extractText(cells[col]).trim();
            if (!text) continue;
            nonEmpty[col]++;
            if (NUMERIC_CELL_REGEX.test(text) && Number.isFinite(Number.parseFloat(text.replace(/,/g, "")))) {
                numeric[col]++;
            }
        }
    }

    const aligns: ColumnAlign[] = new Array(columnCount).fill("left");
    for (let col = 0; col < columnCount; col++) {
        if (nonEmpty[col] > 0 && numeric[col] / nonEmpty[col] >= 0.8) {
            aligns[col] = "right";
        }
    }
    return aligns;
}
```

- [ ] **Step 3: TypeScript-check the file**

Run: `cd /home/leon26/projects/sentiedge-projects/senti-agent-0428/client && npx tsc -b --noEmit 2>&1 | head -30`
Expected: PASS (no errors). The contexts/helpers are pure additions, no existing code references them yet.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/MarkdownRenderer.tsx
git commit -m "feat(markdown): add column-align contexts + scanColumns helper

No behavioral change yet — the contexts are not consumed by any
component in this commit. Follow-up commits wire them into
CustomTable / CustomTR / CustomTH / CustomTD."
```

---

## Task 2: Wire `CustomTable` to scan and provide both contexts

**Files:**
- Modify: `client/src/components/MarkdownRenderer.tsx` (existing `CustomTable` around line 314-331)

- [ ] **Step 1: Replace the existing `CustomTable` definition**

Find:

```tsx
const CustomTable: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <div className="overflow-x-auto my-4 rounded-lg border border-border/40 dark:border-white/10 bg-background shadow-sm">
        {/*
          Round-6 polish: tables in chat bubbles compressed columns
          tight enough that "Original Quantity" and "Executed Quantity"
          headers ran into each other and the Status badge sat flush
          against the numbers. Strategy: bump per-cell horizontal
          breathing room (handled in CustomTD / CustomTH below) AND
          give numeric columns right-alignment so the decimal points
          line up. `border-separate + border-spacing` would have
          worked too but breaks the row hover background; sticking
          with `border-collapse` and per-cell padding instead.
        */}
        <table className="w-full text-left text-sm border-collapse whitespace-nowrap">
            {children}
        </table>
    </div>
);
```

Replace with:

```tsx
const CustomTable: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const columnAligns = React.useMemo(() => scanColumns(children), [children]);
    return (
        <div className="overflow-x-auto my-4 rounded-lg border border-border/40 dark:border-white/10 bg-background shadow-sm">
            <ColumnAlignContext.Provider value={columnAligns.length ? columnAligns : null}>
                <table className="w-full text-left text-sm border-collapse whitespace-nowrap">
                    {children}
                </table>
            </ColumnAlignContext.Provider>
        </div>
    );
};
```

Note: the prior block-comment about Round-6 padding is removed — the explanation it carried is now stale relative to the column-aware logic. Keep a one-line replacement comment next to the alignment context only if the reviewer asks; default is no comment (CLAUDE.md guidance).

- [ ] **Step 2: TypeScript-check**

Run: `cd /home/leon26/projects/sentiedge-projects/senti-agent-0428/client && npx tsc -b --noEmit 2>&1 | head -30`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/MarkdownRenderer.tsx
git commit -m "feat(markdown): CustomTable provides ColumnAlignContext

scanColumns runs once per table render (memoized on children).
Provided value is null for malformed tables, letting TH/TD fall
back to the legacy keyword heuristic."
```

---

## Task 3: Wire `CustomTR` to provide each cell's column index

**Files:**
- Modify: `client/src/components/MarkdownRenderer.tsx` (existing `CustomTR` around line 475-507)

- [ ] **Step 1: Update `CustomTR` to wrap each child with the column-index provider AND add zebra striping**

Find the entire `const CustomTR: React.FC<...> = ({ children }) => { ... };` block.

Replace its body so each TR maps over its children and wraps each one in a `ColumnIndexContext.Provider`. The cancel-button injection logic must stay intact and unchanged. Add `even:bg-muted/30 dark:even:bg-white/[0.02]` to both className strings.

Replacement:

```tsx
const CustomTR: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const { orderId, isOpen, venue, productId } = scanRowForCancelable(children);
    const showCancel = !!orderId && isOpen;

    const childArray = React.Children.toArray(children);
    const indexedChildren = childArray.map((child, index) => (
        <ColumnIndexContext.Provider key={index} value={index}>
            {child}
        </ColumnIndexContext.Provider>
    ));

    const baseClass =
        "border-b border-border/40 dark:border-white/10 last:border-0 even:bg-muted/30 dark:even:bg-white/[0.02] hover:bg-muted/40 dark:hover:bg-white/[0.02] transition-colors";

    if (!showCancel) {
        return <tr className={baseClass}>{indexedChildren}</tr>;
    }

    return (
        <tr className={baseClass}>
            {indexedChildren}
            <td className="px-2 py-3 text-right align-middle whitespace-nowrap">
                <CancelOrderButton orderId={orderId!} venue={venue} productId={productId} />
            </td>
        </tr>
    );
};
```

Notes for the implementer:
- Use `React.Children.toArray(children)` (not `as React.ReactElement[]`) because the children include strings/`Fragment` boundaries from `markdown-to-jsx`. `.toArray` flattens them and assigns stable `_index` keys internally; the `key={index}` we add is the column index, which is what we want.
- The `else` branch's appended `<td>` for the Cancel chip is **outside** the wrapped children deliberately — it lives in its own bonus column with no header, matching today's behavior. We do not wrap it in a `ColumnIndexContext.Provider`, so its TD will read `-1` from context and skip column-aware alignment (which is correct — it's not part of the markdown's column layout).

- [ ] **Step 2: TypeScript-check**

Run: `cd /home/leon26/projects/sentiedge-projects/senti-agent-0428/client && npx tsc -b --noEmit 2>&1 | head -30`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/MarkdownRenderer.tsx
git commit -m "feat(markdown): CustomTR provides per-cell column index

Each <th>/<td> child is wrapped in ColumnIndexContext so the cell
can look up its column's alignment from ColumnAlignContext.

Also adds even-row zebra striping (subtle bg-muted/30) for
balance/orders tables. Cancel-chip injection logic unchanged."
```

---

## Task 4: Update `CustomTH` to consume column alignment

**Files:**
- Modify: `client/src/components/MarkdownRenderer.tsx` (existing `CustomTH` around line 509-527)

- [ ] **Step 1: Replace `CustomTH` body**

Find:

```tsx
const CustomTH: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    // Round-6: headers needed the same `px-5` breathing room as body
    // cells (was `px-4`) — without it labels like "Original Quantity"
    // and "Executed Quantity" sat too close on narrow chat-bubble
    // tables. Tracking-tighter + slight uppercase styling makes the
    // header row visually distinct from data without taking extra
    // vertical space.
    const text = extractText(children);
    const looksNumericHeader =
        /\b(price|quantity|qty|size|amount|value|notional|leverage|fee)\b/i.test(text);
    const align = looksNumericHeader ? "text-right" : "text-left";
    return (
        <th
            className={`px-5 py-3 text-[11px] font-semibold tracking-wide uppercase text-muted-foreground border-b border-border/50 dark:border-white/10 whitespace-nowrap ${align}`}
        >
            {children}
        </th>
    );
};
```

Replace with:

```tsx
const CustomTH: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const columnAligns = React.useContext(ColumnAlignContext);
    const columnIndex = React.useContext(ColumnIndexContext);

    let align: "text-left" | "text-right";
    if (columnAligns && columnIndex >= 0 && columnIndex < columnAligns.length) {
        align = columnAligns[columnIndex] === "right" ? "text-right" : "text-left";
    } else {
        const text = extractText(children);
        const looksNumericHeader =
            /\b(price|quantity|qty|size|amount|value|notional|leverage|fee)\b/i.test(text);
        align = looksNumericHeader ? "text-right" : "text-left";
    }

    return (
        <th
            className={`px-5 py-3 text-[11px] font-semibold tracking-wide uppercase text-muted-foreground border-b border-border/50 dark:border-white/10 whitespace-nowrap ${align}`}
        >
            {children}
        </th>
    );
};
```

- [ ] **Step 2: TypeScript-check**

Run: `cd /home/leon26/projects/sentiedge-projects/senti-agent-0428/client && npx tsc -b --noEmit 2>&1 | head -30`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/MarkdownRenderer.tsx
git commit -m "feat(markdown): CustomTH reads column alignment from context

Column-derived alignment now wins over the keyword regex.
Regex remains as a fallback for malformed tables (where
scanColumns returned [])."
```

---

## Task 5: Update `CustomTD` to consume column alignment and render asset chips

**Files:**
- Modify: `client/src/components/MarkdownRenderer.tsx` (existing `CustomTD` around line 656-691)

- [ ] **Step 1: Replace `CustomTD` body**

Find:

```tsx
const CustomTD: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const text = extractText(children);
    const cls = classifyCellValue(text);
    let inner: React.ReactNode = children;

    const isNumeric = /^[0-9.,]+$/.test(text.trim());

    if (cls.kind === "side" && cls.normalized) {
        inner = <SideBadge value={cls.normalized} />;
    } else if (cls.kind === "status" && cls.normalized) {
        inner = <StatusBadge value={cls.normalized} />;
    } else if ((cls.kind === "uuid" || cls.kind === "long_id") && cls.normalized) {
        inner = <TruncatedId value={cls.normalized} />;
    } else if (isNumeric) {
        const pretty = formatTradingNumber(text);
        inner = (
            <span className="font-mono text-[13px] tabular-nums">
                {pretty ?? children}
            </span>
        );
    }
    // Round-6: numeric cells right-align so columns of decimals line
    // up at the decimal point; status/side badges stay left-aligned so
    // the badge sits at the natural column start. Per-cell horizontal
    // padding bumped from `px-4` to `px-5` so adjacent columns don't
    // run into each other inside the in-chat bubble width.
    const isBadgeCell = cls.kind === "side" || cls.kind === "status";
    const align = isNumeric && !isBadgeCell ? "text-right" : "text-left";
    return (
        <td
            className={`px-5 py-3 text-[13px] text-foreground/90 whitespace-nowrap ${align}`}
        >
            {inner}
        </td>
    );
};
```

Replace with:

```tsx
const CustomTD: React.FC<{ children: React.ReactNode }> = ({ children }) => {
    const columnAligns = React.useContext(ColumnAlignContext);
    const columnIndex = React.useContext(ColumnIndexContext);

    const text = extractText(children);
    const trimmed = text.trim();
    const cls = classifyCellValue(text);
    let inner: React.ReactNode = children;

    const isNumeric = /^[0-9.,]+$/.test(trimmed);
    const isAssetChip =
        columnIndex === 0 &&
        trimmed.length >= 2 &&
        trimmed.length <= 6 &&
        KNOWN_TICKERS.has(trimmed.toUpperCase());

    if (cls.kind === "side" && cls.normalized) {
        inner = <SideBadge value={cls.normalized} />;
    } else if (cls.kind === "status" && cls.normalized) {
        inner = <StatusBadge value={cls.normalized} />;
    } else if ((cls.kind === "uuid" || cls.kind === "long_id") && cls.normalized) {
        inner = <TruncatedId value={cls.normalized} />;
    } else if (isAssetChip) {
        inner = (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded text-[12px] font-mono font-semibold tracking-tight bg-muted/60 text-foreground ring-1 ring-border/40">
                {trimmed.toUpperCase()}
            </span>
        );
    } else if (isNumeric) {
        const pretty = formatTradingNumber(text);
        inner = (
            <span className="font-mono text-[13px] tabular-nums">
                {pretty ?? children}
            </span>
        );
    }

    const isBadgeCell = cls.kind === "side" || cls.kind === "status";
    let align: "text-left" | "text-right";
    if (columnAligns && columnIndex >= 0 && columnIndex < columnAligns.length && !isBadgeCell) {
        align = columnAligns[columnIndex] === "right" ? "text-right" : "text-left";
    } else {
        align = isNumeric && !isBadgeCell ? "text-right" : "text-left";
    }

    return (
        <td
            className={`px-5 py-3 text-[13px] text-foreground/90 whitespace-nowrap ${align}`}
        >
            {inner}
        </td>
    );
};
```

Notes:
- Asset chip only fires when `columnIndex === 0` so a stray "BTC" in a description column elsewhere doesn't get chipped.
- Badge cells (side / status) keep the legacy `text-left` regardless of column alignment — badges have their own visual layout that the right-align would skew.
- The fallback path (no column alignment available) preserves the exact behavior the file had before this change.

- [ ] **Step 2: TypeScript-check**

Run: `cd /home/leon26/projects/sentiedge-projects/senti-agent-0428/client && npx tsc -b --noEmit 2>&1 | head -30`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add client/src/components/MarkdownRenderer.tsx
git commit -m "feat(markdown): CustomTD column-aware alignment + asset chip

Numeric cells line up under their numeric headers because both
read alignment from the same ColumnAlignContext.

Asset tickers in column 0 render as a small mono chip when the
text matches the KNOWN_TICKERS allowlist (BTC/ETH/USDT/...).
Falls through to plain text for any unrecognised ticker."
```

---

## Task 6: Add H3 section dividers via Tailwind arbitrary variant

**Files:**
- Modify: `client/src/components/MarkdownRenderer.tsx` (existing `MarkdownRenderer` wrapper around line 756-779)

- [ ] **Step 1: Locate the wrapper div className**

Find:

```tsx
    return (
        <div
            className={cn(
                "w-full max-w-full break-words whitespace-pre-wrap [overflow-wrap:anywhere] min-w-0 overflow-hidden",
                className
            )}
        >
            <Markdown options={options}>
                {normalized}
            </Markdown>
        </div>
    );
```

- [ ] **Step 2: Append the H3-divider arbitrary variant to the className**

Replace with:

```tsx
    return (
        <div
            className={cn(
                "w-full max-w-full break-words whitespace-pre-wrap [overflow-wrap:anywhere] min-w-0 overflow-hidden",
                "[&_h3:not(:first-of-type)]:mt-6 [&_h3:not(:first-of-type)]:pt-3 [&_h3:not(:first-of-type)]:border-t [&_h3:not(:first-of-type)]:border-border/30",
                className
            )}
        >
            <Markdown options={options}>
                {normalized}
            </Markdown>
        </div>
    );
```

- [ ] **Step 3: TypeScript-check**

Run: `cd /home/leon26/projects/sentiedge-projects/senti-agent-0428/client && npx tsc -b --noEmit 2>&1 | head -30`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add client/src/components/MarkdownRenderer.tsx
git commit -m "feat(markdown): H3 section divider for second-and-later headings

Wallet sections (### Spot Wallet / ### Funding Wallet / ###
Cross Margin) emitted by the get_balance template now read as
separate visual blocks. The variant only applies to H3s after
the first, so messages with a single H3 are unchanged."
```

---

## Task 7: Full build + lint gate

**Files:**
- None (verification only)

- [ ] **Step 1: Run the client build**

Run: `cd /home/leon26/projects/sentiedge-projects/senti-agent-0428 && pnpm --filter client build 2>&1 | tail -30`
Expected: build succeeds. No TypeScript errors, no Vite errors. A line like `✓ built in <N>ms`.

If the build fails, fix and recommit. Do not proceed until clean.

- [ ] **Step 2: Run the lint check**

Run: `cd /home/leon26/projects/sentiedge-projects/senti-agent-0428 && pnpm lint 2>&1 | tail -30`
Expected: Biome reports no errors. The Round-6 comment removal and the new code should be Biome-clean (double quotes, semicolons, tabs/spaces match existing file style).

If lint fails, run `pnpm check` to auto-fix, then recommit.

- [ ] **Step 3: Inspect the final diff**

Run: `cd /home/leon26/projects/sentiedge-projects/senti-agent-0428 && git diff origin/staging -- client/src/components/MarkdownRenderer.tsx | head -200`

Manually confirm:
- `scanRowForCancelable` is unchanged.
- `CancelOrderButton` is unchanged.
- `classifyCellValue` / `SideBadge` / `StatusBadge` / `TruncatedId` / `formatTradingNumber` are unchanged.
- The contexts, `KNOWN_TICKERS`, and `scanColumns` are pure additions.

- [ ] **Step 4: Push the branch**

Run: `cd /home/leon26/projects/sentiedge-projects/senti-agent-0428 && git push -u origin fix/balance-table-alignment`
Expected: branch is published; remote tracking confirmed.

Do NOT open a PR in this task — manual visual check happens first (Task 8).

---

## Task 8: Manual visual verification

**Files:**
- None (browser session against local dev server)

- [ ] **Step 1: Start the agent + client**

Two terminals from the repo root:
```bash
pnpm start
pnpm start:client
```

Wait for both to be ready. Open `http://localhost:5173` in the browser.

- [ ] **Step 2: Sign in and test the balance flow**

In the chat, send: `what is my balance`

Confirm visually:
- **Spot Wallet** section shows numeric values directly under the FREE, LOCKED, EST. USD headers — no horizontal drift.
- Asset cells (BTC, ETH, USDT, …) appear as a small monospace chip with a thin outline.
- A thin top divider sits between Spot Wallet, Funding Wallet, and Cross Margin sections.
- Alternating data rows have a faint background tint (zebra striping).

If alignment is still off in any section, re-inspect `scanColumns` — likely a malformed `<thead>`/`<tbody>` shape that `markdown-to-jsx` produced differently than expected. Add a debug `console.log(columnAligns)` inside `CustomTable` and re-test.

- [ ] **Step 3: Regression-test open orders**

Send: `show my open orders`

Confirm visually:
- SIDE column still shows colored BUY/SELL badges.
- STATUS column still shows colored NEW/FILLED/PARTIAL/CANCELLED badges.
- The order-ID column still renders as a truncated copy-on-click chip.
- The Cancel chip still appears on rows whose status is OPEN/NEW/PENDING/PARTIAL.
- Column alignment is unchanged relative to the pre-fix screenshots stored in `/home/leon26/projects/sentiedge-projects/staging-orders-table-with-badges.png` (or whatever the team's reference is). The orders table has trading keywords in its headers and now also has numeric columns — both heuristics agree, so alignment should be visually identical to before.

- [ ] **Step 4: Optional — capture a fresh screenshot**

Take a screenshot of the balance view to attach to the PR description: `<screenshot tool of choice>`. Save to `/home/leon26/projects/sentiedge-projects/balance-aligned-2026-05-23.png`.

- [ ] **Step 5: If all checks pass, open the PR**

Run from repo root:
```bash
gh pr create --base staging --title "fix(markdown): column-aware alignment + balance-table polish" --body "$(cat <<'EOF'
## Summary
- Replace the brittle TH-keyword regex with column-aware alignment: scanColumns walks the table and infers right vs left per column from data.
- Add asset chips for column-0 tickers (BTC, ETH, USDT, ...), even-row zebra striping, and H3 section dividers for the get_balance markdown output.
- Surgical change to client/src/components/MarkdownRenderer.tsx only. No server or template changes.

## Visual evidence
Before / after screenshots of the Spot / Funding / Cross Margin tables.

## Test plan
- [x] pnpm --filter client build (typecheck + bundle)
- [x] pnpm lint
- [x] Manual: "what is my balance" — columns line up, asset chips render, sections separated.
- [x] Regression: "show my open orders" — badges, copy chip, and Cancel chip all unchanged.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

---

## Self-review against the spec

The spec is the source of truth. Each requirement maps to a task:

| Spec requirement | Implementing task |
|---|---|
| `ColumnAlignContext` + `ColumnIndexContext` introduced | Task 1 |
| `scanColumns` with 80% threshold + 0-row fallback | Task 1 |
| `CustomTable` provides `ColumnAlignContext` | Task 2 |
| `CustomTR` provides `ColumnIndexContext` per cell | Task 3 |
| `CustomTH` reads column alignment, falls back to keyword regex | Task 4 |
| `CustomTD` reads column alignment, falls back to numeric-cell regex | Task 5 |
| `KNOWN_TICKERS` allowlist + asset chip in column 0 | Tasks 1 + 5 |
| Zebra striping (`even:bg-muted/30`) on `CustomTR` | Task 3 |
| H3 section divider via Tailwind arbitrary variant | Task 6 |
| Cancel-button row scanner unchanged | Task 3 (preserved verbatim) |
| `pnpm build` + `pnpm lint` gate | Task 7 |
| Manual visual + regression checks | Task 8 |

No spec requirement is unallocated. No placeholders in this plan. Type names and signatures (`ColumnAlign`, `ColumnAlignContext`, `ColumnIndexContext`, `scanColumns`, `KNOWN_TICKERS`, `NUMERIC_CELL_REGEX`) are consistent across all tasks.
