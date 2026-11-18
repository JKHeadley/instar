/**
 * Integration (Tier 2) for docs/specs/identity-security-piece1h-no-token-refusal.md: the auth
 * middleware mounted in a real HTTP server with a key the secret store did not load.
 */
import { afterEach, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authMiddleware, bearerMatches } from '../../src/server/middleware.js';

const PLACEHOLDER = { secret: true } as unknown as string;
let token: unknown = PLACEHOLDER;

function app() {
  const a = express();
  a.use(express.json());
  a.use(authMiddleware(() => token as string | undefined, 'agent'));
  a.get('/health', (_req, res) => res.json({ status: 'ok' }));
  a.get('/status', (_req, res) => res.json({ ok: true }));
  // a self-gated route, like the ones mounted ahead of the middleware
  a.get('/self-gated', (req, res) => (bearerMatches(req as never, token as string) ? res.json({ ok: true }) : res.status(401).json({ error: 'no' })));
  return a;
}

afterEach(() => { token = PLACEHOLDER; });

describe('agent key over HTTP', () => {
  it('unreadable key: protected 503, /health open, a self-gated route refuses', async () => {
    const a = app();
    expect((await request(a).get('/status').set('Authorization', 'Bearer x')).status).toBe(503);
    expect((await request(a).get('/health')).status).toBe(200);
    expect((await request(a).get('/self-gated').set('Authorization', 'Bearer x')).status).toBe(401);
  });

  it('the live getter: once the key loads, the same server accepts it with no restart', async () => {
    const a = app();
    expect((await request(a).get('/status').set('Authorization', 'Bearer real')).status).toBe(503);
    token = 'real';
    expect((await request(a).get('/status').set('Authorization', 'Bearer real').set('X-Instar-AgentId', 'agent')).status).toBe(200);
    expect((await request(a).get('/status').set('Authorization', 'Bearer wrong').set('X-Instar-AgentId', 'agent')).status).toBe(403);
  });

  it('no key: served as today', async () => {
    token = undefined;
    const a = app();
    expect((await request(a).get('/status')).status).toBe(200);
    expect((await request(a).get('/self-gated')).status).toBe(200);
  });
});
