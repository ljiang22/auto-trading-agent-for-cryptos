# Binance Endpoint and Payload Matrix (plugin-cex)

Scope: only Spot/Wallet endpoints currently used by `plugin-cex`.

## Endpoints

| Endpoint | Method | Signed | Required params (Binance) | Optional params used | plugin-cex mapping |
|---|---|---:|---|---|---|
| `/api/v3/account` | GET | Yes | none | `recvWindow` | `BinanceAccountsService.getBalance` |
| `/sapi/v1/asset/get-funding-asset` | POST | Yes | none | `recvWindow` | `BinanceAccountsService.getBalance` |
| `/api/v3/openOrders` | GET | Yes | none (or symbol for scoped query) | `recvWindow` | `BinanceOrdersService.getOrders`, `cancelOrder` |
| `/api/v3/order` | GET | Yes | `symbol`, `orderId` | `recvWindow` | `BinanceOrdersService.getOrders` |
| `/api/v3/allOrders` | GET | Yes | `symbol` | `startTime`, `endTime`, `limit`, `recvWindow` | `BinanceOrdersService.getOrders` |
| `/api/v3/order` | POST | Yes | `symbol`, `side`, `type`, plus quantity/price fields per type | `newClientOrderId`, `stopPrice`, `goodTillDate`, `recvWindow` | `BinanceOrdersService.createOrder` |
| `/api/v3/order` | DELETE | Yes | `symbol`, `orderId` (or `origClientOrderId`) | `recvWindow` | `BinanceOrdersService.cancelOrder` |
| `/api/v3/myTrades` | GET | Yes | `symbol` | `startTime`, `endTime`, `limit`, `recvWindow` | `BinanceOrdersService.getFills` |

## Schema alignment notes

- `get_fills.product_ids`: required for Binance (`myTrades` requires a symbol).
- `cancel_order.product_id`: added as Binance symbol fallback when order is not in open-orders cache.
- `get_orders.product_ids`: marked as conditionally required in Binance-specific flows that need symbol resolution.
- `create_order.stop_limit_*`: `base_size` marked required to match Binance mapper expectations.
- `create_order.trigger_bracket_*`: explicitly documented as unsupported for Binance in shared action schema descriptions.
