# JWT RS256 Auth Hardening — Design

**Date:** 2026-05-13
**Status:** Revised 2026-05-13 — scope tightened to the minimum that closes the auth bypass. Frontend cookie cleanup, `COOKIE_SECRET` plumbing removal, boot-time `process.exit`, and dev-key fingerprint check are explicitly **deferred** to follow-up PRs (see §10). Original design preserved in git history.
**Owner:** TBD
**Related code (this PR):**
- `packages/client-direct/src/ipUtils.ts`
- `packages/client-direct/src/auth/verifyJwt.ts` (new)
- `SentiEdge-Django-Server/sentiedge_django_server/{production,local_dev}_settings.py`
- `SentiEdge-Django-Server/common/serializers.py`

---

## 1. Background & Problem

Node agent currently identifies authenticated users via **two parallel paths**:

1. **`user_info` cookie** — written by frontend JS (`AuthContext.setCookie(USER_INFO_COOKIE_KEY, JSON.stringify(userData))`), plain JSON containing `{ userId, email, role, ... }`. Not `httpOnly`, not signed. Any browser user can edit it in DevTools and impersonate any other userId/email.
2. **`Authorization: Bearer <jwt>`** — Django-issued JWT. Node parses it via `decodeJwtPayload` which only `Buffer.from(...).toString('base64')`-decodes the payload. **No signature verification.** Forgeable.

`ipUtils.ts:165` emits a permanent warning (`"[auth] Unsigned user_info cookie accepted — set COOKIE_SECRET..."`) acknowledging the issue, but the underlying paths still grant identity to forged inputs.

Additional fragility: the two paths use different UUID spaces (`email-user-${email}` vs `stringToUuid('jwt-user-${user_id}')`), so the same person can appear as two different `userId` values to the runtime depending on which path resolved their request.

**Outcome:** broken authentication (OWASP A07). Privilege boundaries on `/memories`, `/agents/.../rooms`, CEX approval, and admin-gated routes cannot be relied on.

## 2. Goals

- Move Node agent identity to a **single trusted path**: a Bearer JWT whose signature Node verifies with a public key.
- Keep the existing identity UUID space (`email-user-${email}`) so historical room/memory data continues to belong to the same users.
- Forced re-login at cutover is acceptable. Maintenance window only.

**Non-goals:**

- Key rotation tooling / JWKS endpoint — out of scope, revisit when scale or compliance demands it.
- Anonymous-user IP fallback (`getUserIdFromIP`) — unchanged.
- Django's display-only `user_email` cookie (HttpOnly=False) — unchanged. It carries no auth weight.
- Local dev key generation/distribution — handled out of band by the implementer.

## 3. Approach (chosen)

| Decision | Choice | Rationale |
|---|---|---|
| Signing algorithm | **RS256** | Node holds only the public key. Compromise of the Node service cannot mint tokens. |
| Public key distribution | **Static `JWT_PUBLIC_KEY` env var** (PEM) | Senti is not yet at the scale that needs JWKS rotation. Trivial to upgrade later. |
| `userId` unification | **Add `email` claim to JWT** | Once email is in the token, Node always resolves to `emailToUserId(email)`. The legacy `jwt-user-${user_id}` namespace is deleted. Historical data preserved. |
| Cutover | **Forced re-login, single window** | All HS256 tokens in flight become invalid simultaneously. Simpler than dual-algorithm transition; acceptable given DAU profile and that task chains can be re-triggered. |
| `user_info` cookie (server-side) | **Stop reading it. This PR.** | Server-side reads are the actual privilege boundary. Once the server ignores the cookie, forging it grants nothing. |
| `user_info` cookie (client-side writes) | **Leave in place. Deferred.** | Frontend continues writing the cookie; it becomes inert metadata. Removing the writes is hygiene, not security, and is moved to a follow-up PR to keep this change's blast radius small (see §10). |

## 4. Components & Changes

### 4.1 Django service

**Files:** `sentiedge_django_server/production_settings.py`, `sentiedge_django_server/local_dev_settings.py`, `common/serializers.py`

**4.1.1 Switch `SIMPLE_JWT` to RS256**

In both settings files, extend the existing `SIMPLE_JWT` block:

```python
import base64, os

JWT_PRIVATE_KEY = base64.b64decode(os.environ["JWT_PRIVATE_KEY_B64"]).decode()
JWT_PUBLIC_KEY  = base64.b64decode(os.environ["JWT_PUBLIC_KEY_B64"]).decode()

SIMPLE_JWT = {
    # ...existing keys...
    "ALGORITHM": "RS256",
    "SIGNING_KEY": JWT_PRIVATE_KEY,
    "VERIFYING_KEY": JWT_PUBLIC_KEY,
}
```

Direct `os.environ[...]` access — no `.get()` default. Missing key → Django boot fails fast (intentional for both prod and local dev; key provisioning is the operator's responsibility).

**PEM transport: base64-encoded, single-line.** ECS task definitions are JSON and pass env vars through multiple layers (Terraform/CDK/console/Secrets Manager → container env); embedded `\n` in multi-line PEM is fragile across that chain and produces "works locally, fails on ECS" footguns. Base64 is single-line ASCII — safe to diff, paste, and log-redact. Generate with `base64 -w0 private.pem` (Linux) or `base64 -i private.pem | tr -d '\n'` (macOS). Node side mirrors with `Buffer.from(process.env.JWT_PUBLIC_KEY_B64, 'base64').toString()`.

**4.1.2 Add `email` claim**

`common/serializers.py:84` — `UserInfoTokenSerializer.get_token`:

```python
@classmethod
def get_token(cls, user: MyUserModel):
    token = super().get_token(user)
    if user.email:
        token["email"] = user.email.lower().strip()
    return token
```

Lowercased + trimmed to match Node's `emailToUserId` normalization exactly. Because `super().get_token(user)` returns a `RefreshToken` and the access token is derived via `refresh.access_token`, simplejwt propagates custom claims to both — one edit covers both token types.

**4.1.3 No change required**

- `LoginView` / `CookieTokenObtainPairView` — response shape unchanged.
- `CustomAuthentication` — continues to verify Django-issued tokens with the new algorithm via simplejwt's standard machinery.
- `TokenVerifyView` — unused by Node in this design.

### 4.2 Node agent service

**Files:** `packages/client-direct/src/ipUtils.ts`, `packages/client-direct/src/auth/verifyJwt.ts` (new), `packages/client-direct/package.json`

**4.2.1 Add `jsonwebtoken` dependency.**

**4.2.2 Boot-time public-key load** (`packages/client-direct/src/auth/verifyJwt.ts`)

On boot, read `JWT_PUBLIC_KEY` env var and validate it parses as an RSA public key. **Failure mode: log once at ERROR level and continue.** Do **not** `process.exit`. Rationale:

- The fail-safe is already correct: with no key loaded, `verifyBearerJwt` returns `null` for every request, and `getUserInfo` falls through to anonymous-IP identity. The service stays up; users cannot log in until the config is fixed.
- A `process.exit` would convert a config error into a crash-loop, which during an ECS rolling deploy can cascade across tasks. "Auth degraded, service up" is strictly better than "service down."
- Contributor local-dev impact: a `process.exit` would block anyone without keys from running the server at all.

A dev-key fingerprint check (rejecting the well-known dev key in production) is **not** included. ECS env-var hygiene is the defense for that threat; an additional check is unwarranted code surface.

**4.2.3 Verify utility** (`packages/client-direct/src/auth/verifyJwt.ts`)

```ts
export function verifyBearerJwt(req): { userId: UUID; email: string } | null {
    if (!publicKeyPem) return null; // boot failed; treat as anonymous
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) return null;
    const token = authHeader.slice(7).trim();
    if (!token) return null;
    try {
        const payload = jwt.verify(token, publicKeyPem, {
            algorithms: ["RS256"],
        }) as { email?: unknown };
        const email = typeof payload.email === "string"
            ? payload.email.toLowerCase().trim()
            : null;
        if (!email) return null;
        return { email, userId: emailToUserId(email) };
    } catch (err) {
        // JsonWebTokenError, TokenExpiredError, NotBeforeError
        // Log at debug with err.name (no token contents)
        return null;
    }
}
```

**4.2.4 Delete cookie-based identity** (`packages/client-direct/src/ipUtils.ts`) — **this is where the security fix lives**

In `extractUserEmail`:
- Delete the `req.signedCookies.user_info` / `req.cookies.user_info` block entirely.
- Delete the unsigned-cookie warning.
- Function body becomes: `return verifyBearerJwt(req)?.email ?? null;`

In `getUserInfo`:
- Delete the `extractUserFromBearer` legacy branch (the `jwt-user-${user_id}` UUID-space synthesis).
- Use `verifyBearerJwt` only.
- Anonymous fallback (`return { type: 'anonymous', ... }`) preserved.

Delete `extractUserFromBearer` and `decodeJwtPayload` (unused after the changes above).

**4.2.5 Deliberately NOT in this PR**

The following are deferred to follow-up cleanup PRs once telemetry confirms zero server-side reads of the cookie:

- `cookieParser(cookieSecret)` / `COOKIE_SECRET` env-var plumbing in `packages/client-direct/src/index.ts:397-401` — refactor, no security weight. `cookieParser(undefined)` parses unsigned cookies fine, so removing the secret arg changes nothing functionally.
- `res.clearCookie('user_info', ...)` at `api.ts:3806` — left in place; it now clears a cookie the server doesn't read. Helpful for hygiene on logout, removable later.
- The unsigned-cookie warning log line in `ipUtils.ts:165` — gone naturally because the surrounding block is deleted in 4.2.4.

### 4.3 Frontend (senti-agent_2.0/client) — DEFERRED

**Not in this PR.** All `client/src/contexts/AuthContext.tsx`, `client/src/lib/constants.ts`, `client/src/lib/cookieUtils.ts` changes — including the previously-proposed localStorage migration — are deferred to a follow-up PR.

Rationale:
- The privilege boundary is enforced server-side (§4.2.4). Once the server stops reading `user_info`, anything the frontend writes is inert metadata. There is no security reason to delete the frontend writes in the same PR.
- The previously-proposed `localStorage.setItem('senti.user', ...)` migration moves the tamperable surface from cookies to localStorage without reducing it (both are equally inspectable / mutable from DevTools).
- Frontend touches 6+ code paths; bundling them with the server-side fix increases blast radius and the chance of a frontend bug stranding users during the cutover window.

Known frontend dependencies on `user_info` cookie (handled in the follow-up PR, not now):
- `AuthContext.tsx` — three `setCookie(USER_INFO_COOKIE_KEY, ...)` writes (≈ lines 154, 198, 365).
- `AuthContext.tsx:160-170` — `getStoredTierFromCookie` reads tier from the cookie.
- `AuthContext.tsx:204-268` — `checkAuthStatus` uses cookie presence as a session marker and has a DEV-mode fallback (lines 251–262) that parses the cookie when `/authentication/me/` fails. **Removing the cookie writes without rewriting this DEV path would silently break local dev login.** Follow-up PR must address it.
- `client/src/lib/cookieUtils.ts:73-86` — `deleteAllAuthCookies()` clears `USER_INFO_COOKIE_KEY`. Constant must stay exported as long as this reference remains.
- `client/src/lib/constants.ts:10,18` — `USER_INFO_COOKIE_KEY` declaration and re-export.

## 5. Cutover Plan

Single coordinated window. Expected duration: 15 minutes excluding deploy time.

| Step | Actor | Action |
|---|---|---|
| T-24h | Ops | Generate RSA-2048 keypair; base64-encode both PEMs (`base64 -w0`); inject `JWT_PRIVATE_KEY_B64` to Django ECS, `JWT_PUBLIC_KEY_B64` to Node agent ECS (both prod and staging). Verify env vars present without restarting. |
| T0 | Eng | Announce maintenance / login-required window in status channel. |
| T0+0 | Deploy | Django RS256 build → prod. From this moment Django signs RS256 and rejects HS256 verify. |
| T0+5 | Verify | Hit `LoginView` from a clean browser → confirm new RS256 token in response and that `email` claim is present (decode header.payload, inspect). |
| T0+5 | Deploy | Node agent build → prod (rolling). |
| T0+15 | Verify | Smoke test: login → comprehensive analysis → reload page → still authed. Inspect `/memories` request: 200. |
| T0+30 | Monitor | CloudWatch: zero occurrences of `"Unsigned user_info cookie accepted"`. Zero occurrences of `"JsonWebTokenError"` (or only from genuinely bad tokens). |

**During the window:** users with active sessions see "session expired, please log in again" once their next request hits Django (HS256 refresh token rejected) or Node post-deploy. Re-login flows produce a new RS256 token carrying `email` → identity resolves to the same `email-user-${email}` UUID as before → all rooms/memories intact.

**Brief asymmetry between T0 and T0+5:** New RS256 tokens hit old-code Node, which only base64-decodes — Node will still happily extract `user_id` and synthesize `jwt-user-${user_id}` UUID, *not* the email-based one. Users in this 5-minute window see a "fresh" agent state. Acceptable; no data corruption (we don't auto-merge UUID spaces). Reload after T0+5 deploy fixes it.

## 6. Rollback

If anything breaks post-deploy:

1. ECS redeploy previous Node image — restores base64-decode-only path. Tokens (RS256 or HS256) both round-trip.
2. ECS redeploy previous Django image — restores HS256 signing. New logins issue HS256 again.
3. Total rollback time: ~5–10 minutes.

Rollback is **not** reversible mid-flight: once we revert Django to HS256, any RS256 tokens issued during the broken window expire normally (1 day) and clients re-login. No data migration needed.

## 7. Testing

### 7.1 Node agent unit tests (`packages/client-direct/__tests__/`)

`verifyBearerJwt`:

- Valid RS256 token with `email` claim → returns `{ email, userId: emailToUserId(email) }`.
- Valid signature, no `email` claim → returns `null` (caller falls back to anonymous).
- Expired token (`exp` in the past) → returns `null`. No throw out of the function.
- Token signed by a *different* RSA key → returns `null`.
- HS256-signed token (algorithm confusion attempt: same `kid`, wrong alg) → returns `null` because `algorithms: ['RS256']` is enforced.
- Tampered payload (signature mismatch) → returns `null`.
- Missing `Authorization` header → returns `null`.
- Malformed Bearer (`Bearer ` alone, or non-JWT string) → returns `null`.

Boot check:

- `loadJwtPublicKey()` with `JWT_PUBLIC_KEY` unset → logs ERROR, leaves `publicKeyPem` null, returns. Subsequent `verifyBearerJwt` calls return null.
- With malformed PEM → same: ERROR log, null key, anonymous fallback for all requests.
- With valid PEM → key loaded, `verifyBearerJwt` operates normally.

### 7.2 Integration tests

- `POST /api/auth/login` → response carries access_token; `GET /memories` with `Authorization: Bearer <token>` → 200 and returns the requesting user's rooms.
- Same `GET /memories` with token from a *different* user → returns *their* rooms, not the first user's. Verifies UUID space coherence.
- `GET /memories` with no Authorization → falls back to IP-based anonymous user (existing behavior preserved).
- `GET /memories` with `Authorization: Bearer eyJhbGc...` where alg is HS256 → 200 with anonymous IP-based identity (token rejected, fallback engages — *not* a 401).
- `GET /memories` with a `user_info` cookie forged to claim a different email → identity attributed by the server is **not** the forged email (server no longer reads the cookie).

### 7.3 Frontend tests — DEFERRED

Moved to the follow-up frontend cleanup PR. This PR does not modify frontend auth logic.

### 7.4 E2E manual checklist

- Fresh browser → login → comprehensive analysis → page reload → analysis history visible (frontend continues to write `user_info` cookie; behavior unchanged from the user's perspective).
- DevTools → Application → edit `user_info` cookie value to a fake email → `/memories` and `/agents/.../rooms` still scoped to the real user.
- Server logs: no `"Unsigned user_info cookie accepted"` warning lines after deploy.
- Logout → login as different user → previous user's data not visible.

## 8. Acceptance Criteria

- Node continues to boot when `JWT_PUBLIC_KEY` is missing/malformed; logs ERROR once; all requests resolve to anonymous-IP identity until the env is fixed.
- Bearer token with valid RS256 signature and `email` claim resolves to `email-user-${email}` UUID.
- All other Bearer inputs (missing, expired, wrong algorithm, wrong key, missing email claim) resolve to anonymous IP-based identity.
- `packages/client-direct/src` contains zero reads of `req.cookies.user_info` / `req.signedCookies.user_info`.
- Forging a `user_info` cookie in the browser does not change the `userId` the server attributes the request to.
- CloudWatch shows zero `"Unsigned user_info cookie accepted"` warnings for 24 hours post-deploy (the originating log line is removed in 4.2.4).

## 9. Open Items

- Logging strategy for `verifyBearerJwt` failures: structured log with `err.name` only, no token contents. Confirm with ops before deploy.

## 10. Deferred to Follow-Up PRs

Listed explicitly so they are not lost. Each is tracked as a separate issue:

1. **Frontend cookie cleanup** (originally §4.3) — delete `setCookie(USER_INFO_COOKIE_KEY, ...)` writes; rewrite the DEV-mode cookie-parse fallback in `AuthContext.tsx:251-262`; remove `USER_INFO_COOKIE_KEY` references in `cookieUtils.ts` and `constants.ts`. Trigger: after 1 week of telemetry confirming zero server-side reads.
2. **`COOKIE_SECRET` / `cookieParser` cleanup** — remove the secret arg, remove the env var, drop the conditional warning in `index.ts:397-401` and the `COOKIE_SECRET` line in `.env.example`. Trigger: bundle with #1.
3. **`res.clearCookie('user_info', ...)` removal** at `api.ts:3806`. Trigger: after #1 ships and the cookie is fully phased out client-side.

## 11. Out of Scope (Future Work)

- JWKS endpoint and key rotation tooling.
- Migrating `access_token` / `refresh_token` from cookie storage to a stricter `httpOnly` + same-site `Strict` scheme.
- Replacing the bespoke `emailToUserId(...)` UUID derivation with a real users table primary key (long-standing tech debt; orthogonal to this work).
