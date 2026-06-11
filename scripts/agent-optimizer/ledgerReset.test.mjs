import test from "node:test";
import assert from "node:assert/strict";
import { PAPER_LEDGER_COLLECTIONS, clearPaperLedger } from "./ledgerReset.mjs";

// GEAP §8 — paper-ledger reset is HARD-SCOPED: only the three paper collections, only by userId,
// and never a blanket wipe.

function mockDb() {
    const calls = [];
    return {
        calls,
        collection: (name) => ({
            deleteMany: async (filter) => {
                calls.push({ name, filter });
                return { deletedCount: name === "paper_orders" ? 2 : 0 };
            },
        }),
    };
}

test("clearPaperLedger deletes ONLY the 3 paper collections, scoped by userId", async () => {
    const db = mockDb();
    const counts = await clearPaperLedger(db, "u-123");
    assert.deepEqual(db.calls.map((c) => c.name).sort(), [...PAPER_LEDGER_COLLECTIONS].sort());
    for (const c of db.calls) assert.deepEqual(c.filter, { userId: "u-123" }); // every delete is user-scoped
    assert.equal(counts.paper_orders, 2);
});

test("clearPaperLedger REFUSES to run without a userId (no blanket wipe)", async () => {
    const db = mockDb();
    await assert.rejects(() => clearPaperLedger(db, ""), /no blanket wipe/);
    await assert.rejects(() => clearPaperLedger(db, undefined), /no blanket wipe/);
    assert.equal(db.calls.length, 0); // nothing deleted
});

test("PAPER_LEDGER_COLLECTIONS is exactly the paper surfaces (no real-trade collections)", () => {
    assert.deepEqual(PAPER_LEDGER_COLLECTIONS, ["paper_orders", "paper_fills", "pending_orders_ledger"]);
});
