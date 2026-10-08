/**
 * Integration tests — A2A inbound message-id ledger over the full HTTP pipeline
 * (docs/specs/a2a-inbound-id-ledger.md).
 *
 *  A. POST /threadline/messages/receive (signed): commit point, the §2 answers
 *     (409 in flight, 200 deduped on a terminal row, re-admission otherwise), the
 *     503 on a database error, and the /threadline/health capability.
 *  B. A real AgentServer: POST /messages/relay-agent (local namespaces never
 *     suppress; a known id bypasses the content window; a terminal VERIFIED row
 *     answers bare; the 503 releases the content window), and the Registry-First
 *     read route GET /a2a/inbound-ids (401 / 400 / unknown / rows / 503 dark /
 *     live flip).
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { createThreadlineRoutes } from '../../../src/threadline/ThreadlineEndpoints.js';
import { sign, generateIdentityKeyPair } from '../../../src/threadline/ThreadlineCrypto.js';
import { computeFingerprint } from '../../../src/threadline/client/MessageEncryptor.js';
import { InboundIdLedger } from '../../../src/threadline/InboundIdLedger.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../../src/messaging/MessageRouter.js';
import { generateAgentToken, deleteAgentToken } from '../../../src/messaging/AgentTokenManager.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';

const tick = () => new Promise((r) => setImmediate(r));

describe('A. signed HTTP receive + health', () => {
  let tmp: string;
  let a: HandshakeManager;
  let b: HandshakeManager;
  let aPriv: Buffer;
  let aFp: string;
  let dirB: string;
  let ledger: InboundIdLedger;
  let daemon = false;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'inbound-ledger-int-'));
    const dirA = path.join(tmp, 'a');
    dirB = path.join(tmp, 'b');
    fs.mkdirSync(path.join(dirA, 'threadline'), { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    const kp = generateIdentityKeyPair();
    aPriv = kp.privateKey;
    aFp = computeFingerprint(kp.publicKey);
    fs.writeFileSync(path.join(dirA, 'threadline', 'identity.json'), JSON.stringify({
      publicKey: kp.publicKey.toString('hex'), privateKey: kp.privateKey.toString('hex'),
    }));
    a = new HandshakeManager(dirA, 'agent-a');
    b = new HandshakeManager(dirB, 'agent-b');
    const init = a.initiateHandshake('agent-b');
    if (!('payload' in init)) throw new Error('handshake');
    const resp = b.handleHello(init.payload);
    if (!('payload' in resp)) throw new Error('handshake');
    const confirm = a.handleHelloResponse(resp.payload);
    if (!('confirmPayload' in confirm)) throw new Error('handshake');
    b.handleConfirm(confirm.confirmPayload);
    ledger = InboundIdLedger.openMemory();
    daemon = false;
  }, 20000);

  afterEach(() => {
    ledger.close();
    SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/integration/threadline/inbound-id-ledger.test.ts' });
  });

  function app(router: unknown) {
    const x = express();
    x.use(express.json());
    x.use(createThreadlineRoutes(b, router as never, {
      localAgent: 'agent-b', version: '1.0', stateDir: dirB,
      inboundIdLedger: () => (ledger.isOpen ? ledger : null),
      inboundIdLedgerDaemonDeferred: () => daemon,
    }));
    return x;
  }

  function signed(body: unknown) {
    const nonce = crypto.randomBytes(16).toString('hex');
    const timestamp = new Date().toISOString();
    const bodyHash = crypto.createHash('sha256').update(JSON.stringify(body)).digest();
    const data = Buffer.concat([Buffer.from(`POST\n/threadline/messages/receive\n${nonce}\n${timestamp}\n`, 'utf-8'), bodyHash]);
    return {
      Authorization: `Threadline-Relay ${a.getRelayToken('agent-b')!}`,
      'X-Threadline-Agent': 'agent-a',
      'X-Threadline-Nonce': nonce,
      'X-Threadline-Timestamp': timestamp,
      'X-Threadline-Signature': sign(aPriv, data).toString('hex'),
    };
  }
  const body = (id: string, extra: Record<string, unknown> = {}) => ({ message: { id, threadId: 'thread-1', from: { agent: 'agent-a' }, body: 'hi', ...extra } });
  const post = (x: express.Express, bd: unknown) => request(x).post('/threadline/messages/receive').set(signed(bd)).send(bd);

  it('keys on the signature-derived fingerprint and answers 409 while the original is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    const router = { handleInboundMessage: vi.fn(() => new Promise((r) => { release = r; })) };
    const x = app(router);
    const r1 = await post(x, body('m1'));
    expect(r1.status).toBe(200);
    expect(ledger.getRow(aFp, 'm1')?.ingress).toBe('threadline-http');
    const r2 = await post(x, body('m1'));
    expect(r2.status).toBe(409);
    expect(r2.body).toEqual({ deduped: true, disposition: 'admitted', retryable: true });
    release({ handled: true, path: 'live' });
    await tick(); await tick();
    expect(ledger.getRow(aFp, 'm1')?.disposition).toBe('handed-off');
    // A non-durable hand-off is re-admitted and delivered with the resent-copy notice.
    const r3 = await post(x, body('m1'));
    expect(r3.status).toBe(200);
    expect(r3.body.accepted).toBe(true);
    const opts = router.handleInboundMessage.mock.calls[1][2] as { resentNotice: string | null };
    expect(opts.resentNotice).toMatch(/^resent copy/);
  });

  it('answers a terminal (no-reply) row as a duplicate with disposition, path and first time', async () => {
    const seeded = ledger.admit({ senderKey: aFp, messageId: 'quiet', ingress: 'relay', threadId: 'thread-1' });
    if (seeded.kind === 'admitted') { seeded.ticket.recordNoReply(); seeded.ticket.finish(); }
    const router = { handleInboundMessage: vi.fn(async () => ({ handled: true, path: 'cold' })) };
    const r = await post(app(router), body('quiet'));
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ accepted: false, deduped: true, dedupBy: 'id', disposition: 'no-reply', path: null, retryable: false });
    expect(typeof r.body.firstSeenAt).toBe('string');
    expect(router.handleInboundMessage).not.toHaveBeenCalled();
  });

  it('an autonomy-blocked message is refused, and its retry is judged again (refused again)', async () => {
    const router = { handleInboundMessage: vi.fn(async () => ({ handled: false, gateDecision: 'block' })) };
    const x = app(router);
    await post(x, body('blk'));
    await tick(); await tick();
    expect(ledger.getRow(aFp, 'blk')?.disposition).toBe('refused');
    const again = await post(x, body('blk'));
    expect(again.status).toBe(200);
    expect(again.body.deduped).toBeUndefined();
    await tick(); await tick();
    expect(router.handleInboundMessage).toHaveBeenCalledTimes(2);
    expect(ledger.getRow(aFp, 'blk')?.disposition).toBe('refused');
  });

  it('a topic-linkage failure-visible outcome is handoff-failed and its retry is delivered', async () => {
    const router = { handleInboundMessage: vi.fn(async () => ({ handled: true, accepted: true, queued: true, injected: false, resumed: false })) };
    const x = app(router);
    await post(x, body('fv'));
    await tick(); await tick();
    expect(ledger.getRow(aFp, 'fv')?.disposition).toBe('handoff-failed');
    expect((await post(x, body('fv'))).status).toBe(200);
    await tick(); await tick();
    expect(router.handleInboundMessage).toHaveBeenCalledTimes(2);
  });

  it('a database error answers 503 once, then fails open during the cooldown', async () => {
    const router = { handleInboundMessage: vi.fn(async () => ({ handled: true, path: 'cold' })) };
    const x = app(router);
    ledger._testBreakDb();
    const r1 = await post(x, body('db1'));
    expect(r1.status).toBe(503);
    expect(r1.body).toEqual({ error: 'ledger-unavailable', retryable: true });
    expect(router.handleInboundMessage).not.toHaveBeenCalled();
    const r2 = await post(x, body('db2'));
    expect(r2.status).toBe(200);
  });

  it('advertises the capability only while operational and not daemon-deferred', async () => {
    const x = app(null);
    const h1 = await request(x).get('/threadline/health');
    expect(h1.body.capabilities).toEqual(['inbound-id-ledger']);
    expect(h1.body.protocolVersion).toBe(2);
    expect(h1.body.protocol).toBe('threadline');
    daemon = true;
    const h2 = await request(x).get('/threadline/health');
    expect(h2.body.capabilities).toBeUndefined();
    expect(h2.body.protocolVersion).toBeUndefined();
    daemon = false;
    ledger._testBreakDb();
    ledger.admit({ senderKey: aFp, messageId: 'x', ingress: 'relay' }); // trips the cooldown
    const h3 = await request(x).get('/threadline/health');
    expect(h3.body.capabilities).toBeUndefined();
  });
});

describe('B. AgentServer — /messages/relay-agent and GET /a2a/inbound-ids', () => {
  let project: TempProject;
  let server: AgentServer;
  let messageStore: MessageStore;
  let app: ReturnType<AgentServer['getApp']>;
  let token: string;
  let config: InstarConfig;
  let handleInboundMessage: ReturnType<typeof vi.fn>;
  const AUTH = 'test-auth-ledger';
  const PROJECT = 'test-ledger-project';
  const DAWN_FP = 'd'.repeat(32);

  beforeAll(async () => {
    project = createTempProject();
    const messagingDir = path.join(project.stateDir, 'messages');
    fs.mkdirSync(messagingDir, { recursive: true });
    messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();
    const delivery = new MessageDelivery(new MessageFormatter(), {
      getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false, sendKeys: () => true, getOutputLineCount: () => 100,
    });
    const messageRouter = new MessageRouter(messageStore, delivery, { localAgent: PROJECT, localMachine: 'test-machine', serverUrl: 'http://localhost:0' });
    token = generateAgentToken(PROJECT);
    // A registered peer: `dawn` resolves to a verified fingerprint via known-agents.
    fs.mkdirSync(path.join(project.stateDir, 'threadline'), { recursive: true });
    fs.writeFileSync(path.join(project.stateDir, 'threadline', 'known-agents.json'), JSON.stringify({ agents: [{ name: 'dawn', fingerprint: DAWN_FP }] }));
    config = {
      projectName: PROJECT, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
      requestTimeoutMs: 5000, version: '0.9.81',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
      messaging: [], monitoring: {}, updates: {}, users: [],
      threadline: { relayEnabled: false, inboundIdLedger: { enabled: true, retentionDays: 14 } },
    } as InstarConfig;
    handleInboundMessage = vi.fn(async () => ({ handled: true, accepted: true, delivered: true, spawned: true, threadId: 't', path: 'cold' }));
    server = new AgentServer({
      config, sessionManager: createMockSessionManager() as never, state: project.state, messageRouter,
      threadlineRouter: { handleInboundMessage } as never,
    });
    await server.start();
    app = server.getApp();
  });

  afterAll(async () => {
    await server.stop();
    await messageStore.destroy();
    deleteAgentToken(PROJECT);
    project.cleanup();
  });

  const ledgerOf = () => (server as unknown as { inboundIdLedger: { current(): InboundIdLedger | null } }).inboundIdLedger.current();

  function envelope(id: string, fromAgent: string, body = `body ${id}`, threadId = crypto.randomUUID()) {
    const now = new Date().toISOString();
    return {
      schemaVersion: 1,
      message: { id, from: { agent: fromAgent, session: 's', machine: 'remote' }, to: { agent: PROJECT, session: 'best', machine: 'local' }, type: 'request', priority: 'medium', subject: 'hello', body, threadId, createdAt: now, ttlMinutes: 30 },
      transport: { relayChain: ['remote'], originServer: 'http://remote:3000', nonce: `${crypto.randomUUID()}:${now}`, timestamp: now },
      delivery: { phase: 'sent', transitions: [], attempts: 0 },
    };
  }
  const post = (env: unknown) => request(app).post('/messages/relay-agent').set('Authorization', `Bearer ${token}`).send(env);

  it('a same-id local repeat (even of identical text, inside the content window) is delivered again', async () => {
    handleInboundMessage.mockClear();
    const env = envelope('loc-1', 'codey', 'same text', 'thread-same');
    expect((await post(env)).status).toBe(200);
    await tick(); await tick();
    const again = await post(envelope('loc-1', 'codey', 'same text', 'thread-same'));
    expect(again.status).toBe(200);
    expect(again.body.deduped).toBeUndefined();
    await tick(); await tick();
    expect(handleInboundMessage).toHaveBeenCalledTimes(2);
    expect(ledgerOf()!.getRow('local:relay-agent:codey', 'loc-1')!.readmissions).toBe(1);
  });

  it('a relay original judged no-reply then a same-id local retry dedups bare (registry key)', async () => {
    handleInboundMessage.mockClear();
    const l = ledgerOf()!;
    const r = l.admit({ senderKey: DAWN_FP, messageId: 'dawn-1', ingress: 'relay', threadId: 'thread-d' });
    if (r.kind === 'admitted') { r.ticket.recordNoReply(); r.ticket.finish(); }
    const res = await post(envelope('dawn-1', 'dawn'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: false, deduped: true, dedupBy: 'id' });
    expect(handleInboundMessage).not.toHaveBeenCalled();
  });

  it('a token holder pre-registering dawn\'s id on the local route cannot suppress dawn\'s relay message', async () => {
    const pre = await post(envelope('dawn-2', 'dawn'));
    expect(pre.status).toBe(200);
    await tick(); await tick();
    expect(ledgerOf()!.lookup(DAWN_FP, 'dawn-2')).toBe('retryable');
  });

  it('a loop envelope is refused with no row', async () => {
    const env = envelope('loop-1', 'codey');
    env.transport.relayChain = ['test-machine'];
    expect((await post(env)).status).toBe(409);
    expect(ledgerOf()!.getRow('local:relay-agent:codey', 'loop-1')).toBeNull();
  });

  it('the read route: 401 without bearer, 400 on bounds, unknown key, and rows with senderVerified', async () => {
    expect((await request(app).get('/a2a/inbound-ids?id=x')).status).toBe(401);
    const auth = (q: string) => request(app).get(`/a2a/inbound-ids${q}`).set('Authorization', `Bearer ${AUTH}`);
    expect((await auth('?id=' + 'x'.repeat(200))).status).toBe(400);
    const unknown = await auth('?sender=zz&id=nope');
    expect(unknown.status).toBe(200);
    expect(unknown.body).toEqual({ rows: [], disposition: null });
    const rows = await auth(`?sender=${encodeURIComponent('local:relay-agent:codey')}&id=loc-1`);
    expect(rows.status).toBe(200);
    expect(rows.body.rows[0]).toMatchObject({ senderVerified: false, ingress: 'relay-agent' });
    expect(rows.body.rows[0].threadIdNote).toMatch(/untrusted/);
    const pool = await auth('?id=loc-1&scope=pool');
    expect(pool.status).toBe(200);
    expect(pool.body.scope).toBe('pool');
    expect(pool.body.rows.length).toBeGreaterThan(0);
  });

  it('a locked database answers 503 and releases the content window', async () => {
    handleInboundMessage.mockClear();
    ledgerOf()!._testBreakDb();
    const env = envelope('lock-1', 'codey', 'locked text', 'thread-lock');
    const r1 = await post(env);
    expect(r1.status).toBe(503);
    expect(r1.body).toEqual({ error: 'ledger-unavailable', retryable: true });
    // A retry inside the 60 s content window is not stopped there (the window was released);
    // during the cooldown it fails open to today's path.
    const r2 = await post(envelope('lock-2', 'codey', 'locked text', 'thread-lock'));
    expect(r2.status).toBe(200);
    expect(r2.body.deduped).toBeUndefined();
  });

  it('a live true→false flip closes the ledger; the read route then answers 503', async () => {
    (config.threadline as { inboundIdLedger: { enabled: boolean } }).inboundIdLedger.enabled = false;
    const res = await request(app).get('/a2a/inbound-ids?id=x').set('Authorization', `Bearer ${AUTH}`);
    expect(res.status).toBe(503);
    (config.threadline as { inboundIdLedger: { enabled: boolean } }).inboundIdLedger.enabled = true;
    const back = await request(app).get('/a2a/inbound-ids?id=x').set('Authorization', `Bearer ${AUTH}`);
    expect(back.status).toBe(200);
  });
});
