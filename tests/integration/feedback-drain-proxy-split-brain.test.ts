import { once } from 'node:events';
import { generateKeyPairSync, sign, verify, type KeyObject } from 'node:crypto';
import http, { type Server } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { InitiativeTracker } from '../../src/core/InitiativeTracker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { FeedbackProcessingService } from '../../src/feedback-factory/processing/FeedbackProcessingService.js';
import { FeedbackDrainStore } from '../../src/feedback-factory/drain/FeedbackDrainStore.js';
import { FeedbackDrainService } from '../../src/feedback-factory/drain/FeedbackDrainService.js';
import { FeedbackInitiativeConsumer } from '../../src/feedback-factory/drain/FeedbackInitiativeConsumer.js';
import { FeedbackReadinessArbiter } from '../../src/feedback-factory/drain/FeedbackReadinessArbiter.js';
import {
  drainTickProxyEnvelopePayload,
  FeedbackDrainTickProxy,
  type DrainTickGatewayResult,
  type DrainTickProxyEnvelope,
} from '../../src/feedback-factory/drain/FeedbackDrainTickProxy.js';

const KEY = 'split-brain-transport-key'.repeat(3);
const dirs: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  })));
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'feedback-drain-proxy-split-brain.test.ts' });
});

interface RegistryState { owner: 'machine-a' | 'machine-b'; epoch: number }

function machineFixture(machineId: 'machine-a' | 'machine-b', registry: RegistryState, privateKey: KeyObject) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `feedback-proxy-${machineId}-`));
  dirs.push(dir);
  const canonical = path.join(dir, 'canonical');
  const state = path.join(dir, 'state');
  fs.mkdirSync(canonical, { recursive: true });
  fs.writeFileSync(path.join(canonical, 'clusters.jsonl'), `${JSON.stringify({
    clusterId: 'split-cluster', title: 'Split-brain recurrence', type: 'bug', reportCount: 3,
    createdAt: '2026-07-01T00:00:00Z', updatedAt: '2026-07-02T00:00:00Z',
  })}\n`);
  const dbPath = path.join(state, 'feedback-drain.db');
  const store = new FeedbackDrainStore({ dbPath, tokenHmacKey: KEY });
  const authority = store.mutateAuthority({
    action: 'create', operatorDecisionRef: `operator-${machineId}`, authorityId: 'authority', agentId: 'codey',
    ownerMachineId: machineId, ownerEpoch: registry.epoch, provider: 'claude-code', modelFamily: 'fable-5',
    promptVersion: 'p1', schemaVersion: 's1', decisionPointId: 'feedback-readiness',
    maxBatch: 10, maxTokens: 1_000, maxDailySpendUsd: 5,
  });
  store.ensureReadiness('split-cluster');
  store.approveReady({ clusterId: 'split-cluster', approvalKey: `approved-${machineId}`, authorityId: authority.authorityId,
    authorityGeneration: authority.generation, evidenceHash: `evidence-${machineId}`, decisionNonce: `decision-${machineId}-00000001`, proposalSetHash: 'a'.repeat(64) });
  const tracker = new InitiativeTracker(path.join(state, 'initiatives'));
  const arbiter = new FeedbackReadinessArbiter({
    evaluate: async (_prompt, options) => {
      // Keep the real owner run active long enough for the independent HTTP
      // contender to observe/dedupe against the same durable run admission.
      await new Promise((resolve) => setTimeout(resolve, 50));
      options?.onModel?.({ model: 'claude-fable-5', framework: 'claude-code' });
      return JSON.stringify({ decisions: [{ clusterId: 'split-cluster', outcome: 'ready', confidence: 0.96,
        reasonCodes: ['coherent-recurrence'], evidenceIds: ['cluster:split-cluster'] }] });
    },
  });
  const processing = new FeedbackProcessingService({ dataDir: canonical });
  for (const source of processing.sourceFeedbackGenerationPlan()) {
    fs.mkdirSync(path.dirname(source.filePath), { recursive: true });
    fs.closeSync(fs.openSync(source.filePath, 'a'));
  }
  const service = new FeedbackDrainService({
    store,
    processing,
    consumer: new FeedbackInitiativeConsumer(tracker),
    arbiter,
    authorityId: 'authority',
    ownerHost: machineId,
    ownerEpoch: () => registry.epoch,
    isCanonicalOwner: () => registry.owner === machineId,
    isConsumerLive: () => true,
  });
  return { machineId, dir, state, dbPath, store, tracker, service, privateKey };
}

async function listen(proxy: FeedbackDrainTickProxy): Promise<{ baseUrl: string }> {
  const server = http.createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> : {};
      let result: DrainTickGatewayResult;
      if (req.url === '/tick') result = await proxy.request({ agentId: String(body.agentId), nonce: String(body.nonce) });
      else if (req.url === '/proxy') result = await proxy.receive(body.proxyEnvelope as DrainTickProxyEnvelope);
      else result = { status: 503, body: { error: 'unknown test route' } };
      res.writeHead(result.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(result.body));
    })().catch((error) => {
      res.writeHead(503, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'transport failure' }));
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('loopback server did not bind');
  return { baseUrl: `http://127.0.0.1:${address.port}` };
}

async function post(baseUrl: string, route: '/tick' | '/proxy', body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`${baseUrl}${route}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}

async function eventually(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('timed out waiting for the real drain service');
}

describe('feedback drain networked two-machine split-brain proxy fence', () => {
  it('routes a nonowner over HTTP to the registry owner, never executes locally, and rejects stale authority after owner change', async () => {
    const registry: RegistryState = { owner: 'machine-a', epoch: 7 };
    const identityA = generateKeyPairSync('ed25519');
    const identityB = generateKeyPairSync('ed25519');
    const publicKeys = new Map([['machine-a', identityA.publicKey], ['machine-b', identityB.publicKey]]);
    const machineA = machineFixture('machine-a', registry, identityA.privateKey);
    const machineB = machineFixture('machine-b', registry, identityB.privateKey);
    const endpoints = new Map<string, string>();

    const makeProxy = (machine: typeof machineA) => new FeedbackDrainTickProxy({
      selfMachineId: machine.machineId,
      ownerMachineId: () => registry.owner,
      isCanonicalOwner: () => registry.owner === machine.machineId,
      store: machine.store,
      service: machine.service,
      signingKey: KEY,
      signEnvelope: (payload) => sign(null, Buffer.from(payload), machine.privateKey).toString('hex'),
      verifyEnvelope: (sender, payload, signature) => {
        const publicKey = publicKeys.get(sender);
        return Boolean(publicKey && verify(null, Buffer.from(payload), publicKey, Buffer.from(signature, 'hex')));
      },
      transport: async (target, envelope) => {
        const endpoint = endpoints.get(target);
        if (!endpoint) return { status: 503, body: { error: 'registry target unavailable' } };
        const response = await post(endpoint, '/proxy', { proxyEnvelope: envelope });
        return response as DrainTickGatewayResult;
      },
    });

    const proxyA = makeProxy(machineA);
    const proxyB = makeProxy(machineB);
    const endpointA = await listen(proxyA);
    const endpointB = await listen(proxyB);
    endpoints.set('machine-a', endpointA.baseUrl);
    endpoints.set('machine-b', endpointB.baseUrl);

    expect(machineA.service.canAgentMutateReadiness('codey')).toBe(true);
    const nonownerResponse = await post(endpointB.baseUrl, '/tick', { agentId: 'codey', nonce: 'network-nonowner-b-nonce-001' });
    expect(nonownerResponse.status, JSON.stringify(nonownerResponse.body)).toBe(202);
    expect(nonownerResponse.body).toMatchObject({ proxied: true });
    expect(nonownerResponse.body.runId).toEqual(expect.any(String));

    try {
      await eventually(() => machineA.store.workByKey('feedback-work:split-cluster:1')?.state === 'completed');
    } catch {
      throw new Error(JSON.stringify({ run: machineA.store.lastRun(), readiness: machineA.store.getReadiness('split-cluster'),
        work: machineA.store.workByKey('feedback-work:split-cluster:1'), authority: machineA.store.authorityPosture('authority', 1) }));
    }
    expect(machineA.tracker.findByFeedbackWorkKey('feedback-work:split-cluster:1')).toBeDefined();
    expect(machineB.store.lastRun()).toBeNull();
    expect(machineB.store.metrics().work).toEqual({ queued: 0, claimed: 0, completed: 0, retryable: 0, 'dead-lettered': 0, held: 0 });
    expect(machineB.tracker.list()).toHaveLength(0);

    const verifyA = new Database(machineA.dbPath, { readonly: true });
    const verifyB = new Database(machineB.dbPath, { readonly: true });
    expect((verifyA.prepare('SELECT COUNT(*) n FROM work').get() as { n: number }).n).toBe(1);
    expect((verifyA.prepare('SELECT COUNT(*) n FROM artifact_links').get() as { n: number }).n).toBe(1);
    expect((verifyB.prepare('SELECT COUNT(*) n FROM work').get() as { n: number }).n).toBe(0);
    expect((verifyB.prepare('SELECT COUNT(*) n FROM artifact_links').get() as { n: number }).n).toBe(0);
    verifyB.close(); verifyA.close();

    // An epoch advance without a matching operator-ratified authority record is
    // refused before another run can be admitted.
    registry.epoch = 8;
    const staleEpoch = await post(endpointA.baseUrl, '/tick', { agentId: 'codey', nonce: 'network-stale-epoch-nonce-001' });
    expect(staleEpoch.status).toBe(403);
    expect(machineA.store.lastRun()?.runId).toBe(nonownerResponse.body.runId);

    // Once the registry owner changes, even a previously valid, asymmetrically
    // signed envelope targeting A is stale and cannot execute there.
    const issuedAt = Date.now();
    const unsigned = { version: 1 as const, senderMachineId: 'machine-b', targetMachineId: 'machine-a', agentId: 'codey',
      nonce: 'network-captured-envelope-001', issuedAt, expiresAt: issuedAt + 30_000, hopCount: 1 as const, action: 'feedback-drain-tick' as const };
    const captured: DrainTickProxyEnvelope = { ...unsigned, signature: sign(null, Buffer.from(drainTickProxyEnvelopePayload(unsigned)), identityB.privateKey).toString('hex') };
    registry.owner = 'machine-b';
    const staleOwner = await post(endpointA.baseUrl, '/proxy', { proxyEnvelope: captured });
    expect(staleOwner).toMatchObject({ status: 409, body: { reason: 'not-canonical-owner' } });
    expect(machineA.store.metrics().work.completed).toBe(1);
    expect(machineB.store.metrics().work.completed).toBe(0);

    machineB.store.close(); machineA.store.close();
  });
});
