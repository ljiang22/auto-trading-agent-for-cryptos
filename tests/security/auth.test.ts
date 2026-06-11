import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { checkAuthenticated } from '../../packages/client-direct/src/api.ts';

// checkAuthenticated is the exported core of requireAuth.
// Importing from source means regressions in production code will break these tests.

function makeApp(userInfo: object | null | undefined) {
  const app = express();
  app.use((req: any, _res, next) => { req.userInfo = userInfo; next(); });
  app.get('/protected', checkAuthenticated, (_req, res) => res.json({ ok: true }));
  return app;
}

describe('checkAuthenticated (core of requireAuth middleware)', () => {
  it('returns 401 when userInfo is null', async () => {
    const res = await request(makeApp(null)).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('returns 401 when userInfo.type is anonymous', async () => {
    const res = await request(makeApp({ type: 'anonymous', ip: '127.0.0.1' })).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('returns 401 when userInfo is undefined', async () => {
    const res = await request(makeApp(undefined)).get('/protected');
    expect(res.status).toBe(401);
  });

  it('calls next() when userInfo.type is authenticated', async () => {
    const res = await request(makeApp({ type: 'authenticated', email: 'user@example.com' })).get('/protected');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
