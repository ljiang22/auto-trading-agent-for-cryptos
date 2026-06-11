import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { chatLimiter, imageLimiter, ttsLimiter, whisperLimiter } from '../../packages/client-direct/src/rateLimiters.ts';

function buildApp(limiter: ReturnType<typeof chatLimiter>) {
    const app = express();
    app.use(express.json());
    app.post('/test', limiter, (_req, res) => res.json({ ok: true }));
    return app;
}

async function fireN(app: express.Application, n: number) {
    const results: number[] = [];
    for (let i = 0; i < n; i++) {
        const res = await request(app).post('/test').send({});
        results.push(res.status);
    }
    return results;
}

describe('Rate limiters', () => {
    it('chatLimiter: allows 10, blocks 11th with 429', async () => {
        const app = buildApp(chatLimiter);
        const statuses = await fireN(app, 11);
        expect(statuses.slice(0, 10).every(s => s === 200)).toBe(true);
        expect(statuses[10]).toBe(429);
    });

    it('imageLimiter: allows 2, blocks 3rd with 429', async () => {
        const app = buildApp(imageLimiter);
        const statuses = await fireN(app, 3);
        expect(statuses.slice(0, 2).every(s => s === 200)).toBe(true);
        expect(statuses[2]).toBe(429);
    });

    it('429 response contains expected error message', async () => {
        const app = buildApp(imageLimiter);
        await fireN(app, 2);
        const res = await request(app).post('/test').send({});
        expect(res.status).toBe(429);
        expect(res.body).toMatchObject({ error: 'Too many requests, please try again in a minute.' });
    });

    it('ttsLimiter: allows 5, blocks 6th with 429', async () => {
        const app = buildApp(ttsLimiter);
        const statuses = await fireN(app, 6);
        expect(statuses.slice(0, 5).every(s => s === 200)).toBe(true);
        expect(statuses[5]).toBe(429);
    });

    it('whisperLimiter: allows 3, blocks 4th with 429', async () => {
        const app = buildApp(whisperLimiter);
        const statuses = await fireN(app, 4);
        expect(statuses.slice(0, 3).every(s => s === 200)).toBe(true);
        expect(statuses[3]).toBe(429);
    });
});
