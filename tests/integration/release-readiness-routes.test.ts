/**
 * Integration — /release-readiness routes (Layer B, release-readiness-visibility).
 *
 * Mounts the REAL router with a REAL ReleaseReadinessSentinel (controllable
 * deps) and exercises the HTTP surface end-to-end. Also serves as the bug-fix
 * evidence: a blocked + aged backlog (the original silent-stall shape) produces
 * exactly one Attention signal once a tick runs — i.e. the stall now surfaces.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import {
  ReleaseReadinessSentinel,
  type ReleaseReadinessSentinelDeps,
  type ReadinessState,
  type AttentionItem,
} from '../../src/monitoring/ReleaseReadinessSentinel.js';
import { createRoutes } from '../../src/server/routes.js';

const DAY = 24 * 60 * 60 * 1000;

interface Server { url: string; close: () => Promise<void>; }
async function listen(app: express.Express): Promise<Server> {
  return new Promise((resolve) => {
    const srv = app.listen(0, () => {
      const port = (srv.address() as AddressInfo).port;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => srv.close(() => r())) });
    });
  });
}

function makeSentinel(over: Partial<{ blocked: boolean; ageDays: number }> = {}) {
  const posted: AttentionItem[] = [];
  const resolved: Array<{ id: string; reason: string }> = [];
  let state: ReadinessState = ReleaseReadinessSentinel.emptyState();
  const clock = Date.UTC(2026, 4, 27);
  const blocked = over.blocked ?? true;
  const ageDays = over.ageDays ?? 5;
  const deps: ReleaseReadinessSentinelDeps = {
    fetchCanonical: async () => ({ ok: true, headSha: 'f'.repeat(40) }),
    runAnalyzer: async () => ({
      lastTag: 'v1.0.0',
      commitCount: blocked ? 3 : 0,
      analysis: { commitClassification: { features: blocked ? 3 : 0, fixes: 0 } },
      guideCoverage: { criticalGaps: 0, highGaps: 0 },
    }),
    oldestUnreleasedCommit: async () => (blocked ? { sha: 'a'.repeat(40), dateMs: clock - ageDays * DAY } : null),
    guideBlocksPublish: async () => blocked,
    draftGuide: async () => {},
    postAttention: async (i) => { posted.push(i); return true; },
    resolveAttention: async (id, reason) => { resolved.push({ id, reason }); return true; },
    loadState: () => state,
    saveState: (s) => { state = s; },
    isAncestor: async () => false,
    audit: () => {},
    now: () => clock,
  };
  return { sentinel: new ReleaseReadinessSentinel(deps, { enabled: true }), posted, resolved };
}

function buildApp(sentinel: ReleaseReadinessSentinel | null): express.Express {
  const app = express();
  app.use(express.json());
  const ctx: any = { releaseReadinessSentinel: sentinel, config: { authToken: 'test', stateDir: '/tmp', port: 0 }, stateDir: '/tmp' };
  app.use(createRoutes(ctx));
  return app;
}

describe('/release-readiness routes', () => {
  let server: Server;
  afterEach(async () => { if (server) await server.close(); });

  it('GET returns 200 with state when the sentinel is wired (feature is alive, not 503)', async () => {
    const { sentinel } = makeSentinel();
    server = await listen(buildApp(sentinel));
    const resp = await fetch(`${server.url}/release-readiness`);
    expect(resp.status).toBe(200);
    expect(resp.headers.get('x-readiness-source')).toBe('leader');
    const body = await resp.json();
    expect(body).toHaveProperty('disabled', false);
    expect(body).toHaveProperty('openEpisodes');
  });

  it('GET returns 503 when no sentinel is configured (no analyzable repo)', async () => {
    server = await listen(buildApp(null));
    const resp = await fetch(`${server.url}/release-readiness`);
    expect(resp.status).toBe(503);
  });

  it('reproduces the stall: a blocked+aged backlog raises exactly one Attention signal after a tick', async () => {
    const { sentinel, posted } = makeSentinel({ blocked: true, ageDays: 5 });
    server = await listen(buildApp(sentinel));
    const tick = await fetch(`${server.url}/release-readiness/tick`, { method: 'POST' });
    expect(tick.status).toBe(200);
    expect(posted).toHaveLength(1);
    expect(posted[0].title).toContain('Release blocked');
    // Re-ticking does not duplicate the signal (deduped on the oldest-commit SHA).
    await fetch(`${server.url}/release-readiness/tick`, { method: 'POST' });
    expect(posted).toHaveLength(1);
    // The open episode is visible via GET.
    const body = await (await fetch(`${server.url}/release-readiness`)).json();
    expect(body.openEpisodes).toBe(1);
  });

  it('a clean (unblocked) backlog produces no signal', async () => {
    const { sentinel, posted } = makeSentinel({ blocked: false });
    server = await listen(buildApp(sentinel));
    await fetch(`${server.url}/release-readiness/tick`, { method: 'POST' });
    expect(posted).toHaveLength(0);
  });

  it('rollback is loud: disables + raises a HIGH attention item + audits', async () => {
    const { sentinel, posted } = makeSentinel();
    server = await listen(buildApp(sentinel));
    const resp = await fetch(`${server.url}/release-readiness/rollback`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'sess-1' }),
    });
    expect(resp.status).toBe(200);
    const high = posted.find((p) => p.id === 'release-readiness-rolled-back');
    expect(high?.priority).toBe('HIGH');
    // After rollback, a tick no-ops (disabled) — no further signals.
    const before = posted.length;
    await fetch(`${server.url}/release-readiness/tick`, { method: 'POST' });
    expect(posted.length).toBe(before);
    // Re-enable re-arms it.
    const en = await fetch(`${server.url}/release-readiness/enable`, { method: 'POST' });
    expect(en.status).toBe(200);
    const state = await (await fetch(`${server.url}/release-readiness`)).json();
    expect(state.disabled).toBe(false);
  });
});
