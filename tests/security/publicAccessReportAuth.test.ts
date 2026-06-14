import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { publicOrRequireAuth } from '../../packages/client-direct/src/api.ts';

// `publicOrRequireAuth` is the auth selector used by the public-demo report
// routes (/daily-analysis, /reports/DailyReports, /reports/DailyCharts).
//
// Contract:
//   - PUBLIC_ACCESS_MODE unset (production AWS): identical to requireAuth —
//     an anonymous request is rejected with 401.
//   - PUBLIC_ACCESS_MODE=1 (isolated public demo): anonymous visitors may read
//     shared/system report resources, so the request passes through.
//
// The bug this guards against: the report routes hard-required auth, so the
// public Cloud Run demo showed a "Sign in required" screen for the daily report
// even though anonymous chat + S3 charts already honored PUBLIC_ACCESS_MODE.

function makeApp() {
  const app = express();
  app.get('/protected', publicOrRequireAuth, (_req, res) => res.json({ ok: true }));
  return app;
}

const prev = process.env.PUBLIC_ACCESS_MODE;
afterEach(() => {
  if (prev === undefined) delete process.env.PUBLIC_ACCESS_MODE;
  else process.env.PUBLIC_ACCESS_MODE = prev;
});

describe('publicOrRequireAuth (public-demo report-route auth selector)', () => {
  it('rejects anonymous requests with 401 when PUBLIC_ACCESS_MODE is unset', async () => {
    delete process.env.PUBLIC_ACCESS_MODE;
    const res = await request(makeApp()).get('/protected');
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('Authentication required');
  });

  it('allows anonymous requests through when PUBLIC_ACCESS_MODE=1', async () => {
    process.env.PUBLIC_ACCESS_MODE = '1';
    const res = await request(makeApp()).get('/protected');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});
