/**
 * Integration test — Principal-Coherence Signal (Know Your Principal / Caroline
 * identity-bleed standard, security build increment 3).
 *
 * Tier 2: the full HTTP pipeline. A finalized outbound message that credits an
 * operator-ROLE decision (approval / mandate / credential / lock / acting-for)
 * to a principal who is NOT the topic's VERIFIED operator is recorded — observe
 * only — as a line in `state/principal-coherence.jsonl`. The check is gated on
 * `monitoring.principalCoherence.enabled` and a wired TopicOperatorStore, and it
 * is SIGNAL-ONLY: it NEVER blocks, delays, or rewrites the message (the reply
 * always returns 200 and the text always delivers).
 *
 * Gating + correctness asserted on both sides of every boundary:
 *   - flag ON + bound operator + misattribution to an OUTSIDER  → one finding logged
 *   - flag ON + attribution to the BOUND operator               → nothing logged
 *   - flag ON + NO bound operator + misattribution              → logged (unverifiable)
 *   - flag OFF                                                   → nothing logged
 *   - in every case the message still delivers (never 422)
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createMockSessionManager } from '../helpers/setup.js';
import type { InstarConfig } from '../../src/core/types.js';

const AUTH = 'pc-int-token';
const auth = () => ({ Authorization: `Bearer ${AUTH}` });

interface Built { dir: string; server: AgentServer; delivered: Array<{ topicId: number; text: string }>; }

function telegramStub(delivered: Array<{ topicId: number; text: string }>): any {
  return {
    onMessageLogged: null,
    async sendToTopic(topicId: number, text: string) { delivered.push({ topicId, text }); return {}; },
    getSessionForTopic: () => null,
    isSessionAlive: () => true,
  };
}

function build(opts: { enabled: boolean }): Built {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-int-'));
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'sessions'), { recursive: true });
  fs.mkdirSync(path.join(dir, '.instar', 'state', 'jobs'), { recursive: true });
  const delivered: Array<{ topicId: number; text: string }> = [];
  const config: InstarConfig = {
    projectName: 'pc-int', agentName: 'Int', projectDir: dir,
    stateDir: path.join(dir, '.instar'), port: 0, authToken: AUTH,
    ...(opts.enabled ? { monitoring: { principalCoherence: { enabled: true } } } : {}),
  } as InstarConfig;
  const sm = createMockSessionManager() as any;
  sm.clearInjectionTracker = () => {};
  const server = new AgentServer({
    config, sessionManager: sm, state: new StateManager(path.join(dir, '.instar')), telegram: telegramStub(delivered),
  });
  return { dir, server, delivered };
}

/** Bind a verified operator for a topic over the wire (the WRITE side). */
async function bindOperator(server: AgentServer, topicId: number, uid: string, displayName: string): Promise<void> {
  const res = await request(server.getApp()).post('/topic-operator').set(auth())
    .send({ topicId, platform: 'telegram', uid, displayName });
  expect(res.status).toBe(200);
  expect(res.body.bound).toBe(true);
}

function auditPath(dir: string): string {
  return path.join(dir, '.instar', 'state', 'principal-coherence.jsonl');
}

/** Read the audit jsonl, returning parsed entries (the observe write is async). */
function readAudit(dir: string): any[] {
  const p = auditPath(dir);
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Poll until at least `min` audit entries are present (observe call is fire-and-forget). */
async function waitForAudit(dir: string, min: number): Promise<any[]> {
  for (let i = 0; i < 40; i++) {
    const entries = readAudit(dir);
    if (entries.length >= min) return entries;
    await new Promise((r) => setTimeout(r, 25));
  }
  return readAudit(dir);
}

describe('Principal-Coherence Signal — observe-only recording path (integration)', () => {
  let built: Built | null = null;
  afterEach(() => {
    if (built) { SafeFsExecutor.safeRmSync(built.dir, { recursive: true, force: true, operation: 'pc-int' }); built = null; }
  });

  it('logs a finding when an outbound message credits an OUTSIDER in an authority role (flag on, operator bound)', async () => {
    built = build({ enabled: true });
    await bindOperator(built.server, 701, '55501', 'Justin');

    const res = await request(built.server.getApp())
      .post('/telegram/reply/701').set(auth())
      .send({ text: 'Locked the migration with Caroline and shipped it under mandate (Caroline).' });
    // SIGNAL-ONLY: the message always delivers; never blocked.
    expect(res.status).toBe(200);
    expect(built.delivered.some((d) => d.topicId === 701)).toBe(true);

    const entries = await waitForAudit(built.dir, 1);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    const caroline = entries.find((e) => e.principal === 'caroline');
    expect(caroline).toBeTruthy();
    expect(caroline.kind).toBe('principal-coherence');
    expect(caroline.topicId).toBe(701);
    expect(caroline.operatorUid).toBe('55501');
    expect(caroline.operatorBound).toBe(true);
    // The credential/mandate-bearing kind carries a block verdict — RECORDED only.
    const mandate = entries.find((e) => e.principal === 'caroline' && e.attributionKind === 'mandate');
    expect(mandate?.verdict).toBe('block');
  });

  it('logs NOTHING when the attribution resolves to the BOUND operator', async () => {
    built = build({ enabled: true });
    await bindOperator(built.server, 702, '55502', 'Justin');

    const res = await request(built.server.getApp())
      .post('/telegram/reply/702').set(auth())
      .send({ text: 'Justin approved the plan, so I shipped it.' });
    expect(res.status).toBe(200);

    // Give the async observe call time to run, then assert no file/entries.
    await new Promise((r) => setTimeout(r, 150));
    expect(readAudit(built.dir)).toHaveLength(0);
  });

  it('logs a finding with operatorBound=false when NO operator is bound (flag on)', async () => {
    built = build({ enabled: true });
    // No bindOperator call — the topic is unbound.

    const res = await request(built.server.getApp())
      .post('/telegram/reply/703').set(auth())
      .send({ text: 'Mandate (Caroline) authorized the credential handoff.' });
    expect(res.status).toBe(200);

    const entries = await waitForAudit(built.dir, 1);
    expect(entries.length).toBeGreaterThanOrEqual(1);
    expect(entries[0].operatorBound).toBe(false);
    expect(entries[0].operatorUid).toBeNull();
    expect(entries[0].principal).toBe('caroline');
  });

  it('GATED: flag OFF records nothing and the message still delivers', async () => {
    built = build({ enabled: false });
    await bindOperator(built.server, 704, '55504', 'Justin');

    const res = await request(built.server.getApp())
      .post('/telegram/reply/704').set(auth())
      .send({ text: 'Locked with Caroline under mandate (Caroline).' });
    expect(res.status).toBe(200);
    expect(built.delivered.some((d) => d.topicId === 704)).toBe(true);

    await new Promise((r) => setTimeout(r, 150));
    expect(readAudit(built.dir)).toHaveLength(0);
  });

  it('never writes the verdict as an enforcement (a blocked verdict is recorded but the message is NOT 422)', async () => {
    built = build({ enabled: true });
    await bindOperator(built.server, 705, '55505', 'Justin');

    const res = await request(built.server.getApp())
      .post('/telegram/reply/705').set(auth())
      .send({ text: 'Caroline dropped a token for the deploy.' });
    // 'credential' kind → block verdict in the finding — but observe-only, so 200.
    expect(res.status).toBe(200);

    const entries = await waitForAudit(built.dir, 1);
    const cred = entries.find((e) => e.attributionKind === 'credential');
    expect(cred).toBeTruthy();
    expect(cred.verdict).toBe('block'); // recorded
    expect(res.status).not.toBe(422);   // never enforced
  });
});
