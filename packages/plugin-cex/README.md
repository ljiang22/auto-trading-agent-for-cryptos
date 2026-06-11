# @elizaos-plugins/plugin-cex

`plugin-cex` is a focused ElizaOS trading plugin built around a small exchange registry and direct REST-backed exchange services.

The current implementation supports:
- Coinbase only
- Advanced Trade REST endpoints through `@elizaos/core` `httpClient`
- Trading/account actions for balances, orders, order creation, order cancellation, and fills

## Current Scope

This plugin does not currently implement:
- multiple exchanges
- providers
- background services registered into the runtime
- futures/position management actions

The exchange registry exists so additional exchanges can be added later, but the only supported exchange id today is `coinbase`.

## Architecture

### Exchange Layer

- [src/exchanges/registry.ts](./src/exchanges/registry.ts)
  Maps an exchange id to an exchange service implementation.
- [src/exchanges/services/coinbase.ts](./src/exchanges/services/coinbase.ts)
  Implements the `ExchangeService` contract for Coinbase using direct REST calls.

### Action Layer

- [src/actions/index.ts](./src/actions/index.ts)
  Declares the plugin actions.
- [src/actions/shared.ts](./src/actions/shared.ts)
  Provides the shared `createTradeAction` wrapper used by all actions.

### Output Layer

- [src/templates/output.ts](./src/templates/output.ts)
  Formats successful action output.
- [src/templates/error.ts](./src/templates/error.ts)
  Formats user-facing error output.

### Shared Types

- [src/types.ts](./src/types.ts)
  Defines the exchange service contracts and action parameter types.

## Available Actions

The plugin currently exports these actions:

- `get_balance`
- `get_orders`
- `create_order`
- `cancel_order`
- `get_fills`

## Coinbase Endpoints Used

The Coinbase service currently calls:

- `GET /api/v3/brokerage/accounts`
- `GET /api/v3/brokerage/orders/historical/batch`
- `POST /api/v3/brokerage/orders`
- `POST /api/v3/brokerage/orders/batch_cancel`
- `GET /api/v3/brokerage/orders/historical/fills`

The Coinbase base URL is owned by the Coinbase exchange service implementation and is not passed through action params.

## Param Handling

Action params are expected to come from the ElizaOS action call payload passed into the handler through `options`.

The shared wrapper:
1. reads `options` and `options.parameters`
2. runs lightweight param validation
3. creates the exchange service from the exchange registry
4. calls the action-specific handler
5. formats success or error output through templates

### Lightweight Validation

Validation is intentionally narrow:

- `exchange` must be `coinbase`
- `authHeader` must be present
- required action-specific fields are checked
- optional fields are only normalized, not deeply validated

This keeps the action layer light while still preventing obviously malformed calls.

## Authentication

The plugin expects the action payload to provide:

```ts
{
  exchange: "coinbase",
  authHeader: string | Record<string, string>
}
```

`authHeader` is forwarded to the Coinbase REST client and used as request headers.

## Example Action Payloads

### Get Balance

```ts
{
  exchange: "coinbase",
  authHeader: {
    Authorization: "Bearer <token>"
  }
}
```

### Get Orders

```ts
{
  exchange: "coinbase",
  authHeader: {
    Authorization: "Bearer <token>"
  },
  productIds: ["BTC-USD"],
  limit: 25
}
```

### Create Order

```ts
{
  exchange: "coinbase",
  authHeader: {
    Authorization: "Bearer <token>"
  },
  clientOrderId: "order-123",
  productId: "BTC-USD",
  side: "BUY",
  orderConfiguration: {
    market_market_ioc: {
      quote_size: "25"
    }
  }
}
```

### Cancel Order

```ts
{
  exchange: "coinbase",
  authHeader: {
    Authorization: "Bearer <token>"
  },
  orderIds: ["abc123"]
}
```

### Get Fills

```ts
{
  exchange: "coinbase",
  authHeader: {
    Authorization: "Bearer <token>"
  },
  productIds: ["BTC-USD"],
  limit: 50
}
```

## Registering the Plugin

```ts
import { cexPlugin } from "@elizaos-plugins/plugin-cex";

export default {
    plugins: [cexPlugin],
};
```

## Development

```bash
pnpm --dir packages/plugin-cex dev
pnpm --dir packages/plugin-cex build
```

## Tests

From the monorepo root (`senti-agent-0428`):

**Unit (Vitest)** — runs `__tests__/*.test.ts`:

```bash
pnpm --filter @elizaos-plugins/plugin-cex test:unit
```

**Binance question suite** — hits a running API (default `http://127.0.0.1:3000`). Set `PLUGIN_CEX_TEST_USER_EMAIL` in `.env` or the script exits 0 without running. Optional: `QUESTION_RUNNER_BASE_URL`, `PLUGIN_CEX_BINANCE_QUESTIONS`, `PLUGIN_CEX_BINANCE_APPROVALS`. Use Binance testnet base URL (e.g. `BINANCE_BASE_URL=https://testnet.binance.vision`) when exercising testnet keys.

```bash
pnpm --filter @elizaos-plugins/plugin-cex test:integration
```

## Dependencies

Runtime dependencies:

- `@elizaos/core`
  Used for the `Plugin` type, action response helpers, and `httpClient`.
- `@tavily/core`
  Present in `package.json`, but not currently used by the active implementation.

Build/dev dependencies:

- `tsup`
- `@biomejs/biome`
- `@types/node`

## Notes

- The plugin is implementation-accurate as of the current Coinbase-only REST version.
- If more exchanges are added later, they should plug into the existing exchange registry and `ExchangeService` contract rather than duplicating action logic.
