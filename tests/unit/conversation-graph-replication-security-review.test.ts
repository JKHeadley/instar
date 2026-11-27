import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
/** Independent witness contract regressions found during replication review. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { Server } from 'node:http';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { GraphWitnessService } from '../../src/core/GraphWitnessService.js';
import { GraphWitnessClient } from '../../src/core/GraphWitnessClient.js';
import { canonicalHash, GRAPH_SIGNATURE_DOMAINS, signGraphRecord, witnessActionPayload } from '../../src/core/GraphWitnessTypes.js';
import { replicationFixture } from './conversation-graph-replication.fixtures.js';

const directories: string[] = []; const services: GraphWitnessService[] = []; let server: Server | null = null;
afterEach(async () => {
  if (server) { const s = server; server = null; await new Promise<void>((resolve) => s.close(() => resolve())); }
  for (const service of services.splice(0)) service.close();
  for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'replication-security-review:teardown' });
});
async function fixture() {
  const f = replicationFixture(); const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-review-')); directories.push(dir);
  const service = new GraphWitnessService({ databasePath: path.join(dir, 'witness.sqlite'), witnessId: 'independent-witness',
    failureDomain: 'managed-external', signingPrivateKey: f.witness.privateKey,
    installedFailureDomains: ['installed-writer', 'installed-sleeper'], now: () => Date.parse('2026-11-05T08:06:00Z'),
    enrollments: { echo: { ownerPublicKey: f.owner.publicKey.export({ type: 'spki', format: 'pem' }).toString(), bearerToken: 'review-test-only-token' } } });
  services.push(service); service.registerMembership(f.membership);
  const r = f.record(); const preparation = { controlCapsule:createGraphControlCapsule(r.coreType,r.core,r.authorizationProof), packet: r.packet, packetSignature: r.packetSignature, lease: f.lease,
    originalLease: f.originalLease, encryptedSourceBundle: r.encryptedSourceBundle! };
  service.prepare(preparation);
  return { ...f, service, r };
}

describe('independent witness security regressions', () => {
  it('refuses even correctly signed receipt fields that would persist plaintext at the witness', async () => {
    const f = await fixture();
    const receipts = f.members.map((m, index) => {
      const payload = { agentId: 'echo', eventId: f.r.packet.eventId, operationHash: canonicalHash(f.r.packet), membershipEpoch: 1,
        leaseEpoch: 1, machineId: m.machineId, phase: 'source' as const, persistedAt: '2026-11-05T08:06:00Z',
        ...(index === 0 ? { debugTranscript: 'private-canary-must-never-persist' } : {}) };
      return { ...payload, signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.memberReceipt, payload, m.signing.privateKey) };
    });
    expect(() => f.service.commit('echo', f.r.packet.idempotencyKey, f.lease, f.originalLease, receipts)).toThrow();
    expect(f.service.operation('echo', f.r.packet.idempotencyKey)?.state).toBe('prepared');
  });
  it('does not accept an unsigned final-state claim attached to a valid preparation proof', async () => {
    const f = await fixture(); const operation = f.service.operation('echo', f.r.packet.idempotencyKey)!;
    const app = express();let tamper=false;app.get('/v1/agents/echo/memberships/1',(_req,res)=>res.json(f.membership));app.get('/v1/agents/echo/operations/:key', (_req, res) => res.json(tamper?{ ...operation, state: 'certified', certificate: null }:operation));
    server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('listen-address-missing');
    const client = new GraphWitnessClient({ baseUrl: `http://127.0.0.1:${address.port}`, agentId: 'echo',
      witnessId: 'independent-witness', expectedFailureDomain: 'managed-external',
      witnessPublicKey: f.witness.publicKey.export({ type: 'spki', format: 'pem' }).toString(),
      bearerToken: 'review-test-only-token',ownerPublicKey:f.owner.publicKey.export({type:'spki',format:'pem'}).toString(), allowLoopbackHttpForTests: true });
    expect((await client.operation(f.r.packet.idempotencyKey)).state).toBe('prepared');tamper=true;
    await expect(client.operation(f.r.packet.idempotencyKey)).rejects.toThrow();
  });
  it('keeps witnessed cancellation discoverable until its all-member terminal certificate is durable', async () => {
    const f = await fixture();
    const actionSignature = signGraphRecord(GRAPH_SIGNATURE_DOMAINS.action,
      witnessActionPayload('cancel', { idempotencyKey: f.r.packet.idempotencyKey }, f.lease), f.members[0].signing.privateKey);
    f.service.cancel('echo', f.r.packet.idempotencyKey, f.lease, f.originalLease, actionSignature);
    expect(f.service.pending('echo').map((x) => x.packet.eventId)).toContain(f.r.packet.eventId);
  });
});
