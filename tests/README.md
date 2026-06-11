# Security & Reliability Tests

## Setup
```bash
# From repo root
pnpm install
```

## Run all tests
```bash
# If vitest is configured:
pnpm --filter @sentiedge/root test
# Or directly:
npx vitest run tests/
```

## Test suites

| File | What it covers |
|---|---|
| `security/auth.test.ts` | `requireAuth` middleware — 401 on unauthenticated, pass-through on authenticated |
| `security/cors.test.ts` | CORS allowlist — blocks unknown origins, allows listed ones |
| `security/path-traversal.test.ts` | `DELETE /files` path validation — traversal attempts rejected |
| `reliability/scheduler.test.ts` | Atomic catchup-state writes — no corruption on concurrent/interrupted writes |
| `reliability/mutex.test.ts` | Per-user analysis mutex — concurrent users unblocked, same user blocked |
| `reliability/embedding.test.ts` | Singleton init — concurrent calls initialize model exactly once; retry after failure |

## Dependencies required
- `vitest` — test runner (already in repo devDependencies)
- `supertest` — HTTP assertion for auth/cors tests
- `express` — used as stub in auth/cors tests

If supertest is not already installed:
```bash
pnpm add -D supertest @types/supertest
```
