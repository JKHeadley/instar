/**
 * Layer 1b tests — server-side agent-id binding in authMiddleware.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § Layer 1b.
 *
 * The auth middleware now takes a second argument: this server's
 * agentId. When set, the middleware validates `X-Instar-AgentId`
 * BEFORE comparing the bearer token. This makes a token sent to the
 * wrong agent's server structurally inert — the cross-tenant misroute
 * proven by the Inspec/cheryl 2026-04-27 incident is closed at the
 * trust boundary.
 *
 * Cases:
 *   - matching agent-id + correct token → 200
 *   - mismatched agent-id → 403 with structured body { error: 'agent_id_mismatch', expected }
 *     (no token data echoed)
 *   - missing agent-id header → accepted under deprecation, logs once-per-source
 *   - mismatched agent-id with WRONG token → still returns agent_id_mismatch
 *     (we never reach the token comparison)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  authMiddleware,
  _resetDeprecationLogCache,
} from '../../src/server/middleware.js';

function createApp(token: string, agentId: string) {
  const app = express();
  app.use(authMiddleware(token, agentId));
  app.get('/protected', (_req, res) => res.json({ ok: true }));
  return app;
}

describe('authMiddleware — agent-id binding (Layer 1b)', () => {
  beforeEach(() => {
    _resetDeprecationLogCache();
  });

  it('returns 200 when agent-id matches AND token matches', async () => {
    const app = createApp('tok', 'echo');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer tok')
      .set('X-Instar-AgentId', 'echo');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('returns 403 with structured body on mismatched agent-id', async () => {
    const app = createApp('tok', 'echo');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer tok')
      .set('X-Instar-AgentId', 'cheryl');
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'agent_id_mismatch', expected: 'echo' });
    // Body must not echo any token-derived information.
    expect(JSON.stringify(res.body)).not.toContain('tok');
  });

  it('returns agent_id_mismatch BEFORE token comparison (wrong token + wrong agent)', async () => {
    const app = createApp('tok', 'echo');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer wrong-token-bytes')
      .set('X-Instar-AgentId', 'cheryl');
    expect(res.status).toBe(403);
    // The error code MUST be agent_id_mismatch, not 'Invalid auth token' —
    // proving we short-circuit before token compare. This is the structural
    // guarantee: tokens never cross the trust boundary into a wrong server.
    expect(res.body.error).toBe('agent_id_mismatch');
  });

  it('accepts requests with no X-Instar-AgentId header (deprecation window)', async () => {
    const app = createApp('tok', 'echo');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer tok');
    // No X-Instar-AgentId — accepted with deduped log.
    expect(res.status).toBe(200);
  });

  it('still rejects bad tokens when agent-id header is absent (deprecation does not bypass auth)', async () => {
    const app = createApp('tok', 'echo');
    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer wrong');
    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Invalid');
  });

  it('still rejects missing Authorization header (401)', async () => {
    const app = createApp('tok', 'echo');
    const res = await request(app)
      .get('/protected')
      .set('X-Instar-AgentId', 'echo');
    expect(res.status).toBe(401);
  });

  it('agent-id binding is inactive when authMiddleware constructed without agentId', async () => {
    // Backward-compat shape: callers that don't pass agentId behave as before.
    const app = express();
    app.use(authMiddleware('tok'));
    app.get('/protected', (_req, res) => res.json({ ok: true }));

    const res = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer tok')
      .set('X-Instar-AgentId', 'whatever-value');
    expect(res.status).toBe(200);
  });
});
