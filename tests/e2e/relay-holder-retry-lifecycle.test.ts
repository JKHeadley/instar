/** Tier 3: mirror server.ts construction with real state, store, router, resolver,
 * retry manager and AgentServer. Only the physical tmux boundary is substituted.
 * The HTTP feature must be alive and delegate to real generation-aware delivery.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import request from 'supertest';
import { MachineIdentityManager } from '../../src/core/MachineIdentity.js';
import { NonceStore } from '../../src/core/NonceStore.js';
import { SecurityLog } from '../../src/core/SecurityLog.js';
import { signRequest, verifyRelayAnswer } from '../../src/server/machineAuth.js';
import { generationProofId } from '../../src/messaging/peerMessageTarget.js';
import { GENERATION_RELAY_MACHINE_PATH, machineRelayBody, MESSAGE_GENERATION_PATH, type MessageEnvelope } from '../../src/messaging/types.js';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { MessageStore } from '../../src/messaging/MessageStore.js';
import { MessageRouter, canonicalJSON, signedPayloadOf } from '../../src/messaging/MessageRouter.js';
import { MessageDelivery } from '../../src/messaging/MessageDelivery.js';
import { MessageFormatter } from '../../src/messaging/MessageFormatter.js';
import { DeliveryRetryManager } from '../../src/messaging/DeliveryRetryManager.js';
import { resolveSessionTarget } from '../../src/messaging/sessionAddressResolver.js';
import { createMockSessionManager } from '../helpers/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { InstarConfig, Session } from '../../src/core/types.js';

describe('holder retry is alive in the server lifecycle', () => {
  let dir: string, server: AgentServer, state: StateManager, store: MessageStore;
  let retry: DeliveryRetryManager;
  let identity: MachineIdentityManager, peer: MachineIdentityManager, nonces: NonceStore;
  let peerId: string, localId: string;
  const typed: string[] = [];
  const authToken = 'holder-lifecycle-fixture';
  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'holder-alive-'));
    vi.spyOn(os, 'homedir').mockReturnValue(dir);
    vi.stubEnv('INSTAR_TEST_REGISTRY_DIR', path.join(dir, 'registry'));
    const stateDir = path.join(dir, '.instar');
    state = new StateManager(stateDir);
    state.saveSession({ id: 'old', name: 'worker', tmuxSession: 'echo-worker', status: 'completed', startedAt: new Date(Date.now() - 3_600_000).toISOString() } as Session);
    store = new MessageStore(path.join(stateDir, 'messages')); await store.initialize();
    const isGeneration = (name: string, id: string) => state.listSessions().some((s) => s.tmuxSession === name && s.id === id && s.status === 'running');
    const delivery = new MessageDelivery(new MessageFormatter(), {
      getForegroundProcess: () => 'bash', isSessionAlive: () => true, isSessionGeneration: isGeneration,
      hasActiveHumanInput: () => false, getOutputLineCount: () => 100,
      sendKeys: (_session, text) => { typed.push(text); return true; },
    });
    identity = new MachineIdentityManager(stateDir);
    peer = new MachineIdentityManager(path.join(dir, 'peer'));
    const local = await identity.generateIdentity({ name: 'Receiver' });
    const remote = await peer.generateIdentity({ name: 'Sender' });
    localId = local.machineId; peerId = remote.machineId;
    identity.registerMachine(remote, 'awake'); identity.storeRemoteIdentity(remote);
    nonces = new NonceStore(stateDir); nonces.initialize();
    const securityLog = new SecurityLog(stateDir);
    const router = new MessageRouter(store, delivery, {
      localAgent: 'echo', localMachine: localId, serverUrl: 'http://localhost:0',
      isOwnSession: (name) => state.listSessions().some((s) => s.tmuxSession === name && s.status === 'running'),
      resolveSession: (target, asOf) => resolveSessionTarget(target, {
        sessions: state.listSessions(), prefix: 'echo', asOf, sessionNameForTopic: () => null, isStandingDown: () => false,
      }),
      refusalAuditPath: path.join(stateDir, 'logs', 'message-delivery-refusals.jsonl'),
    }, { identityManager: identity, signingKeyPem: identity.loadSigningKey(), nonceStore: nonces, securityLog });
    retry = new DeliveryRetryManager(store, delivery, {
      agentName: 'echo', isLocalEnvelope: () => true, isPinnedSessionLive: isGeneration,
      redeliverUnresolved: (envelope, claim) => router.redeliverSameAgentLocal(envelope, claim),
      onDeadLetter: (envelope, reason) => router.reportTerminalFailure(envelope, reason),
    });
    const config = {
      projectName: 'echo', projectDir: dir, stateDir, port: 0, authToken, requestTimeoutMs: 5000, version: 'test',
      sessions: { claudePath: '/usr/bin/echo', maxSessions: 3, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 5000 },
      scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: {}, users: [],
    } as InstarConfig;
    const coordinator = { enabled: true, identity: local, managers: { identityManager: identity,
      nonceStore: nonces, securityLog, heartbeatManager: {} }, getStatus: () => ({}) };
    server = new AgentServer({ config, sessionManager: createMockSessionManager() as any, state, messageRouter: router,
      coordinator: coordinator as any, meshSelfId: localId, localSigningKeyPem: identity.loadSigningKey() });
    await server.start();
  });
  afterAll(async () => {
    nonces.destroy(); retry.stop(); await server.stop(); await store.destroy(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/relay-holder-retry-lifecycle.test.ts' });
  });

  it('mounts the signed generation endpoint through AgentServer and rejects a canonically revoked caller', async () => {
    state.saveSession({ id: 'generation-proof', name: 'proof', tmuxSession: 'echo-proof', status: 'running', startedAt: new Date().toISOString() } as Session);
    const body = { target: 'echo-proof' };
    const signed = () => signRequest(peerId, peer.loadSigningKey(), body);
    const headers = signed();
    const response = await request(server.getApp()).post(MESSAGE_GENERATION_PATH).set(headers).set('Content-Type', 'application/json').send(body);
    expect(response.status).toBe(200);
    expect(response.body.observation.sessionId).toBe('generation-proof');
    expect(response.body.ack).toMatchObject({ machineId: localId, messageId: generationProofId(response.body.observation) });
    expect(verifyRelayAnswer(response.body.ack, response.body.sig, localId, generationProofId(response.body.observation), headers['X-Nonce'], identity.getSigningPublicKeyPem(localId)!)).toBe('ack');
    const now = new Date().toISOString();
    const env: MessageEnvelope = { schemaVersion: 1,
      message: { id: crypto.randomUUID(), from: { agent: 'echo', session: 'sender', machine: peerId }, to: { agent: 'echo', session: 'echo-proof', machine: localId, sessionId: 'generation-proof', sessionGenerationRequired: true }, type: 'info', priority: 'low', subject: 'strict lifecycle', body: 'Signed strict lifecycle payload', createdAt: now, ttlMinutes: 30 },
      transport: { relayChain: [peerId], originServer: 'fixture', nonce: crypto.randomUUID(), timestamp: now, age: 0, signedBy: peerId },
      delivery: { phase: 'relaying', transitions: [], attempts: 0 } };
    env.transport.signature = crypto.sign(null, Buffer.from(canonicalJSON(signedPayloadOf(env))), peer.loadSigningKey()).toString('base64');
    const wrapped = machineRelayBody(env); const transportHeaders = signRequest(peerId, peer.loadSigningKey(), wrapped);
    const relayed = await request(server.getApp()).post(GENERATION_RELAY_MACHINE_PATH).set(transportHeaders).send(wrapped);
    expect(relayed.status).toBe(200);
    expect(verifyRelayAnswer(relayed.body.ack, relayed.body.sig, localId, env.message.id, transportHeaders['X-Nonce'], identity.getSigningPublicKeyPem(localId)!)).toBe('ack');
    await vi.waitFor(() => expect(typed).toHaveLength(1));
    expect(typed[0]).toContain('Signed strict lifecycle payload');
    expect((await store.get(env.message.id))?.delivery).toMatchObject({ phase: 'delivered', resolvedSessionId: 'generation-proof' });
    typed.length = 0;
    const registry = identity.loadRegistry();
    registry.machines[peerId].revokedAt = new Date().toISOString();
    registry.machines[peerId].status = 'active';
    identity.saveRegistry(registry);
    const refused = await request(server.getApp()).post(MESSAGE_GENERATION_PATH).set(signed()).set('Content-Type', 'application/json').send(body);
    expect(refused.status).toBe(403);
    expect(refused.body.observation).toBeUndefined();
  });

  it('POST /messages/send is alive; an unresolved holder waits durably and the real retry pins and delivers', async () => {
    const sent = await request(server.getApp()).post('/messages/send').set('Authorization', `Bearer ${authToken}`).send({
      from: { agent: 'echo', session: 'sender', machine: 'self' }, to: { agent: 'echo', session: 'echo-worker', machine: 'local' },
      type: 'handoff', priority: 'medium', subject: 'holder lifecycle', body: 'A real message through the HTTP pipeline.',
    });
    expect(sent.status).toBe(201);
    const id = sent.body.messageId;
    expect(sent.body.phase).toBe('received');
    expect((await store.get(id))?.delivery).toMatchObject({ holderPending: true, deliveryPending: false });
    expect(typed).toHaveLength(0);
    const waiting = (await store.get(id))!;
    // The real session record was created before the message; its publication was delayed.
    state.saveSession({ id: 'current', name: 'worker', tmuxSession: 'echo-worker-current', status: 'running', startedAt: new Date(Date.parse(waiting.message.createdAt) - 1000).toISOString() } as Session);
    await retry.runRecoveryCycle();
    const delivered = await request(server.getApp()).get(`/messages/${id}`).set('Authorization', `Bearer ${authToken}`);
    expect(delivered.status).toBe(200);
    expect((await store.get(id))?.delivery).toMatchObject({ phase: 'delivered', resolvedSessionId: 'current', resolvedSession: 'echo-worker-current' });
    expect((await store.get(id))?.delivery.holderPending).toBeUndefined();
    expect(typed).toHaveLength(1);
    expect(typed[0]).toContain('A real message through the HTTP pipeline.');
  });
});
