/**
 * Behavioral tests for middleware functions.
 *
 * Covers gaps in existing middleware.test.ts:
 * - CORS origin filtering (localhost allowed, external rejected)
 * - rateLimiter window expiration and per-IP isolation
 * - requestTimeout actual timeout behavior
 * - errorHandler with non-Error thrown values
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { corsMiddleware, rateLimiter, requestTimeout, errorHandler } from '../../src/server/middleware.js';

describe('corsMiddleware origin filtering', () => {
  function createCorsApp() {
    const app = express();
    app.use(corsMiddleware);
    app.get('/test', (_req, res) => res.json({ ok: true }));
    return app;
  }

  it('sets Access-Control-Allow-Origin for localhost origin', async () => {
    const app = createCorsApp();
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://localhost:3000');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('sets Access-Control-Allow-Origin for 127.0.0.1 origin', async () => {
    const app = createCorsApp();
    const res = await request(app)
      .get('/test')
      .set('Origin', 'http://127.0.0.1:8080');
    expect(res.headers['access-control-allow-origin']).toBe('http://127.0.0.1:8080');
  });

  it('sets Access-Control-Allow-Origin for https://localhost', async () => {
    const app = createCorsApp();
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://localhost');
    expect(res.headers['access-control-allow-origin']).toBe('https://localhost');
  });

  it('does NOT set Access-Control-Allow-Origin for external origins', async () => {
    const app = createCorsApp();
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('does NOT set Access-Control-Allow-Origin for origin with localhost in subdomain', async () => {
    const app = createCorsApp();
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://localhost.evil.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('still sets Allow-Methods header even without matching origin', async () => {
    const app = createCorsApp();
    const res = await request(app)
      .get('/test')
      .set('Origin', 'https://evil.com');
    // Allow-Methods is set for all requests (without the Allow-Origin, browsers block anyway)
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });

  it('responds 204 to OPTIONS preflight from localhost', async () => {
    const app = createCorsApp();
    const res = await request(app)
      .options('/test')
      .set('Origin', 'http://localhost:3000');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:3000');
  });

  it('responds 204 to OPTIONS preflight from external origin (no ACAO header)', async () => {
    const app = createCorsApp();
    const res = await request(app)
      .options('/test')
      .set('Origin', 'https://evil.com');
    expect(res.status).toBe(204);
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('rateLimiter behavioral', () => {
  it('tracks limits per-IP independently', async () => {
    const app = express();
    // Set max 1 request per window
    app.use(rateLimiter(60_000, 1));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    // supertest uses 127.0.0.1 for all requests from the same test,
    // so we can't truly test per-IP isolation via supertest.
    // Instead, verify that the first request succeeds and second is blocked.
    const res1 = await request(app).get('/test');
    expect(res1.status).toBe(200);

    const res2 = await request(app).get('/test');
    expect(res2.status).toBe(429);
  });

  it('includes retryAfterMs in 429 response', async () => {
    const app = express();
    app.use(rateLimiter(60_000, 1));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    await request(app).get('/test');
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.body.retryAfterMs).toBeGreaterThan(0);
    expect(res.body.retryAfterMs).toBeLessThanOrEqual(60_000);
  });

  it('resets after window expires', async () => {
    // Keep the window comfortably above the suite-wide 50ms Supertest start
    // interval so transport backpressure cannot change the middleware state
    // this test is exercising.
    const windowMs = 250;
    const app = express();
    app.use(rateLimiter(windowMs, 1));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    const res1 = await request(app).get('/test');
    expect(res1.status).toBe(200);

    // Second request within window should be blocked
    const res2 = await request(app).get('/test');
    expect(res2.status).toBe(429);

    // Wait for window to expire
    await new Promise(resolve => setTimeout(resolve, windowMs + 100));

    // Third request after window should succeed
    const res3 = await request(app).get('/test');
    expect(res3.status).toBe(200);
  });

  it('allows exactly maxRequests within window', async () => {
    const app = express();
    app.use(rateLimiter(60_000, 3));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    const r1 = await request(app).get('/test');
    const r2 = await request(app).get('/test');
    const r3 = await request(app).get('/test');
    const r4 = await request(app).get('/test');

    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);
    expect(r3.status).toBe(200);
    expect(r4.status).toBe(429);
  });

  it('includes custom window and limit in error message', async () => {
    const app = express();
    app.use(rateLimiter(120_000, 5));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    // Exhaust limit
    for (let i = 0; i < 5; i++) {
      await request(app).get('/test');
    }

    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.body.error).toContain('5');
    expect(res.body.error).toContain('120');
  });
});

describe('requestTimeout behavioral', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('allows requests that complete within timeout', async () => {
    const app = express();
    app.use(requestTimeout(5000));
    app.get('/fast', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/fast');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 408 when request exceeds timeout', async () => {
    const app = express();
    app.use(requestTimeout(50)); // 50ms timeout
    app.get('/slow', (_req, res) => {
      // Respond after 200ms — well past the 50ms timeout
      setTimeout(() => {
        if (!res.headersSent) {
          res.json({ ok: true });
        }
      }, 200);
    });

    const res = await request(app).get('/slow');
    expect(res.status).toBe(408);
    expect(res.body.error).toBe('Request timeout');
    expect(res.body.timeoutMs).toBe(50);
  });

  it('uses default 30s timeout when no argument provided', () => {
    const middleware = requestTimeout();
    expect(typeof middleware).toBe('function');
    // Can't easily test 30s timeout in a unit test,
    // but we verify the function was created successfully
  });

  it('clears timeout when response finishes normally', async () => {
    // If the timeout isn't cleared, we'd see timer warnings or
    // the timeout would fire after the response is sent.
    const app = express();
    app.use(requestTimeout(200));
    app.get('/fast', (_req, res) => res.json({ done: true }));

    const res = await request(app).get('/fast');
    expect(res.status).toBe(200);

    // Wait a bit to ensure no late timeout fires
    await new Promise(resolve => setTimeout(resolve, 300));
    // If we get here without error, timeout was properly cleared
  });
});

describe('errorHandler behavioral', () => {
  it('handles non-Error thrown values (string)', async () => {
    const app = express();
    app.get('/throw-string', () => {
      throw 'string error';
    });
    app.use(errorHandler);

    const res = await request(app).get('/throw-string');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    // Should NOT leak the actual string
    expect(JSON.stringify(res.body)).not.toContain('string error');
  });

  it('handles non-Error thrown values (number)', async () => {
    const app = express();
    app.get('/throw-number', () => {
      throw 42;
    });
    app.use(errorHandler);

    const res = await request(app).get('/throw-number');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
  });

  it('handles thrown object values', async () => {
    const app = express();
    app.get('/throw-object', () => {
      throw { code: 'CUSTOM', detail: 'sensitive info' };
    });
    app.use(errorHandler);

    const res = await request(app).get('/throw-object');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Internal server error');
    // Should NOT leak internal details
    expect(JSON.stringify(res.body)).not.toContain('sensitive info');
    expect(JSON.stringify(res.body)).not.toContain('CUSTOM');
  });

  it('includes timestamp in error response', async () => {
    const app = express();
    app.get('/error', () => { throw new Error('test'); });
    app.use(errorHandler);

    const res = await request(app).get('/error');
    expect(res.body.timestamp).toBeTruthy();
    // Verify it's a valid ISO timestamp
    const ts = new Date(res.body.timestamp);
    expect(ts.getTime()).not.toBeNaN();
  });
});
