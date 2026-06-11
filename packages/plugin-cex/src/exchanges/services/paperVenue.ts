import type {
    CancelOrderParams,
    ClosePositionParams,
    CreateOrderParams,
    EditOrderParams,
    ExchangeAccountsService,
    ExchangeName,
    ExchangeOrdersService,
    ExchangeService,
    GetBalanceParams,
    GetFillsParams,
    GetOrdersParams,
} from "../../types";
import type { PaperOrderStore, PaperOrderRecord, PaperFillRecord } from "./paperOrderStore";
import { createInMemoryPaperOrderStore } from "./paperOrderStore";

export interface PaperFill {
    order_id: string;
    client_order_id: string;
    product_id: string;
    side: "BUY" | "SELL";
    fill_price: string;
    fill_quantity: string;
    filled_at: string;
}

export interface PaperOrder {
    order_id: string;
    client_order_id: string;
    product_id: string;
    side: "BUY" | "SELL";
    /** "open" | "filled" | "cancelled" */
    status: "open" | "filled" | "cancelled";
    quantity: string;
    price?: string;
    created_at: string;
    filled_at?: string;
    /**
     * F9 — margin context preserved on paper-mode CROSS / ISOLATED orders
     * so the order ledger faithfully reproduces the venue contract. Omitted
     * for spot orders (current QA defect: paper margin orders dropped these
     * fields silently → cancel + reporting tools couldn't tell margin from
     * spot in the paper ledger).
     */
    margin_type?: "CROSS" | "ISOLATED";
    margin_action?: "NORMAL" | "AUTO_BORROW" | "AUTO_REPAY";
    leverage?: string;
}

export interface PaperBalance {
    asset: string;
    available: string;
    locked: string;
}

export interface SlippageModel {
    kind: "linear_bps" | "book_walk";
    /** For linear_bps: half-spread + impact (round-trip bps). */
    bps?: number;
    /** For book_walk: cumulative impact per unit quantity. */
    impact_bps_per_unit?: number;
}

export interface PaperVenueConfig {
    /** Function returning the latest mid price for a given product_id. */
    getMidPrice: (productId: string) => Promise<number>;
    /** Slippage model applied to market orders. */
    slippage?: SlippageModel;
    /** Initial USD balance. */
    initialUsd?: number;
    /**
     * F3 — persistence store. When provided, orders persist across action
     * calls and container restarts (via the configured adapter). When
     * omitted, falls back to in-memory storage for unit-test use.
     */
    store?: PaperOrderStore;
    /**
     * F3 — venue label (e.g. "binance", "coinbase") recorded on each
     * row so a user toggling between venues sees a consistent ledger.
     */
    venue?: string;
    /**
     * F3 — TTL in seconds for paper-order rows. Defaults to 24h. Override
     * via env `PAPER_ORDER_TTL_SECONDS` and pass through here.
     */
    ttlSeconds?: number;
}

function newId(prefix: string): string {
    return `${prefix}-${Math.random().toString(36).slice(2, 10)}-${Date.now()}`;
}

function applySlippage(
    side: "BUY" | "SELL",
    midPrice: number,
    quantity: number,
    slippage: SlippageModel,
): number {
    let bps = 0;
    if (slippage.kind === "linear_bps") {
        bps = slippage.bps ?? 0;
    } else if (slippage.kind === "book_walk") {
        bps = (slippage.impact_bps_per_unit ?? 0) * quantity;
    }
    const direction = side === "BUY" ? 1 : -1;
    return midPrice * (1 + direction * (bps / 10_000));
}

class PaperAccountsService implements ExchangeAccountsService {
    public constructor(
        private readonly store: PaperOrderStore,
        private readonly initialUsd: number,
    ) {}

    public async getBalance(params: GetBalanceParams): Promise<unknown> {
        const userId = String(params.userId);
        const tracked = (await this.store.getBalances?.(userId)) ?? [];
        const usd = {
            asset: "USD",
            available: String(this.initialUsd),
            locked: "0",
        };
        const accounts = tracked.length > 0 ? tracked : [usd];
        // F3 — emit BOTH `accounts` (matches the real Binance/Coinbase
        // envelope downstream renderers expect) AND `balances` (kept for
        // backward compatibility with existing paper-venue unit tests).
        return { accounts, balances: accounts };
    }
}

class PaperOrdersService implements ExchangeOrdersService {
    public constructor(
        private readonly store: PaperOrderStore,
        private readonly config: PaperVenueConfig,
    ) {}

    private get venue(): string {
        return this.config.venue ?? "paper";
    }

    private get ttlAt(): number {
        const seconds = this.config.ttlSeconds ?? 86_400;
        return Date.now() + seconds * 1000;
    }

    public async getOrders(params: GetOrdersParams): Promise<unknown> {
        const userId = String(params.userId);
        const statuses = params.order_status;
        const records = await this.store.getOrders(userId, statuses?.length ? { statuses } : undefined);
        // Strip persistence-only fields before returning so the response
        // shape matches `PaperOrder` (which is what the existing tests
        // and downstream renderers expect).
        const orders = records.map(stripRecord);
        return { orders };
    }

    public async getFills(params: GetFillsParams): Promise<unknown> {
        const userId = String(params.userId);
        const all = await this.store.getFills(userId);
        const fills = all.map(stripFill);
        return { fills };
    }

    public async createOrder(params: CreateOrderParams): Promise<unknown> {
        const userId = String(params.userId);
        const productId = params.product_id;
        const mid = await this.config.getMidPrice(productId);
        const slip = this.config.slippage ?? { kind: "linear_bps", bps: 5 };
        const cfg = params.order_configuration;
        const isMarket = cfg.market_market_ioc !== undefined || cfg.market_market_fok !== undefined;
        const sizeFields = (cfg.market_market_ioc ??
            cfg.market_market_fok ??
            cfg.limit_limit_gtc ??
            cfg.limit_limit_gtd ??
            cfg.sor_limit_ioc ??
            cfg.limit_limit_fok ??
            { base_size: "0" }) as { base_size?: string; quote_size?: string };
        let quantity = Number.parseFloat(sizeFields.base_size ?? "0");
        if (!Number.isFinite(quantity) || quantity <= 0) {
            const quote = Number.parseFloat(sizeFields.quote_size ?? "0");
            quantity = mid > 0 ? quote / mid : 0;
        }
        const limitInner = (cfg.limit_limit_gtc ??
            cfg.limit_limit_gtd ??
            cfg.sor_limit_ioc ??
            cfg.limit_limit_fok) as { limit_price?: string } | undefined;
        const limitPrice = limitInner?.limit_price
            ? Number.parseFloat(limitInner.limit_price)
            : undefined;

        const fillPrice = isMarket
            ? applySlippage(params.side, mid, quantity, slip)
            : (limitPrice ?? mid);

        const orderId = newId("paper-ord");
        const now = new Date().toISOString();
        const order: PaperOrder = {
            order_id: orderId,
            client_order_id: params.client_order_id,
            product_id: productId,
            side: params.side,
            status: isMarket ? "filled" : "open",
            quantity: quantity.toString(),
            price: fillPrice.toString(),
            created_at: now,
            filled_at: isMarket ? now : undefined,
            // F9 — carry the margin-context fields verbatim from the
            // canonical params onto the paper order. These are the only
            // params the paper venue treats as identifying for the
            // margin (vs spot) flavor of the order.
            ...(params.margin_type ? { margin_type: params.margin_type } : {}),
            ...(params.margin_action ? { margin_action: params.margin_action } : {}),
            ...(params.leverage ? { leverage: params.leverage } : {}),
        };
        const record: PaperOrderRecord = {
            ...order,
            userId,
            venue: this.venue,
            ttl_at: this.ttlAt,
            updated_at: now,
        };
        await this.store.addOrder(record);

        if (isMarket) {
            const fill: PaperFillRecord = {
                userId,
                venue: this.venue,
                ttl_at: this.ttlAt,
                order_id: orderId,
                client_order_id: params.client_order_id,
                product_id: productId,
                side: params.side,
                fill_price: fillPrice.toString(),
                fill_quantity: quantity.toString(),
                filled_at: now,
            };
            await this.store.addFill(fill);
        }

        return {
            success: true,
            order_id: orderId,
            client_order_id: params.client_order_id,
            order,
        };
    }

    public async cancelOrder(params: CancelOrderParams): Promise<unknown> {
        const userId = String(params.userId);
        const ids = params.order_ids ?? [];
        const cancelled: string[] = [];
        const notFound: string[] = [];
        for (const id of ids) {
            const rec = await this.store.getOrderById(userId, id);
            if (!rec) {
                notFound.push(id);
                continue;
            }
            if (rec.status === "open") {
                const ok = await this.store.updateOrderStatus(userId, id, "cancelled");
                if (ok) cancelled.push(id);
            } else {
                // Already filled / already cancelled — surface as "not actively cancelled".
                notFound.push(id);
            }
        }
        // F3 — `results` array gives the cancel template a deterministic
        // count it can branch on (0 = not-found template).
        const results = cancelled.map((id) => ({ order_id: id, status: "cancelled" }));
        return { success: true, cancelled, not_found: notFound, results };
    }

    public async editOrder(params: EditOrderParams): Promise<unknown> {
        const userId = (params as unknown as { userId?: string }).userId
            ? String((params as unknown as { userId?: string }).userId)
            : "";
        const rec = await this.store.getOrderById(userId, params.orderId);
        if (!rec) return { success: false, error: "not_found" };
        if (params.size) rec.quantity = params.size;
        if (params.price) rec.price = params.price;
        rec.updated_at = new Date().toISOString();
        await this.store.addOrder(rec); // upsert
        return { success: true, order: stripRecord(rec) };
    }

    public async closePosition(params: ClosePositionParams): Promise<unknown> {
        return this.createOrder({
            userId: params.userId,
            exchange: params.exchange,
            client_order_id: params.client_order_id,
            product_id: params.product_id,
            side: "SELL",
            order_configuration: {
                market_market_ioc: { base_size: String(params.size) },
            },
        });
    }
}

function stripRecord(rec: PaperOrderRecord): PaperOrder {
    const { userId: _u, venue: _v, ttl_at: _t, updated_at: _ua, ...rest } = rec;
    return rest;
}

function stripFill(rec: PaperFillRecord): PaperFill {
    const { userId: _u, venue: _v, ttl_at: _t, ...rest } = rec;
    return rest;
}

/**
 * PaperVenueExchangeService — `ExchangeService` implementation that
 * simulates fills locally. Persistence:
 *  - When `config.store` is provided, all reads / writes go through it
 *    (adapter-backed in production, in-memory in tests).
 *  - When omitted, a fresh in-memory store is created per instance.
 *    Backward-compatible with existing unit tests that construct the
 *    venue without an adapter.
 */
export class PaperVenueExchangeService implements ExchangeService {
    public readonly exchange = "paper" as unknown as ExchangeName;
    public readonly accounts: ExchangeAccountsService;
    public readonly orders: ExchangeOrdersService;
    public readonly store: PaperOrderStore;

    public constructor(config: PaperVenueConfig) {
        this.store = config.store ?? createInMemoryPaperOrderStore();
        this.accounts = new PaperAccountsService(this.store, config.initialUsd ?? 10_000);
        this.orders = new PaperOrdersService(this.store, config);
    }
}

export function createPaperVenue(config: PaperVenueConfig): PaperVenueExchangeService {
    return new PaperVenueExchangeService(config);
}
