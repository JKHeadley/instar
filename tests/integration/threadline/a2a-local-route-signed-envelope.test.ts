/**
 * A2A local-route signed envelope — integration tier
 * (docs/specs/a2a-local-route-signed-envelope.md, ACT-067).
 *
 * The REAL `POST /messages/relay-agent` route on a real AgentServer (listening
 * on a real port), with a real MessageRouter, the real inbound-id ledger and a
 * real known-agents registry. Only the ThreadlineRouter is a recording fake
 * (it would spawn sessions), and the AgentRegistry listing is pinned so the
 * test never reads the developer's own registry.
 *
 * Covers each mode — off, dry-run, enforcing — and that an enforcing refusal
 * is PRE-ADMISSION: no inbox entry, no ledger row, no content window.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AgentServer } from '../../../src/server/AgentServer.js';
import { MessageStore } from '../../../src/messaging/MessageStore.js';
import { MessageFormatter } from '../../../src/messaging/MessageFormatter.js';
import { MessageDelivery } from '../../../src/messaging/MessageDelivery.js';
import { MessageRouter } from '../../../src/messaging/MessageRouter.js';
import { generateAgentToken, deleteAgentToken } from '../../../src/messaging/AgentTokenManager.js';
import { HandshakeManager } from '../../../src/threadline/HandshakeManager.js';
import { IdentityManager } from '../../../src/threadline/client/IdentityManager.js';
import {
  createAgentLocalEnvelopeSigner,
  localRouteSignatureAuditPath,
  verifyLocalEnvelope,
} from '../../../src/threadline/localEnvelopeSignature.js';
import { createTempProject, createMockSessionManager } from '../../helpers/setup.js';
import type { TempProject } from '../../helpers/setup.js';
import type { InstarConfig } from '../../../src/core/types.js';
import { createLocalSender, localSenderFromIdentity, makeLocalEnvelope, registerKnownAgent, signEnvelope, type LocalSender } from '../../helpers/localEnvelope.js';

const running: Array<{ name: string; port: number; status: string }> = [];
vi.mock('../../../src/core/AgentRegistry.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/core/AgentRegistry.js')>();
  return { ...actual, listAgents: vi.fn(() => running) };
});

type Block = {
  mode: string; since: string; verified: number; verifiedBySender: Record<string, number>; wouldRefuse: number; refused: number;
  byReason: Record<string, number>; errors: number; firstContactKeys: number; replayCacheSize: number; signerAvailable: boolean;
  localRefused: number; signed: number; auditWriteFailures: number;
};

const NAME = `lse-int-${process.pid}`;
const AUTH = 'lse-int-auth';

function configFor(project: TempProject): InstarConfig {
  return {
    projectName: NAME, projectDir: project.dir, stateDir: project.stateDir, port: 0, authToken: AUTH,
    requestTimeoutMs: 5000, version: '0.9.81', developmentAgent: true,
    sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
    scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 },
    messaging: [], monitoring: {}, updates: {}, users: [],
    threadline: {},
  } as InstarConfig;
}

describe('/messages/relay-agent — signed envelope (real route)', () => {
  let project: TempProject;
  let config: InstarConfig;
  let server: AgentServer;
  let app: ReturnType<AgentServer['getApp']>;
  let messageStore: MessageStore;
  let messageRouter: MessageRouter;
  let token: string;
  let port: number;
  let alice: LocalSender;
  const handleInboundMessage = vi.fn(async () => ({ handled: true, accepted: true, delivered: true, spawned: true, threadId: 't', path: 'cold' }));

  beforeAll(async () => {
    project = createTempProject();
    const messagingDir = path.join(project.stateDir, 'messages');
    fs.mkdirSync(messagingDir, { recursive: true });
    messageStore = new MessageStore(messagingDir);
    await messageStore.initialize();
    const delivery = new MessageDelivery(new MessageFormatter(), {
      getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false, sendKeys: () => true, getOutputLineCount: () => 100,
    });
    messageRouter = new MessageRouter(messageStore, delivery, { localAgent: NAME, localMachine: 'test-machine', serverUrl: 'http://localhost:0' });
    token = generateAgentToken(NAME);
    config = configFor(project);
    server = new AgentServer({
      config,
      sessionManager: createMockSessionManager() as never,
      state: project.state,
      messageRouter,
      handshakeManager: new HandshakeManager(project.stateDir, NAME),
      threadlineRouter: { handleInboundMessage } as never,
    } as never);
    await server.start();
    app = server.getApp();
    port = (server as unknown as { server: { address(): { port: number } } }).server.address().port;
    alice = createLocalSender('alice');
    registerKnownAgent(project.stateDir, alice);
  }, 60_000);

  afterAll(async () => {
    await server?.stop();
    await messageStore?.destroy();
    deleteAgentToken(NAME);
    project?.cleanup();
  });

  beforeEach(() => {
    handleInboundMessage.mockClear();
    running.length = 0;
    (config as { developmentAgent?: boolean }).developmentAgent = true;
    (config.threadline as Record<string, unknown>).localRouteSignature = undefined;
  });

  const setMode = (block: { enabled?: boolean; dryRun?: boolean } | undefined, dev = true) => {
    (config as { developmentAgent?: boolean }).developmentAgent = dev;
    (config.threadline as Record<string, unknown>).localRouteSignature = block;
  };
  const post = (env: unknown, t = token, headers: Record<string, string> = {}) => {
    let r = request(app).post('/messages/relay-agent').set('Authorization', `Bearer ${t}`);
    for (const [k, v] of Object.entries(headers)) r = r.set(k, v);
    return r.send(env as object);
  };
  const block = async (): Promise<Block> => {
    const r = await request(app).get('/health').set('Authorization', `Bearer ${AUTH}`).expect(200);
    return r.body.threadline.localRouteSignature as Block;
  };
  const ledger = () => (server as unknown as { inboundIdLedger: { current(): { getRow(k: string, id: string): unknown } | null } }).inboundIdLedger.current();
  const inInbox = async (id: string) => (await messageRouter.getInbox(NAME, {})).some((e) => e.message.id === id);
  const signedBy = (s: LocalSender, over: Parameters<typeof makeLocalEnvelope>[2] = {}) => signEnvelope(makeLocalEnvelope(s.name, NAME, over), s);
  const auditRows = () => {
    const f = localRouteSignatureAuditPath(project.stateDir);
    return fs.existsSync(f) ? fs.readFileSync(f, 'utf-8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  // ── off ──────────────────────────────────────────────────────────────────
  it('off: the field is not read — an unsigned envelope is delivered, the answer carries no signature block, nothing is counted', async () => {
    setMode(undefined, false);
    const before = await block();
    expect(before.mode).toBe('off');
    const rowsBefore = auditRows().length;
    const env = makeLocalEnvelope('alice', NAME);
    const res = await post(env).expect(200);
    expect(res.body.signature).toBeUndefined();
    expect(await inInbox(env.message.id)).toBe(true);
    const after = await block();
    expect([after.verified, after.wouldRefuse, after.refused]).toEqual([before.verified, before.wouldRefuse, before.refused]);
    expect(auditRows().length).toBe(rowsBefore);
  });

  it('off: a request that REQUIRES the proof is refused not-enforcing and reaches no inbox', async () => {
    setMode(undefined, false);
    const env = signedBy(alice);
    const res = await post(env, token, { 'X-Instar-Require-Signature': 'v1' }).expect(401);
    expect(res.body).toEqual({ error: 'bad-signature', refused: true, retryable: true, remedy: 'receiver', reason: 'not-enforcing' });
    expect(await inInbox(env.message.id)).toBe(false);
  });

  // ── dry-run ──────────────────────────────────────────────────────────────
  it('dry-run (enabled omitted on a development agent): an unsigned envelope is delivered, counted and audited', async () => {
    const before = await block();
    expect(before.mode).toBe('dry-run');
    const env = makeLocalEnvelope('alice', NAME);
    const res = await post(env).expect(200);
    expect(res.body).toMatchObject({ ok: true, signature: { mode: 'dry-run', verified: false } });
    expect(await inInbox(env.message.id)).toBe(true);
    const after = await block();
    expect(after.wouldRefuse - before.wouldRefuse).toBe(1);
    expect(after.byReason.unsigned - before.byReason.unsigned).toBe(1);
    expect(after.refused).toBe(before.refused);
    expect(auditRows().at(-1)).toMatchObject({ source: 'route', mode: 'dry-run', outcome: 'would-refuse', from: 'alice', reason: 'unsigned' });
  });

  it('dry-run: a signed envelope is delivered and counted verified; nothing downstream changes', async () => {
    const before = await block();
    const env = signedBy(alice);
    const res = await post(env).expect(200);
    expect(res.body.signature).toEqual({ mode: 'dry-run', verified: true });
    const after = await block();
    expect(after.verified - before.verified).toBe(1);
    expect(after.verifiedBySender.alice).toBeGreaterThanOrEqual(1);
    expect(auditRows().at(-1)).toMatchObject({ outcome: 'verified', from: 'alice' });
    // The ledger key is today's name-resolved registry fingerprint (the stored field), as before.
    expect(ledger()!.getRow(`registry:${alice.fingerprint}`, env.message.id)).not.toBeNull();
  });

  it('dry-run: a forged envelope (right name, wrong key) is still delivered — watch-only refuses nothing', async () => {
    const forger = createLocalSender('alice');
    const env = signedBy(forger);
    const res = await post(env).expect(200);
    expect(res.body.signature).toEqual({ mode: 'dry-run', verified: false });
    expect(auditRows().at(-1)).toMatchObject({ outcome: 'would-refuse', reason: 'signature-invalid' });
  });

  it('dry-run: the requirement header is refused not-enforcing', async () => {
    const before = await block();
    const env = signedBy(alice);
    await post(env, token, { 'X-Instar-Require-Signature': 'v1' }).expect(401);
    expect(await inInbox(env.message.id)).toBe(false);
    const after = await block();
    expect(after.refused - before.refused).toBe(1);
    expect(after.byReason['not-enforcing'] - before.byReason['not-enforcing']).toBe(1);
  });

  // ── enforcing ────────────────────────────────────────────────────────────
  it('enforcing: auth stays first — a wrong token is the token 401, signed or not', async () => {
    setMode({ dryRun: false });
    const res = await post(makeLocalEnvelope('alice', NAME), 'wrong-token').expect(401);
    expect(res.body).toEqual({ error: 'Invalid or missing agent token' });
  });

  it('enforcing: an unsigned envelope is refused PRE-ADMISSION — no inbox entry, no ledger row, router never called', async () => {
    setMode({ dryRun: false });
    const before = await block();
    expect(before.mode).toBe('enforcing');
    const env = makeLocalEnvelope('alice', NAME);
    const res = await post(env).expect(401);
    expect(res.body).toEqual({ error: 'bad-signature', refused: true, retryable: false, remedy: 'sender', reason: 'unsigned' });
    expect(await inInbox(env.message.id)).toBe(false);
    expect(ledger()!.getRow(`registry:${alice.fingerprint}`, env.message.id)).toBeNull();
    expect(ledger()!.getRow('local:relay-agent:alice', env.message.id)).toBeNull();
    expect(handleInboundMessage).not.toHaveBeenCalled();
    const after = await block();
    expect(after.refused - before.refused).toBe(1);
    expect(after.wouldRefuse).toBe(before.wouldRefuse);
    expect(auditRows().at(-1)).toMatchObject({ mode: 'enforcing', outcome: 'refused', reason: 'unsigned' });
  });

  it('enforcing: each reason answers its own 401 body', async () => {
    setMode({ dryRun: false });
    const expectReason = async (env: unknown, reason: string, retryable: boolean, remedy: string) => {
      const res = await post(env).expect(401);
      expect(res.body).toEqual({ error: 'bad-signature', refused: true, retryable, remedy, reason });
    };
    await expectReason({ ...signedBy(alice), signature: 'nope!' }, 'malformed', false, 'sender');
    await expectReason(signEnvelope(makeLocalEnvelope('alice', 'someone-else'), alice), 'wrong-recipient', false, 'sender');
    await expectReason(signedBy(alice, { at: Date.now() - 11 * 60_000 }), 'stale', false, 'sender');
    await expectReason(signedBy(createLocalSender('alice')), 'signature-invalid', false, 'sender');
    await expectReason(signedBy(alice, { fingerprint: 'b'.repeat(32) }), 'fingerprint-mismatch', false, 'sender');
    await expectReason(signedBy(createLocalSender('stranger')), 'unknown-sender', true, 'receiver');
    const good = signedBy(alice);
    await expectReason({ ...good, message: { ...good.message, body: 'tampered' } }, 'signature-invalid', false, 'sender');
  });

  it('enforcing: a signed envelope is delivered, the answer says so, and the ledger key is the PROVEN fingerprint', async () => {
    setMode({ dryRun: false });
    // The registry's stored fingerprint is stale; the proven one derives from the key.
    registerKnownAgent(project.stateDir, alice, { fingerprint: 'e'.repeat(32) });
    try {
      const env = signedBy(alice);
      const res = await post(env).expect(200);
      expect(res.body).toMatchObject({ ok: true, signature: { mode: 'enforcing', verified: true } });
      expect(await inInbox(env.message.id)).toBe(true);
      expect(ledger()!.getRow(`registry:${alice.fingerprint}`, env.message.id)).not.toBeNull();
      expect(ledger()!.getRow(`registry:${'e'.repeat(32)}`, env.message.id)).toBeNull();
      await vi.waitFor(() => expect(handleInboundMessage).toHaveBeenCalledTimes(1));
    } finally {
      registerKnownAgent(project.stateDir, alice);
    }
  });

  it('enforcing: re-posting the same signed bytes is a replay', async () => {
    setMode({ dryRun: false });
    const env = signedBy(alice);
    await post(env).expect(200);
    const res = await post(env).expect(401);
    expect(res.body.reason).toBe('replay');
  });

  it('enforcing: a refusal reserves no content window — the same content, signed, is accepted', async () => {
    setMode({ dryRun: false });
    const body = `same content ${crypto.randomUUID()}`;
    const threadId = crypto.randomUUID();
    await post(makeLocalEnvelope('alice', NAME, { body, threadId })).expect(401);
    const res = await post(signedBy(alice, { body, threadId })).expect(200);
    expect(res.body.deduped).toBeUndefined();
    expect(res.body).toMatchObject({ ok: true, accepted: true });
  });

  it('enforcing: the requirement header is satisfied by a proven envelope', async () => {
    setMode({ dryRun: false });
    const env = signedBy(alice);
    const res = await post(env, token, { 'X-Instar-Require-Signature': 'v1' }).expect(200);
    expect(res.body.signature).toEqual({ mode: 'enforcing', verified: true });
  });

  it('the mode is read live per request', async () => {
    const env1 = makeLocalEnvelope('alice', NAME);
    await post(env1).expect(200); // dry-run
    setMode({ dryRun: false });
    await post(makeLocalEnvelope('alice', NAME)).expect(401);
    setMode({ enabled: false });
    const res = await post(makeLocalEnvelope('alice', NAME)).expect(200);
    expect(res.body.signature).toBeUndefined();
  });

  // ── a real MessageRouter sender with THE production signer ───────────────
  describe('a real MessageRouter sender', () => {
    let senderProject: TempProject;
    let senderStore: MessageStore;
    let senderRouter: MessageRouter;
    let senderId: LocalSender;
    const SENDER = `lse-int-sender-${process.pid}`;
    const dropFile = (id: string) => path.join(os.homedir(), '.instar', 'messages', 'drop', NAME, `${id}.json`);

    beforeAll(async () => {
      senderProject = createTempProject();
      const dir = path.join(senderProject.stateDir, 'messages');
      fs.mkdirSync(dir, { recursive: true });
      senderStore = new MessageStore(dir);
      await senderStore.initialize();
      generateAgentToken(SENDER);
      // The identity exists before the first send, as after a real Threadline bootstrap.
      senderId = localSenderFromIdentity(SENDER, new IdentityManager(senderProject.stateDir).getOrCreate());
      const delivery = new MessageDelivery(new MessageFormatter(), {
        getForegroundProcess: () => 'bash', isSessionAlive: () => true, hasActiveHumanInput: () => false, sendKeys: () => true, getOutputLineCount: () => 100,
      });
      senderRouter = new MessageRouter(senderStore, delivery, {
        localAgent: SENDER, localMachine: 'test-machine', serverUrl: 'http://localhost:0',
        envelopeSigner: createAgentLocalEnvelopeSigner(SENDER, senderProject.stateDir),
      });
    });
    afterAll(async () => {
      await senderStore?.destroy();
      deleteAgentToken(SENDER);
      senderProject?.cleanup();
    });

    const send = () => senderRouter.send(
      { agent: SENDER, session: 's', machine: 'test-machine' }, { agent: NAME, session: 'best', machine: 'local' },
      'info', 'medium', 'from the router', `body ${crypto.randomUUID()}`,
    );

    it('wiring: the production signer signs with the key the sender publishes as its identity', () => {
      const env = makeLocalEnvelope(SENDER, NAME);
      const sig = createAgentLocalEnvelopeSigner(SENDER, senderProject.stateDir)(env);
      expect(sig).toBeTruthy();
      expect(verifyLocalEnvelope({ ...env, signature: sig! }, senderId.publicKey)).toBe(true);
    });

    it('enforcing: delivers to the real receiver when its key is on record', async () => {
      setMode({ dryRun: false });
      running.push({ name: NAME, port, status: 'running' });
      registerKnownAgent(project.stateDir, senderId);
      const before = await block();
      const res = await send();
      expect((await senderStore.get(res.messageId))?.delivery.phase).toBe('received');
      expect(await inInbox(res.messageId)).toBe(true);
      const after = await block();
      expect(after.verified - before.verified).toBe(1);
      expect(after.verifiedBySender[SENDER.toLowerCase()]).toBeGreaterThanOrEqual(1);
    });

    it('enforcing: a refusal FAILS the send and writes nothing to the drop directory', async () => {
      setMode({ dryRun: false });
      running.push({ name: NAME, port, status: 'running' });
      // Remove the sender's key: the receiver cannot prove it (and cannot probe it — it is not running).
      const file = path.join(project.stateDir, 'threadline', 'known-agents.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf-8'));
      fs.writeFileSync(file, JSON.stringify({ agents: data.agents.filter((a: { name: string }) => a.name !== SENDER) }));
      const before = await block();
      const res = await send();
      const stored = await senderStore.get(res.messageId);
      expect(stored?.delivery.phase).toBe('failed');
      expect(stored?.delivery.failureReason).toContain('bad-signature/unknown-sender');
      expect(fs.existsSync(dropFile(res.messageId))).toBe(false);
      expect(await inInbox(res.messageId)).toBe(false);
      const after = await block();
      expect(after.localRefused - before.localRefused).toBe(1);
    });
  });

  // ── read surfaces ────────────────────────────────────────────────────────
  it('authed /health carries the block; the unauthenticated /health does not', async () => {
    const b = await block();
    expect(b).toMatchObject({ mode: 'dry-run', errors: 0, auditWriteFailures: 0 });
    expect(typeof b.since).toBe('string');
    expect(Object.keys(b.byReason)).toHaveLength(12);
    expect(typeof b.signerAvailable).toBe('boolean');
    const open = await request(app).get('/health').expect(200);
    expect(JSON.stringify(open.body)).not.toContain('localRouteSignature');
  });

  it('/threadline/health advertises the version and the live mode', async () => {
    const dry = await request(app).get('/threadline/health').expect(200);
    expect(dry.body.localEnvelopeSignature).toEqual({ version: 'v1', mode: 'dry-run' });
    setMode({ dryRun: false });
    const enf = await request(app).get('/threadline/health').expect(200);
    expect(enf.body.localEnvelopeSignature).toEqual({ version: 'v1', mode: 'enforcing' });
    setMode(undefined, false);
    const off = await request(app).get('/threadline/health').expect(200);
    expect(off.body.localEnvelopeSignature).toEqual({ version: 'v1', mode: 'off' });
  });
});
