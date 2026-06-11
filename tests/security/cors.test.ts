import { describe, it, expect } from 'vitest';
import express from 'express';
import cors from 'cors';
import request from 'supertest';

function makeCorsApp(allowedOrigins: string[]) {
  const allowed = new Set(allowedOrigins);
  const app = express();
  app.use(cors({
    origin: (origin, cb) => {
      if (!origin || allowed.has(origin)) cb(null, true);
      else cb(new Error('CORS: origin not allowed'));
    },
    credentials: true,
  }));
  app.get('/ping', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('CORS allowlist', () => {
  const app = makeCorsApp(['https://sentiedge.com', 'http://localhost:3000']);

  it('allows a whitelisted origin', async () => {
    const res = await request(app).get('/ping').set('Origin', 'https://sentiedge.com');
    expect(res.headers['access-control-allow-origin']).toBe('https://sentiedge.com');
  });

  it('blocks an unknown origin', async () => {
    const res = await request(app).get('/ping').set('Origin', 'https://evil.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('allows requests with no origin (server-to-server)', async () => {
    const res = await request(app).get('/ping');
    expect(res.status).toBe(200);
  });
});
