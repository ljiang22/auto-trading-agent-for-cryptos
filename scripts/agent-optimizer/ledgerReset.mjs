/**
 * GEAP §8 Auto-Optimizer — paper-ledger reset (TEST HYGIENE).
 *
 * Root cause found while driving live runs (2026-06-10): scenario_01's step-5 status check calls
 * get_orders, which returns the user's ENTIRE accumulated paper ledger. Orders left over from prior
 * runs make the status-related criticals (canExplainTrades / validatesModifiedStrategy /
 * noSilentStrategyChange) fail on phantom orders — corrupting the optimizer's behavioral floor so it
 * can never adopt. Resetting the user's PAPER ledger before each evaluation makes the status check
 * reflect ONLY the current conversation.
 *
 * Hard-scoped for safety: only the three paper collections, only by the given userId, and it REFUSES
 * to run without a userId (never a blanket wipe). Paper data only — never a real exchange.
 */

export const PAPER_LEDGER_COLLECTIONS = ["paper_orders", "paper_fills", "pending_orders_ledger"];

/**
 * Delete one user's paper-ledger docs. Returns per-collection delete counts.
 * @param {{ collection: (name:string) => { deleteMany: (filter:object)=>Promise<{deletedCount:number}> } }} db
 * @param {string} userId
 */
export async function clearPaperLedger(db, userId) {
    if (!userId || typeof userId !== "string") {
        throw new Error("clearPaperLedger: refusing to run without a userId (no blanket wipe)");
    }
    const counts = {};
    for (const name of PAPER_LEDGER_COLLECTIONS) {
        const r = await db.collection(name).deleteMany({ userId });
        counts[name] = r?.deletedCount ?? 0;
    }
    return counts;
}
