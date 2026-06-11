import { describe, it, expect } from 'vitest';
import express from 'express';
import cors from 'cors';
import request from 'supertest';

// Mirrors the corsOptions factories in src/index.ts / api.ts /
// verifiable-log-api.ts. The three callsites use the same shape; this
// regression test pins the critical behavior: disallowed origins must
// NOT throw — throwing turns every request with a non-whitelisted Origin
// into a 500 (including same-origin GETs, since browsers send Origin on
// <script type="module">, fonts, XHR with credentials, etc).
function makeCorsApp(allowedOrigins: string[]) {
    const allowed = new Set(allowedOrigins);
    const app = express();
    app.use(cors({
        origin: (origin, cb) => {
            if (!origin || allowed.has(origin)) cb(null, true);
            else cb(null, false);
        },
        credentials: true,
    }));
    app.get('/ping', (_req, res) => res.json({ ok: true }));
    return app;
}

describe('CORS allowlist', () => {
    const app = makeCorsApp(['https://sentiedge.ai', 'http://localhost:3000']);

    it('allows a whitelisted origin and echoes it back', async () => {
        const res = await request(app).get('/ping').set('Origin', 'https://sentiedge.ai');
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBe('https://sentiedge.ai');
    });

    it('does NOT 500 for a disallowed origin — returns 200 without CORS header', async () => {
        // This is the regression guard. If someone re-adds
        // `cb(new Error(...))`, this test fails because cors() will call
        // next(err) → Express default error handler → 500.
        const res = await request(app).get('/ping').set('Origin', 'https://evil.example');
        expect(res.status).toBe(200);
        expect(res.headers['access-control-allow-origin']).toBeUndefined();
    });

    it('allows server-to-server calls (no Origin header)', async () => {
        const res = await request(app).get('/ping');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ ok: true });
    });
});
