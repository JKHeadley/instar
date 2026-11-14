import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {deriveGraphErasureIdentity} from '../../src/core/ConversationGraphOperation.js';
import {encodeGraphSourceEnvelope} from '../../src/core/ConversationGraphSourceEnvelope.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MachineIdentityManager, sign } from '../../src/core/MachineIdentity.js';
import { StateManager } from '../../src/core/StateManager.js';
import { ConversationRegistry } from '../../src/core/ConversationRegistry.js';
import { createConversationBindAuth } from '../../src/core/conversationBindToken.js';
import { FencedLease } from '../../src/core/FencedLease.js';
import { signEnvelope } from '../../src/core/MeshRpc.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { WriteAdmission } from '../../src/core/WriteAdmission.js';
import { buildWriteDomainRegistry } from '../../src/core/WriteDomainRegistry.js';
import { canonicalHash, signGraphRecord, type GraphMembershipEpoch, type GraphWitnessLease } from '../../src/core/GraphWitnessTypes.js';
import { ConversationGraphRemoteDelegationSource, ConversationGraphRemoteDelegationIngress, verifyRemoteGraphDelegationSource,
  verifyRemoteGraphDelegationCoreSource } from '../../src/core/ConversationGraphDelegationRemote.js';
import { verifyGraphAuthorization } from '../../src/core/ConversationGraphReplicationProof.js';
import type { DelegationPlacementHead, GraphDelegationConversationRef } from '../../src/core/ConversationGraphDelegation.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';

const NOW = Date.parse('2026-11-05T10:00:00Z');
const parentRef: GraphDelegationConversationRef = { kind: 'conversation', platform: 'telegram', chatId: '-100123', topicId: 42 };
const workerRef: GraphDelegationConversationRef = { ...parentRef, topicId: 43 };

describe('independently signed live cross-machine delegation', () => {
  let dir: string;
  let machines: { identity: MachineIdentityManager; state: StateManager; registry: ConversationRegistry;
    auth: ReturnType<typeof createConversationBindAuth>; capture: ConversationGraphRemoteDelegationSource; id: string }[];
  let membership: GraphMembershipEpoch;
  let bridge: GraphWitnessLease;
  let graphLease: ReturnType<FencedLease['signLease']>;
  let ingress: ConversationGraphRemoteDelegationIngress;
  let admission: WriteAdmission;
  let ownership: Map<number, SessionOwnershipRecord>;
  let heads: DelegationPlacementHead[];
  let owner: ReturnType<typeof crypto.generateKeyPairSync<'ed25519'>>;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-remote-delegation-'));
    owner = crypto.generateKeyPairSync('ed25519');
    ownership = new Map(); heads = []; machines = [];
    for (const name of ['writer', 'parent', 'worker']) {
      const base = path.join(dir, name); const identity = new MachineIdentityManager(base);
      const record = await identity.generateIdentity({ name });
      const state = new StateManager(base); const auth = createConversationBindAuth(base);
      const registry = new ConversationRegistry({ stateDir: base, machineId: () => record.machineId });
      const capture = new ConversationGraphRemoteDelegationSource({ agentId: 'echo', identity, state, bindAuth: auth, conversations: registry,
        telegramChatId: '-100123', conversationIdsForSession: (tmux) => tmux === 'parent-tmux' ? [42] : tmux === 'worker-tmux' ? [43] : [],
        projectForConversation: () => 'instar', ownershipForConversation: (ref) => ref.platform === 'telegram' ? ownership.get(ref.topicId) ?? null : null,
        ownerPublicKey: owner.publicKey, now: () => NOW });
      machines.push({ identity, state, auth, registry, capture, id: record.machineId });
    }
    const [writer, parent, worker] = machines;
    const m = { v: 1 as const, agentId: 'echo', epoch: 1, previousMembershipHash: null, writerId: writer.id,
      witnessId: 'external-witness', failureDomain: 'managed-external', createdAt: new Date(NOW - 2000).toISOString(),
      members: machines.map((m) => ({ machineId: m.id, signingPublicKey: m.identity.getSigningPublicKeyPem(m.id)!,
        sealingPublicKey: m.identity.getEncryptionPublicKeyPem(m.id)! })) };
    membership = { ...m, signature: signGraphRecord('graph-membership-v1', m, owner.privateKey) };
    const lease = new FencedLease({ selfMachineId: writer.id, sign: (bytes) => sign(bytes, writer.identity.loadSigningKey()), verify: () => false }, { leaseTtlMs: 60000, failoverThresholdMs: 180000 });
    graphLease = lease.signLease(3, new Date(NOW - 1000).toISOString(), new Date(NOW + 59000).toISOString(), 1);
    const b = { v: 1 as const, agentId: 'echo', membershipEpoch: 1, leaseEpoch: 3, writerId: writer.id,
      issuedAt: graphLease.acquiredAt, expiresAt: graphLease.expiresAt, fencedLeaseHash: canonicalHash(graphLease) };
    bridge = { ...b, signature: signGraphRecord('graph-lease-v1', b, writer.identity.loadSigningKey()) };
    for (const [topic, machine] of [[42, parent], [43, worker]] as const) ownership.set(topic, {
      sessionKey: `telegram-${topic}`, ownerMachineId: machine.id, ownershipEpoch: 7, status: 'active', nonce: 'ownership', timestamp: NOW,
      updatedAt: new Date(NOW - 500).toISOString() });
    parent.state.saveSession({ id: 'parent-session', name: 'parent', tmuxSession: 'parent-tmux', status: 'running', startedAt: new Date(NOW - 1500).toISOString() });
    worker.state.saveSession({ id: 'worker-session', name: 'worker', tmuxSession: 'worker-tmux', status: 'running', startedAt: new Date(NOW - 500).toISOString() });
    admission = new WriteAdmission({ thisMachineId: writer.id, isReadOnly: () => false, isPoolActive: () => true,
      registry: buildWriteDomainRegistry({ machineId: writer.id }), dryRun: false, disableTimers: true });
    ingress = new ConversationGraphRemoteDelegationIngress({ agentId: 'echo', stateDir: writer.state.baseDir, identity: writer.identity, admission,
      coordinator: { holdsLease: () => true, currentEpoch: () => 3, currentLease: () => graphLease }, ownerPublicKey: owner.publicKey,
      membership: () => membership, leaseBridge: () => bridge, verifiedHeadsFor: () => heads, parentProjectScope: () => ['instar'],
      projectForConversation: () => 'instar', ownershipForConversation: (ref) => ref.platform === 'telegram' ? ownership.get(ref.topicId) ?? null : null, now: () => NOW });
  });
  afterEach(async () => { admission?.stop(); for (const m of machines ?? []) await m.registry.close();
    if (dir) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'remote-delegation-test-cleanup' }); });
  function request() { return machines[1].capture.createRequest({ sourceId: 'dispatch-remote-1', parentSessionId: 'parent-session',
    parentBindToken: machines[1].auth.mint('parent-tmux', [42]), parentRef, workerRef, targetMachineId: machines[2].id, membership, graphLease }); }
  function transport(r = request()) { return signEnvelope({ sender: machines[1].id, recipient: machines[2].id, epoch: 7, nonce: 'nonce1', timestamp: NOW,
    command: { type: 'deliverMessage', session: 'telegram-43', messageId: 'dispatch-remote-1', ownershipEpoch: 7,
      payload: { graphDelegationRequest: r, prompt: 'private prompt excluded from graph proof' } } }, (bytes) => sign(bytes, machines[1].identity.loadSigningKey())); }
  function source() { const r = request(); return machines[2].capture.attestSuccessfulSpawn({ request: r, membership, originalMeshEnvelope: transport(r),
    workerSessionId: 'worker-session', workerBindToken: machines[2].auth.mint('worker-tmux', [43]) }); }

  it('accepts a real standby parent and worker proof, then signs only as independent admitted writer', () => {
    const s = source(); expect(verifyRemoteGraphDelegationSource(s, membership)).toBe(true);
    const result = ingress.prepare(s); expect(result.status).toBe('proposed'); if (result.status !== 'proposed') return;
    expect(result.core.machineId).toBe(machines[0].id); expect(s.request.requesterMachineId).toBe(machines[1].id);
    expect(s.attestation.targetMachineId).toBe(machines[2].id);
    expect(verifyRemoteGraphDelegationCoreSource(result.core, s, membership, machines[0].id)).toBe(true);
    const receipt = result.authorizationProof.receipt;
    const packet = { coreType:'graph-event' as const, controlHash:canonicalHash(createGraphControlCapsule('graph-event',result.core as unknown as Record<string,unknown>,result.authorizationProof)), erasureIdentity:deriveGraphErasureIdentity('graph-event',result.core), agentId: 'echo', eventId: receipt.eventId, idempotencyKey: receipt.idempotencyKey, coreHash: canonicalHash(result.core),
      authorizationReceiptHash: canonicalHash(receipt), sourceSequence: 1, predecessorHash: null, membershipEpoch: 1, leaseEpoch: 3,
      writerId: machines[0].id, sourceBundleHash: 'a'.repeat(64) };
    expect(verifyGraphAuthorization(packet, result.core, result.authorizationProof, owner.publicKey, machines[0].id)).toEqual({ ok: true });
    expect(verifyRemoteGraphDelegationCoreSource({ ...result.core, title: 'unerasable plaintext' }, s, membership, machines[0].id)).toBe(false);
    expect(JSON.stringify(s)).not.toContain('private prompt'); expect(JSON.stringify(s)).not.toContain(machines[1].auth.mint('parent-tmux', [42]));
    expect(ingress.prepare(s)).toEqual(result);
    machines[2].state.saveSession({ ...machines[2].state.getSession('worker-session')!, status: 'completed' });
    expect(machines[2].capture.readCaptured(s.request.sourceId, membership)).toEqual(s);
    expect(machines[2].capture.readCaptured(s.request.sourceId, { ...membership, writerId: machines[1].id })).toBeNull();
  });
  it('binds the signed parent ownership epoch and sessionKey and preserves frozen proof across lease renewal', () => {
    const s = source();
    ownership.get(42)!.ownershipEpoch++;
    expect(ingress.prepare(s)).toMatchObject({ status: 'refused', reason: 'remote-session-ownership-changed' });
    ownership.get(42)!.ownershipEpoch--;
    ownership.get(42)!.sessionKey = 'replacement-parent';
    expect(ingress.prepare(s)).toMatchObject({ status: 'refused', reason: 'remote-session-ownership-changed' });
    ownership.get(42)!.sessionKey = 'telegram-42';
    const first = ingress.prepare(s); expect(first.status).toBe('proposed');
    const writer = machines[0];
    const fl = new FencedLease({ selfMachineId: writer.id, sign: (b) => sign(b, writer.identity.loadSigningKey()), verify: () => false }, { leaseTtlMs: 60000, failoverThresholdMs: 180000 });
    graphLease = fl.signLease(3, new Date(NOW - 500).toISOString(), new Date(NOW + 59500).toISOString(), 2);
    const b = { v: 1 as const, agentId: 'echo', membershipEpoch: 1, leaseEpoch: 3, writerId: writer.id, issuedAt: graphLease.acquiredAt, expiresAt: graphLease.expiresAt, fencedLeaseHash: canonicalHash(graphLease) };
    bridge = { ...b, signature: signGraphRecord('graph-lease-v1', b, writer.identity.loadSigningKey()) };
    expect(ingress.prepare(s)).toEqual(first);
  });
  it('accepts the registered current native lease holder after takeover without changing installed owner enrollment', () => {
    // Installed genesis writer differs from the actual higher-epoch holder.
    const { signature: _previousSignature, ...installed } = membership;
    installed.writerId = machines[1].id;
    membership = { ...installed, signature: signGraphRecord('graph-membership-v1', installed, owner.privateKey) };
    const frozenEnrollment = JSON.stringify(membership);
    const s = source(); const result = ingress.prepare(s);
    expect(result.status).toBe('proposed'); if (result.status !== 'proposed') return;
    expect(result.authorizationProof.receipt.writerId).toBe(machines[0].id);
    expect(result.authorizationProof.originalLease.holder).toBe(machines[0].id);
    expect(JSON.stringify(result.authorizationProof.membership)).toBe(frozenEnrollment);
    const receipt = result.authorizationProof.receipt;
    const packet = { coreType:'graph-event' as const, controlHash:canonicalHash(createGraphControlCapsule('graph-event',result.core as unknown as Record<string,unknown>,result.authorizationProof)), erasureIdentity:deriveGraphErasureIdentity('graph-event',result.core), agentId: 'echo', eventId: receipt.eventId, idempotencyKey: receipt.idempotencyKey, coreHash: canonicalHash(result.core),
      authorizationReceiptHash: canonicalHash(receipt), sourceSequence: 1, predecessorHash: null, membershipEpoch: membership.epoch,
      leaseEpoch: graphLease.epoch, writerId: machines[0].id, sourceBundleHash: 'a'.repeat(64) };
    expect(verifyGraphAuthorization(packet, result.core, result.authorizationProof, owner.publicKey, machines[0].id)).toEqual({ ok: true });
    expect(JSON.stringify(membership)).toBe(frozenEnrollment);
  });
  it('rejects bearer-only capture and a worker bound to another conversation', () => {
    expect(() => machines[1].capture.createRequest({ sourceId: 'no-bind', parentSessionId: 'parent-session', parentBindToken: 'bearer',
      parentRef, workerRef, targetMachineId: machines[2].id, membership, graphLease })).toThrow('parent-proof');
    const r = request(); expect(() => machines[2].capture.attestSuccessfulSpawn({ request: r, membership, originalMeshEnvelope: transport(r),
      workerSessionId: 'worker-session', workerBindToken: machines[2].auth.mint('worker-tmux', [44]) })).toThrow('worker-proof');
  });
  it('rejects changed recipient, payload and ownership epoch even with authentic source request', () => {
    const r = request(); const good = transport(r);
    for (const env of [{ ...good, recipient: machines[0].id }, { ...good, command: { ...good.command, payload: {} } }])
      expect(() => machines[2].capture.attestSuccessfulSpawn({ request: r, membership, originalMeshEnvelope: env,
        workerSessionId: 'worker-session', workerBindToken: machines[2].auth.mint('worker-tmux', [43]) })).toThrow('mesh-proof');
    ownership.get(43)!.ownershipEpoch++;
    expect(() => machines[2].capture.attestSuccessfulSpawn({ request: r, membership, originalMeshEnvelope: good,
      workerSessionId: 'worker-session', workerBindToken: machines[2].auth.mint('worker-tmux', [43]) })).toThrow('ownership-changed');
  });
  it('fails closed on forged source signatures and owner placement never gets replaced', () => {
    const s = source(); const tampered = structuredClone(s); tampered.attestation.workerSessionId = 'forged';
    expect(verifyRemoteGraphDelegationSource(tampered, membership)).toBe(false);
    expect(ingress.prepare(tampered).status).toBe('refused');
    heads = [{ eventId: 'owner-head', authority: 'owner' }];
    expect(ingress.prepare(s)).toEqual({ status: 'suggestion', sourceId: 'dispatch-remote-1', reason: 'owner-placement-exists' });
  });
  it('fences changed ownership and refuses corrupted persisted proposed receipt', () => {
    const s = source(); const first = ingress.prepare(s); expect(first.status).toBe('proposed');
    ownership.get(43)!.ownershipEpoch++;
    expect(ingress.prepare(s)).toMatchObject({ status: 'refused', reason: 'remote-session-ownership-changed' });
    ownership.get(43)!.ownershipEpoch--;
    const root = path.join(machines[0].state.baseDir, 'state', 'conversation-graph-remote-delegation');
    const file = path.join(root, fs.readdirSync(root).find((name) => name.endsWith('.prepared.json'))!);
    const stored = JSON.parse(fs.readFileSync(file, 'utf8')); stored.authorizationProof.receipt.signature = 'forged'; fs.writeFileSync(file, JSON.stringify(stored));
    expect(ingress.prepare(s)).toMatchObject({ status: 'refused', reason: 'remote-prepared-source-conflict' });
  });
  it('binds the signed placing generation and refuses another active generation on the same machine',()=>{
    ownership.get(43)!.status='placing';
    const r=request();const env=transport(r);machines[2].capture.admitDispatch({request:r,membership,originalMeshEnvelope:env});
    ownership.get(43)!.status='active';ownership.get(43)!.ownershipEpoch=8;
    const saved=machines[2].capture.attestSuccessfulSpawn({request:r,membership,workerSessionId:'worker-session',workerBindToken:machines[2].auth.mint('worker-tmux',[43])});
    expect(verifyRemoteGraphDelegationSource(saved,membership)).toBe(true);
    ownership.get(43)!.ownershipEpoch=9;
    expect(()=>machines[2].capture.attestSuccessfulSpawn({request:r,membership,workerSessionId:'worker-session',workerBindToken:machines[2].auth.mint('worker-tmux',[43])})).toThrow('worker-proof');
  });
  it('retains only separately signed dispatch admission after the original prompt frame is gone',()=>{
    const r=request();const frame=transport(r);const receipt=machines[2].capture.admitDispatch({request:r,membership,originalMeshEnvelope:frame});
    const root=path.join(machines[2].state.baseDir,'state','conversation-graph-remote-delegation');
    const persisted=fs.readdirSync(root).map(file=>fs.readFileSync(path.join(root,file),'utf8')).join('');
    expect(persisted).not.toContain('private prompt');expect(persisted).not.toContain('graphDelegationLaunch');
    const restored=machines[2].capture.attestSuccessfulSpawn({request:r,membership,workerSessionId:'worker-session',workerBindToken:machines[2].auth.mint('worker-tmux',[43])});
    expect(restored.admission).toEqual(receipt);expect(verifyRemoteGraphDelegationSource(restored,membership)).toBe(true);
    const forged=structuredClone(restored);forged.admission.sessionKey='other';expect(verifyRemoteGraphDelegationSource(forged,membership)).toBe(false);
  });

});
