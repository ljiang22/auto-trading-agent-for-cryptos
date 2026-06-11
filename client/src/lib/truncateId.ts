/**
 * Display form for order / trade / client IDs in tables.
 * Paper venue IDs are shown in full; all others show only the last 4
 * characters with a leading ellipsis. The full value is always available
 * for copy-to-clipboard at the call site.
 */
export function displayId(value: string): string {
    if (value.startsWith("paper-")) return value;
    return value.length > 4 ? `…${value.slice(-4)}` : value;
}
