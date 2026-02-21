import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authMiddleware, corsMiddleware, errorHandler, rateLimiter, signViewPath } from '../../src/server/middleware.js';

function createApp(authToken?: string) {
  const app = express();
  app.use(corsMiddleware);
  app.use(authMiddleware(authToken));

  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.get('/status', (_req, res) => res.json({ sessions: 0 }));
  app.get('/view/:id', (_req, res) => res.json({ view: 'ok' }));
  app.get('/error', () => { throw new Error('test error'); });
  app.use(errorHandler);

  return app;
}

describe('authMiddleware', () => {
  describe('when auth token is configured', () => {
    const app = createApp('test-secret-token');

    it('allows /health without auth', async () => {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });

    it('blocks requests without Authorization header', async () => {
      const res = await request(app).get('/status');
      expect(res.status).toBe(401);
      expect(res.body.error).toContain('Authorization');
    });

    it('blocks requests with wrong token', async () => {
      const res = await request(app)
        .get('/status')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Invalid');
    });

    it('allows requests with correct token', async () => {
      const res = await request(app)
        .get('/status')
        .set('Authorization', 'Bearer test-secret-token');
      expect(res.status).toBe(200);
      expect(res.body.sessions).toBe(0);
    });

    it('blocks non-Bearer auth schemes', async () => {
      const res = await request(app)
        .get('/status')
        .set('Authorization', 'Basic dGVzdDp0ZXN0');
      expect(res.status).toBe(401);
    });

    it('blocks token with different length (timing-safe)', async () => {
      const res = await request(app)
        .get('/status')
        .set('Authorization', 'Bearer short');
      expect(res.status).toBe(403);
    });

    it('blocks empty Bearer value', async () => {
      const res = await request(app)
        .get('/status')
        .set('Authorization', 'Bearer ');
      // Supertest trims the header value, so 'Bearer ' becomes 'Bearer'
      // which fails the startsWith('Bearer ') check → 401
      expect(res.status).toBe(401);
    });

    it('blocks token that is a prefix of the real token', async () => {
      const res = await request(app)
        .get('/status')
        .set('Authorization', 'Bearer test-secret');
      expect(res.status).toBe(403);
    });

    it('allows /view/ routes with valid HMAC signature', async () => {
      const viewPath = '/view/test-id-123';
      const sig = signViewPath(viewPath, 'test-secret-token');
      const res = await request(app).get(`${viewPath}?sig=${sig}`);
      expect(res.status).toBe(200);
      expect(res.body.view).toBe('ok');
    });

    it('blocks /view/ routes with invalid signature', async () => {
      const res = await request(app).get('/view/test-id-123?sig=bad-signature');
      expect(res.status).toBe(401);
    });

    it('blocks /view/ routes with signature for a different path', async () => {
      const sig = signViewPath('/view/other-id', 'test-secret-token');
      const res = await request(app).get(`/view/test-id-123?sig=${sig}`);
      expect(res.status).toBe(401);
    });

    it('blocks /view/ routes with signature from wrong token', async () => {
      const sig = signViewPath('/view/test-id-123', 'wrong-secret');
      const res = await request(app).get(`/view/test-id-123?sig=${sig}`);
      expect(res.status).toBe(401);
    });

    it('signed URLs only work for /view/ routes, not other endpoints', async () => {
      const sig = signViewPath('/status', 'test-secret-token');
      const res = await request(app).get(`/status?sig=${sig}`);
      expect(res.status).toBe(401);
    });
  });

  describe('when auth token is not configured', () => {
    const app = createApp(undefined);

    it('allows all requests without auth', async () => {
      const res = await request(app).get('/status');
      expect(res.status).toBe(200);
    });
  });
});

describe('corsMiddleware', () => {
  const app = createApp();

  it('handles OPTIONS preflight', async () => {
    const res = await request(app).options('/status');
    expect(res.status).toBe(204);
  });

  it('sets CORS headers on regular requests', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['access-control-allow-methods']).toContain('GET');
  });
});

describe('errorHandler', () => {
  const app = createApp();

  it('returns 500 with generic error message (no internal details leaked)', async () => {
    const res = await request(app).get('/error');
    expect(res.status).toBe(500);
    // Should NOT leak internal error details to client
    expect(res.body.error).toBe('Internal server error');
    expect(res.body.error).not.toContain('test error');
    expect(res.body).toHaveProperty('timestamp');
  });

  it('errorHandler uses proper type narrowing (not err: any)', () => {
    const source = require('fs').readFileSync(
      require('path').join(process.cwd(), 'src/server/middleware.ts'),
      'utf-8'
    );
    // Should use `err: unknown` not `err: any`
    expect(source).toContain('err: unknown');
    expect(source).not.toContain('err: any');
    // Should use instanceof Error check
    expect(source).toContain('err instanceof Error');
  });
});

describe('rateLimiter', () => {
  it('rate limiter is per-IP (not global)', () => {
    const source = require('fs').readFileSync(
      require('path').join(process.cwd(), 'src/server/middleware.ts'),
      'utf-8'
    );
    // Should use a Map keyed by IP, not a single array
    expect(source).toContain('new Map');
    expect(source).toContain('req.ip');
  });

  it('allows requests within limit', async () => {
    const app = express();
    app.use(rateLimiter(60_000, 3));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    const res = await request(app).get('/test');
    expect(res.status).toBe(200);
  });

  it('returns 429 when limit exceeded', async () => {
    const app = express();
    app.use(rateLimiter(60_000, 2));
    app.get('/test', (_req, res) => res.json({ ok: true }));

    await request(app).get('/test');
    await request(app).get('/test');
    const res = await request(app).get('/test');
    expect(res.status).toBe(429);
    expect(res.body.error).toContain('Rate limit exceeded');
    expect(res.body).toHaveProperty('retryAfterMs');
  });
});
