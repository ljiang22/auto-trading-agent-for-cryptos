/**
 * F3 — paper-orders persistence layer.
 *
 * The PaperVenueExchangeService is now stateful + adapter-backed: orders
 * placed in one action call must remain visible to the next action call
 * (QA H1+H2 reproduced "I placed a paper order; now it's gone"). The
 * `PaperOrderStore` interface is the contract; two implementations:
 *
 *   - `createInMemoryPaperOrderStore` — for tests + fall-back when no
 *     adapter is wired (e.g., unit tests in plugin-cex).
 *   - `createAdapterBackedPaperOrderStore(runtime)` — production path;
 *     writes to the `paper_orders` MongoDB collection (or the parallel
 *     `paper_orders` SQLite table). 24h TTL configured per
 *     `PAPER_ORDER_TTL_SECONDS`.
 *
 * The store is scoped by `userId` so two users running paper mode on
 * the same agent process never see each other's orders.
 */

import type { PaperFill, PaperOrder } from "./paperVenue";

export interface PaperOrderRecord extends PaperOrder {
    userId: string;
    venue: string;
    /** Unix ms — when this row should be culled by the TTL index. */
    ttl_at: number;
    /** ISO timestamp of last write. */
    updated_at: string;
}

export interface PaperFillRecord extends PaperFill {
    userId: string;
    venue: string;
    ttl_at: number;
}

export interface PaperOrderStore {
    addOrder(record: PaperOrderRecord): Promise<void>;
    getOrders(userId: string, opts?: { statuses?: string[] }): Promise<PaperOrderRecord[]>;
    getOrderById(userId: string, orderId: string): Promise<PaperOrderRecord | null>;
    updateOrderStatus(
        userId: string,
        orderId: string,
        status: PaperOrder["status"],
    ): Promise<boolean>;
    addFill(record: PaperFillRecord): Promise<void>;
    getFills(userId: string): Promise<PaperFillRecord[]>;
    /** Best-effort total balance lookup; returns empty when not tracked. */
    getBalances?(userId: string): Promise<Array<{ asset: string; available: string; locked: string }>>;
}

/**
 * F3 — in-memory implementation. The `state` Map is process-local; this
 * is what tests exercise and what we fall back to when the runtime has
 * no adapter (e.g., before `runtime.initialize()`).
 */
export function createInMemoryPaperOrderStore(): PaperOrderStore {
    const orders = new Map<string, PaperOrderRecord>(); // key = `${userId}:${orderId}`
    const fillsByOrder = new Map<string, PaperFillRecord[]>();
    const k = (userId: string, orderId: string) => `${userId}:${orderId}`;
    return {
        async addOrder(record) {
            orders.set(k(record.userId, record.order_id), record);
        },
        async getOrders(userId, opts) {
            const out: PaperOrderRecord[] = [];
            for (const rec of orders.values()) {
                if (rec.userId !== userId) continue;
                if (opts?.statuses?.length && !opts.statuses.includes(rec.status)) continue;
                out.push(rec);
            }
            return out;
        },
        async getOrderById(userId, orderId) {
            return orders.get(k(userId, orderId)) ?? null;
        },
        async updateOrderStatus(userId, orderId, status) {
            const rec = orders.get(k(userId, orderId));
            if (!rec) return false;
            rec.status = status;
            rec.updated_at = new Date().toISOString();
            orders.set(k(userId, orderId), rec);
            return true;
        },
        async addFill(record) {
            const arr = fillsByOrder.get(record.order_id) ?? [];
            arr.push(record);
            fillsByOrder.set(record.order_id, arr);
        },
        async getFills(userId) {
            const all: PaperFillRecord[] = [];
            for (const arr of fillsByOrder.values()) {
                for (const f of arr) {
                    if (f.userId === userId) all.push(f);
                }
            }
            return all;
        },
    };
}

/**
 * Structural cast of the runtime.databaseAdapter — only the paper_orders
 * methods are required. The adapter is allowed to throw / be missing
 * (the caller falls back to in-memory).
 */
export interface PaperOrdersAdapter {
    paperOrdersAdd?: (record: PaperOrderRecord) => Promise<void>;
    paperOrdersGetByUser?: (
        userId: string,
        opts?: { statuses?: string[] },
    ) => Promise<PaperOrderRecord[]>;
    paperOrdersGetById?: (userId: string, orderId: string) => Promise<PaperOrderRecord | null>;
    paperOrdersUpdateStatus?: (
        userId: string,
        orderId: string,
        status: PaperOrder["status"],
    ) => Promise<boolean>;
    paperFillsAdd?: (record: PaperFillRecord) => Promise<void>;
    paperFillsGetByUser?: (userId: string) => Promise<PaperFillRecord[]>;
}

/**
 * Adapter-backed store. If any required adapter method is missing the
 * `addOrder`/`getOrders`/etc. silently degrade to a no-op (returning
 * empty), so a partially-implemented adapter doesn't crash.
 */
export function createAdapterBackedPaperOrderStore(adapter: PaperOrdersAdapter): PaperOrderStore {
    return {
        async addOrder(record) {
            if (typeof adapter.paperOrdersAdd !== "function") return;
            await adapter.paperOrdersAdd(record);
        },
        async getOrders(userId, opts) {
            if (typeof adapter.paperOrdersGetByUser !== "function") return [];
            return adapter.paperOrdersGetByUser(userId, opts);
        },
        async getOrderById(userId, orderId) {
            if (typeof adapter.paperOrdersGetById !== "function") return null;
            return adapter.paperOrdersGetById(userId, orderId);
        },
        async updateOrderStatus(userId, orderId, status) {
            if (typeof adapter.paperOrdersUpdateStatus !== "function") return false;
            return adapter.paperOrdersUpdateStatus(userId, orderId, status);
        },
        async addFill(record) {
            if (typeof adapter.paperFillsAdd !== "function") return;
            await adapter.paperFillsAdd(record);
        },
        async getFills(userId) {
            if (typeof adapter.paperFillsGetByUser !== "function") return [];
            return adapter.paperFillsGetByUser(userId);
        },
    };
}
