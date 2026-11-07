import {GRAPH_REPLICATION_MAX_LEASE_EPOCH,GRAPH_REPLICATION_EPOCH_STRIDE} from '../../src/core/ConversationGraphReplicationLimits.js';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import {ConversationGraphLocalErasureFence} from '../../src/core/ConversationGraphLocalErasure.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConversationGraphReplication, graphReplicationFileStem, validateGraphReplicationRecord, verifyGraphCommitProofDeliveryReceipt } from '../../src/core/ConversationGraphReplication.js';
import { verifyGraphAuthorization } from '../../src/core/ConversationGraphReplicationProof.js';
import { canonicalHash, GRAPH_SIGNATURE_DOMAINS, signGraphRecord, type GraphWitnessErasure } from '../../src/core/GraphWitnessTypes.js';
import { replicationFixture } from './conversation-graph-replication.fixtures.js';
import { ReplicatedKindRegistry } from '../../src/core/ReplicatedRecordEnvelope.js';
import { ReplicatedStoreReader } from '../../src/core/ReplicatedStoreReader.js';
import { DroppedOriginRegistry } from '../../src/core/RollbackUnmerge.js';
import { ConflictStore } from '../../src/core/ConflictStore.js';
import { registerConversationGraphReplication } from '../../src/core/ConversationGraphReplication.js';
import type { OriginRecord } from '../../src/core/UnionReader.js';

const directories: string[] = [];
async function directory() { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'graph-replication-')); directories.push(dir); return dir; }
afterEach(async () => { for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'graph-replication-test:teardown' }); });
function sourceReader(dir: string, records: () => OriginRecord[]) {
  const registry = new ReplicatedKindRegistry(); registerConversationGraphReplication(registry);
  const dropped = new DroppedOriginRegistry({ stateDir: dir });
  const reader = new ReplicatedStoreReader({ registry, stores: { conversationGraph: { enabled: true } }, tierOf: () => 'high',
    droppedOrigins: dropped, conflictStore: new ConflictStore({ stateDir: dir, now: () => new Date() }),
    listRecordKeys: () => [...new Set(records().map((x) => x.envelope.recordKey))],
    loadOriginRecords: (_store, key) => records().filter((x) => x.envelope.recordKey === key) });
  return { reader, dropped };
}

describe('graph immutable source and replication proofs', () => {
  it('reopens takeover-only storage without fabricating an original source receipt',async()=>{
    const f=replicationFixture(),dir=await directory(),options=f.options(dir,'sleeper'),record=f.record('intake-before-source-ack');
    const source=await ConversationGraphReplication.open(options);await source.receiveNativeTakeover(record);
    expect(source.retainedOriginalSourceReceipt(record.packet.eventId)).toBeNull();
    expect((await fs.readdir(dir)).some(name=>name.endsWith('.receipt.json'))).toBe(false);
    const reopened=await ConversationGraphReplication.open(options);expect(reopened.repairRecord(record.packet.eventId)?.packetSignature).toBe(record.packetSignature);expect(reopened.retainedOriginalSourceReceipt(record.packet.eventId)).toBeNull();
    expect((await fs.readdir(dir)).some(name=>name.endsWith('.receipt.json'))).toBe(false);
  });

  it('refuses a new source before any receipt at the lower history budget while preserving retries and priority erasure',async()=>{
    const f=replicationFixture(),dir=await directory(),store=await ConversationGraphReplication.open({...f.options(dir),maxHistoryEntries:2});
    const a=f.record('budget-a'),b=f.record('budget-b',2,a.packet.coreHash),c=f.record('budget-c',3,b.packet.coreHash);
    await store.appendLocal(a);await store.appendLocal(b);const before=(await fs.readdir(dir)).sort();
    await expect(store.appendLocal(c)).rejects.toThrow('history-capacity');expect((await fs.readdir(dir)).sort()).toEqual(before);expect(store.repairRecord(c.packet.eventId)).toBeNull();
    expect((await store.appendLocal(a)).receipt.eventId).toBe(a.packet.eventId);
    const raw={v:1 as const,agentId:'echo',requestId:'budget-priority-forget',target:a.packet.erasureIdentity,bundleHashes:[],membershipEpoch:1,leaseEpoch:1,authorizationReceiptHash:'a'.repeat(64),witnessId:'independent-witness',erasedAt:'2026-11-05T08:20:00Z'};
    const proof={...raw,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,raw,f.witness.privateKey)};await store.applyErasure(proof,f.erasureAuthority(proof));expect(store.isErased(a.packet.erasureIdentity)).toBe(true);
    const negativeRaw={...raw,requestId:'budget-new-negative',target:c.packet.erasureIdentity};const negative={...negativeRaw,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,negativeRaw,f.witness.privateKey)};
    await store.applyErasure(negative,f.erasureAuthority(negative));expect(store.isErased(c.packet.erasureIdentity)).toBe(true);
    await expect(store.receive({...c,erasure:negative,encryptedSourceBundle:null},c.packet.writerId)).rejects.toThrow('history-capacity');expect(store.repairRecord(c.packet.eventId)).toBeNull();
    const reopened=await ConversationGraphReplication.open({...f.options(dir),maxHistoryEntries:2});await expect(reopened.receive({...c,erasure:negative,encryptedSourceBundle:null},c.packet.writerId)).rejects.toThrow('history-capacity');
    await expect(ConversationGraphReplication.open({...f.options(await directory()),maxHistoryEntries:20001})).rejects.toThrow('budget-invalid');
  });
  it('verifies native historical lease and binds actor, signature, hash and original envelope origin', () => {
    const f = replicationFixture(); const r = f.record();
    expect(verifyGraphAuthorization(r.packet, r.core, r.authorizationProof, f.owner.publicKey, 'writer')).toEqual({ ok: true });
    expect(verifyGraphAuthorization(r.packet, r.core, r.authorizationProof, f.owner.publicKey, 'sleeper').ok).toBe(false);
    const unexpected = { ...r.authorizationProof, dispatchSource: { transcript: 'must refuse unknown plaintext' } } as unknown as typeof r.authorizationProof;
    expect(verifyGraphAuthorization(r.packet, r.core, unexpected, f.owner.publicKey, 'writer').ok).toBe(false);
    const forged = structuredClone(r); forged.authorizationProof.originalLease.epoch = 2;
    expect(verifyGraphAuthorization(forged.packet, forged.core, forged.authorizationProof, f.owner.publicKey, 'writer').ok).toBe(false);
    forged.authorizationProof.originalLease = r.authorizationProof.originalLease; forged.core.principal = 'other';
    expect(verifyGraphAuthorization(forged.packet, forged.core, forged.authorizationProof, f.owner.publicKey, 'writer').ok).toBe(false);
  });
  it('retains the exact frozen chain slot when priority erasure leaves only publication intent',async()=>{
    const f=replicationFixture(),dir=await directory(),r=f.record(),fence=new ConversationGraphLocalErasureFence(dir);
    let store=await ConversationGraphReplication.open({...f.options(dir),localErasure:fence});await store.appendLocal(r);
    // Crash after intent was durable but before source/receipt publication.
    for(const name of await fs.readdir(dir))if(name.endsWith('.source.json')||name.endsWith('.receipt.json'))SafeFsExecutor.safeUnlinkSync(path.join(dir,name),{operation:'graph-replication-test:crash-before-source-publication'});
    await fence.deny(r.packet.erasureIdentity);await store.eraseLocal(r.packet.erasureIdentity);
    store=await ConversationGraphReplication.open({...f.options(dir),localErasure:fence});
    expect(store.recordsForRepair()).toEqual([]);
    const intents=await store.controlIntents();expect(intents).toHaveLength(1);expect(intents[0].packet).toEqual(r.packet);expect(intents[0].packetSignature).toBe(r.packetSignature);
    expect(intents[0].encryptedSourceBundle).toBeNull();expect(intents[0].erasure).toBeUndefined();
    expect((await fs.readdir(dir)).some(name=>name.endsWith('.receipt.json'))).toBe(false);
  });
  it('does not authorize an unactivated future witness merely because its recovery key is pinned',async()=>{
    const f=replicationFixture(),dir=await directory(),future=crypto.generateKeyPairSync('ed25519'),options=f.options(dir),r=f.record();
    const store=await ConversationGraphReplication.open({...options,installedMembership:f.membership,witnessPublicKeys:new Map([...options.witnessPublicKeys,['future-witness',future.publicKey]])});await store.appendLocal(r);
    const unsigned={v:1 as const,agentId:'echo',requestId:'unactivated-future-erase',target:r.packet.erasureIdentity,bundleHashes:[],membershipEpoch:2,leaseEpoch:2,authorizationReceiptHash:r.packet.authorizationReceiptHash,witnessId:'future-witness',erasedAt:new Date().toISOString()};
    const proof={...unsigned,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,unsigned,future.privateKey)};
    await expect(store.applyErasure(proof)).rejects.toThrow();
    const {signature:_membershipSignature,...priorMembership}=f.membership,proposed={...priorMembership,epoch:2,previousMembershipHash:canonicalHash(f.membership),witnessId:'future-witness'};
    const membership={...proposed,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.membership,proposed,f.owner.privateKey)};
    const endorsement={v:1 as const,agentId:'echo',requestId:proof.requestId,erasureHash:canonicalHash(proof),membershipEpoch:2,membershipHash:canonicalHash(membership),activationHash:null,witnessId:'future-witness',challenge:crypto.randomBytes(32).toString('base64url'),recordedAt:new Date().toISOString()};
    await expect(store.applyErasure(proof,{membership,activations:[],endorsement:{...endorsement,signature:signGraphRecord('graph-erasure-active-endorsement-v1',endorsement,future.privateKey)}})).rejects.toThrow('issuer-authority-invalid');
    expect(store.isErased(r.packet.erasureIdentity)).toBe(false);const bytes=store.openVerifiedPayload(r);expect(bytes.byteLength).toBeGreaterThan(0);bytes.fill(0);
    await fs.writeFile(path.join(dir,`global-erasure-${canonicalHash(proof)}.json`),JSON.stringify(proof));
    await expect(ConversationGraphReplication.open({...options,installedMembership:f.membership,witnessPublicKeys:new Map([...options.witnessPublicKeys,['future-witness',future.publicKey]])})).rejects.toThrow();
    expect((await fs.readdir(dir)).some(name=>name.endsWith('.bundle.json'))).toBe(true);
  });
  it('rejects a signed cross-target hash before any negative latch or physical purge',async()=>{
    const f=replicationFixture(),dir=await directory(),r=f.record(),store=await ConversationGraphReplication.open(f.options(dir));await store.appendLocal(r);
    const target={sourceKind:'graph-intent' as const,sourceId:'graph-event:unrelated'},unsigned={v:1 as const,agentId:'echo',requestId:'cross-target-erase',target,bundleHashes:[r.packet.sourceBundleHash],membershipEpoch:1,leaseEpoch:1,authorizationReceiptHash:r.packet.authorizationReceiptHash,witnessId:'independent-witness',erasedAt:new Date().toISOString()};
    const proof={...unsigned,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,unsigned,f.witness.privateKey)};
    await expect(store.applyErasure(proof)).rejects.toThrow('cross-target-hash');expect(store.isErased(target)).toBe(false);expect(store.isErased(r.packet.erasureIdentity)).toBe(false);
    const payload=store.openVerifiedPayload(r);expect(payload.byteLength).toBeGreaterThan(0);payload.fill(0);expect((await fs.readdir(dir)).some(name=>name.startsWith('global-erasure-'))).toBe(false);
  });
  it('rejects cross-target hashes on incoming source and cold replay before either body is suppressed',async()=>{
    const f=replicationFixture(),dir=await directory(),a=f.record('cross-target-kept-a'),b=f.record('cross-target-kept-b',2,a.packet.coreHash),store=await ConversationGraphReplication.open(f.options(dir));await store.appendLocal(a);await store.appendLocal(b);
    const unsigned={v:1 as const,agentId:'echo',requestId:'cross-target-cold',target:a.packet.erasureIdentity,bundleHashes:[b.packet.sourceBundleHash],membershipEpoch:1,leaseEpoch:1,authorizationReceiptHash:a.packet.authorizationReceiptHash,witnessId:'independent-witness',erasedAt:new Date().toISOString()},proof={...unsigned,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,unsigned,f.witness.privateKey)};
    await store.erasureAuthorities.accept(proof,f.erasureAuthority(proof));
    await expect(store.receive({...a,encryptedSourceBundle:null,erasure:proof},'writer')).rejects.toThrow('untrusted-record');expect(store.isErased(a.packet.erasureIdentity)).toBe(false);
    await fs.writeFile(path.join(dir,`global-erasure-${canonicalHash(proof)}.json`),JSON.stringify(proof));
    await expect(ConversationGraphReplication.open(f.options(dir))).rejects.toThrow('cross-target-hash');
    expect((await fs.readdir(dir)).filter(name=>name.endsWith('.bundle.json'))).toHaveLength(2);
  });
  it('withholds repair and stale caller key envelopes immediately after deny before queued physical purge',async()=>{
    const f=replicationFixture(),dir=await directory(),r=f.record(),fence=new ConversationGraphLocalErasureFence(dir),store=await ConversationGraphReplication.open({...f.options(dir),localErasure:fence});await store.appendLocal(r);
    await fence.deny(r.packet.erasureIdentity);expect((await fs.readdir(dir)).some(name=>name.endsWith('.bundle.json'))).toBe(true);
    expect(store.repairRecord(r.packet.eventId)?.encryptedSourceBundle).toBeNull();expect(store.recordsForRepair()[0].encryptedSourceBundle).toBeNull();
    expect((store.recordForTransport(r) as typeof r).encryptedSourceBundle).toBeNull();await store.eraseLocal(r.packet.erasureIdentity);
    expect((await fs.readdir(dir)).some(name=>name.endsWith('.bundle.json'))).toBe(false);
  });
  it('retains actual signed erased-control authority when a durable local deny also survives restart',async()=>{
    const f=replicationFixture(),dir=await directory(),r=f.record(),fence=new ConversationGraphLocalErasureFence(dir);let store=await ConversationGraphReplication.open({...f.options(dir),localErasure:fence});await store.appendLocal(r);
    const decision={v:1 as const,agentId:'echo',requestId:'cold-local-global-erasure',target:r.packet.erasureIdentity,bundleHashes:[],membershipEpoch:1,leaseEpoch:1,authorizationReceiptHash:r.packet.authorizationReceiptHash,witnessId:'independent-witness',erasedAt:new Date().toISOString()},erasure={...decision,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,decision,f.witness.privateKey)};
    await store.applyErasure(erasure,f.erasureAuthority(erasure));await fence.deny(r.packet.erasureIdentity);
    const custody={v:1 as const,agentId:'echo',eventId:r.packet.eventId,operationHash:canonicalHash(r.packet),membershipEpoch:1,leaseEpoch:1,custodyMembershipEpoch:1,witnessId:'independent-witness',targetHash:canonicalHash(r.packet.erasureIdentity),recordedAt:new Date().toISOString()},proof={...custody,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasedControl,custody,f.witness.privateKey)};
    await store.attachErasedControl(r.packet.eventId,proof,f.membership,[]);expect(store.verifyHistoricalRecord(store.repairRecord(r.packet.eventId)!)).toBe(true);
    const coldFence=new ConversationGraphLocalErasureFence(dir);await coldFence.refresh();store=await ConversationGraphReplication.open({...f.options(dir),localErasure:coldFence});
    expect(store.repairRecord(r.packet.eventId)?.erasure).toEqual(erasure);expect(store.repairRecord(r.packet.eventId)?.erasedControlProof).toEqual(proof);expect(store.repairRecord(r.packet.eventId)?.preparationProof).toBeUndefined();expect(store.repairRecord(r.packet.eventId)?.encryptedSourceBundle).toBeNull();
  });
  it('orders current-lease terminal refusal updates after an earlier erased pending descriptor',async()=>{
    const f=replicationFixture(),dir=await directory(),r=f.record(),store=await ConversationGraphReplication.open(f.options(dir));await store.appendLocal(r);
    const raw={v:1 as const,agentId:'echo',requestId:'erased-refusal-version',target:r.packet.erasureIdentity,bundleHashes:[],membershipEpoch:1,leaseEpoch:1,authorizationReceiptHash:r.packet.authorizationReceiptHash,witnessId:'independent-witness',erasedAt:new Date().toISOString()},proof={...raw,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,raw,f.witness.privateKey)};await store.applyErasure(proof,f.erasureAuthority(proof));
    await store.receive(f.adopted(r,true,2),'writer');const before=store.descriptorFor(store.repairRecord(r.packet.eventId)!);
    await store.receive(f.adopted(r,true,3),'writer');const after=store.descriptorFor(store.repairRecord(r.packet.eventId)!);
    expect(after.controlHash).not.toBe(before.controlHash);expect(after.publicationVersion).toBeGreaterThan(before.publicationVersion);
    // Every admitted positive rank has epoch<=MAX and phase<STRIDE.
    expect(before.publicationVersion).toBeGreaterThan(GRAPH_REPLICATION_MAX_LEASE_EPOCH*GRAPH_REPLICATION_EPOCH_STRIDE+GRAPH_REPLICATION_EPOCH_STRIDE-1);
  });
  it('merges legitimate partial final-receipt observations without fabricating a source conflict',async()=>{
    const f=replicationFixture(),dir=await directory(),r=f.record(),writer=await ConversationGraphReplication.open(f.options(dir)),peer=await ConversationGraphReplication.open(f.options(await directory(),'sleeper'));
    const a=await writer.appendLocal(r),b=await peer.receive(r,'writer'),certificate=f.certificate(r,[a.receipt,b]);
    const ownA=await writer.attachCertificate(r.packet.eventId,certificate),ownB=await peer.attachCertificate(r.packet.eventId,certificate);await writer.recordCertificateReceipt(r.packet.eventId,ownA);await peer.recordCertificateReceipt(r.packet.eventId,ownB);
    const view=sourceReader(dir,()=>[...writer.originRecords(),...peer.originRecords()]);const pending=writer.certifiedUnion(view.reader,view.dropped);
    expect(pending.records).toHaveLength(0);expect(pending.partial).toBe(true);expect(pending.quarantined).toEqual([]);expect(peer.certifiedUnion(view.reader,view.dropped).quarantined).toEqual([]);
    expect(writer.descriptorFor(writer.repairRecord(r.packet.eventId)!)).toEqual(peer.descriptorFor(peer.repairRecord(r.packet.eventId)!));
    await writer.recordCertificateReceipt(r.packet.eventId,ownB);await peer.recordCertificateReceipt(r.packet.eventId,ownA);
    expect(writer.certifiedUnion(view.reader,view.dropped).records).toHaveLength(1);
  });
  it('local source survives enqueue refusal and restart; enqueue acceptance alone is not durable', async () => {
    const f = replicationFixture(); const dir = await directory(); const r = f.record();
    let store = await ConversationGraphReplication.open(f.options(dir));
    await store.appendLocal(r);
    expect(await store.drainOutbox(() => 'rate-limited')).toEqual({ 'graph-event:event-one': 'rate-limited' });
    store = await ConversationGraphReplication.open(f.options(dir));
    expect(store.repairRecord('graph-event:event-one')?.packet).toEqual(r.packet);
    expect(await store.drainOutbox(() => 'accepted')).toEqual({ 'graph-event:event-one': 'accepted' });
    store = await ConversationGraphReplication.open(f.options(dir));
    expect(await store.drainOutbox(() => 'accepted')).toEqual({ 'graph-event:event-one': 'accepted' });
    await store.journalCommitted('graph-event:event-one', canonicalHash(store.descriptorFor(r)));
    store = await ConversationGraphReplication.open(f.options(dir));
    expect(await store.drainOutbox(() => 'accepted')).toEqual({});
    expect(store.status('graph-event:event-one').state).toBe('prepared');
  });
  it('repairs a crash between source fsync and receipt fsync without inventing a commit', async () => {
    const f = replicationFixture(); const dir = await directory();
    const store = await ConversationGraphReplication.open(f.options(dir)); await store.appendLocal(f.record());
    const receiptFile = (await fs.readdir(dir)).find((n) => n.endsWith('.receipt.json'))!;
    SafeFsExecutor.safeUnlinkSync(path.join(dir, receiptFile), { operation: 'graph-replication-test:simulate-incomplete-receipt' });
    const repaired = await ConversationGraphReplication.open(f.options(dir));
    expect(repaired.status('graph-event:event-one').state).toBe('prepared');
    expect((await fs.readdir(dir)).some((n) => n.endsWith('.receipt.json'))).toBe(true);
  });
  it('requires every installed member source receipt and certificate persistence before success', async () => {
    const f = replicationFixture(); const r = f.record();
    const writer = await ConversationGraphReplication.open(f.options(await directory()));
    const sleeper = await ConversationGraphReplication.open(f.options(await directory(), 'sleeper'));
    const wr = await writer.appendLocal(r);
    const partial = f.certificate(r, [wr.receipt]);
    await expect(writer.attachCertificate('graph-event:event-one', partial)).rejects.toThrow('invalid-certificate');
    expect(writer.status('graph-event:event-one').state).toBe('prepared');
    const sr = await sleeper.receive(r, 'writer');
    const cert = f.certificate(r, [wr.receipt, sr]);
    const wa = await writer.attachCertificate('graph-event:event-one', cert);
    expect(writer.status('graph-event:event-one')).toMatchObject({ state: 'certified', missingMembers: ['sleeper'] });
    expect(writer.mayAcknowledgeNewWrite('graph-event:event-one')).toBe(false);
    const sa = await sleeper.attachCertificate('graph-event:event-one', cert);
    await writer.recordCertificateReceipt('graph-event:event-one', sa);
    await sleeper.recordCertificateReceipt('graph-event:event-one', wa);
    expect(writer.mayAcknowledgeNewWrite('graph-event:event-one')).toBe(true);
    expect(sleeper.status('graph-event:event-one').state).toBe('committed');
    const recovered = await ConversationGraphReplication.open(f.options(writer['options'].directory));
    expect(recovered.status('graph-event:event-one').state).toBe('committed');
  });
  it('new fenced writes refuse while a historically valid old event still repairs', async () => {
    const f = replicationFixture(); const r = f.record();
    const writer = await ConversationGraphReplication.open(f.options(await directory()));
    f.setLive({ ...f.getLive(), leaseEpoch: 2 });
    await expect(writer.appendLocal(r)).rejects.toThrow('graph-write-refused');
    const sleeper = await ConversationGraphReplication.open(f.options(await directory(), 'sleeper'));
    expect((await sleeper.receive(r, 'writer')).eventId).toBe('graph-event:event-one');
  });
  it('never signs a member source receipt for a bundle its actual local key cannot decrypt', async () => {
    const f = replicationFixture(); const r = f.record();
    r.encryptedSourceBundle!.envelopes[1].tag = Buffer.alloc(16, 1).toString('base64url');
    r.packet.sourceBundleHash = canonicalHash(r.encryptedSourceBundle);
    r.packetSignature = signGraphRecord(GRAPH_SIGNATURE_DOMAINS.packet, r.packet, f.members[0].signing.privateKey);
    const writer = await ConversationGraphReplication.open(f.options(await directory()));
    const peerDir = await directory(); const peer = await ConversationGraphReplication.open(f.options(peerDir, 'sleeper'));
    expect((await writer.appendLocal(r)).receipt.machineId).toBe('writer');
    await expect(peer.receive(r, 'writer')).rejects.toThrow();
    expect((await fs.readdir(peerDir)).some((n) => n.endsWith('.receipt.json'))).toBe(false);
  });
  it('duplicate ids with different valid payloads quarantine, never silently win', async () => {
    const f = replicationFixture(); const store = await ConversationGraphReplication.open(f.options(await directory()));
    await store.appendLocal(f.record());
    await expect(store.appendLocal(f.record())).rejects.toThrow('event-conflict'); // fresh encryption changes bound source bundle
    expect(store.status('graph-event:event-one').state).toBe('quarantined');
    expect(store.repairRecord('graph-event:event-one')).toBeNull();
  });
  it('erasure survives restart, removes sealed envelopes, and older repair cannot restore them', async () => {
    const f = replicationFixture(); const dir = await directory(); const r = f.record();
    let store = await ConversationGraphReplication.open(f.options(dir)); await store.appendLocal(r);
    const unsigned = { v: 1 as const, agentId: 'echo', requestId: 'erase-one', target:r.packet.erasureIdentity, bundleHashes: [r.packet.sourceBundleHash],
      membershipEpoch: 1, leaseEpoch: 1, authorizationReceiptHash: r.packet.authorizationReceiptHash,
      witnessId: 'independent-witness', erasedAt: '2026-11-05T08:08:00Z' };
    const proof: GraphWitnessErasure = { ...unsigned, signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure, unsigned, f.witness.privateKey) };
    await store.eraseBundle('graph-event:event-one', proof,f.erasureAuthority(proof));
    store = await ConversationGraphReplication.open(f.options(dir));
    expect(store.repairRecord('graph-event:event-one')?.encryptedSourceBundle).toBeNull();
    await store.receive(r, 'writer');
    expect(store.repairRecord('graph-event:event-one')?.encryptedSourceBundle).toBeNull();
    expect((await fs.readdir(dir)).some((n) => n.endsWith('.bundle.json'))).toBe(false);
  });
  it('envelope validator refuses mutation deletes and record/origin confusion', async () => {
    const f = replicationFixture(); const r = f.record();
    expect(validateGraphReplicationRecord({ ...r, title: 'plaintext title' })).toBeNull();
    const store = await ConversationGraphReplication.open(f.options(await directory()));
    expect(() => store.envelope(r, { physical: 1, logical: 0, node: 'writer' })).not.toThrow();
    await expect(store.receive({ ...r, core: { ...r.core, title: 'plaintext title' } }, 'writer')).rejects.toThrow();
    const poison = structuredClone(r); poison.packet.sourceSequence = 9;
    await expect(store.receive(poison, 'writer')).rejects.toThrow('untrusted-record');
  });
  it('a certified cancellation advances the chain without inserting the canceled core', async () => {
    const f = replicationFixture(); const wd = await directory(); const pd = await directory(); const r = f.record();
    const writer = await ConversationGraphReplication.open(f.options(wd));
    const peer = await ConversationGraphReplication.open(f.options(pd, 'sleeper'));
    await writer.appendLocal(r); await peer.receive(r, 'writer');
    const decisionUnsigned = { v: 1 as const, agentId: 'echo', eventId: r.packet.eventId, operationHash: canonicalHash(r.packet),
      membershipEpoch: 1, leaseEpoch: 1, witnessId: 'independent-witness', canceledAt: '2026-11-05T08:07:00Z' };
    const decision = { ...decisionUnsigned, signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.cancellation, decisionUnsigned, f.witness.privateKey) };
    const originalReceipt=writer.retainedOriginalSourceReceipt(r.packet.eventId);
    const wr = await writer.attachCancellation('graph-event:event-one', decision); const pr = await peer.attachCancellation('graph-event:event-one', decision);
    const cancellationCold=await ConversationGraphReplication.open(f.options(wd),'verify-only');expect(cancellationCold.cancellationReceipt(r.packet.eventId)).toEqual(wr);expect(cancellationCold.retainedOriginalSourceReceipt(r.packet.eventId)).toEqual(originalReceipt);expect(originalReceipt!.phase).toBe('source');
    const terminalUnsigned = { v: 1 as const, agentId: 'echo', eventId: r.packet.eventId, operationHash: canonicalHash(r.packet),
      coreHash: r.packet.coreHash, authorizationReceiptHash: r.packet.authorizationReceiptHash, sourceSequence: 1, predecessorHash: null,
      membershipEpoch: 1, leaseEpoch: 1, membershipHash: canonicalHash(f.membership), outcome: 'canceled' as const,
      cancellationHash: canonicalHash(decision), memberReceipts: [wr, pr], witnessId: 'independent-witness', canceledAt: '2026-11-05T08:08:00Z' };
    const terminal = { ...terminalUnsigned, signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.cancellationCertificate, terminalUnsigned, f.witness.privateKey) };
    const wa = await writer.attachCancellationCertificate('graph-event:event-one', terminal); const pa = await peer.attachCancellationCertificate('graph-event:event-one', terminal);
    await writer.recordCertificateReceipt('graph-event:event-one', pa); await peer.recordCertificateReceipt('graph-event:event-one', wa);
    expect(writer.status('graph-event:event-one').state).toBe('canceled');
    await expect(writer.attachCertificate('graph-event:event-one', f.certificate(r, [wr, pr]))).rejects.toThrow();
    const next = f.record('event-two', 2, r.packet.coreHash);
    const ws = await writer.appendLocal(next); const ps = await peer.receive(next, 'writer');
    const nextCert = f.certificate(next, [ws.receipt, ps]);
    await writer.attachCertificate('graph-event:event-two', nextCert);
    const nextAck = await peer.attachCertificate('graph-event:event-two', nextCert);
    await writer.recordCertificateReceipt('graph-event:event-two', nextAck);
    const registry = new ReplicatedKindRegistry(); registerConversationGraphReplication(registry);
    const dropped = new DroppedOriginRegistry({ stateDir: wd });
    const reader = new ReplicatedStoreReader({ registry, stores: { conversationGraph: { enabled: true } }, tierOf: () => 'high',
      droppedOrigins: dropped, conflictStore: new ConflictStore({ stateDir: wd, now: () => new Date() }),
      listRecordKeys: () => writer.originRecords().map((x) => x.envelope.recordKey),
      loadOriginRecords: (_store, key) => writer.originRecords().filter((x) => x.envelope.recordKey === key) });
    expect(writer.certifiedUnion(reader, dropped).records.map((x) => x.packet.eventId)).toEqual(['graph-event:event-two']);
    const restarted = await ConversationGraphReplication.open(f.options(wd));
    expect(restarted.status('graph-event:event-one').state).toBe('canceled');
  });
  it('preserves an actual original ACK through normal cold repair after readoption archive publication fails',async()=>{const f=replicationFixture(),record=f.record(),dir=await directory();let source=await ConversationGraphReplication.open(f.options(dir));await source.appendLocal(record);const original=source.retainedOriginalSourceReceipt(record.packet.eventId),save=(source as unknown as {save(name:string,value:unknown,immutable?:boolean):Promise<void>}).save.bind(source),fault=vi.spyOn(source as unknown as {save(name:string,value:unknown,immutable?:boolean):Promise<void>},'save').mockImplementation(async(name,value,immutable)=>{if(name.endsWith('.original-receipt.json'))throw new Error('fault-before-original-archive');return save(name,value,immutable);});try{await expect(source.receive(f.adopted(record,true),'writer')).rejects.toThrow('fault-before-original-archive');}finally{fault.mockRestore();}source=await ConversationGraphReplication.open(f.options(dir));expect(source.retainedOriginalSourceReceipt(record.packet.eventId)).toEqual(original);source=await ConversationGraphReplication.open(f.options(dir),'verify-only');expect(source.retainedOriginalSourceReceipt(record.packet.eventId)).toEqual(original);});
  it('refuses a genuine foreign member receipt substituted into a local receipt slot',async()=>{const f=replicationFixture(),record=f.record(),dir=await directory(),other=await directory(),source=await ConversationGraphReplication.open(f.options(dir)),peer=await ConversationGraphReplication.open(f.options(other,'sleeper'));await source.appendLocal(record);const foreign=await peer.receive(record,'writer');await source.receive(f.adopted(record,true),'writer');await fs.writeFile(path.join(dir,graphReplicationFileStem(record.packet.eventId)+'.receipt.json'),JSON.stringify(foreign));await expect(ConversationGraphReplication.open(f.options(dir),'verify-only')).rejects.toThrow('local-receipt-machine-mismatch');});
  it.each([false,true])('retains the actual original source ACK across readoption and cold verify-only reopen (refused=%s)',async refused=>{const f=replicationFixture(),record=f.record(),dir=await directory();let source=await ConversationGraphReplication.open(f.options(dir));await source.appendLocal(record);const original=source.retainedOriginalSourceReceipt(record.packet.eventId);expect(original).not.toBeNull();await source.receive(f.adopted(record,refused),'writer');expect(source.retainedOriginalSourceReceipt(record.packet.eventId)).toEqual(original);source=await ConversationGraphReplication.open(f.options(dir),'verify-only');expect(source.retainedOriginalSourceReceipt(record.packet.eventId)).toEqual(original);});
  it('never chooses an event-id winner when valid certificates equivocate on one source sequence', async () => {
    const f = replicationFixture(); const dir = await directory();
    const writer = await ConversationGraphReplication.open(f.options(dir));
    const peer = await ConversationGraphReplication.open(f.options(await directory(), 'sleeper'));
    for (const id of ['event-aaa', 'event-zzz']) {
      const r = f.record(id); const wr = await writer.appendLocal(r); const pr = await peer.receive(r, 'writer');
      const cert = f.certificate(r, [wr.receipt, pr]);
      await writer.attachCertificate(r.packet.eventId, cert);
      await writer.recordCertificateReceipt(r.packet.eventId, await peer.attachCertificate(r.packet.eventId, cert));
    }
    const { reader, dropped } = sourceReader(dir, () => writer.originRecords());
    expect(writer.certifiedUnion(reader, dropped)).toMatchObject({ records: [], partial: true, quarantined: ['graph-event:event-aaa', 'graph-event:event-zzz'] });
  });
  it('a validated peer erasure dominates a stale certified local source', async () => {
    const f = replicationFixture(); const dir = await directory(); const r = f.record();
    const writer = await ConversationGraphReplication.open(f.options(dir));
    const peer = await ConversationGraphReplication.open(f.options(await directory(), 'sleeper'));
    const wr = await writer.appendLocal(r); const pr = await peer.receive(r, 'writer');
    const cert = f.certificate(r, [wr.receipt, pr]);
    await writer.attachCertificate('graph-event:event-one', cert);
    await writer.recordCertificateReceipt('graph-event:event-one', await peer.attachCertificate('graph-event:event-one', cert));
    const row = writer.originRecords()[0];
    const unsigned = { v: 1 as const, agentId: 'echo', requestId: 'erase-peer', target:r.packet.erasureIdentity, bundleHashes: [r.packet.sourceBundleHash],
      membershipEpoch: 1, leaseEpoch: 1, authorizationReceiptHash: r.packet.authorizationReceiptHash,
      witnessId: 'independent-witness', erasedAt: '2026-11-05T08:08:00Z' };
    const erased = { ...writer.repairRecord('graph-event:event-one')!, certificatePersistenceReceipts: [], encryptedSourceBundle: null,
      erasure: { ...unsigned, signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure, unsigned, f.witness.privateKey) } };
    let repaired=false;const { reader, dropped } = sourceReader(dir, () => repaired?writer.originRecords():[{ ...row, envelope:{...row.envelope,hlc:{...row.envelope.hlc,logical:writer.descriptorFor(erased).publicationVersion}},data: { descriptor: writer.descriptorFor(erased) } }]);
    expect(writer.certifiedUnion(reader,dropped)).toMatchObject({records:[],partial:true});
    await writer.applyErasure(erased.erasure!,f.erasureAuthority(erased.erasure!));await writer.receive(erased,'writer');repaired=true;
    expect(writer.certifiedUnion(reader, dropped).records[0].encryptedSourceBundle).toBeNull();
    expect(writer.certifiedUnion(reader, dropped).records[0].erasure?.requestId).toBe('erase-peer');
  });
  it('keeps canonical placement pending until all signed final persistence receipts survive publication and restart', async () => {
    const f = replicationFixture(); const dir = await directory(); const r = f.record();
    let writer = await ConversationGraphReplication.open(f.options(dir));
    const peer = await ConversationGraphReplication.open(f.options(await directory(), 'sleeper'));
    const wr = await writer.appendLocal(r); const pr = await peer.receive(r, 'writer');
    const cert = f.certificate(r, [wr.receipt, pr]);
    await writer.attachCertificate('graph-event:event-one', cert);
    let view = sourceReader(dir, () => writer.originRecords());
    expect(writer.certifiedUnion(view.reader, view.dropped)).toMatchObject({records: [], partial: true});
    expect(()=>writer.commitProofDeliveryReceipt('graph-event:event-one')).toThrow('proof-not-durable');
    const ack = await peer.attachCertificate('graph-event:event-one', cert);
    await writer.recordCertificateReceipt('graph-event:event-one', ack);
    writer = await ConversationGraphReplication.open(f.options(dir));
    view = sourceReader(dir, () => writer.originRecords());
    expect(writer.certifiedUnion(view.reader, view.dropped).records).toHaveLength(1);
    const repaired = writer.repairRecord('graph-event:event-one')!;
    expect(repaired.certificatePersistenceReceipts).toHaveLength(2);
    const delivery = writer.commitProofDeliveryReceipt('graph-event:event-one');
    expect(verifyGraphCommitProofDeliveryReceipt(delivery,repaired)).toBe(true);
    expect(verifyGraphCommitProofDeliveryReceipt({...delivery,machineId:'sleeper'},repaired)).toBe(false);
    expect(verifyGraphCommitProofDeliveryReceipt({...delivery,certificatePersistenceReceiptsHash:canonicalHash([])},repaired)).toBe(false);
    await peer.receive(repaired, 'writer');
    expect(peer.status('graph-event:event-one').state).toBe('committed');
    await writer.recordCommitProofDeliveryReceipt('graph-event:event-one',delivery);
    expect(writer.allCommitProofDelivered('graph-event:event-one')).toBe(false);
    await writer.recordCommitProofDeliveryReceipt('graph-event:event-one',peer.commitProofDeliveryReceipt('graph-event:event-one'));
    writer = await ConversationGraphReplication.open(f.options(dir));
    expect(writer.allCommitProofDelivered('graph-event:event-one')).toBe(true);
  });

  it('durably retains an exact signed witness preparation proof for recovery manifests', async () => {
    const f = replicationFixture(); const dir = await directory(); const r = f.record();
    let store = await ConversationGraphReplication.open(f.options(dir));
    await store.appendLocal(r);
    const value = {v: 1 as const, agentId: r.packet.agentId, eventId: r.packet.eventId,
      operationHash: canonicalHash(r.packet), membershipEpoch: 1, leaseEpoch: 1,
      witnessId: 'independent-witness', preparedAt: '2026-11-05T08:07:00Z'};
    const proof = {...value, signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.prepare, value, f.witness.privateKey)};
    await store.attachPreparation('graph-event:event-one', proof);
    await expect(store.attachPreparation('graph-event:event-one', {...proof, eventId: 'wrong'})).rejects.toThrow('invalid-preparation');
    store = await ConversationGraphReplication.open(f.options(dir));
    expect(store.repairRecord('graph-event:event-one')?.preparationProof).toEqual(proof);
    expect(store.status('graph-event:event-one').state).toBe('prepared');
  });

  it('continues a fsynced pending source after actual native same-epoch renewal without rewriting immutable authority', async () => {
    const f = replicationFixture(); const r = f.record(); const store = await ConversationGraphReplication.open(f.options(await directory()));
    await store.appendLocal(r); const current = f.actuation();
    f.setLive({admitted:true,writerId:'writer',leaseEpoch:1,membershipEpoch:1,fencedLeaseHash:current.lease.fencedLeaseHash});
    await expect(store.appendLocal(r)).rejects.toThrow('graph-write-refused');
    expect(store.mayContinue(r.packet.eventId,current.lease,current.originalLease)).toBe(true);
    expect(store.lookupByIdempotencyKey(r.packet.idempotencyKey)?.authorizationProof).toEqual(r.authorizationProof);
    f.setLive({...f.getLive(),admitted:false});
    expect(store.mayContinue(r.packet.eventId,current.lease,current.originalLease)).toBe(false);
  });
  it('adopts immutable old-writer source under a verified current lease and persists all current receipts', async () => {
    const f = replicationFixture(); const r = f.record(); const dir = await directory();
    let writer = await ConversationGraphReplication.open(f.options(dir));
    const peer = await ConversationGraphReplication.open(f.options(await directory(),'sleeper'));
    await writer.appendLocal(r); await peer.receive(r,'writer');
    const recovered = f.adopted(r); const wr = await writer.receive(recovered,'writer'); const pr = await peer.receive(recovered,'writer');
    expect(wr.leaseEpoch).toBe(2); expect(pr.machineId).toBe('sleeper');
    expect(writer.repairRecord(r.packet.eventId)?.authorizationProof).toEqual(r.authorizationProof);
    const cert = f.certificate(recovered,[wr,pr]); const wa = await writer.attachCertificate(r.packet.eventId,cert);
    const pa = await peer.attachCertificate(r.packet.eventId,cert); await writer.recordCertificateReceipt(r.packet.eventId,pa); await peer.recordCertificateReceipt(r.packet.eventId,wa);
    writer = await ConversationGraphReplication.open(f.options(dir));
    expect(writer.status(r.packet.eventId).state).toBe('committed');
    const view = sourceReader(dir,()=>writer.originRecords()); expect(writer.certifiedUnion(view.reader,view.dropped).records).toHaveLength(1);
    const bad = f.adopted(f.record('event-bad')); bad.adoption!.revalidation.sourceProofHash = canonicalHash('wrong');
    await expect(peer.receive(bad,'writer')).rejects.toThrow('untrusted-record');
  });
  it('removes a rewrap published concurrently with priority local deny before returning a new source receipt',async()=>{
    const f=replicationFixture(),r=f.record(),dir=await directory(),fence=new ConversationGraphLocalErasureFence(dir);
    const store=await ConversationGraphReplication.open({...f.options(dir),localErasure:fence});await store.appendLocal(r);
    const disk=store as unknown as {save:(name:string,value:unknown,immutable?:boolean)=>Promise<void>},save=disk.save.bind(disk);
    const race=vi.spyOn(disk,'save').mockImplementation(async(name,value,immutable)=>{await save(name,value,immutable);if(name.includes('.rewrap-'))await fence.deny(r.packet.erasureIdentity);});
    try{await expect(store.receive(f.adopted(r),'writer')).rejects.toThrow('erasure-raced-publication');}finally{race.mockRestore();}
    expect((await fs.readdir(dir)).filter(name=>name.includes('.bundle.json')||name.includes('.rewrap-'))).toEqual([]);
    expect(()=>store.openVerifiedPayload(r)).toThrow('locally-erased');
  });
  it('refuses absent source without creating a false source-durability receipt', async () => {
    const f = replicationFixture(); const r = f.adopted(f.record(),true); const dir = await directory();
    let peer = await ConversationGraphReplication.open(f.options(dir,'sleeper'));
    const receipt = await peer.receive(r,'writer'); expect(receipt.phase).toBe('cancellation'); expect(receipt.leaseEpoch).toBe(2);
    // Crash after atomic recovery sidecar but before local receipt persistence.
    SafeFsExecutor.safeUnlinkSync(path.join(dir,`${graphReplicationFileStem(r.packet.eventId)}.receipt.json`),{operation:'graph-replication-test:crash-cut'});
    peer = await ConversationGraphReplication.open(f.options(dir,'sleeper'));
    expect(peer.repairRecord(r.packet.eventId)?.encryptedSourceBundle).toBeNull();
    expect(peer.status(r.packet.eventId).state).toBe('prepared');
    const view = sourceReader(dir,()=>peer.originRecords()); expect(peer.certifiedUnion(view.reader,view.dropped).records).toHaveLength(0);
  });

  it('keeps sealed keys out of immutable adoption certificates and purges every rewrap/orphan across erased restart', async()=>{
    const f=replicationFixture();const original=f.record();const r=f.adopted(original);const dir=await directory();
    let store=await ConversationGraphReplication.open(f.options(dir));const peer=await ConversationGraphReplication.open(f.options(await directory(),'sleeper'));
    const wr=await store.receive(r,'writer');const pr=await peer.receive(r,'writer');const cert=f.certificate(r,[wr,pr]);
    await store.attachCertificate(r.packet.eventId,cert);await store.recordCertificateReceipt(r.packet.eventId,await peer.attachCertificate(r.packet.eventId,cert));
    expect(JSON.stringify(cert)).not.toMatch(/"(?:envelopes|ciphertext|ephemeralPublicKey)"/);
    expect(JSON.stringify(store.originRecords())).not.toMatch(/"(?:envelopes|ciphertext|ephemeralPublicKey)"/);
    const prefix=graphReplicationFileStem(r.packet.eventId);
    await fs.writeFile(path.join(dir,`${prefix}.bundle.json.deadbeef.tmp`),JSON.stringify(original.encryptedSourceBundle));
    await fs.writeFile(path.join(dir,`${prefix}.rewrap-${r.adoption!.rewrapHash}.json.deadbeef.tmp`),JSON.stringify(r.rewrap));
    const raw={v:1 as const,agentId:'echo',requestId:'erase-adopted',target:r.packet.erasureIdentity,bundleHashes:[r.packet.sourceBundleHash],membershipEpoch:1,leaseEpoch:2,authorizationReceiptHash:r.packet.authorizationReceiptHash,witnessId:'independent-witness',erasedAt:'2026-11-05T08:09:00Z'};
    const proof={...raw,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,raw,f.witness.privateKey)};
    await store.applyErasure(proof,f.erasureAuthority(proof));
    expect((await fs.readdir(dir)).some(name=>name.includes('.rewrap-')||name.includes('.bundle.json'))).toBe(false);
    // A restored stale payload copy cannot defeat the durable erasure inventory.
    await fs.writeFile(path.join(dir,`${prefix}.bundle.json`),JSON.stringify(original.encryptedSourceBundle));
    await fs.writeFile(path.join(dir,`${prefix}.rewrap-${r.adoption!.rewrapHash}.json`),JSON.stringify(r.rewrap));
    store=await ConversationGraphReplication.open(f.options(dir));
    expect(store.repairRecord(r.packet.eventId)?.rewrap).toBeUndefined();expect(store.repairRecord(r.packet.eventId)?.encryptedSourceBundle).toBeNull();
    expect(store.status(r.packet.eventId).state).toBe('committed');
    expect((await fs.readdir(dir)).some(name=>name.includes('.rewrap-')||name.includes('.bundle.json'))).toBe(false);
    const inspect=async(folder:string):Promise<void>=>{for(const name of await fs.readdir(folder)){const file=path.join(folder,name);if((await fs.stat(file)).isDirectory())await inspect(file);else expect(await fs.readFile(file,'utf8')).not.toMatch(/"(?:envelopes|ciphertext|ephemeralPublicKey)"/);}};await inspect(dir);
  });

  it('fences a never-seen logical target before a future fresh encrypted nonce arrives',async()=>{
    const f=replicationFixture();const initial=f.record();const dir=await directory();let store=await ConversationGraphReplication.open(f.options(dir));
    const raw={v:1 as const,agentId:'echo',requestId:'erase-unseen',target:initial.packet.erasureIdentity,bundleHashes:[],membershipEpoch:1,leaseEpoch:1,authorizationReceiptHash:initial.packet.authorizationReceiptHash,witnessId:'independent-witness',erasedAt:'2026-11-05T08:08:00Z'};
    const proof={...raw,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.erasure,raw,f.witness.privateKey)};await store.applyErasure(proof,f.erasureAuthority(proof));
    const later=f.record();expect(later.packet.sourceBundleHash).not.toBe(initial.packet.sourceBundleHash);
    await store.receive(later,'writer');store=await ConversationGraphReplication.open(f.options(dir));
    expect(store.repairRecord(later.packet.eventId)?.encryptedSourceBundle).toBeNull();expect((await fs.readdir(dir)).some(n=>n.includes('.bundle.json'))).toBe(false);
    const unrelated=f.record('unrelated');await expect(store.receive(unrelated,'writer')).resolves.toBeDefined();
  });
  it('suppresses and physically purges locally during witness outage without inventing a fleet proof',async()=>{
    const f=replicationFixture();const r=f.record();const dir=await directory();const fence=new ConversationGraphLocalErasureFence(dir);const options={...f.options(dir),localErasure:fence};
    let store=await ConversationGraphReplication.open(options);await store.appendLocal(r);
    await fence.deny(r.packet.erasureIdentity);expect(()=>store.openVerifiedPayload(r)).toThrow('locally-erased');await store.eraseLocal(r.packet.erasureIdentity);
    expect((await fs.readdir(dir)).some(n=>n.includes('.bundle.json'))).toBe(false);
    store=await ConversationGraphReplication.open(options);expect(store.repairRecord(r.packet.eventId)?.erasure).toBeUndefined();
    await expect(store.appendLocal(f.record())).rejects.toThrow();expect(()=>store.openVerifiedPayload(r)).toThrow('locally-erased');
  });

  it('classifies known Pending separately and preserves certified chain without exposing missing final acknowledgments',async()=>{
    const f=replicationFixture(),dir=await directory();const source=await ConversationGraphReplication.open(f.options(dir)),peer=await ConversationGraphReplication.open(f.options(await directory(),'sleeper'));
    const first=f.record('pending-first'),wr=await source.receive(first,'writer'),pr=await peer.receive(first,'writer');const cert=f.certificate(first,[wr,pr]);await source.attachCertificate(first.packet.eventId,cert);
    let view=sourceReader(dir,()=>source.originRecords());let union=source.certifiedUnion(view.reader,view.dropped);expect(union.records).toEqual([]);expect(union.pendingEventIds).toEqual([first.packet.eventId]);expect(union.missingEventIds).toEqual([]);
    const second=f.record('next-certified',2,first.packet.coreHash),wr2=await source.receive(second,'writer'),pr2=await peer.receive(second,'writer');const cert2=f.certificate(second,[wr2,pr2]);await source.attachCertificate(second.packet.eventId,cert2);await source.recordCertificateReceipt(second.packet.eventId,await peer.attachCertificate(second.packet.eventId,cert2));
    union=source.certifiedUnion(view.reader,view.dropped);expect(union.records.map(r=>r.packet.eventId)).toEqual([second.packet.eventId]);expect(union.missingEventIds).toEqual([]);
    await source.recordCertificateReceipt(first.packet.eventId,await peer.attachCertificate(first.packet.eventId,cert));
    union=source.certifiedUnion(view.reader,view.dropped);expect(union.records).toHaveLength(2);expect(union.pendingEventIds).toEqual([]);expect(union.partial).toBe(false);
  });

  it('never lets delayed valid adoption restore source authority after a durable signed refusal',async()=>{
    const f=replicationFixture(),r=f.record(),dir=await directory();let store=await ConversationGraphReplication.open(f.options(dir));
    const refused=f.adopted(r,true);await store.receive(refused,'writer');const before=store.repairRecord(r.packet.eventId)!;
    await expect(store.receive(f.adopted(r),'writer')).rejects.toThrow('terminal-decision-dominates');
    store=await ConversationGraphReplication.open(f.options(dir));expect(store.repairRecord(r.packet.eventId)?.adoption).toEqual(before.adoption);expect(store.repairRecord(r.packet.eventId)?.encryptedSourceBundle).toBeNull();
  });

});
