/**
 * E2E lifecycle — Principal-Coherence Signal (Know Your Principal / Caroline
 * identity-bleed standard, security build increment 3).
 *
 * Tier 3 of the Testing Integrity Standard. Tests the complete PRODUCTION path:
 *   Phase 1 — Feature is alive: a real AgentServer is booted the way production
 *             boots it (config on disk, the TopicOperatorStore composed in the
 *             constructor). With `monitoring.principalCoherence.enabled` true, a
 *             finalized outbound message that credits an operator-ROLE decision
 *             to a NON-operator principal causes the observe-only write to land
 *             at state/principal-coherence.jsonl. This is the "feature is alive"
 *             proof — the observe seam is really wired into the delivery path,
 *             not dead code.
 *   Phase 2 — The SIGNAL-ONLY + gating invariants over the live server: the
 *             message ALWAYS delivers (never 422), an attribution to the BOUND
 *             operator logs nothing, and with the flag OFF nothing is ever
 *             written (default-dark).
 *
 * The observe write is fire-and-forget, so reads poll for the audit file.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH_TOKEN = 'test-principal-coherence-e2e';
const auth = () => ({ Authorization: `Bearer ${AUTH_TOKEN}` });

function telegramStub(delivered: Array<{ topicId: number; text: string }>): any {
  return {
    onMessageLogged: null,
    async sendToTopic(topicId: number, text: string) { delivered.push({ topicId, text }); return {}; },
    getSessionForTopic: () => null,
    isSessionAlive: () => true,
  };
}

interface Boot {
  tmpDir: string;
  stateDir: string;
  server: AgentServer;
  app: ReturnType<AgentServer['getApp']>;
  delivered: Array<{ topicId: number; text: string }>;
}

function boot(enabled: boolean): Boot {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-e2e-'));
  const stateDir = path.join(tmpDir, '.instar');
  fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
  fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify({ port: 0, projectName: 'pc-e2e' }));
  const delivered: Array<{ topicId: number; text: string }> = [];
  const config: InstarConfig = {
    projectName: 'pc-e2e', agentName: 'E2E Agent', projectDir: tmpDir,
    stateDir, port: 0, authToken: AUTH_TOKEN,
    ...(enabled ? { monitoring: { principalCoherence: { enabled: true } } } : {}),
  } as InstarConfig;
  const sm = createMockSessionManager() as any;
  // The /telegram/reply path clears the inject tracker on send; the bare mock
  // doesn't define it (the topic-operator e2e never exercises reply, so it omits this).
  sm.clearInjectionTracker = () => {};
  const server = new AgentServer({
    config, sessionManager: sm,
    state: new StateManager(stateDir), telegram: telegramStub(delivered),
  });
  return { tmpDir, stateDir, server, app: server.getApp(), delivered };
}

function auditEntries(stateDir: string): any[] {
  const p = path.join(stateDir, 'state', 'principal-coherence.jsonl');
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

async function waitForAudit(stateDir: string, min: number): Promise<any[]> {
  for (let i = 0; i < 40; i++) {
    const e = auditEntries(stateDir);
    if (e.length >= min) return e;
    await new Promise((r) => setTimeout(r, 25));
  }
  return auditEntries(stateDir);
}

async function bind(app: Boot['app'], topicId: number, uid: string, displayName: string): Promise<void> {
  const res = await request(app).post('/topic-operator').set(auth())
    .send({ topicId, platform: 'telegram', uid, displayName });
  expect(res.status).toBe(200);
}

describe('Principal-Coherence Signal E2E lifecycle', () => {
  let on: Boot;
  let off: Boot;

  beforeAll(() => {
    on = boot(true);
    off = boot(false);
  });

  afterAll(async () => {
    for (const b of [on, off]) {
      try { await (b.server as unknown as { stop?: () => Promise<void> }).stop?.(); } catch { /* ignore */ }
      SafeFsExecutor.safeRmSync(b.tmpDir, { recursive: true, force: true, operation: 'principal-coherence-lifecycle' });
    }
  });

  // ── Phase 1: feature is alive on the production AgentServer boot path ──

  it('records an observe-only finding when a misattribution is sent (flag on, bound operator)', async () => {
    await bind(on.app, 19437, '7812716706', 'Justin');

    const res = await request(on.app).post('/telegram/reply/19437').set(auth())
      .send({ text: 'Locked the migration with Caroline under mandate (Caroline).' });
    expect(res.status).toBe(200); // message delivers
    expect(on.delivered.some((d) => d.topicId === 19437)).toBe(true);

    const entries = await waitForAudit(on.stateDir, 1);
    const caroline = entries.find((e) => e.topicId === 19437 && e.principal === 'caroline');
    expect(caroline).toBeTruthy();
    expect(caroline.operatorUid).toBe('7812716706');
    expect(caroline.operatorBound).toBe(true);
    expect(caroline.kind).toBe('principal-coherence');
  });

  // ── Phase 2: SIGNAL-ONLY + gating invariants over the live server ──

  it('SIGNAL-ONLY: a credential misattribution carries a block verdict but never blocks the message', async () => {
    await bind(on.app, 19440, '7812716706', 'Justin');
    const res = await request(on.app).post('/telegram/reply/19440').set(auth())
      .send({ text: 'Caroline dropped a token for the deploy.' });
    expect(res.status).toBe(200);   // delivered, not 422
    expect(res.status).not.toBe(422);

    const entries = await waitForAudit(on.stateDir, 1);
    const cred = entries.find((e) => e.topicId === 19440 && e.attributionKind === 'credential');
    expect(cred?.verdict).toBe('block'); // recorded, never enforced
  });

  it('an attribution to the BOUND operator logs nothing', async () => {
    await bind(on.app, 19441, '7812716706', 'Justin');
    const before = auditEntries(on.stateDir).filter((e) => e.topicId === 19441).length;
    const res = await request(on.app).post('/telegram/reply/19441').set(auth())
      .send({ text: 'Justin approved the plan, so I shipped it.' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    const after = auditEntries(on.stateDir).filter((e) => e.topicId === 19441).length;
    expect(after).toBe(before);
  });

  it('GATED: with the flag OFF, an identical misattribution writes nothing and still delivers', async () => {
    await bind(off.app, 19437, '7812716706', 'Justin');
    const res = await request(off.app).post('/telegram/reply/19437').set(auth())
      .send({ text: 'Locked with Caroline under mandate (Caroline).' });
    expect(res.status).toBe(200);
    expect(off.delivered.some((d) => d.topicId === 19437)).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    expect(auditEntries(off.stateDir)).toHaveLength(0);
  });
});
