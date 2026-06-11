/**
 * MongoDB operations for the pending orders ledger.
 * Implements the LedgerOperations interface for tracking order states throughout their lifecycle.
 */

import type { Db, Collection } from "mongodb";
import type {
    LedgerOperations,
    PendingOrderLedgerRow,
    PendingOrderState,
    PendingOrderStateTransition,
} from "./types";

/**
 * Terminal states that prevent further transitions.
 * Orders in these states should not be updated.
 */
const TERMINAL_STATES = new Set<PendingOrderState>([
    "filled",
    "cancelled",
    "expired",
    "rejected",
    "reconciliation_failed",
]);

/**
 * Helper to get the pending_orders_ledger collection with proper typing.
 */
function collection(db: Db): Collection<PendingOrderLedgerRow> {
    return db.collection<PendingOrderLedgerRow>("pending_orders_ledger");
}

/**
 * Create a MongoDB-backed LedgerOperations implementation.
 * @param db - The MongoDB Db instance
 */
export function createMongoLedger(db: Db): LedgerOperations {
    return {
        async upsertPendingOrder(row: PendingOrderLedgerRow): Promise<void> {
            await collection(db).updateOne(
                { client_order_id: row.client_order_id },
                {
                    $set: {
                        state: row.state,
                        lastSeenAt: row.lastSeenAt,
                        latest_payload: row.latest_payload,
                    },
                    $setOnInsert: {
                        request_id: row.request_id,
                        intent_hash: row.intent_hash,
                        client_order_id: row.client_order_id,
                        venue: row.venue,
                        symbol: row.symbol,
                        userId: row.userId,
                        submittedAt: row.submittedAt,
                        locale: row.locale,
                    },
                },
                { upsert: true },
            );
        },

        async updateOrderState(
            transition: PendingOrderStateTransition,
        ): Promise<PendingOrderLedgerRow | null> {
            const now = new Date().toISOString();

            // Build the update object
            const updateFields: Record<string, unknown> = {
                state: transition.new_state,
                lastSeenAt: now,
                latest_payload: transition.payload,
            };

            // Optionally store the venue_order_id if provided
            if (transition.venue_order_id) {
                updateFields.venue_order_id = transition.venue_order_id;
            }

            const result = await collection(db).findOneAndUpdate(
                {
                    client_order_id: transition.client_order_id,
                    state: { $nin: Array.from(TERMINAL_STATES) },
                },
                { $set: updateFields },
                { returnDocument: "after" },
            );

            return result ?? null;
        },

        async getPendingOrderByClientOrderId(
            client_order_id: string,
        ): Promise<PendingOrderLedgerRow | null> {
            return collection(db).findOne({ client_order_id });
        },

        async getStaleSubmittedOrders(
            userId: string,
            staleAfterMs: number,
        ): Promise<PendingOrderLedgerRow[]> {
            const now = new Date();
            const staleThresholdTime = new Date(now.getTime() - staleAfterMs);

            return collection(db)
                .find({
                    userId,
                    // UNKNOWN rows are unresolved venue submits — the
                    // reconciliation poller must drive them to a terminal
                    // state so pre-submit dedup can release the block.
                    state: { $in: ["submitted", "unknown"] },
                    submittedAt: { $lt: staleThresholdTime.toISOString() },
                })
                .toArray();
        },

        async getAllStaleSubmittedOrders(
            staleAfterMs: number,
        ): Promise<PendingOrderLedgerRow[]> {
            const now = new Date();
            const staleThresholdTime = new Date(now.getTime() - staleAfterMs);

            return collection(db)
                .find({
                    state: { $in: ["submitted", "unknown"] },
                    submittedAt: { $lt: staleThresholdTime.toISOString() },
                })
                .toArray();
        },
    };
}

/**
 * Build just the pending_orders_ledger indexes.
 * Called from the MongoDB adapter's ensureIndexes() method.
 * @param db - The MongoDB Db instance
 */
export async function ensurePendingOrdersLedgerIndexes(db: Db): Promise<void> {
    const coll = collection(db);

    await Promise.all([
        // Unique index on client_order_id for upsert
        coll.createIndex({ client_order_id: 1 }, { unique: true }),

        // Compound index for stale order queries and state transitions
        coll.createIndex({ userId: 1, venue: 1, state: 1 }),

        // Index for TTL and stale-order timestamp filtering
        coll.createIndex({ submittedAt: 1 }),
    ]);
}
