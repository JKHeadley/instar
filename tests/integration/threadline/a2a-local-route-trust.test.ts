/**
 * Local-route trust — integration tier (docs/specs/a2a-local-route-trust.md, ACT-056).
 *
 * The REAL `POST /messages/relay-agent` route on a real AgentServer, with a
 * real MessageRouter, a real AgentTrustManager (inside a real unified trust
 * system), the real inbound-id ledger and a real known-agents registry. Only
 * the ThreadlineRouter is a recording fake (it would spawn sessions).
 *
 * Covers every mode — gate off, dry-run, enforcing, no trust manager — and
 * that an enforcing refusal is PRE-ADMISSION: no inbox entry, no ledger row,
 * no content-window reservation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../../src/messaging/MessageRouter.js';
import { generateAgentToken, deleteAgentToken } from '../../../src/messaging/AgentTokenManager.js';
import { AgentTrustManager } from '../../../src/threadline/AgentTrustManager.js';
import { createUnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
import type { UnifiedTrustSystem } from '../../../src/threadline/UnifiedTrustWiring.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

const FP_KNOWN = 'c'.repeat(32);   // "peer-known" in known-agents.json
const FP_OTHER = 'd'.repeat(32);   // a fingerprint only ever asserted in a body

type Counters = { enabled: boolean; dryRun: boolean; trustManagerWired: boolean; evaluated: number; allowed: number; wouldRefuse: number; refused: number; noTrustManager: number; lookupErrors: number };

function configFor(project: TempProject, name: string, auth: string): InstarConfig {
  return {
    projectName: name, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: auth,
    requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {}, users: [],
    threadline: {},
  } as InstarConfig;
}

async function buildServer(name: string, auth: string, withTrust: boolean) {
  const project = createTempProject();
  const messagingDir = path.join(project.stateDir, 'messages');
  fs.mkdirSync(messagingDir, { recursive: true });
  fs.mkdirSync(path.join(project.stateDir, 'threadline'), { recursive: true });
  fs.writeFileSync(path.join(project.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({
    agents: [{ name: 'peer-known', port: 1, fingerprint: FP_KNOWN }],
  }));
  const messageStore = new MessageStore(messagingDir);
  await messageStore.initialize();
  const delivery = new MessageDelivery(new MessageFormatter(), {
    getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false, sendKeys: () => true, getOutputLineCount: () => 100,
  });
  const messageRouter = new MessageRouter(messageStore, delivery, { localAgent: name, localMachine: 'test-machine', serverUrl: 'http://localhost:0' });
  const token = generateAgentToken(name);
  const trustManager = withTrust ? new AgentTrustManager({ stateDir: project.stateDir }) : null;
  const unifiedTrust: UnifiedTrustSystem | undefined = trustManager
    ? createUnifiedTrustSystem(trustManager, { stateDir: project.stateDir })
    : undefined;
  const handleInboundMessage = vi.fn(async () => ({ handled: true, accepted: true, delivered: true, spawned: true, threadId: 't', path: 'cold' }));
  const config = configFor(project, name, auth);
  const server = new AgentServer({
    config,
    sessionManager: createMockSessionManager() as never,
    state: project.state,
    messageRouter,
    threadlineRouter: { handleInboundMessage } as never,
    ...(unifiedTrust ? { unifiedTrust } : {}),
  } as never);
  await server.start();
  return {
    project, messageStore, messageRouter, token, trustManager, unifiedTrust, handleInboundMessage, config, server,
    app: server.getApp(),
    async stop() {
      await server.stop();
      unifiedTrust?.shutdown();
      await messageStore.destroy();
      deleteAgentToken(name);
      project.cleanup();
    },
  };
}

function envelope(to: string, o: { from?: string; assertedFp?: string; body?: unknown; id?: string } = {}) {
  const now = new Date().toISOString();
  return {
    schemaVersion: 1,
    message: {
      id: o.id ?? `lrt-${crypto.randomUUID()}`,
      from: { agent: o.from ?? 'peer-known', session: 's', machine: 'remote', ...(o.assertedFp ? { fingerprint: o.assertedFp } : {}) },
      to: { agent: to, session: 'best', machine: 'local' },
      type: 'request', priority: 'medium', subject: 'hello',
      body: o.body ?? `body ${crypto.randomUUID()}`,
      threadId: crypto.randomUUID(), createdAt: now, ttlMinutes: 30,
    },
    transport: { relayChain: ['remote'], originServer: 'http://localhost:0', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
    delivery: { phase: 'sent', transitions: [], attempts: 0 },
  };
}

describe('/messages/relay-agent — local-route trust (real route)', () => {
  const NAME = `lrt-int-${process.pid}`;
  const AUTH = 'lrt-int-auth';
  let h: Awaited<ReturnType<typeof buildServer>>;

  beforeAll(async () => { h = await buildServer(NAME, AUTH, true); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  beforeEach(() => {
    h.handleInboundMessage.mockClear();
    (h.config as { developmentAgent?: boolean }).developmentAgent = true;
    (h.config.threadline as Record<string, unknown>).localRouteTrust = undefined;
    // Reset trust to "nobody may send a message".
    for (const fp of [FP_KNOWN, FP_OTHER]) {
      if (h.trustManager!.getProfileByFingerprint(fp)) h.trustManager!.setTrustLevelByFingerprint(fp, 'untrusted', 'user-granted', 'reset');
    }
  });

  const setMode = (block: { enabled?: boolean; dryRun?: boolean } | undefined) => {
    (h.config.threadline as Record<string, unknown>).localRouteTrust = block;
  };
  const post = (env: unknown, token = h.token) =>
    request(h.app).post('/messages/relay-agent').set('Authorization', `Bearer ${token}`).send(env as object);
  const counters = async (): Promise<Counters> => {
    const r = await request(h.app).get('/health').set('Authorization', `Bearer ${AUTH}`).expect(200);
    return r.body.threadline.localRouteTrust as Counters;
  };
  const ledger = () => (h.server as unknown as { inboundIdLedger: { current(): { getRow(k: string, id: string): unknown } | null } }).inboundIdLedger.current();
  const captureLogs = async <T>(fn: () => Promise<T>) => {
    const logs: string[] = [];
    const spy = vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => { logs.push(a.map(String).join(' ')); });
    try { return { result: await fn(), logs }; } finally { spy.mockRestore(); }
  };

  it('the counters ride the AUTHED /health only', async () => {
    const open = await request(h.app).get('/health').expect(200);
    expect(open.body.threadline?.localRouteTrust).toBeUndefined();
    const c = await counters();
    expect(c).toMatchObject({ enabled: true, dryRun: true, trustManagerWired: true });
  });

  it('gate off (fleet default): a sender with no profile is handled exactly as today, nothing counted', async () => {
    (h.config as { developmentAgent?: boolean }).developmentAgent = false;
    const before = await counters();
    expect(before.enabled).toBe(false);
    const res = await post(envelope(NAME)).expect(200);
    expect(res.body).toMatchObject({ ok: true, accepted: true });
    await vi.waitFor(() => expect(h.handleInboundMessage).toHaveBeenCalledTimes(1));
    expect(h.handleInboundMessage.mock.calls[0][2]).not.toHaveProperty('localTrustLevel');
    expect(await counters()).toEqual(before);
  });

  it('dry-run (dev default): a no-profile sender is DELIVERED, logged as would-refuse and counted', async () => {
    const before = await counters();
    const env = envelope(NAME);
    const { result: res, logs } = await captureLogs(() => post(env));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: true });
    await vi.waitFor(() => expect(h.handleInboundMessage).toHaveBeenCalledTimes(1));
    // Dry-run changes nothing downstream: the router keeps its `verified` default.
    expect(h.handleInboundMessage.mock.calls[0][2]).not.toHaveProperty('localTrustLevel');
    expect(logs.filter((l) => l.startsWith('[relay-agent-trust]'))).toHaveLength(1);
    expect(logs.find((l) => l.startsWith('[relay-agent-trust]'))).toMatch(/^\[relay-agent-trust\] would-refuse from=peer-known fp=c{12} source=\w+ trust=untrusted op=message$/);
    const after = await counters();
    expect(after.evaluated - before.evaluated).toBe(1);
    expect(after.wouldRefuse - before.wouldRefuse).toBe(1);
    expect(after.refused).toBe(before.refused);
  });

  it('dry-run: a sender whose profile permits the operation counts as allowed, not would-refuse', async () => {
    h.trustManager!.setTrustLevelByFingerprint(FP_KNOWN, 'verified', 'user-granted', 'test', 'peer-known');
    const before = await counters();
    await post(envelope(NAME)).expect(200);
    const after = await counters();
    expect(after.allowed - before.allowed).toBe(1);
    expect(after.wouldRefuse).toBe(before.wouldRefuse);
  });

  it('enforcing: a no-profile sender gets a pre-admission 403 — no inbox entry, no ledger row, router never called', async () => {
    setMode({ dryRun: false });
    const before = await counters();
    const who = `stranger-${crypto.randomUUID().slice(0, 8)}`;
    const env = envelope(NAME, { from: who });
    const { result: res, logs } = await captureLogs(() => post(env));
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'insufficient-trust', refused: true, retryable: false, operation: 'message' });
    expect(logs).toContain(`[relay-agent-trust] refuse from=${who} fp=none source=none trust=untrusted op=message`);
    expect(h.handleInboundMessage).not.toHaveBeenCalled();
    const inbox = await h.messageRouter.getInbox(NAME, {});
    expect(inbox.find((e) => e.message.id === env.message.id)).toBeUndefined();
    const l = ledger();
    expect(l).not.toBeNull();
    expect(l!.getRow(`local:relay-agent:${who}`, env.message.id)).toBeNull();
    const after = await counters();
    expect(after.refused - before.refused).toBe(1);
    expect(after.wouldRefuse).toBe(before.wouldRefuse);
  });

  it('enforcing: an admitted message DOES write the ledger row the refused one did not', async () => {
    setMode({ dryRun: false });
    h.trustManager!.setTrustLevelByFingerprint(FP_KNOWN, 'verified', 'user-granted', 'test', 'peer-known');
    const env = envelope(NAME);
    await post(env).expect(200);
    expect(ledger()!.getRow(`registry:${FP_KNOWN}`, env.message.id)).not.toBeNull();
  });

  it('enforcing: a refusal reserves no content window — the same content is accepted once trust is granted', async () => {
    setMode({ dryRun: false });
    const body = `same content ${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();
    const first = envelope(NAME, { body });
    first.message.threadId = threadId;
    await post(first).expect(403);
    h.trustManager!.setTrustLevelByFingerprint(FP_KNOWN, 'verified', 'user-granted', 'granted', 'peer-known');
    const second = envelope(NAME, { body });
    second.message.threadId = threadId;
    const res = await post(second).expect(200);
    expect(res.body.deduped).toBeUndefined();
    expect(res.body).toMatchObject({ ok: true, accepted: true });
  });

  it('enforcing: a permitted sender is admitted and the router is told the resolved level, capped at verified', async () => {
    setMode({ dryRun: false });
    h.trustManager!.setTrustLevelByFingerprint(FP_KNOWN, 'verified', 'user-granted', 'test', 'peer-known');
    await post(envelope(NAME)).expect(200);
    await vi.waitFor(() => expect(h.handleInboundMessage).toHaveBeenCalledTimes(1));
    expect(h.handleInboundMessage.mock.calls[0][2]).toMatchObject({ localTrustLevel: 'verified' });

    h.handleInboundMessage.mockClear();
    h.trustManager!.setTrustLevelByFingerprint(FP_KNOWN, 'trusted', 'user-granted', 'test', 'peer-known');
    await post(envelope(NAME)).expect(200);
    await vi.waitFor(() => expect(h.handleInboundMessage).toHaveBeenCalledTimes(1));
    // A claimed identity never RAISES the stated level above today's `verified`.
    expect(h.handleInboundMessage.mock.calls[0][2]).toMatchObject({ localTrustLevel: 'verified' });

    // An untrusted sender's permitted probe is stated as untrusted (lowered).
    h.handleInboundMessage.mockClear();
    h.trustManager!.setTrustLevelByFingerprint(FP_KNOWN, 'untrusted', 'user-granted', 'test', 'peer-known');
    await post(envelope(NAME, { body: { type: 'ping', content: 'are you there' } })).expect(200);
    await vi.waitFor(() => expect(h.handleInboundMessage).toHaveBeenCalledTimes(1));
    expect(h.handleInboundMessage.mock.calls[0][2]).toMatchObject({ localTrustLevel: 'untrusted' });
  });

  it('enforcing: the operation check is the relay gate\'s — verified may not task-request, trusted may', async () => {
    setMode({ dryRun: false });
    h.trustManager!.setTrustLevelByFingerprint(FP_KNOWN, 'verified', 'user-granted', 'test', 'peer-known');
    const res = await post(envelope(NAME, { body: { type: 'task-request', content: 'do a thing' } })).expect(403);
    expect(res.body).toEqual({ error: 'insufficient-trust', refused: true, retryable: false, operation: 'task-request' });
    h.trustManager!.setTrustLevelByFingerprint(FP_KNOWN, 'trusted', 'user-granted', 'test', 'peer-known');
    await post(envelope(NAME, { body: { type: 'task-request', content: 'do a thing' } })).expect(200);
  });

  it('enforcing: a body-asserted fingerprint cannot borrow trust when the registry resolves the sender', async () => {
    setMode({ dryRun: false });
    h.trustManager!.setTrustLevelByFingerprint(FP_OTHER, 'autonomous', 'user-granted', 'test', 'someone-else');
    // Registry: peer-known → FP_KNOWN (may not send). Body claims FP_OTHER.
    await post(envelope(NAME, { assertedFp: FP_OTHER })).expect(403);
    // With no registry entry for the name, the asserted fingerprint is the only identity.
    await post(envelope(NAME, { from: 'not-in-registry', assertedFp: FP_OTHER })).expect(200);
    // …matched case-insensitively (profiles store lower-case fingerprints).
    await post(envelope(NAME, { from: 'not-in-registry', assertedFp: FP_OTHER.toUpperCase() })).expect(200);
    // Leaving the fingerprint OUT and claiming that profile's display name gains nothing.
    await post(envelope(NAME, { from: 'someone-else' })).expect(403);
    // A sender named after an object built-in is refused cleanly, not by a crash.
    await post(envelope(NAME, { from: 'constructor' })).expect(403);
  });

  it('enforcing: a profile granted by name admits a sender the registry does not know', async () => {
    setMode({ dryRun: false });
    const who = `named-${crypto.randomUUID().slice(0, 8)}`;
    await post(envelope(NAME, { from: who })).expect(403);
    h.trustManager!.setTrustLevel(who, 'verified', 'user-granted', 'by name');
    await post(envelope(NAME, { from: who })).expect(200);
  });

  it('enforcing: a trust lookup that throws is refused retryably (503); in dry-run it is delivered', async () => {
    const spy = vi.spyOn(h.trustManager!, 'getProfileByFingerprint').mockImplementation(() => { throw new Error('boom'); });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const before = await counters();
      setMode({ dryRun: false });
      const res = await post(envelope(NAME)).expect(503);
      expect(res.body).toEqual({ error: 'trust-unavailable', refused: true, retryable: true });
      setMode(undefined);
      await post(envelope(NAME)).expect(200);
      const after = await counters();
      expect(after.lookupErrors - before.lookupErrors).toBe(2);
      expect(after.evaluated).toBe(before.evaluated);
    } finally {
      spy.mockRestore();
      warn.mockRestore();
    }
  });

  it('auth still comes first: a bad token is 401 and is never evaluated', async () => {
    setMode({ dryRun: false });
    const before = await counters();
    await post(envelope(NAME), 'not-the-token').expect(401);
    expect((await counters()).evaluated).toBe(before.evaluated);
  });

  it('an explicit enabled:false switches the check off on a dev agent', async () => {
    setMode({ enabled: false, dryRun: false });
    const before = await counters();
    expect(before.enabled).toBe(false);
    await post(envelope(NAME)).expect(200);
    expect((await counters()).evaluated).toBe(before.evaluated);
  });
});

describe('/messages/relay-agent — local-route trust with NO trust manager wired', () => {
  const NAME = `lrt-int-notm-${process.pid}`;
  const AUTH = 'lrt-int-notm-auth';
  let h: Awaited<ReturnType<typeof buildServer>>;
  beforeAll(async () => { h = await buildServer(NAME, AUTH, false); }, 60_000);
  afterAll(async () => { await h?.stop(); });

  it('even when enforcing, the message is handled as today and the gap is counted', async () => {
    (h.config.threadline as Record<string, unknown>).localRouteTrust = { dryRun: false };
    const res = await request(h.app).post('/messages/relay-agent').set('Authorization', `Bearer ${h.token}`).send(envelope(NAME)).expect(200);
    expect(res.body).toMatchObject({ ok: true, accepted: true });
    await vi.waitFor(() => expect(h.handleInboundMessage).toHaveBeenCalledTimes(1));
    expect(h.handleInboundMessage.mock.calls[0][2]).not.toHaveProperty('localTrustLevel');
    const r = await request(h.app).get('/health').set('Authorization', `Bearer ${AUTH}`).expect(200);
    expect(r.body.threadline.localRouteTrust).toMatchObject({ enabled: true, dryRun: false, trustManagerWired: false, noTrustManager: 1, evaluated: 0, refused: 0 });
  });
});
