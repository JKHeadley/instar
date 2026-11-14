import {GRAPH_NATIVE_TAIL_DOMAIN,type GraphNativeTailClosure} from '../../src/core/ConversationGraphNativeTail.js';
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GraphWitnessService } from '../../src/core/GraphWitnessService.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { rewrapGraphBundle } from '../../src/core/GraphWitnessCrypto.js';
import { canonicalHash, GRAPH_SIGNATURE_DOMAINS as D, signGraphRecord, verifyAdoptionCertificate, verifyCommitCertificate,
  type GraphMemberReceipt, type GraphPendingRevalidation } from '../../src/core/GraphWitnessTypes.js';
import { pem, witnessFixture } from './graph-witness-fixtures.js';

const services: GraphWitnessService[] = []; const directories: string[] = [];
afterEach(() => { for (const s of services.splice(0)) s.close(); for (const dir of directories.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'graph-witness-recovery-fixture-cleanup' }); });
function fixture() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-witness-recovery-')); directories.push(dir); const f = witnessFixture(dir); const service = f.open(); services.push(service); return { ...f, service }; }
function sourceReceipt(f: ReturnType<typeof fixture>, packet: ReturnType<typeof f.prepareRequest>['packet'], machine: number, leaseEpoch: number): GraphMemberReceipt {
  const body = { agentId: packet.agentId, eventId: packet.eventId, operationHash: canonicalHash(packet), membershipEpoch: 1, leaseEpoch,
    machineId: f.machines[machine].machineId, phase: 'source' as const, persistedAt: new Date(f.options.now()).toISOString() };
  return { ...body, signature: signGraphRecord(D.memberReceipt, body, f.machines[machine].signing.privateKey) };
}
function revalidation(f: ReturnType<typeof fixture>, request: ReturnType<typeof f.prepareRequest>, actuation: ReturnType<typeof f.leaseFor>, machine = 0, decision: 'adopt' | 'refuse' = 'adopt') {
  const rewrap = decision === 'adopt' ? rewrapGraphBundle(request.encryptedSourceBundle, f.machines[machine].machineId,
    f.machines[machine].sealing.privateKey, f.membership, f.machines[machine].machineId, f.machines[machine].signing.privateKey, request.packet) : null;
  const payload = { v: 1 as const, agentId: request.packet.agentId, idempotencyKey: request.packet.idempotencyKey,
    operationHash: canonicalHash(request.packet), coreHash: request.packet.coreHash,
    sourceProofHash: canonicalHash({ opaqueVerifiedSource: request.packet.authorizationReceiptHash }), subjectHeadsHash: canonicalHash([]), dependenciesHash: canonicalHash([]),
    rewrapHash: canonicalHash(rewrap), newMembershipHash: canonicalHash(f.membership), currentLeaseHash: canonicalHash(actuation.lease),
    writerId: f.machines[machine].machineId, decision, reason: decision === 'adopt' ? 'ok' as const : 'stale-heads' as const,
    validatedAt: new Date(f.options.now()).toISOString() };
  const proof: GraphPendingRevalidation = { ...payload, signature: signGraphRecord(D.revalidation, payload, f.machines[machine].signing.privateKey) };
  return { proof, rewrap };
}
describe('witness current-actuation recovery protocol', () => {
  it('custodies the exact old unwitnessed source only with every current native tail closed, then adopts without rewriting old authority',()=>{
    const f=fixture(),r=f.prepareRequest(),current=f.leaseFor(1,2),validation=revalidation(f,r,current,1),sourceProofHash=canonicalHash({coreType:r.packet.coreType,packet:r.packet,packetSignature:r.packetSignature,core:r.controlCapsule.core,authorizationProof:r.controlCapsule.authorizationProof});
    const proofRaw={...validation.proof,sourceProofHash};const {signature:_old,...unsignedProof}=proofRaw;const proof={...unsignedProof,signature:signGraphRecord(D.revalidation,unsignedProof,f.machines[1].signing.privateKey)};
    const entry={eventId:r.packet.eventId,packetHash:canonicalHash(r.packet),sourceSequence:r.packet.sourceSequence,predecessorHash:r.packet.predecessorHash,coreHash:r.packet.coreHash,sourceProofHash};
    const closedTails:GraphNativeTailClosure[]=f.machines.map((machine,index)=>{const entries=index===0?[entry]:[],raw={v:1 as const,agentId:f.membership.agentId,membershipHash:canonicalHash(f.membership),writerId:current.lease.writerId,leaseEpoch:current.lease.leaseEpoch,nativeLeaseHash:canonicalHash(current.originalLease),machineId:machine.machineId,tailHash:canonicalHash(entries),entryCount:entries.length,highestSourceSequence:entries.at(-1)?.sourceSequence??0,recordedAt:new Date(f.options.now()).toISOString()};return{receipt:{...raw,signature:signGraphRecord(GRAPH_NATIVE_TAIL_DOMAIN,raw,machine.signing.privateKey)},observedLease:current.lease,originalObservedLease:current.originalLease,entries};});
    const request={...r,...current,originalSourceReceipt:f.receipt(r.packet,0),closedTails,revalidation:proof,rewrap:validation.rewrap!};
    expect(()=>f.service.recoverPositiveSource({...request,closedTails:closedTails.slice(0,1)})).toThrow('tail-unclosed');expect(f.service.operation(r.packet.agentId,r.packet.idempotencyKey)).toBeNull();
    expect(()=>f.service.recoverPositiveSource({...request,originalSourceReceipt:f.receipt(r.packet,1)})).toThrow('tail-evidence-missing');expect(f.service.operation(r.packet.agentId,r.packet.idempotencyKey)).toBeNull();
    const operation=f.service.recoverPositiveSource(request);expect(operation.packet).toEqual(r.packet);expect(operation.packetSignature).toBe(r.packetSignature);expect(operation.prepareProof).not.toBeNull();expect(operation.adoption?.currentLease).toEqual(current.lease);expect(operation.adoption?.ownerAuthorization).toBeNull();expect(f.service.recover(r.packet.agentId,r.packet.idempotencyKey).encryptedSourceBundle).toEqual(r.encryptedSourceBundle);
    expect(f.service.recoverPositiveSource(request).adoption).toEqual(operation.adoption);expect(()=>f.service.prepare(r)).toThrow('writer-fenced');
  });
  it('adopts never-saved erased control under a new native holder without fabricating source custody or changing erased outcome',()=>{
    const f=fixture(),r=f.prepareRequest(),fields={requestId:'erase-before-witness',target:r.packet.erasureIdentity,bundleHashes:[],authorizationReceiptHash:canonicalHash({owner:'forget'})};f.service.erase(r.packet.agentId,fields.requestId,fields.target,[],fields.authorizationReceiptHash,r.lease,r.originalLease,f.actionSignature('erase',fields,r.lease));
    const {encryptedSourceBundle:_cipher,...control}=r;f.service.admitErasedControl(control);const current=f.leaseFor(1,2),validation=revalidation(f,r,current,1,'refuse');
    const [adoption]=f.service.adoptPending(r.packet.agentId,{currentLease:current.lease,originalCurrentLease:current.originalLease,revalidations:[validation]});const op=f.service.operation(r.packet.agentId,r.packet.idempotencyKey)!;expect(op.state).toBe('erased');expect(op.prepareProof).toBeNull();expect(op.cancellation).toBeNull();expect(op.adoption).toEqual(adoption);
    const receipts=f.machines.map(machine=>{const value={agentId:r.packet.agentId,eventId:r.packet.eventId,operationHash:canonicalHash(r.packet),membershipEpoch:1,leaseEpoch:2,machineId:machine.machineId,phase:'cancellation' as const,certificateHash:canonicalHash(op.erasure),persistedAt:new Date(f.options.now()).toISOString()};return {...value,signature:signGraphRecord(D.memberReceipt,value,machine.signing.privateKey)};});
    const terminal=f.service.certifyCancellation(r.packet.agentId,r.packet.idempotencyKey,current.lease,current.originalLease,receipts);expect(terminal.outcome).toBe('erased');expect(terminal.cancellationHash).toBe(canonicalHash(op.erasure));expect(terminal.adoption).toEqual(adoption);expect(f.service.recover(r.packet.agentId,r.packet.idempotencyKey).encryptedSourceBundle).toBeNull();
  });
  it('adopts once on ordinary writer failover without owner reapproval or packet mutation', () => {
    const f = fixture(); const request = f.prepareRequest(); f.service.prepare(request);
    const originalHash = canonicalHash(request.packet); const actuation = f.leaseFor(1, 2);
    const validation = revalidation(f, request, actuation, 1);
    const [adoption] = f.service.adoptPending(request.packet.agentId, { currentLease: actuation.lease, originalCurrentLease: actuation.originalLease, revalidations: [validation] });
    expect(adoption.ownerAuthorization).toBeNull(); expect(adoption.membershipChain).toHaveLength(1);
    expect(verifyAdoptionCertificate(adoption, request.packet, f.membership, pem(f.owner.publicKey), pem(f.witness.publicKey))).toBe(true);
    expect(f.service.adoptPending(request.packet.agentId, { currentLease: actuation.lease, originalCurrentLease: actuation.originalLease, revalidations: [validation] })[0]).toEqual(adoption);
    const certificate = f.service.commit(request.packet.agentId, request.packet.idempotencyKey, actuation.lease, actuation.originalLease,
      [sourceReceipt(f, request.packet, 0, 2), sourceReceipt(f, request.packet, 1, 2)]);
    expect(verifyCommitCertificate(certificate, request.packet, f.membership, pem(f.witness.publicKey), pem(f.owner.publicKey))).toBe(true);
    expect(canonicalHash(f.service.operation(request.packet.agentId, request.packet.idempotencyKey)!.packet)).toBe(originalHash);
    expect(() => f.service.commit(request.packet.agentId, request.packet.idempotencyKey, request.lease, request.originalLease, [])).toThrow('writer-fenced');
  });
  it('keeps immutable certificates free of key envelopes and purges actual rewrap sidecar across erase/checkpoint/restart',()=>{
    const f=fixture(),r=f.prepareRequest();f.service.prepare(r);const current=f.leaseFor(1,2),validation=revalidation(f,r,current,1);
    f.service.adoptPending(r.packet.agentId,{currentLease:current.lease,originalCurrentLease:current.originalLease,revalidations:[validation]});
    const cert=f.service.commit(r.packet.agentId,r.packet.idempotencyKey,current.lease,current.originalLease,[sourceReceipt(f,r.packet,0,2),sourceReceipt(f,r.packet,1,2)]);
    expect(JSON.stringify(cert)).not.toContain('ephemeralPublicKey');expect(JSON.stringify(cert)).not.toContain('envelopes');
    expect(f.service.operation(r.packet.agentId,r.packet.idempotencyKey)?.rewrap).toEqual(validation.rewrap);
    const fields={requestId:'erase-adopted',target:r.packet.erasureIdentity,bundleHashes:[r.packet.sourceBundleHash],authorizationReceiptHash:canonicalHash({owner:'forget'})};
    f.service.erase(r.packet.agentId,fields.requestId,fields.target,fields.bundleHashes,fields.authorizationReceiptHash,current.lease,current.originalLease,f.actionSignature('erase',fields,current.lease));
    expect(f.service.checkpointErasure(r.packet.agentId,fields.requestId).walPurged).toBe(true);f.service.close();const reopened=f.open();services.push(reopened);
    const recovered=reopened.recover(r.packet.agentId,r.packet.idempotencyKey);expect(recovered.encryptedSourceBundle).toBeNull();expect(recovered.operation.rewrap).toBeNull();
    expect(verifyCommitCertificate(recovered.operation.certificate!,r.packet,f.membership,pem(f.witness.publicKey),pem(f.owner.publicKey))).toBe(true);
    for(const file of fs.readdirSync(path.dirname(f.options.databasePath)))for(const envelope of validation.rewrap!.envelopes)expect(fs.readFileSync(path.join(path.dirname(f.options.databasePath),file)).includes(Buffer.from(envelope.ciphertext))).toBe(false);
  });
  it('refuses stale observed heads without reopening or committing the original action', () => {
    const f = fixture(); const request = f.prepareRequest(); f.service.prepare(request);
    const actuation = f.leaseFor(1, 2); const validation = revalidation(f, request, actuation, 1, 'refuse');
    const [adoption] = f.service.adoptPending(request.packet.agentId, { currentLease: actuation.lease, originalCurrentLease: actuation.originalLease, revalidations: [validation] });
    expect(adoption.disposition).toBe('refused'); expect(adoption.rewrapHash).toBe(canonicalHash(null));
    const operation = f.service.operation(request.packet.agentId, request.packet.idempotencyKey)!;
    expect(operation.state).toBe('canceled'); expect(operation.cancellation?.membershipEpoch).toBe(1); expect(operation.cancellation?.leaseEpoch).toBe(2);
    expect(f.service.pending(request.packet.agentId)).toHaveLength(1);
    expect(() => f.service.adoptPending(request.packet.agentId, { currentLease: actuation.lease, originalCurrentLease: actuation.originalLease,
      revalidations: [revalidation(f, request, actuation, 1)] })).toThrow('terminal-decision-dominates');
  });
  it('does not endorse modified revalidation fields; a seen higher lease remains fenced even after refusal', () => {
    const f = fixture(); const request = f.prepareRequest(); f.service.prepare(request); const actuation = f.leaseFor(1, 2);
    const validation = revalidation(f, request, actuation, 1);
    expect(() => f.service.adoptPending(request.packet.agentId, { currentLease: actuation.lease, originalCurrentLease: actuation.originalLease,
      revalidations: [{ ...validation, proof: { ...validation.proof, subjectHeadsHash: '0'.repeat(64) } }] })).toThrow('pending-revalidation-invalid');
    expect(() => f.service.commit(request.packet.agentId, request.packet.idempotencyKey, request.lease, request.originalLease, [])).toThrow('writer-fenced');
    expect(f.service.operation(request.packet.agentId, request.packet.idempotencyKey)?.state).toBe('prepared');
  });
});
