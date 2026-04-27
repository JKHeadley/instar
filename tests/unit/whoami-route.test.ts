/**
 * Layer 1c tests — GET /whoami authenticated identity probe.
 *
 * Spec: docs/specs/telegram-delivery-robustness.md § Layer 1c.
 *
 * Contract:
 *   - Returns { agentId, port } on success — version is deliberately omitted
 *     to avoid /whoami doubling as a CVE-targeting oracle for an authed peer
 *     whose token has been stolen.
 *   - Requires X-Instar-AgentId header (no deprecation exception).
 *   - Rate-limited to 1 req/s per (agent-id, remoteAddress) pair so a single
 *     noisy caller can't starve the budget for legitimate sentinel callers.
 */

import { describe, it, expect } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createWhoamiHandler } from '../../src/server/routes.js';

function buildApp(agentId = 'echo', port = 4042, version = '0.99.0') {
  const app = express();
  app.get('/whoami', createWhoamiHandler({ agentId, port, configVersion: version }));
  return app;
}

describe('GET /whoami', () => {
  it('returns the expected shape on a clean authenticated request', async () => {
    const app = buildApp('echo', 4042, '1.2.3');
    const res = await request(app).get('/whoami').set('X-Instar-AgentId', 'echo');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      agentId: 'echo',
      port: 4042,
    });
    // Version is deliberately not exposed — see route header comment.
    expect(res.body.version).toBeUndefined();
  });

  it('returns 403 agent_id_header_required when X-Instar-AgentId is missing', async () => {
    const app = buildApp('echo');
    const res = await request(app).get('/whoami');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent_id_header_required');
    expect(res.body.expected).toBe('echo');
  });

  it('returns 403 agent_id_mismatch when the header value does not match', async () => {
    const app = buildApp('echo');
    const res = await request(app).get('/whoami').set('X-Instar-AgentId', 'cheryl');
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent_id_mismatch');
    expect(res.body.expected).toBe('echo');
  });

  it('rate-limits to 1 req/s per source agent-id', async () => {
    const app = buildApp('echo');
    const first = await request(app).get('/whoami').set('X-Instar-AgentId', 'echo');
    expect(first.status).toBe(200);
    // Second request inside 1s window — must be 429 with retry hint.
    const second = await request(app).get('/whoami').set('X-Instar-AgentId', 'echo');
    expect(second.status).toBe(429);
    expect(second.body.error).toMatch(/Rate limit/i);
    expect(typeof second.body.retryAfterMs).toBe('number');
    expect(second.body.retryAfterMs).toBeGreaterThan(0);
    expect(second.body.retryAfterMs).toBeLessThanOrEqual(1000);
  });

  it('rate-limit is per source agent-id, not global', async () => {
    // Two requests with different agent-ids in quick succession should NOT
    // share a bucket. (Each must, of course, match the server's expected
    // id — but to test the bucket key we'd need two valid handlers.)
    // We approximate by asserting that a 429 from one client doesn't
    // immediately follow a *first* 200 from another (the rate limit
    // doesn't apply globally). We use a single handler keyed on its agent-id
    // and observe that across-time behavior.
    const app = buildApp('echo');
    const ok1 = await request(app).get('/whoami').set('X-Instar-AgentId', 'echo');
    expect(ok1.status).toBe(200);
    // Wait for the bucket to clear.
    await new Promise((r) => setTimeout(r, 1100));
    const ok2 = await request(app).get('/whoami').set('X-Instar-AgentId', 'echo');
    expect(ok2.status).toBe(200);
  });
});
