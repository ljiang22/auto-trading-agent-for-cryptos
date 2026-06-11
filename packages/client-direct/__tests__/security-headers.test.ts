import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { securityHeadersMiddleware } from '../src/index.ts';

// Regression guard for the X-Frame-Options: DENY incident that broke
// ChartEmbed <iframe src="/charts/..."> in production on 2026-04-22.
// See packages/client-direct/src/index.ts — securityHeadersMiddleware.
function makeApp() {
    const app = express();
    app.use(securityHeadersMiddleware);
    // Stands in for the chart iframe target.
    app.get('/charts/sample.html', (_req, res) => {
        res.type('html').send('<html><body>chart</body></html>');
    });
    app.get('/', (_req, res) => res.type('html').send('<html></html>'));
    return app;
}

describe('securityHeadersMiddleware', () => {
    const originalNodeEnv = process.env.NODE_ENV;

    afterEach(() => {
        process.env.NODE_ENV = originalNodeEnv;
    });

    it("sets CSP frame-ancestors 'self' in production so same-origin ChartEmbed iframes render", async () => {
        process.env.NODE_ENV = 'production';
        const res = await request(makeApp()).get('/charts/sample.html');
        expect(res.status).toBe(200);
        expect(res.headers['content-security-policy']).toBe("frame-ancestors 'self'");
    });

    it('allows localhost:5173 (Vite dev) and localhost:3000 as frame ancestors in development', async () => {
        // In dev the React app runs on 5173 and Express on 3000 — different
        // origins — so 'self' alone would block ChartEmbed iframes.
        process.env.NODE_ENV = 'development';
        const res = await request(makeApp()).get('/charts/sample.html');
        expect(res.status).toBe(200);
        expect(res.headers['content-security-policy']).toBe(
            "frame-ancestors 'self' http://localhost:3000 http://localhost:5173"
        );
    });

    it('does NOT set X-Frame-Options — DENY blocks same-origin iframes too', async () => {
        const res = await request(makeApp()).get('/charts/sample.html');
        expect(res.headers['x-frame-options']).toBeUndefined();
    });

    it('does NOT set X-XSS-Protection (deprecated header)', async () => {
        const res = await request(makeApp()).get('/');
        expect(res.headers['x-xss-protection']).toBeUndefined();
    });

    it('sets X-Content-Type-Options and Referrer-Policy', async () => {
        const res = await request(makeApp()).get('/');
        expect(res.headers['x-content-type-options']).toBe('nosniff');
        expect(res.headers['referrer-policy']).toBe('strict-origin-when-cross-origin');
    });

    it('sets HSTS only when NODE_ENV=production', async () => {
        process.env.NODE_ENV = 'production';
        const prodRes = await request(makeApp()).get('/');
        expect(prodRes.headers['strict-transport-security']).toBe(
            'max-age=31536000; includeSubDomains'
        );

        process.env.NODE_ENV = 'development';
        const devRes = await request(makeApp()).get('/');
        expect(devRes.headers['strict-transport-security']).toBeUndefined();
    });
});
