/**
 * Async-scoped context for venue call audit. The CEX workflow handler
 * sets this once per request (`runWithVenueCallContext`); venue clients
 * (binance.ts, coinbase.ts) read it via `getVenueCallContext()` and pass
 * it into `callVenueWithRetry` so every `venue_calls` row joins the
 * `risk_decisions` and `pending_orders_ledger` rows for the same intent.
 *
 * AsyncLocalStorage keeps the venue-client signatures clean — they don't
 * need to know about request_id propagation.
 */

import { AsyncLocalStorage } from "node:async_hooks";

export interface VenueCallContext {
    request_id?: string;
    intent_hash?: string;
    userId?: string;
    client_order_id?: string;
}

const storage = new AsyncLocalStorage<VenueCallContext>();

export function runWithVenueCallContext<T>(
    ctx: VenueCallContext,
    work: () => Promise<T>,
): Promise<T> {
    return storage.run(ctx, work);
}

export function getVenueCallContext(): VenueCallContext | undefined {
    return storage.getStore();
}
