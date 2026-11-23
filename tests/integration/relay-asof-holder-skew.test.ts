/**
 * relay-asof-holder-skew: a relayed session message on the RECEIVING machine.
 * Real Ed25519 keys; two in-process MessageRouters joined by the signed relay
 * protocol (the same harness as tests/unit/messages-cross-machine-relay.test.ts),
 * plus the receiver's DeliveryRetryManager driving the holder-pending lane.
 *
 *   relay → holder too new → queued → ten re-resolutions → dead letter →
 *   signed delivery notice back to the sending machine → sender hears the plain reason
 *   relay → role known, not running → queued → holder appears → delivered
 *   relay → holder started two minutes before the send → typed at once (N73)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { createMachineRoutes } from '../../src/server/machineRoutes.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { signRequest, verifyRelayAnswer } from '../../src/server/machineAuth.js';
import { MESSAGE_GENERATION_PATH } from '../../src/messaging/types.js';
import { generationProofId, readPeerMessageGeneration } from '../../src/messaging/peerMessageTarget.js';
import { GENERATION_RELAY_MACHINE_PATH, RELAY_MACHINE_PATH } from '../../src/messaging/types.js';
import { MessageRouter, canonicalJSON, signedPayloadOf } from '../../src/messaging/MessageRouter.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { CrossMachineRelayQueue } from '../../src/messaging/CrossMachineRelayQueue.js';
import { DeliveryRetryManager } from '../../src/messaging/DeliveryRetryManager.js';
import { resolveSessionTarget, type ResolverSession } from '../../src/messaging/sessionAddressResolver.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { MessageEnvelope } from '../../src/messaging/types.js';

function keys() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
}
const A = 'm_studio', B = 'm_mama_pc';
const K = { [A]: keys(), [B]: keys() };
const idm = (active: string[]) => ({
  isMachineActive: (id: string) => active.includes(id),
  baseDir: path.join(os.homedir(), 'machine-state'),
  getMachineUrl: () => null,
  loadRegistry: () => ({ machines: Object.fromEntries(active.map((id) => [id, { status: 'active' }])) }),
  getSigningPublicKeyPem: (id: string) => K[id]?.publicPem ?? null,
}) as any;
const sec = () => ({ events: [] as any[], append(e: any) { this.events.push(e); } }) as any;
const tmux = (running: () => Set<string>, typed: Array<{ s: string; t: string }>) => ({
  getForegroundProcess: () => 'bash',
  isSessionAlive: (s: string) => running().has(s),
  isSessionGeneration: () => true,
  hasActiveHumanInput: () => false,
  sendKeys: (s: string, t: string) => { typed.push({ s, t }); return true; },
  getOutputLineCount: () => 100,
});

describe('relay-asof-holder-skew: relay → refuse → retry → deliver / notice', () => {
  let dirA: string, dirB: string;
  let storeA: MessageStore, storeB: MessageStore;
  let routerA: MessageRouter, routerB: MessageRouter;
  let retryB: DeliveryRetryManager;
  let auditB: string;
  let appB: express.Express;
  let revokedSenders = new Set<string>();
  let alterRelayedBody: ((envelope: MessageEnvelope) => void) | undefined;
  const nonces: NonceStore[] = [];
  const typedB: Array<{ s: string; t: string }> = [];
  const failuresA: Array<{ id: string; reason: string }> = [];
  let sessionsB: ResolverSession[] = [];
  let rewriteToOldPath = false;
  let beforeRelayToB: (() => void) | undefined;
  const runningB = () => new Set(sessionsB.filter((s) => s.status === 'running').map((s) => s.tmuxSession));
  // One clock for both machines, moved forward by `advance` between retry passes.
  // Only Date is faked (timers stay real): `new Date()` and `Date.now()` must agree,
  // because the relay refuses a signed envelope whose timestamp is off by more than 5 min.
  const advance = (ms: number) => { vi.setSystemTime(Date.now() + ms); };

  beforeEach(async () => {
    rewriteToOldPath = false; typedB.length = 0; failuresA.length = 0; sessionsB = []; beforeRelayToB = undefined; alterRelayedBody = undefined; revokedSenders = new Set();
    vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
    dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-a-'));
    dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'ras-b-'));
    vi.spyOn(os, 'homedir').mockReturnValue(dirA);
    storeA = new MessageStore(dirA); await storeA.initialize();
    storeB = new MessageStore(dirB); await storeB.initialize();
    auditB = path.join(dirB, 'logs', 'message-delivery-refusals.jsonl');
    const deliveryB = new MessageDelivery(new MessageFormatter(), { ...tmux(runningB, typedB), isSessionGeneration: (name, id) => sessionsB.some((s) => s.tmuxSession === name && s.id === id && s.status === 'running') } as any);
    routerB = new MessageRouter(storeB, deliveryB, {
      localAgent: 'echo', localMachine: B, serverUrl: 'http://b',
      isOwnSession: (n) => runningB().has(n),
      resolveSession: (t, asOf) => resolveSessionTarget(t, { sessions: sessionsB, sessionNameForTopic: () => null, isStandingDown: () => false, prefix: 'echo', asOf }),
      refusalAuditPath: auditB,
    }, { identityManager: idm([A, B]), signingKeyPem: K[B].privatePem, nonceStore: {} as any, securityLog: sec() });
    // The receiving machine's retry manager: local scope = envelopes addressed to B.
    retryB = new DeliveryRetryManager(storeB, deliveryB, {
      agentName: 'echo',
      isLocalEnvelope: (e) => e.message.to.machine === B,
      isPinnedSessionLive: (name, id) => sessionsB.some((s) => s.tmuxSession === name && s.id === id && s.status === 'running'),
      onDeadLetter: (e, reason) => routerB.reportTerminalFailure(e, reason),
      redeliverUnresolved: (e, claim) => routerB.redeliverSameAgentLocal(e, claim),
    });

    const appFor = (machine: string, dir: string, router: MessageRouter) => {
      const identities = idm([A, B]);
      identities.isMachineActive = (id: string) => [A, B].includes(id) && !revokedSenders.has(id);
      identities.loadRegistry = () => ({ machines: Object.fromEntries([A, B].map((id) => [id, { status: 'active', ...(revokedSenders.has(id) ? { revokedAt: new Date().toISOString() } : {}) }])) });
      const nonceStore = new NonceStore(path.join(dir, 'nonces'));
      nonces.push(nonceStore);
      const securityLog = sec();
      const app = express();
      app.use(express.json());
      app.use(createMachineRoutes({
        identityManager: identities, heartbeatManager: {} as any, securityLog,
        authDeps: { identityManager: identities, nonceStore, securityLog, localMachineId: machine },
        stateDir: dir, localMachineId: machine, localSigningKeyPem: K[machine].privatePem, messageRouter: router,
      }));
      return app;
    };
    const fetchHttp = (app: express.Express) => async (_url: string, init: any) => {
      if ([RELAY_MACHINE_PATH, GENERATION_RELAY_MACHINE_PATH].includes(new URL(_url).pathname) && app === appB && beforeRelayToB) { const hook = beforeRelayToB; beforeRelayToB = undefined; hook(); }
      let body = init.body ? JSON.parse(init.body) : undefined;
      let headers = init.headers;
      if ([RELAY_MACHINE_PATH, GENERATION_RELAY_MACHINE_PATH].includes(new URL(_url).pathname) && app === appB && alterRelayedBody) {
        alterRelayedBody(body.generationEnvelope ?? body);
        const digest = crypto.createHash('sha256').update(JSON.stringify(body)).digest('hex');
        const signed = `${headers['X-Machine-Id']}|${headers['X-Timestamp']}|${headers['X-Nonce']}|${headers['X-Sequence']}|${digest}`;
        headers = { ...headers, 'X-Signature': crypto.sign(null, Buffer.from(signed), K[A].privatePem).toString('base64') };
      }
      const response = init.method === 'POST'
        ? await request(app).post(rewriteToOldPath && new URL(_url).pathname === GENERATION_RELAY_MACHINE_PATH ? RELAY_MACHINE_PATH : new URL(_url).pathname).set(headers).send(body)
        : await request(app).get(new URL(_url).pathname + new URL(_url).search).set(init.headers);
      return new Response(JSON.stringify(response.body), { status: response.status });
    };
    appB = appFor(B, dirB, routerB);
    const fetchToB = fetchHttp(appB);
    routerA = new MessageRouter(storeA, new MessageDelivery(new MessageFormatter(), tmux(() => new Set(), []) as any), {
      localAgent: 'echo', localMachine: A, serverUrl: 'http://a',
      onDeliveryFailure: (e, reason) => failuresA.push({ id: e.message.id, reason }),
      peerAddresses: () => ['http://b.test'],
      generationBindingEnabled: () => true,
      peerSessionGeneration: (_machine, target) => readPeerMessageGeneration({ peer: { machineId: B, url: 'http://192.168.1.2:4040', kind: 'lan' }, target, selfMachine: A, signingKeyPem: K[A].privatePem, peerPublicKeyPem: K[B].publicPem, fetchImpl: fetchToB as any }),
    }, { identityManager: idm([A, B]), signingKeyPem: K[A].privatePem, nonceStore: {} as any, securityLog: sec() });
    (routerA as any).relayQueue = new CrossMachineRelayQueue({ ...(routerA as any).relayQueue.deps, fetchImpl: fetchToB as any });
    await routerA.startRelayQueue();
    const fetchToA = fetchHttp(appFor(A, dirA, routerA));
    (routerB as any).config.peerAddresses = () => ['http://a.test'];
    (routerB as any).relayQueue = new CrossMachineRelayQueue({ ...(routerB as any).relayQueue.deps, fetchImpl: fetchToA as any });
    await routerB.startRelayQueue();
  });
  afterEach(async () => {
    retryB.stop();
    for (let i = 0; i < 500; i++) {
      const depth = [routerA, routerB].flatMap((r) => Object.values((r as any).relayQueue.depth()) as number[]);
      if (!depth.some((n) => n > 0)) break;
      await new Promise((done) => setTimeout(done, 10));
    }
    await storeA.destroy(); await storeB.destroy();
    for (const nonce of nonces.splice(0)) nonce.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const d of [dirA, dirB]) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/integration/relay-asof-holder-skew.test.ts' });
  });

  const until = async (f: () => Promise<boolean>) => { for (let i = 0; i < 500; i++) { if (await f()) return; await new Promise((r) => setTimeout(r, 10)); } throw new Error('expected delivery state did not settle'); };
  const iso = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const send = () => routerA.send({ agent: 'echo', session: 'echo-lead', machine: A }, { agent: 'echo', session: 'echo-topic-144319', machine: B }, 'handoff', 'medium', 'S', 'Body');
  const sendLegacy = async (target = 'echo-topic-144319') => {
    const now = new Date().toISOString();
    const env: MessageEnvelope = { schemaVersion: 1,
      message: { id: crypto.randomUUID(), from: { agent: 'echo', session: 'echo-lead', machine: A }, to: { agent: 'echo', session: target, machine: B }, type: 'handoff', priority: 'medium', subject: 'legacy fixture', body: 'Legacy body', createdAt: now, ttlMinutes: 90 },
      transport: { relayChain: [A], originServer: 'http://a', nonce: crypto.randomUUID(), timestamp: now, age: 0, signedBy: A },
      delivery: { phase: 'relaying', transitions: [], attempts: 0 },
    };
    env.transport.signature = crypto.sign(null, Buffer.from(canonicalJSON(signedPayloadOf(env))), K[A].privatePem).toString('base64');
    await storeA.save(env);
    const headers = signRequest(A, K[A].privatePem, env);
    const response = await request(appB).post(RELAY_MACHINE_PATH).set(headers).send(env);
    expect(response.status).toBe(200);
    expect(verifyRelayAnswer(response.body.ack, response.body.sig, B, env.message.id, headers['X-Nonce'], K[B].publicPem)).toBe('ack');
    const current = (await storeA.get(env.message.id))!;
    if (current.delivery.phase === 'relaying') await storeA.updateDelivery(env.message.id, { ...current.delivery, phase: 'received' });
    return { messageId: env.message.id };
  };


  it('the generation endpoint requires machine authentication and rejects request replay', async () => {
    sessionsB = [{ id: 'chosen', name: 'topic-144319', tmuxSession: 'echo-topic-144319', status: 'running', startedAt: iso(-60_000), telegramTopicId: 144319 }];
    const body = { target: 'echo-topic-144319' };
    expect((await request(appB).post(MESSAGE_GENERATION_PATH).send(body)).status).toBe(401);
    const headers = signRequest(A, K[A].privatePem, body);
    const response = await request(appB).post(MESSAGE_GENERATION_PATH).set(headers).send(body);
    expect(response.status).toBe(200);
    expect(response.body.observation.sessionId).toBe('chosen');
    expect(verifyRelayAnswer(response.body.ack, response.body.sig, B, generationProofId(response.body.observation), headers['X-Nonce'], K[B].publicPem)).toBe('ack');
    expect((await request(appB).post(MESSAGE_GENERATION_PATH).set(headers).send(body)).status).toBe(403);
  });

  it('a revoked peer with a merged active status cannot obtain generation metadata with its old key', async () => {
    sessionsB = [{ id: 'chosen', name: 'topic-144319', tmuxSession: 'echo-topic-144319', status: 'running', startedAt: iso(-60_000), telegramTopicId: 144319 }];
    revokedSenders.add(A);
    const body = { target: 'echo-topic-144319' };
    const response = await request(appB).post(MESSAGE_GENERATION_PATH).set(signRequest(A, K[A].privatePem, body)).send(body);
    expect(response.status).toBe(403);
    expect(response.body).not.toHaveProperty('observation');
    expect(response.body).not.toHaveProperty('sig');
  });

  it.each(['sessionId', 'sessionGenerationRequired'])('the envelope signature covers to.%s even under a freshly authenticated HTTP wrapper', async (field) => {
    sessionsB = [{ id: 'chosen', name: 'topic-144319', tmuxSession: 'echo-topic-144319', status: 'running', startedAt: iso(-60_000), telegramTopicId: 144319 }];
    alterRelayedBody = (env) => { (env.message.to as any)[field] = field === 'sessionId' ? 'tampered-id' : false; };
    const sent = await send();
    await until(async () => (await storeA.get(sent.messageId))?.delivery.phase === 'failed');
    if (field === 'sessionId') expect((await storeA.get(sent.messageId))?.delivery.failureReason).toContain('relay-signature-invalid');
    expect(await storeB.get(sent.messageId)).toBeNull();
    expect(typedB).toHaveLength(0);
  });

  it('a LAN intermediary rewriting the strict payload path to the old route cannot downgrade the signed wrapper', async () => {
    sessionsB = [{ id: 'chosen', name: 'topic-144319', tmuxSession: 'echo-topic-144319', status: 'running', startedAt: iso(-60_000), telegramTopicId: 144319 }];
    rewriteToOldPath = true;
    const sent = await send();
    await until(async () => (await storeA.get(sent.messageId))?.delivery.phase === 'failed');
    expect(await storeB.get(sent.messageId)).toBeNull();
    expect(typedB).toHaveLength(0);
  });

  it('a fresh short-TTL message survives receiver clock offset inside machine-auth admission', async () => {
    sessionsB = [{ id: 'chosen', name: 'topic-144319', tmuxSession: 'echo-topic-144319', status: 'running', startedAt: iso(-60_000), telegramTopicId: 144319 }];
    beforeRelayToB = () => advance(10000);
    const sent = await routerA.send({ agent: 'echo', session: 'echo-lead', machine: A }, { agent: 'echo', session: 'echo-topic-144319', machine: B }, 'handoff', 'medium', 'S', 'Body', { ttlMinutes: 0.1 });
    await until(async () => (await storeB.get(sent.messageId))?.delivery.phase === 'delivered');
    expect(typedB).toHaveLength(1);
    expect((await storeB.get(sent.messageId))?.delivery.expiresAt).toBeGreaterThan(Date.now());
  });

  it('a receiver without its resolver returns unavailable rather than a signed no-holder observation', async () => {
    (routerB as any).config.resolveSession = undefined;
    const body = { target: 'echo-topic-144319' };
    const response = await request(appB).post(MESSAGE_GENERATION_PATH).set(signRequest(A, K[A].privatePem, body)).send(body);
    expect(response.status).toBe(503); expect(response.body.observation).toBeUndefined();
  });

  it.each([{ sessionGenerationRequired: false, sessionId: 'chosen' }, { sessionGenerationRequired: true }, { sessionId: 'chosen' }])('strict route rejects an incomplete declared protocol: %j', async (to) => {
    const body = { protocol: 'session-generation-v1', generationEnvelope: { message: { id: 'invalid-strict', to } } };
    const response = await request(appB).post(GENERATION_RELAY_MACHINE_PATH).set(signRequest(A, K[A].privatePem, body)).send(body);
    expect(response.status).toBe(400); expect(typedB).toHaveLength(0);
  });

  it('a mixed-version peer without generation proof causes immediate recorded failure at the origin, with no payload relay', async () => {
    (routerA as any).config.peerSessionGeneration = async () => ({ reason: 'HTTP 404' });
    sessionsB = [{ id: 'young', name: 'topic-144319', tmuxSession: 'echo-topic-144319', status: 'running', startedAt: iso(-60_000), telegramTopicId: 144319 }];
    const sent = await send();
    expect(sent.phase).toBe('failed');
    expect((await storeA.get(sent.messageId))?.message.to).toMatchObject({ sessionGenerationRequired: true });
    expect((await storeA.get(sent.messageId))?.delivery.failureReason).toContain('no receiving session generation was proved');
    expect(await storeB.get(sent.messageId)).toBeNull();
    expect(failuresA).toHaveLength(1); expect(typedB).toHaveLength(0);
  });

  it('a young holder that started two minutes before the send is accepted on arrival (N73)', async () => {
    sessionsB = [{ id: 't1', name: 'topic-144319', tmuxSession: 'echo-topic-144319', status: 'running', startedAt: iso(-2 * 60_000), telegramTopicId: 144319 }];
    const res = await send();
    await until(async () => typedB.length > 0);
    expect(typedB[0].s).toBe('echo-topic-144319');
    const onB = await storeB.get(res.messageId);
    expect(onB!.delivery.phase).toBe('delivered');
    expect(fs.existsSync(auditB)).toBe(false);
    await until(async () => (await storeA.get(res.messageId))?.delivery.phase === 'received');
    expect(failuresA).toEqual([]);
  });

  it('a replacement during accepted transit never receives its predecessor’s message, and the sender is told immediately', async () => {
    const startedAt = iso(10_000);
    sessionsB = [{ id: 't1', name: 'topic-144319', tmuxSession: 'echo-topic-144319', status: 'running', startedAt: iso(-2 * 60_000), telegramTopicId: 144319 }];
    beforeRelayToB = () => { advance(20_000); sessionsB[0] = { ...sessionsB[0], id: 'replacement', startedAt }; };
    const res = await send();
    await until(async () => (await storeA.get(res.messageId))?.delivery.phase === 'failed');
    expect((await storeB.get(res.messageId))?.delivery.failureReason).toBe('target-session-generation-changed');
    expect((await storeA.get(res.messageId))?.delivery.failureReason).toContain('no replacement may receive it');
    expect(failuresA).toHaveLength(1); expect(typedB).toHaveLength(0);
    await retryB.runRecoveryCycle();
    expect(typedB).toHaveLength(0); expect(failuresA).toHaveLength(1);
    const rows = fs.readFileSync(auditB, 'utf8').trim().split('\n').map((row) => JSON.parse(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ reason: 'target-session-generation-changed', holderStartedAt: startedAt, outcome: 'failed' });
  });

  it('a role known on the receiver but not running yet waits, then is typed once its session is up', async () => {
    sessionsB = [{ id: 'old', name: 'topic-144319', tmuxSession: 'echo-topic-144319', status: 'completed', startedAt: iso(-60 * 60_000), telegramTopicId: 144319 }];
    const res = await sendLegacy();
    await until(async () => (await storeB.get(res.messageId))?.delivery.phase === 'received' && (await storeB.get(res.messageId))?.delivery.holderPending === true);
    expect((await storeB.get(res.messageId))!.delivery.failureReason).toBe('topic-not-held-here');
    expect((await storeB.get(res.messageId))!.delivery.holderPending).toBe(true);
    const sentAt = Date.parse((await storeB.get(res.messageId))!.message.createdAt);
    advance(31_000); await retryB.runRecoveryCycle();
    expect(typedB).toHaveLength(0);
    // A delayed session record becomes visible: the holder actually started before the send.
    sessionsB.push({ id: 'new', name: 'echo-topic-144319', tmuxSession: 'echo-echo-topic-144319', status: 'running', startedAt: new Date(sentAt - 20 * 60_000).toISOString(), telegramTopicId: 144319 });
    advance(31_000); await retryB.runRecoveryCycle();
    const onB = (await storeB.get(res.messageId))!;
    expect(onB.delivery.phase).toBe('delivered');
    expect(onB.delivery.resolvedSession).toBe('echo-echo-topic-144319');
    expect(onB.delivery.holderPending).toBeUndefined();
    expect(typedB.at(-1)!.s).toBe('echo-echo-topic-144319');
    // Nothing went back to the sender: the origin copy stays 'received'.
    await until(async () => (await storeA.get(res.messageId))?.delivery.phase === 'received');
    expect((await storeA.get(res.messageId))!.delivery.phase).toBe('received');
    expect(failuresA).toEqual([]);
  });

  it('an unknown role from a legacy sender is still refused at once and the sender told', async () => {
    sessionsB = [{ id: 'w', name: 'worker', tmuxSession: 'echo-worker', status: 'running', startedAt: iso(-60_000) }];
    const res = await sendLegacy('echo-nobody');
    await until(async () => (await storeA.get(res.messageId))?.delivery.phase === 'failed');
    expect((await storeA.get(res.messageId))!.delivery.failureReason).toContain(`refused on ${B}: no session holds "echo-nobody"`);
    expect(failuresA).toHaveLength(1);
    expect((await storeB.get(res.messageId))!.delivery.holderPending).toBeUndefined();
  });
});
