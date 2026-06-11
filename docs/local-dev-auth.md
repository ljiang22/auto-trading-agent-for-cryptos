# Local-dev auth (test the trading flow without Django)

The agent authenticates requests by verifying an **RS256 JWT** against `JWT_PUBLIC_KEY_B64`
(in production that's Django's public key). The CEX trading workflow refuses **anonymous**
users — without a valid token it replies *"sign in, set up a default exchange, and enable
trading"* and the `human_input_required` approval gate never fires.

Django isn't special here: it's just the token issuer. For local testing you can be your
own issuer with a throwaway keypair. **Self-minted tokens only verify against an agent you
started with the matching dev public key — they cannot authenticate to staging/prod**, which
use Django's real key.

`LOCAL_DEV_MODE=1` does **not** bypass auth (it only relaxes quotas/caps). You still need a
token.

## One-time setup

```bash
# 1. Generate a dev keypair (.dev-auth/, gitignored) and print the env to set:
pnpm dev:auth init

# 2. Put the printed lines in .env.local (gitignored, overrides .env):
#      JWT_PUBLIC_KEY_B64=<dev public key b64>
#      LOCAL_DEV_MODE=1
#      PAPER_TRADING_ENABLED=true
```

> `.env.local` is loaded with `override: true`, so it wins over `.env` for local dev only.
> Never put the dev `JWT_PUBLIC_KEY_B64` in a staging/prod environment.

## Each session

```bash
# Start the agent (it now trusts your dev key) and the client:
pnpm start            # agent on :3001  (or your SERVER_PORT)
pnpm start:client     # Vite client on :5173

# Mint a token for your test user:
pnpm dev:auth token --email you@example.com
```

This prints:
- the RS256 JWT,
- a **browser** snippet — paste it in the app's devtools console (same host as the SPA, e.g.
  `localhost:5173`); it sets **both** the `access_token` **and** `user_info` cookies, then reloads,
  now signed in. (Both are required: the SPA's `checkAuthStatus` in `AuthContext.tsx` short-circuits
  to logged-out when `user_info` is absent and never calls `getMe()` — so an `access_token`-only
  snippet authenticates the backend but leaves the **UI** signed-out/restricted.)
- a **curl** example using `Authorization: Bearer <token>` (for API/harness use, which only needs
  the Bearer token — the `user_info` cookie is a frontend-only concern).

`verifyBearerJwt` reads the token from the `Authorization: Bearer` header **or** the
`access_token` cookie. Cookies are host-scoped (port-agnostic), so a cookie set on `:5173`
is sent to the agent on `:3001`.

## Reaching the CEX approval gate

The trading workflow also requires the account to have **trading enabled + a default
exchange** (separate from auth). Enable it for your dev user — the account must already
exist, so sign in once with a token first, then:

    pnpm dev:auth seed-trading --email you@example.com

This sets `account.details.enableTrading=true` + a dummy default exchange
(`exchangeAuths.binance`) **and** the user's trading mode to **paper**
(`user_trading_preferences.default_mode = "paper"`, keyed by `account.id`).

> **Why the trading-mode write matters (don't skip it).** `create_order` dispatch is decided
> per-user by `resolveTradingMode`, which reads `user_trading_preferences.default_mode`
> (DB-first) and **defaults to `live`** when there's no row. `PAPER_TRADING_ENABLED` does **not**
> route orders to the paper venue. So without `default_mode = "paper"`, the dummy creds above are
> sent to the **real exchange** and the order fails with *"API-key format invalid"* (`create_order
> error`) — the gate fires but no fill ever lands. With paper mode set, fills run through the
> built-in **paper venue ($10k USD ledger)** and the dummy creds never touch a real exchange. (The
> gate pre-check accepts plain dummy strings; encryption is not required.)

Then submit a small order — chat → **Trade** → *Compose & Authorize Order*, or a chat
message like `buy market 10 USDT on Binance BTC/USDT`. The agent runs preprocess →
idempotency → risk check and emits the `human_input_required` approval gate (the
"Review & Authorize Order" modal). Verified end-to-end on 2026-06-07.

The `scripts/agent-sim/` harness uses the same minting (`approvalDriver.mjs::mintTestJwt`)
to drive the approval endpoint headlessly.

## Is this safe for production? (yes, by design)

This flow **cannot** authenticate to or affect staging/prod, on three independent layers:

1. **Cryptographic boundary.** Auth is RS256. Staging/prod verify tokens against **Django's
   public key** (set on the ECS task definition). Your self-minted tokens are signed with a
   throwaway dev *private* key, so their signature **fails verification** against Django's key →
   prod rejects them. Forging a prod-valid token would require Django's private key, which this
   flow never has.
2. **The dev knobs never ship.** The dev public key + `LOCAL_DEV_MODE=1` live only in `.env.local`,
   which is **gitignored** (never committed) *and* **dockerignored** (`.dockerignore` excludes
   `.env.*`). The `.dev-auth/` keypair is likewise gitignored + dockerignored. Prod images contain
   **no `.env*`** and get all config (incl. Django's `JWT_PUBLIC_KEY_B64`) from the ECS task def.
3. **The frontend dev-login-bypass is compiled out of prod.** `buildDevBypassUser` only runs when
   `import.meta.env.DEV` is true (the Vite dev server); a production `vite build` sets it false, and
   prod builds set `VITE_TEST_USER_EMAIL=` (empty). It is also frontend-only (no JWT), so it can
   never grant backend access regardless.

**Rules every developer must follow (the only ways to break the above):**

- **Never** set the dev `JWT_PUBLIC_KEY_B64`, `LOCAL_DEV_MODE`, or `VITE_TEST_USER_EMAIL` in a
  staging/prod environment / task def. (A dev public key in prod would let self-minted tokens
  authenticate — this is the one thing that defeats layer 1.)
- **Never** build a deployable image from a tree where you've un-ignored `.env*` / `.dev-auth/`.
  The repo guards this; don't override it.
- **Never** run `pnpm dev:auth seed-trading` or point `MONGODB_CONNECTION_STRING` /
  `DOCUMENTDB_CONNECTION_STRING` at the production cluster (`sentiedge-docdb` /
  `senti-agent-prod` / `senti-agent-staging`). Use a local/throwaway Mongo only. (The
  `scripts/geap/deploy-cloud-run.sh` helper hard-aborts on prod datastore strings; the dev
  scripts don't, so this one is on you.)
- Keep trading in **paper** mode (`seed-trading` sets it) — never connect real exchange keys
  to a locally-authed dev account.

**Each teammate generates their own keypair** (`pnpm dev:auth init` writes a per-developer
`.dev-auth/`, gitignored) — there is no shared secret to leak, and one developer's dev key is
useless to anyone else and to every deployed environment.
