import {graphCustodyRequiresRoleFrontier} from '../../src/core/GraphCustodyTransport.js';
import {graphWitnessEndpoints} from '../../src/core/GraphWitnessDispatcher.js';
import {GRAPH_REPLICATION_MAX_LEASE_EPOCH,GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH} from '../../src/core/ConversationGraphReplicationLimits.js';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { GraphWitnessService } from '../../src/core/GraphWitnessService.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { openGraphBundle,sealGraphBundle } from '../../src/core/GraphWitnessCrypto.js';
import { canonicalHash, GRAPH_SIGNATURE_DOMAINS as D, signGraphRecord, unsigned, verifyCommitCertificate,
  GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES,validatePacket, verifyMembershipEpoch, verifyWitnessLease, verifyFencedLeaseBridge, verifyEncryptedBundle, verifyGraphRecord, verifyWitnessErasure, verifyWitnessInventory } from '../../src/core/GraphWitnessTypes.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {makeHeaderOperation} from '../../src/core/EffortHeaderStore.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import { pem, witnessFixture } from './graph-witness-fixtures.js';

const services: GraphWitnessService[] = [];
const directories: string[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-witness-'));
  directories.push(directory);
  const f = witnessFixture(directory);
  const service = f.open(); services.push(service);
  return { ...f, service, directory };
}
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'graph-witness-unit-fixture-cleanup' }); });

describe('independent graph witness', () => {
  it('classifies encoded signing paths exactly as the actual witness dispatcher does',()=>{
    const f=fixture(),request=f.prepareRequest(),routes=graphWitnessEndpoints(f.service);
    for(const [encoded,canonical] of [['/v1/agents/echo/%6cease','/v1/agents/:agentId/lease'],['/%761/%61gents/echo/operations/request/%70repare','/v1/agents/:agentId/operations/:key/prepare'],['/v1/agents/echo/operations/request/%63ommit','/v1/agents/:agentId/operations/:key/commit']]){
      const parts=new URL(encoded,'https://custody.invalid').pathname.split('/').filter(Boolean).map(decodeURIComponent),endpoint=routes.find(row=>row.method==='POST'&&row.path.split('/').filter(Boolean).length===parts.length&&row.path.split('/').filter(Boolean).every((part,index)=>part.startsWith(':')||part===parts[index]));
      expect(endpoint?.path).toBe(canonical);expect(graphCustodyRequiresRoleFrontier('POST',encoded)).toBe(true);
    }
    expect(graphCustodyRequiresRoleFrontier('POST','/v1/agents/echo/%65rasures')).toBe(false);expect(graphCustodyRequiresRoleFrontier('GET','/v1/agents/echo/operations/request')).toBe(false);expect(()=>graphCustodyRequiresRoleFrontier('POST','/v1/agents/echo/%xx')).toThrow();
    const prepare=routes.find(row=>row.path.endsWith('/:key/prepare'))!;expect(prepare.handle({params:{agentId:f.membership.agentId,key:request.packet.idempotencyKey},query:{},body:request})).toHaveProperty('operationHash',canonicalHash(request.packet));
  });

  it('refuses authentic out-of-budget membership and bridge authority before new custody while retaining old Saved proof',()=>{
    const f=fixture(),original=f.prepareRequest(),saved=f.service.prepare(original),raw={...unsigned(f.membership),epoch:GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH,previousMembershipHash:canonicalHash(f.membership)},last={...raw,signature:signGraphRecord(D.membership,raw,f.owner.privateKey)},outsideRaw={...raw,epoch:GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH+1},outside={...outsideRaw,signature:signGraphRecord(D.membership,outsideRaw,f.owner.privateKey)};
    expect(verifyMembershipEpoch(last,f.owner.publicKey)).toBe(true);expect(verifyMembershipEpoch(outside,f.owner.publicKey)).toBe(false);expect(()=>f.service.registerMembership(outside)).toThrow('membership-proof-invalid');
    const bridgeRaw={...unsigned(original.lease),membershipEpoch:outside.epoch},bridge={...bridgeRaw,signature:signGraphRecord(D.lease,bridgeRaw,f.machines[0].signing.privateKey)};expect(verifyWitnessLease(bridge,outside)).toBe(false);expect(verifyFencedLeaseBridge(bridge,original.originalLease,outside)).toBe(false);expect(validatePacket({...original.packet,membershipEpoch:outside.epoch})).toBe(false);expect(()=>f.service.prepare({...original,lease:bridge})).toThrow('lease-proof-invalid');expect(f.service.prepare(original)).toEqual(saved);expect(f.service.membershipProof(original.packet.agentId,1)).toEqual(f.membership);
  });
  it('refuses new source/control custody at the shared manifest budget while preserving old retries and priority erasure fences',()=>{
    const f=fixture();f.service.close();const service=new GraphWitnessService({...f.options,maxHistoryEntries:2});services.push(service);
    const first=f.prepareRequest('capacity-one'),second=f.prepareRequest('capacity-two',2,first.packet.coreHash),third=f.prepareRequest('capacity-three',3,second.packet.coreHash);
    const saved=service.prepare(first);service.cancel(first.packet.agentId,first.packet.idempotencyKey,first.lease,first.originalLease,f.actionSignature('cancel',{idempotencyKey:first.packet.idempotencyKey},first.lease));
    function erase(r:typeof first,id:string){const fields={requestId:id,target:r.packet.erasureIdentity,bundleHashes:[],authorizationReceiptHash:canonicalHash({owner:id})};return service.erase(r.packet.agentId,id,fields.target,[],fields.authorizationReceiptHash,r.lease,r.originalLease,f.actionSignature('erase',fields,r.lease));}
    erase(second,'erase-capacity-two');const {encryptedSourceBundle:_body,...control}=second;const terminal=service.admitErasedControl(control);expect(terminal.prepareProof).toBeNull();expect(terminal.erasedControlProof).toBeTruthy();
    expect(service.recoveryManifest(first.packet.agentId).entries).toHaveLength(2);
    expect(()=>service.prepare(third)).toThrow('witness-history-capacity');expect(service.operation(third.packet.agentId,third.packet.idempotencyKey)).toBeNull();
    // The capacity of immutable operation custody never blocks the separate priority tombstone ledger.
    expect(erase(third,'erase-capacity-three').requestId).toBe('erase-capacity-three');const {encryptedSourceBundle:_third,...thirdControl}=third;
    expect(()=>service.admitErasedControl(thirdControl)).toThrow('witness-history-capacity');expect(service.operation(third.packet.agentId,third.packet.idempotencyKey)).toBeNull();
    expect(service.prepare(first)).toEqual(saved);expect(service.admitErasedControl(control)).toEqual(terminal);expect(service.recoveryManifest(first.packet.agentId).entries).toHaveLength(2);
    expect(()=>new GraphWitnessService({...f.options,maxHistoryEntries:GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES+1})).toThrow('witness-history-budget-invalid');
    expect(()=>new GraphWitnessService({...f.options,maxHistoryEntries:0})).toThrow('witness-history-budget-invalid');
  });
  it('refuses oversized graph packet and native actuation epochs before Saved without changing the native lease system',()=>{
    const f=fixture(),original=f.prepareRequest(),huge=f.leaseFor(0,GRAPH_REPLICATION_MAX_LEASE_EPOCH+1),last=f.leaseFor(0,GRAPH_REPLICATION_MAX_LEASE_EPOCH);
    expect(verifyWitnessLease(last.lease,f.membership)).toBe(true);expect(verifyFencedLeaseBridge(last.lease,last.originalLease,f.membership)).toBe(true);
    expect(verifyWitnessLease(huge.lease,f.membership)).toBe(false);expect(verifyFencedLeaseBridge(huge.lease,huge.originalLease,f.membership)).toBe(false);
    const packet={...original.packet,leaseEpoch:huge.lease.leaseEpoch};expect(validatePacket(packet)).toBe(false);
    expect(()=>f.service.prepare({...original,packet,packetSignature:signGraphRecord(D.packet,packet,f.machines[0].signing.privateKey),...huge})).toThrow();
    expect(()=>f.service.prepare({...original,...huge})).toThrow('lease-proof-invalid');
    expect(f.service.operation(original.packet.agentId,original.packet.idempotencyKey)).toBeNull();expect(f.service.pending(original.packet.agentId)).toHaveLength(0);
    const saved=f.service.prepare(original);expect(()=>f.service.commit(original.packet.agentId,original.packet.idempotencyKey,huge.lease,huge.originalLease,[f.receipt(original.packet,0),f.receipt(original.packet,1)])).toThrow('lease-proof-invalid');
    expect(f.service.operation(original.packet.agentId,original.packet.idempotencyKey)?.prepareProof).toEqual(saved);
  });
  it('never returns Saved for a tail without its exact witnessed prefix and never permits a sequence fork',()=>{
    const f=fixture();const orphan=f.prepareRequest('event-0002',2,'1'.repeat(64));expect(()=>f.service.prepare(orphan)).toThrow('witness-prefix-missing');expect(f.service.pending(orphan.packet.agentId)).toEqual([]);
    const badGenesis=f.prepareRequest('event-0001',1,'1'.repeat(64));expect(()=>f.service.prepare(badGenesis)).toThrow('witness-prefix-mismatch');
    const first=f.prepareRequest();f.service.prepare(first);const second=f.prepareRequest('event-0002',2,first.packet.coreHash),proof=f.service.prepare(second);
    expect(f.service.prepare(second)).toEqual(proof);
    const fork=f.prepareRequest('event-fork',2,first.packet.coreHash);expect(()=>f.service.prepare(fork)).toThrow('source-sequence-conflict');
    f.service.close();const reopened=f.open();services.push(reopened);const third=f.prepareRequest('event-0003',3,second.packet.coreHash);expect(reopened.prepare(third).eventId).toBe(third.packet.eventId);
    expect(reopened.pending(first.packet.agentId).map(op=>op.packet.sourceSequence)).toEqual([1,2,3]);
  });
  it('keeps identical raw IDs in different explicit core namespaces distinct and refuses unknown or mismatched discriminators',()=>{
    const f=fixture(),graph=f.prepareRequest();f.service.prepare(graph);
    const eventId='header-op:event-0001';const encryptedSourceBundle=sealGraphBundle(Buffer.from('sealed header fixture'),f.membership.members,{agentId:graph.packet.agentId,eventId});
    const core=makeHeaderOperation('forget-header','hdr-0000000000000001',0,{opId:'event-0001',createdAt:new Date().toISOString()});const {signature:_sig,...oldReceipt}=graph.controlCapsule.authorizationProof.receipt;const receipt=signGraphAuthorizationReceipt({...oldReceipt,eventId,coreHash:canonicalHash(core),receiptId:core.receipt.id},f.machines[0].signing.privateKey);const adjustedCore={...core,principal:receipt.actorPrincipal,machineId:receipt.writerId};const correctedReceipt=signGraphAuthorizationReceipt({...oldReceipt,eventId,coreHash:canonicalHash(adjustedCore),receiptId:core.receipt.id,idempotencyKey:'header-op:request:event-0001'},f.machines[0].signing.privateKey);const controlCapsule=createGraphControlCapsule('header-op',adjustedCore,{...graph.controlCapsule.authorizationProof,receipt:correctedReceipt});
    const packet={...graph.packet,controlHash:canonicalHash(controlCapsule),coreHash:canonicalHash(adjustedCore),authorizationReceiptHash:canonicalHash(correctedReceipt),coreType:'header-op' as const,erasureIdentity:{sourceKind:'header' as const,sourceId:'hdr-0000000000000001'},eventId,idempotencyKey:'header-op:request:event-0001',sourceSequence:2,predecessorHash:graph.packet.coreHash,sourceBundleHash:canonicalHash(encryptedSourceBundle)};
    const header={...graph,packet,controlCapsule,encryptedSourceBundle,packetSignature:signGraphRecord(D.packet,packet,f.machines[0].signing.privateKey)};
    expect(f.service.prepare(header).eventId).toBe(eventId);expect(f.service.operation(packet.agentId,packet.idempotencyKey)?.packet.coreType).toBe('header-op');
    expect(f.service.operation(graph.packet.agentId,graph.packet.idempotencyKey)?.packet.eventId).toBe('graph-event:event-0001');
    expect(()=>f.service.prepare({...header,packet:{...packet,coreType:'graph-event'}})).toThrow('operation-packet-invalid');
    expect(()=>f.service.prepare({...header,packet:{...packet,coreType:'unknown' as never}})).toThrow('operation-packet-invalid');
  });
  it('fences a never-seen logical header across new nonce versions and restart even with no known bundle hashes',()=>{
    const f=fixture(),r=f.prepareRequest(),target={sourceKind:'header' as const,sourceId:'hdr-0000000000000001'};
    const fields={requestId:'erase-future-header',target,bundleHashes:[],authorizationReceiptHash:canonicalHash({owner:'forget-header'})};
    const proof=f.service.erase(r.packet.agentId,fields.requestId,target,[],fields.authorizationReceiptHash,r.lease,r.originalLease,f.actionSignature('erase',fields,r.lease));expect(proof.target).toEqual(target);
    function attempt(id:string){const base=f.prepareRequest(id),eventId=`header-op:${id}`;const core={...makeHeaderOperation('forget-header',target.sourceId,0,{opId:id}),principal:'owner',machineId:base.packet.writerId};const {signature:_signature,...old}=base.controlCapsule.authorizationProof.receipt;const receipt=signGraphAuthorizationReceipt({...old,eventId,coreHash:canonicalHash(core),receiptId:core.receipt.id},f.machines[0].signing.privateKey);const controlCapsule=createGraphControlCapsule('header-op',core,{...base.controlCapsule.authorizationProof,receipt});const packet={...base.packet,coreType:'header-op' as const,eventId,erasureIdentity:target,coreHash:canonicalHash(core),authorizationReceiptHash:canonicalHash(receipt),controlHash:canonicalHash(controlCapsule)};return {...base,packet,controlCapsule,packetSignature:signGraphRecord(D.packet,packet,f.machines[0].signing.privateKey)};}
    expect(()=>f.service.prepare(attempt('new-version-a'))).toThrow('source-erased');f.service.close();const reopened=f.open();services.push(reopened);expect(()=>reopened.prepare(attempt('new-version-b'))).toThrow('source-erased');expect(reopened.inventory(r.packet.agentId,'d'.repeat(43)).erasures).toEqual([proof]);
  });
  it('requires exact original opaque custody before Saved and retains committed facts after erasure and cold restart',()=>{
    const f=fixture(),r=f.prepareRequest();const capsule=structuredClone(r.controlCapsule);(capsule.authorizationProof.originalLease as unknown as Record<string,unknown>).dispatchMessage='private-capsule-canary';const packet={...r.packet,controlHash:canonicalHash(capsule)};
    expect(()=>f.service.prepare({...r,packet,controlCapsule:capsule,packetSignature:signGraphRecord(D.packet,packet,f.machines[0].signing.privateKey)})).toThrow('operation-control-invalid');expect(f.service.pending(r.packet.agentId)).toEqual([]);
    expect(()=>f.service.prepare({...r,controlCapsule:{...r.controlCapsule,title:'private-capsule-canary'} as never})).toThrow('operation-control-invalid');
    const signedExtra=structuredClone(r.controlCapsule);signedExtra.authorizationProof.receipt=signGraphAuthorizationReceipt({...unsigned(r.controlCapsule.authorizationProof.receipt),debugTranscript:'private-signed-canary'} as never,f.machines[0].signing.privateKey);const signedPacket={...r.packet,authorizationReceiptHash:canonicalHash(signedExtra.authorizationProof.receipt),controlHash:canonicalHash(signedExtra)};expect(()=>f.service.prepare({...r,packet:signedPacket,controlCapsule:signedExtra,packetSignature:signGraphRecord(D.packet,signedPacket,f.machines[0].signing.privateKey)})).toThrow('operation-control-invalid');
    f.service.prepare(r);const certificate=f.service.commit(r.packet.agentId,r.packet.idempotencyKey,r.lease,r.originalLease,[f.receipt(r.packet,0),f.receipt(r.packet,1)]);
    const fields={requestId:'erase-capsule-source',target:r.packet.erasureIdentity,bundleHashes:[r.packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({owner:'erase'})};f.service.erase(r.packet.agentId,fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,r.lease,r.originalLease,f.actionSignature('erase',fields,r.lease));f.service.checkpointErasure(r.packet.agentId,fields.requestId);f.service.close();const reopened=f.open();services.push(reopened);
    const recovered=reopened.recover(r.packet.agentId,r.packet.idempotencyKey);expect(recovered.encryptedSourceBundle).toBeNull();expect(recovered.operation.controlCapsule).toEqual(r.controlCapsule);expect(recovered.operation.certificate).toEqual(certificate);expect(verifyCommitCertificate(certificate,recovered.operation.packet,f.membership,pem(f.witness.publicKey),pem(f.owner.publicKey))).toBe(true);expect(JSON.stringify(recovered.operation.controlCapsule)).not.toContain('private-canary');
  });
  it('shares exact encrypted bundle ingress validation and refuses plaintext or unregistered envelope fields',()=>{
    const f=fixture();const r=f.prepareRequest();expect(verifyEncryptedBundle(r.encryptedSourceBundle,f.membership)).toBe(true);
    expect(verifyEncryptedBundle({...r.encryptedSourceBundle,transcript:'private-canary'},f.membership)).toBe(false);
    const envelope=structuredClone(r.encryptedSourceBundle);(envelope.envelopes[0] as unknown as Record<string,unknown>).contentKey='private-canary';
    expect(verifyEncryptedBundle(envelope,f.membership)).toBe(false);
    expect(verifyEncryptedBundle({...r.encryptedSourceBundle,envelopes:[r.encryptedSourceBundle.envelopes[0]]},f.membership)).toBe(false);
  });
  it('binds full inventory and tombstones to an unpredictable challenge across restart', () => {
    const f = fixture(); const request = f.prepareRequest(); f.service.prepare(request);
    const challenge = 'a'.repeat(43); const first = f.service.inventory(request.packet.agentId, challenge);
    expect(verifyWitnessInventory(first, challenge, request.packet.agentId, f.options.witnessId, pem(f.witness.publicKey))).toBe(true);
    expect(verifyWitnessInventory(first, 'b'.repeat(43), request.packet.agentId, f.options.witnessId, pem(f.witness.publicKey))).toBe(false);
    expect(first.manifest.entries).toHaveLength(1);
    expect(verifyWitnessInventory({...first, fenceEpoch:999}, challenge, request.packet.agentId, f.options.witnessId, pem(f.witness.publicKey))).toBe(false);
    f.service.close(); services.splice(services.indexOf(f.service),1);
    const reopened = f.open(); services.push(reopened);
    const second = reopened.inventory(request.packet.agentId, 'c'.repeat(43));
    expect(second.manifestHash).toBe(first.manifestHash);
    expect(second.challenge).not.toBe(first.challenge);
  });
  it('stores only ciphertext and sealed member envelopes; only a named member can recover the exact source', () => {
    const f = fixture(); const r = f.prepareRequest(); const proof = f.service.prepare(r);
    expect(verifyGraphRecord(D.prepare, unsigned(proof), proof.signature, pem(f.witness.publicKey))).toBe(true);
    expect(f.service.operation(r.packet.agentId, r.packet.idempotencyKey)?.state).toBe('prepared');
    expect(f.service.operation(r.packet.agentId, r.packet.idempotencyKey)?.certificate).toBeNull();
    const recovered = f.service.recover(r.packet.agentId, r.packet.idempotencyKey).encryptedSourceBundle!;
    expect(openGraphBundle(recovered, f.machines[1].machineId, pem(f.machines[1].sealing.privateKey), r.packet).toString()).toBe('private-canary-owner-transcript');
    expect(() => openGraphBundle(recovered, 'unknown', pem(f.machines[1].sealing.privateKey), r.packet)).toThrow();
    expect(() => openGraphBundle(recovered, f.machines[1].machineId, pem(f.machines[1].sealing.privateKey), { agentId: r.packet.agentId, eventId: 'wrong-event' })).toThrow();
    for (const name of fs.readdirSync(f.directory)) expect(fs.readFileSync(path.join(f.directory, name)).includes(Buffer.from('private-canary-owner-transcript'))).toBe(false);
  });
  it('requires every installed source receipt and separately every certificate persistence receipt', () => {
    const f = fixture(); const r = f.prepareRequest(); f.service.prepare(r);
    expect(() => f.service.commit(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, [f.receipt(r.packet, 0)])).toThrow('all-member-durable-receipts-required');
    const receipts = [f.receipt(r.packet, 0), f.receipt(r.packet, 1)];
    const cert = f.service.commit(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, receipts);
    expect(verifyCommitCertificate(cert, r.packet, f.membership, pem(f.witness.publicKey))).toBe(true);
    expect(verifyCommitCertificate({ ...cert, coreHash: '0'.repeat(64) }, r.packet, f.membership, pem(f.witness.publicKey))).toBe(false);
    expect(f.service.acknowledgeCertificate(r.packet.agentId, r.packet.idempotencyKey, f.receipt(r.packet, 0, 'certificate', canonicalHash(cert))).allMembersPersisted).toBe(false);
    expect(f.service.acknowledgeCertificate(r.packet.agentId, r.packet.idempotencyKey, f.receipt(r.packet, 1, 'certificate', canonicalHash(cert))).allMembersPersisted).toBe(true);
  });
  it('does not count duplicated or forged receipts as another installed machine', () => {
    const f = fixture(); const r = f.prepareRequest(); f.service.prepare(r);
    const a = f.receipt(r.packet, 0);
    expect(() => f.service.commit(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, [a, a])).toThrow();
    expect(() => f.service.commit(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, [a, { ...f.receipt(r.packet, 1), persistedAt: '2026-11-05T09:31:00Z' }])).toThrow();
  });
  it('survives close/reopen without changing prepared proofs or final certificates', () => {
    const f = fixture(); const r = f.prepareRequest(); const proof = f.service.prepare(r); f.service.close();
    const restarted = f.open(); services.push(restarted);
    expect(restarted.prepare(r)).toEqual(proof);
    const cert = restarted.commit(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, [f.receipt(r.packet, 0), f.receipt(r.packet, 1)]);
    restarted.close(); const again = f.open(); services.push(again);
    expect(again.recover(r.packet.agentId, r.packet.idempotencyKey).operation.certificate).toEqual(cert);
  });
  it('serializes commit versus cancellation across separate service handles', () => {
    const f = fixture(); const r = f.prepareRequest(); f.service.prepare(r);
    const second = f.open(); services.push(second);
    const decision = f.service.cancel(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, f.actionSignature('cancel', { idempotencyKey: r.packet.idempotencyKey }, r.lease));
    expect(() => second.commit(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, [f.receipt(r.packet, 0), f.receipt(r.packet, 1)])).toThrow('operation-canceled');
    const terminal = f.service.certifyCancellation(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease,
      [f.receipt(r.packet, 0, 'cancellation', canonicalHash(decision)), f.receipt(r.packet, 1, 'cancellation', canonicalHash(decision))]);
    expect(terminal.outcome).toBe('canceled');
    const next = f.prepareRequest('event-0002', 2, r.packet.coreHash); f.service.prepare(next);
    second.commit(next.packet.agentId, next.packet.idempotencyKey, next.lease, next.originalLease, [f.receipt(next.packet, 0), f.receipt(next.packet, 1)]);
    expect(() => f.service.cancel(next.packet.agentId, next.packet.idempotencyKey, next.lease, next.originalLease, f.actionSignature('cancel', { idempotencyKey: next.packet.idempotencyKey }, next.lease))).toThrow('not-cancelable:certified');
  });
  it('fences old writers with the retained original installed lease signature', () => {
    const f = fixture(); const r = f.prepareRequest(); f.service.prepare(r);
    const takeover = f.prepareRequest('event-0002', 2, r.packet.coreHash, 1, 2); f.service.prepare(takeover);
    expect(() => f.service.cancel(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, f.actionSignature('cancel', { idempotencyKey: r.packet.idempotencyKey }, r.lease))).toThrow('writer-fenced');
    expect(() => f.service.prepare({ ...takeover, originalLease: { ...takeover.originalLease, nonce: 999 } })).toThrow('lease-proof-invalid');
  });
  it('keeps an erasure tombstone durable across restart and refuses old-payload replay', () => {
    const f = fixture(); const r = f.prepareRequest(); f.service.prepare(r);
    const authorizationReceiptHash = canonicalHash({ owner: 'verified' });
    const proof = f.service.erase(r.packet.agentId, 'erase-0001',r.packet.erasureIdentity, [r.packet.sourceBundleHash], authorizationReceiptHash, r.lease, r.originalLease,
      f.actionSignature('erase', { requestId: 'erase-0001',target:r.packet.erasureIdentity, bundleHashes: [r.packet.sourceBundleHash], authorizationReceiptHash }, r.lease));
    expect(verifyWitnessErasure(proof, pem(f.witness.publicKey))).toBe(true);
    expect(f.service.recover(r.packet.agentId, r.packet.idempotencyKey).encryptedSourceBundle).toBeNull();
    expect(f.service.checkpointErasure(r.packet.agentId, 'erase-0001')).toMatchObject({ walPurged: true, externalBackupsVerified: false });
    f.service.close(); const restarted = f.open(); services.push(restarted);
    expect(restarted.recover(r.packet.agentId, r.packet.idempotencyKey).erasure).toEqual(proof);
    expect(() => restarted.prepare(r)).toThrow('source-erased');
    expect(() => restarted.commit(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, [f.receipt(r.packet, 0), f.receipt(r.packet, 1)])).toThrow('operation-erased');
  });
  it('requires a separate pinned infrastructure audit signature for external backup erasure',()=>{
    const f=fixture();const auditor=crypto.generateKeyPairSync('ed25519');
    (f.options.enrollments['agent-a'] as {backupPolicyAuditorPublicKey?:string}).backupPolicyAuditorPublicKey=pem(auditor.publicKey);
    const r=f.prepareRequest();f.service.prepare(r);
    const fields={requestId:'erase-audit',target:r.packet.erasureIdentity,bundleHashes:[r.packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({owner:'forget'})};
    const erasure=f.service.erase(r.packet.agentId,fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,r.lease,r.originalLease,f.actionSignature('erase',fields,r.lease));
    const raw={v:1 as const,agentId:r.packet.agentId,witnessId:f.options.witnessId,failureDomain:f.options.failureDomain,requestId:fields.requestId,erasureHash:canonicalHash(erasure),
      policy:'no-retained-copies' as const,providerResourceHash:canonicalHash({resource:'test-provider-resource'}),evidenceHash:canonicalHash({sealedProviderRead:'fixture evidence only'}),
      checkedAt:new Date(f.options.now()).toISOString(),expiresAt:new Date(f.options.now()+60000).toISOString()};
    expect(()=>f.service.attestBackupErasure(r.packet.agentId,{...raw,signature:signGraphRecord('graph-backup-erasure-v1',raw,f.owner.privateKey)})).toThrow('backup-erasure-attestation-invalid');
    f.service.attestBackupErasure(r.packet.agentId,{...raw,signature:signGraphRecord('graph-backup-erasure-v1',raw,auditor.privateKey)});
    expect(f.service.checkpointErasure(r.packet.agentId,fields.requestId)).toMatchObject({walPurged:true,externalBackupsVerified:true});
    expect(()=>f.service.attestBackupErasure(r.packet.agentId,{...raw,evidenceHash:'0'.repeat(64),signature:signGraphRecord('graph-backup-erasure-v1',raw,auditor.privateKey)})).toThrow();
  });
  it('rejects membership forgery, skipped transitions and installed-failure-domain witnesses', () => {
    const f = fixture();
    expect(() => f.service.registerMembership({ ...f.membership, epoch: 2 })).toThrow('membership-proof-invalid');
    const changed = { ...unsigned(f.membership), epoch: 3, previousMembershipHash: canonicalHash(f.membership) };
    expect(() => f.service.registerMembership({ ...changed, signature: signGraphRecord(D.membership, changed, f.owner.privateKey) })).toThrow('membership-transition-invalid');
    expect(() => new GraphWitnessService({ ...f.options, installedFailureDomains: [f.options.failureDomain] })).toThrow('witness-failure-domain-not-independent');
  });
  it('never activates a new installed membership through plain registration after final certification',()=>{
    const f=fixture(),r=f.prepareRequest();f.service.prepare(r);f.service.commit(r.packet.agentId,r.packet.idempotencyKey,r.lease,r.originalLease,[f.receipt(r.packet,0),f.receipt(r.packet,1)]);
    const nextRaw={...unsigned(f.membership),epoch:2,previousMembershipHash:canonicalHash(f.membership),members:[f.membership.members[0]]};
    const next={...nextRaw,signature:signGraphRecord(D.membership,nextRaw,f.owner.privateKey)};
    expect(()=>f.service.registerMembership(next)).toThrow('membership-recovery-required');expect(f.service.membershipProof(r.packet.agentId,1)).toEqual(f.membership);
    expect(f.service.registerMembership(f.membership)).toEqual({membershipHash:canonicalHash(f.membership)});
  });
  it('requires an unbroken source chain and keeps idempotency keys immutable', () => {
    const f = fixture(); const r = f.prepareRequest(); f.service.prepare(r);
    const changed = { ...r.packet, coreHash: '0'.repeat(64) };
    expect(() => f.service.prepare({ ...r, packet: changed, packetSignature: signGraphRecord(D.packet, changed, f.machines[0].signing.privateKey) })).toThrow('operation-control-invalid');
    const gap = f.prepareRequest('event-0002', 2, '0'.repeat(64));expect(()=>f.service.prepare(gap)).toThrow('witness-prefix-mismatch');
    const next=f.prepareRequest('event-0002',2,r.packet.coreHash);f.service.prepare(next);expect(()=>f.service.commit(next.packet.agentId,next.packet.idempotencyKey,next.lease,next.originalLease,[f.receipt(next.packet,0),f.receipt(next.packet,1)])).toThrow('source-chain-gap');
  });
  it('does not let a transport credential and replayed lease authorize arbitrary operations or erasure', () => {
    const f = fixture(); const r = f.prepareRequest();
    expect(() => f.service.prepare({ ...r, packetSignature: '' })).toThrow('operation-signature-invalid');
    expect(f.service.pending(r.packet.agentId)).toHaveLength(0);
    f.service.prepare(r);
    expect(() => f.service.cancel(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, '')).toThrow('cancel-signature-invalid');
    expect(() => f.service.erase(r.packet.agentId, 'forged-erase',r.packet.erasureIdentity, [r.packet.sourceBundleHash], canonicalHash({ forged: true }), r.lease, r.originalLease, '')).toThrow('erasure-signature-invalid');
    expect(f.service.recover(r.packet.agentId, r.packet.idempotencyKey).encryptedSourceBundle).not.toBeNull();
  });
  it('refuses new witness endorsements after lease expiry while retained proofs remain readable', () => {
    const f = fixture(); const r = f.prepareRequest(); f.service.prepare(r); f.service.close();
    const expired = new GraphWitnessService({ ...f.options, now: () => Date.parse(r.originalLease.expiresAt) + 1 }); services.push(expired);
    expect(expired.recover(r.packet.agentId, r.packet.idempotencyKey).operation.prepareProof).toBeTruthy();
    expect(() => expired.prepare(r)).toThrow('lease-proof-invalid');
    expect(() => expired.commit(r.packet.agentId, r.packet.idempotencyKey, r.lease, r.originalLease, [f.receipt(r.packet, 0), f.receipt(r.packet, 1)])).toThrow('lease-proof-invalid');
  });
});
