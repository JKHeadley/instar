/** All-installed-member commit orchestration. A witness prepare is Saved,
 * never committed; final certificates AND persistence proofs reach every
 * installed member before this coordinator reports a successful new write.
 * Spec: conversation-effort-hierarchy-v3 §7.2.
 */
import { canonicalHash, type GraphCommitCertificate, type GraphMemberReceipt,
  type GraphWitnessLease, type GraphCancellationCertificate } from './GraphWitnessTypes.js';
import type { LeaseRecord } from './types.js';
import type { GraphWitnessClient } from './GraphWitnessClient.js';
import {createGraphControlCapsule} from './GraphWitnessControl.js';
import {hasSeparateGraphPendingCopy} from './ConversationGraphPendingCustody.js';
import type { ConversationGraphReplication, ConversationGraphReplicationRecord } from './ConversationGraphReplication.js';
import type { GraphCommitProofDeliveryReceipt,GraphDeliveryCompletionReceipt } from './ConversationGraphReplication.js';

export interface GraphCommitMember {
  machineId: string;
  receiveSource(record: ConversationGraphReplicationRecord): Promise<GraphMemberReceipt>;
  persistCertificate(record: ConversationGraphReplicationRecord, certificate: GraphCommitCertificate): Promise<GraphMemberReceipt>;
  persistCommitProof(record: ConversationGraphReplicationRecord): Promise<GraphCommitProofDeliveryReceipt>;
  persistDeliveryCompletion?(record:ConversationGraphReplicationRecord):Promise<GraphDeliveryCompletionReceipt>;
  persistCancellationCertificate?(record: ConversationGraphReplicationRecord, certificate: GraphCancellationCertificate): Promise<GraphMemberReceipt>;
}
export interface ConversationGraphCommitOptions {
  source: ConversationGraphReplication;
  witness: GraphWitnessClient;
  machineId: string;
  /** Registry-selected authenticated transport; absence means waiting, not
   * removal from the signed installed-machine membership. */
  member(machineId: string): GraphCommitMember | null;
  /** Current real native lease, separate from the immutable original receipt. */
  actuation(): { lease: GraphWitnessLease; originalLease: LeaseRecord };
}
export interface GraphCommitOutcome {
  state: 'checking-save' | 'recorded-local' | 'saved-pending' | 'committed' | 'refused';
  idempotencyKey: string;
  eventId: string;
  waitingMachineIds: string[];
  phase: 'local' | 'witnessed' | 'certified' | 'committed';
  reason?: 'write-refused' | 'witness-unavailable' | 'waiting-members' | 'save-outcome-unknown' | 'recovery-required';
}
export interface GraphCancelOutcome {
  state: 'checking-cancel' | 'cancel-pending' | 'canceled' | 'commit-won';
  idempotencyKey: string; eventId: string; waitingMachineIds: string[];
}

export function localGraphCommitMember(machineId: string, source: ConversationGraphReplication): GraphCommitMember {
  return {
    machineId,
    receiveSource: (record) => source.receive(record, record.packet.writerId),
    persistCertificate: async (record, certificate) => {
      await source.receive(record, record.packet.writerId);
      return source.attachCertificate(record.packet.eventId, certificate);
    },
    persistCommitProof: async (record) => {
      if(record.materialization)await source.receiveHistorical(record);else await source.receive(record, record.packet.writerId);
      return source.durableCommitProofDeliveryReceipt(record.packet.eventId);
    },
    persistDeliveryCompletion:async(record)=>{if(record.materialization)await source.receiveHistorical(record);else await source.receive(record,record.packet.writerId);return source.durableDeliveryCompletionReceipt(record.packet.eventId);},
    persistCancellationCertificate: async (record, certificate) => {
      await source.receive(record, record.packet.writerId);
      return source.attachCancellationCertificate(record.packet.eventId, certificate);
    },
  };
}

export class ConversationGraphCommitCoordinator {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: ConversationGraphCommitOptions) {}

  /** Callers reserve a stable event/core/packet by idempotency key BEFORE
   * invoking this method. A retry never regenerates source ciphertext. */
  submit(record: ConversationGraphReplicationRecord): Promise<GraphCommitOutcome> {
    const run = this.queue.then(() => this.commit(record));
    this.queue = run.catch(() => undefined);
    return run;
  }
  /** Invoked after the route verifies owner authority for this exact operation.
   * The machine signature actuates that authorized cancellation under the real
   * current lease. It is not a substitute for the route's owner proof. */
  cancel(record: ConversationGraphReplicationRecord, signCancellation: (lease: GraphWitnessLease) => string): Promise<GraphCancelOutcome> {
    const run = this.queue.then(() => this.cancelPending(record, signCancellation));
    this.queue = run.catch(() => undefined);
    return run;
  }
  private async cancelPending(input: ConversationGraphReplicationRecord,
    signCancellation: (lease: GraphWitnessLease) => string): Promise<GraphCancelOutcome> {
    const packet = input.packet;
    const result = (state: GraphCancelOutcome['state'], waiting: string[] = []): GraphCancelOutcome =>
      ({ state, idempotencyKey: packet.idempotencyKey, eventId: packet.eventId, waitingMachineIds: waiting.sort() });
    let record = this.options.source.lookupByIdempotencyKey(packet.idempotencyKey);
    if (!record || canonicalHash(record.packet) !== canonicalHash(packet)) return result('checking-cancel');
    const status = this.options.source.status(packet.eventId);
    if (status.state === 'committed') return result('commit-won');
    if (status.state === 'canceled' && this.options.source.allDeliveryCompletionPersisted(packet.eventId)) return result('canceled');
    if((status.state==='canceled'||status.state==='erased')&&this.options.source.allCommitProofDelivered(packet.eventId)){const waiting=await this.publishDeliveryCompletion(record);return waiting.length?result('cancel-pending',waiting):result('canceled');}
    const waiting = new Set<string>();
    try {
      const actuation = this.options.actuation();
      if (!this.options.source.mayContinue(packet.eventId, actuation.lease, actuation.originalLease)
        && !this.options.source.mayContinueCancellation(packet.eventId, actuation.lease, actuation.originalLease)) return result('checking-cancel');
      if (!record.preparationProof && !record.erasedControlProof) {
        if (!record.encryptedSourceBundle) return result('checking-cancel');
        const proof = await this.options.witness.prepare({ packet, packetSignature: record.packetSignature,
          controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),
          encryptedSourceBundle: record.encryptedSourceBundle, ...actuation });
        await this.options.source.attachPreparation(packet.eventId, proof);
      }
      const operation = await this.options.witness.operation(packet.idempotencyKey);
      if (operation.certificate) return result('commit-won');
      // A verified erasure is already the terminal negative decision. An
      // erased-control proof never claims source Saved and must not prepare
      // deleted bytes or manufacture a second witness cancellation.
      const decision = operation.cancellation ?? operation.erasure;
      let own;
      if (decision && !operation.cancellation) {
        await this.options.source.applyErasure(operation.erasure!,
          this.options.source.erasureAuthorities.has(operation.erasure!) ? undefined : await this.options.witness.erasureAuthority(operation.erasure!));
        own = this.options.source.cancellationReceipt(packet.eventId);
      } else {
        const cancellation = operation.cancellation ?? await this.options.witness.cancel(packet.idempotencyKey,
          actuation.lease, actuation.originalLease, signCancellation(actuation.lease));
        own = await this.options.source.attachCancellation(packet.eventId, cancellation);
      }
      record = this.options.source.repairRecord(packet.eventId)!;
      const membership = this.options.source.effectiveContext(packet.eventId).membership;
      const receipts = [own];
      for (const member of membership.members) {
        if (member.machineId === this.options.machineId) continue;
        try {
          const peer = this.options.member(member.machineId); if (!peer) throw new Error('missing-member');
          const receipt = await peer.receiveSource(record);
          if (receipt.machineId !== member.machineId) throw new Error('wrong-member');
          receipts.push(receipt);
        } catch { waiting.add(member.machineId); }
      }
      if (waiting.size) return result('cancel-pending', [...waiting]);
      const certificate = operation.cancellationCertificate ?? await this.options.witness.certifyCancellation({ packet,
        ...this.options.actuation() }, record.authorizationProof.membership, receipts);
      const localFinal = await this.options.source.attachCancellationCertificate(packet.eventId, certificate);
      await this.options.source.recordCertificateReceipt(packet.eventId, localFinal);
      await this.options.witness.acknowledgeCertificate(packet.idempotencyKey, localFinal);
      for (const member of membership.members) {
        if (member.machineId === this.options.machineId) continue;
        try {
          const peer = this.options.member(member.machineId); if (!peer?.persistCancellationCertificate) throw new Error('missing-member');
          const receipt = await peer.persistCancellationCertificate(record, certificate);
          if (receipt.machineId !== member.machineId) throw new Error('wrong-member');
          await this.options.source.recordCertificateReceipt(packet.eventId, receipt);
          await this.options.witness.acknowledgeCertificate(packet.idempotencyKey, receipt);
        } catch { waiting.add(member.machineId); }
      }
      if (waiting.size) return result('cancel-pending', [...waiting]);
      const complete = this.options.source.repairRecord(packet.eventId)!;
      await this.options.source.recordCommitProofDeliveryReceipt(packet.eventId,
        this.options.source.commitProofDeliveryReceipt(packet.eventId));
      for (const member of membership.members) {
        if (member.machineId === this.options.machineId) continue;
        try {
          const peer = this.options.member(member.machineId); if (!peer) throw new Error('missing-member');
          const receipt = await peer.persistCommitProof(complete);
          if (receipt.machineId !== member.machineId) throw new Error('wrong-member');
          await this.options.source.recordCommitProofDeliveryReceipt(packet.eventId, receipt);
        } catch { waiting.add(member.machineId); }
      }
      if(this.options.source.allCommitProofDelivered(packet.eventId))for(const machine of await this.publishDeliveryCompletion(this.options.source.repairRecord(packet.eventId)!))waiting.add(machine);
      return this.options.source.allDeliveryCompletionPersisted(packet.eventId) ? result('canceled') : result('cancel-pending', [...waiting]);
    } catch { return result('checking-cancel', [...waiting]); }
  }

  private async commit(record: ConversationGraphReplicationRecord): Promise<GraphCommitOutcome> {
    const packet = record.packet;
    const outcome = (state: GraphCommitOutcome['state'], phase: GraphCommitOutcome['phase'],
      waitingMachineIds: string[] = [], reason?: GraphCommitOutcome['reason']): GraphCommitOutcome => {
      if(state==='saved-pending'){
        const context=this.options.source.effectiveContext(packet.eventId);
        if(!hasSeparateGraphPendingCopy(this.options.source.lookupByIdempotencyKey(packet.idempotencyKey)??record,
          {membership:context.membership,leaseEpoch:context.lease.leaseEpoch}))state='recorded-local';
      }
      return {state,phase,idempotencyKey:packet.idempotencyKey,eventId:packet.eventId,waitingMachineIds,...(reason?{reason}:{})};
    };
    const known = this.options.source.lookupByIdempotencyKey(packet.idempotencyKey);
    if (known && canonicalHash(known.packet) === canonicalHash(packet)
        && known.packetSignature === record.packetSignature
        && this.options.source.status(packet.eventId).state === 'committed'
        && this.options.source.allDeliveryCompletionPersisted(packet.eventId)) {
      // This is a historical outcome lookup, not a new write. A witness outage
      // or a writer transfer cannot undo a locally verified final certificate.
      return outcome('committed', 'committed');
    }
    if(known&&canonicalHash(known.packet)===canonicalHash(packet)&&known.packetSignature===record.packetSignature&&this.options.source.status(packet.eventId).state==='committed'&&this.options.source.allCommitProofDelivered(packet.eventId)){const waiting=await this.publishDeliveryCompletion(known);return waiting.length?outcome('saved-pending','certified',waiting,'waiting-members'):outcome('committed','committed');}
    if (known) {
      if (canonicalHash(known.packet) !== canonicalHash(packet) || known.packetSignature !== record.packetSignature) {
        return outcome('checking-save', 'local', [], 'recovery-required');
      }
      record = known;
    }
    const actuator = record.adoption?.disposition === 'adopted' ? record.adoption.currentLease.writerId : packet.writerId;
    if (actuator !== this.options.machineId || !record.encryptedSourceBundle) {
      return outcome('checking-save', 'local', [], 'recovery-required');
    }
    let localReceipt: GraphMemberReceipt;
    let actuation: ReturnType<ConversationGraphCommitOptions['actuation']>;
    try {
      actuation = this.options.actuation();
      const prior = this.options.source.lookupByIdempotencyKey(packet.idempotencyKey);
      if (prior) {
        if (canonicalHash(prior.packet) !== canonicalHash(packet) || prior.packetSignature !== record.packetSignature
            || !this.options.source.mayContinue(packet.eventId, actuation.lease, actuation.originalLease)) {
          return outcome('checking-save', 'local', [], 'recovery-required');
        }
        record = prior;
        localReceipt = await this.options.source.receive(prior, prior.packet.writerId);
      } else {
        const appended = await this.options.source.appendLocal(record);
        localReceipt = appended.receipt;
        if (!appended.stillAdmitted) return outcome('checking-save', 'local', [], 'write-refused');
      }
    } catch {
      // An exception may follow the durable append. Never turn an uncertain
      // transport/fsync boundary into a definitive refusal to save.
      return outcome('checking-save', 'local', [], 'save-outcome-unknown');
    }
    if (!record.encryptedSourceBundle) return outcome('refused', 'local', [], 'recovery-required');
    const request = { packet, packetSignature: record.packetSignature,
      controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),
      encryptedSourceBundle: record.encryptedSourceBundle, ...actuation };
    try {
      // Only the client's verified, exact packet-bound signed prepare proof
      // crosses the Saved threshold. Transport acceptance is insufficient.
      // Adopted operations already crossed the witness threshold under their
      // original packet. Re-preparing under the new lease would rewrite that
      // history. Read the verified witness operation and require this adoption.
      const operation = record.adoption ? await this.options.witness.operation(packet.idempotencyKey) : null;
      if (operation && (canonicalHash(operation.packet) !== canonicalHash(packet)
          || canonicalHash(operation.adoption) !== canonicalHash(record.adoption))) throw new Error('adoption-witness-mismatch');
      const preparation = operation?.prepareProof ?? await this.options.witness.prepare(request);
      await this.options.source.attachPreparation(packet.eventId, preparation);
    } catch { return outcome('checking-save', 'local', [], 'save-outcome-unknown'); }
    const membership = this.options.source.effectiveContext(packet.eventId).membership;
    const sourceReceipts = new Map<string, GraphMemberReceipt>([[this.options.machineId, localReceipt]]);
    const waiting = new Set<string>();
    await Promise.all(membership.members.filter((m) => m.machineId !== this.options.machineId).map(async (m) => {
      const member = this.options.member(m.machineId);
      if (!member || member.machineId !== m.machineId) { waiting.add(m.machineId); return; }
      try {
        const receipt = await member.receiveSource(record);
        if (receipt.machineId !== m.machineId) throw new Error('wrong-member-receipt');
        sourceReceipts.set(m.machineId, receipt);
      } catch { waiting.add(m.machineId); }
    }));
    if (waiting.size) return outcome('saved-pending', 'witnessed', [...waiting].sort(), 'waiting-members');
    let certificate: GraphCommitCertificate;
    try {
      // Refresh current actuation before any commit. Immutable original
      // authorization and payload hashes are never rewritten by a lease renew.
      Object.assign(request, this.options.actuation());
      if (this.options.source.isErased(packet.erasureIdentity)
        || !this.options.source.mayContinue(packet.eventId,request.lease,request.originalLease)) {
        return outcome('saved-pending','witnessed',[],'write-refused');
      }
      certificate = await this.options.witness.commit(request, record.authorizationProof.membership, [...sourceReceipts.values()]);
    } catch { return outcome('saved-pending', 'witnessed', [], 'witness-unavailable'); }
    try {
      const localFinal = await this.options.source.attachCertificate(packet.eventId, certificate);
      await this.options.source.recordCertificateReceipt(packet.eventId, localFinal);
      await this.options.witness.acknowledgeCertificate(packet.idempotencyKey, localFinal);
    } catch { return outcome('saved-pending', 'certified', [this.options.machineId], 'waiting-members'); }
    await Promise.all(membership.members.filter((m) => m.machineId !== this.options.machineId).map(async (m) => {
      const member = this.options.member(m.machineId);
      if (!member || member.machineId !== m.machineId) { waiting.add(m.machineId); return; }
      try {
        const receipt = await member.persistCertificate(record, certificate);
        if (receipt.machineId !== m.machineId) throw new Error('wrong-member-receipt');
        // The local source checks the member signature, exact certificate hash,
        // original packet and signed membership before persisting this proof.
        await this.options.source.recordCertificateReceipt(packet.eventId, receipt);
        await this.options.witness.acknowledgeCertificate(packet.idempotencyKey, receipt);
      } catch { waiting.add(m.machineId); }
    }));
    if (waiting.size) return outcome('saved-pending', 'certified', [...waiting].sort(), 'waiting-members');
    const complete = this.options.source.repairRecord(packet.eventId);
    if (!complete || complete.certificatePersistenceReceipts?.length !== membership.members.length
        || complete.certificate?.coreHash !== packet.coreHash
        || canonicalHash(complete.certificate) !== canonicalHash(certificate)) {
      return outcome('saved-pending', 'certified', [], 'recovery-required');
    }
    // Every machine must be able to reconstruct the SAME accepted state after
    // losing both writer and witness. Deliver proof, not a bare committed flag.
    try {
      await this.options.source.recordCommitProofDeliveryReceipt(packet.eventId,
        this.options.source.commitProofDeliveryReceipt(packet.eventId));
    } catch { return outcome('saved-pending', 'certified', [this.options.machineId], 'waiting-members'); }
    await Promise.all(membership.members.filter((m) => m.machineId !== this.options.machineId).map(async (m) => {
      const member = this.options.member(m.machineId);
      if (!member) { waiting.add(m.machineId); return; }
      try {
        const receipt = await member.persistCommitProof(complete);
        if (receipt.machineId !== m.machineId || !this.options.source.verifyCommitProofDeliveryReceipt(receipt, complete)) {
          throw new Error('commit-proof-delivery-unverified');
        }
        await this.options.source.recordCommitProofDeliveryReceipt(packet.eventId, receipt);
      }
      catch { waiting.add(m.machineId); }
    }));
    if (waiting.size) return outcome('saved-pending', 'certified', [...waiting].sort(), 'waiting-members');
    for(const machine of await this.publishDeliveryCompletion(this.options.source.repairRecord(packet.eventId)!))waiting.add(machine);
    if(waiting.size)return outcome('saved-pending','certified',[...waiting].sort(),'waiting-members');
    try {
      if (!this.options.source.mayAcknowledgeNewWrite(packet.eventId, this.options.actuation())) return outcome('saved-pending', 'certified', [], 'write-refused');
    } catch { return outcome('saved-pending', 'certified', [], 'write-refused'); }
    return outcome('committed', 'committed');
  }
  private async publishDeliveryCompletion(record:ConversationGraphReplicationRecord):Promise<string[]>{
    const waiting=new Set<string>(),membership=this.options.source.effectiveContext(record.packet.eventId).membership;
    try{const own=await this.options.source.durableDeliveryCompletionReceipt(record.packet.eventId);await this.options.source.recordDeliveryCompletionReceipt(record.packet.eventId,own);}catch{waiting.add(this.options.machineId);return [...waiting];}
    for(const member of membership.members){if(member.machineId===this.options.machineId)continue;
      try{const peer=this.options.member(member.machineId);if(!peer?.persistDeliveryCompletion)throw new Error('peer-completion-upgrade-required');const receipt=await peer.persistDeliveryCompletion(record);if(receipt.machineId!==member.machineId||!this.options.source.verifyDeliveryCompletionReceipt(receipt,record))throw new Error('completion-receipt-unverified');await this.options.source.recordDeliveryCompletionReceipt(record.packet.eventId,receipt);}
      catch{waiting.add(member.machineId);}
    }return [...waiting].sort();
  }

}
