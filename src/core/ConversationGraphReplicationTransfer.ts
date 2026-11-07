import {GraphNativeMemberLossProgress} from './GraphNativeMemberLossStore.js';
import {verifyGraphOwnerMemberLossConsent,type GraphOwnerMemberLossConsent} from './GraphOwnerMemberLoss.js';
import type {LeaseCoordinator} from './LeaseCoordinator.js';
import type {ConversationGraphNativeTailFloor} from './ConversationGraphNativeTail.js';
import {GraphPreparedTransferEnvelopes,type PrepareHeldRewrapOptions} from './GraphPreparedTransferEnvelopes.js';
import {GraphOwnedSourceStreamReceiverV2} from './GraphOwnedSourceStreamReceiverV2.js';
import {GraphMemberLossNegativeTransferPermit,type GraphMemberLossNegativeTransferEvidence} from './GraphMemberLossNegativeTransfer.js';
import {GraphRecoverySourceManifestAccumulator,buildGraphRecoverySourceManifest} from './ConversationGraphRecoveryManifest.js';
export {GraphRecoverySourceManifestAccumulator,buildGraphRecoverySourceManifest,graphRecoverySourceManifestEntry} from './ConversationGraphRecoveryManifest.js';
import {ConversationGraphLocalErasureFence} from './ConversationGraphLocalErasure.js';
import {realpathSync} from 'node:fs';
import {GraphCustodyProfileAuthority} from './GraphCustodyProfileAuthority.js';
import {assertGraphLocalPath} from './GraphLocalFiles.js';
import {graphTransferContextCapacityBytes} from './ConversationGraphContextCapacity.js';
import {ConversationGraphTransferCustody,type GraphTransferStageMetadata,type GraphTransferCustodyReader} from './ConversationGraphTransferCustody.js';
export type {GraphTransferStageMetadata} from './ConversationGraphTransferCustody.js';
import {ConversationGraphMaterializationContexts,GRAPH_CONTEXT_MAX_BYTES,validateGraphMaterializationReference,splitGraphMaterialization} from './ConversationGraphMaterializationContexts.js';
/** Owner-authorized membership transfer staging. Staged bytes never enter the
 * canonical graph and never produce a phase:source receipt before activation.
 * Spec: conversation-effort-hierarchy-v3 §7.2 installed membership recovery. */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {SafeFsExecutor} from './SafeFsExecutor.js';
import type {LeaseRecord} from './types.js';
import {ConversationGraphReplication,GraphHeldSenderStage,GraphHeldSourceReader,type GraphHeldSourceContext, type ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
import {decodeGraphSourceRecoveryEnvelope} from './ConversationGraphSourceRecovery.js';
import {verifyGraphSourceEnvelopeControl} from './ConversationGraphSourceEnvelope.js';
import {openRewrappedGraphBundle} from './GraphWitnessCrypto.js';
import {validateGraphApplicationSource} from './ConversationGraphOperation.js';
import {sameGraphErasureIdentity,type GraphErasureIdentity,erasureCoversPacket,canonicalHash,canonicalJson,opaque,GRAPH_SIGNATURE_DOMAINS,signGraphRecord,verifyRecoveryAuthorization,
  validateRecoverySourceManifest,canonicalGraphRewrapInventory,graphRewrapInventoryHash,verifyFencedLeaseBridge,verifyPendingRevalidation,verifyBundleRewrap,verifyMemberReceipt,verifyMembershipTransferReceipt,
  type GraphMembershipActivationCertificate,verifyMembershipActivation,type GraphMembershipEpoch,type GraphRecoveryAuthorization,type GraphRecoverySourceManifest,type GraphWitnessLease,
  verifyWitnessErasure,type GraphWitnessErasure,type GraphPendingRevalidation,type GraphBundleRewrap,type GraphMembershipTransferReceipt} from './GraphWitnessTypes.js';

export interface GraphSourceTransferStage {
  authorization: GraphRecoveryAuthorization;
  previousMembership: GraphMembershipEpoch;
  newMembership: GraphMembershipEpoch;
  currentLease: GraphWitnessLease;
  originalCurrentLease: LeaseRecord;
  manifest: GraphRecoverySourceManifest;
  records: ConversationGraphReplicationRecord[];
  revalidations: GraphPendingRevalidation[];
  /** New envelopes for every still-live bundle, including certified history. */
  rewraps: Array<{eventId:string;rewrap:GraphBundleRewrap}>;
}


export function buildGraphTransferRewrapInventory(records:ConversationGraphReplicationRecord[],rewraps:Array<{eventId:string;rewrap:GraphBundleRewrap}>){
 const known=new Set(records.map(record=>record.packet.eventId));const byId=new Map<string,GraphBundleRewrap>();
 for(const row of rewraps){if(!known.has(row.eventId)||byId.has(row.eventId))throw new Error('graph-transfer-invalid-rewrap-inventory');byId.set(row.eventId,row.rewrap);}
 return canonicalGraphRewrapInventory(records.map(record=>({eventId:record.packet.eventId,rewrapHash:canonicalHash(byId.get(record.packet.eventId)??null)})));
}

export class ConversationGraphReplicationTransfer {
  private queue:Promise<unknown>=Promise.resolve();
  private custodyAuthority:GraphCustodyProfileAuthority|null=null;
  private readonly contexts:ConversationGraphMaterializationContexts;
  private readonly custody:ConversationGraphTransferCustody;
  private readonly pendingErased=new Set<string>();
  constructor(private readonly options:{directory:string;machineId:string;diskQuotaBytes?:number;contextBudgetBytes?:number;localErasure?:{isDenied(target:GraphErasureIdentity):boolean};memberPrivateKey:crypto.KeyLike;memberSealingPrivateKey:crypto.KeyLike;
    heldSourceRecovery?:{coordinator:LeaseCoordinator;nativeFloor:ConversationGraphNativeTailFloor};ownerPublicKey:crypto.KeyLike;verification:ConversationGraphReplication;witnessPublicKeys?:ReadonlyMap<string,crypto.KeyLike>;now?:()=>Date}){this.contexts=new ConversationGraphMaterializationContexts(path.join(options.directory,'contexts'));this.custody=new ConversationGraphTransferCustody(options.directory,this.contexts,options.diskQuotaBytes??32*1024*1024,{ownerPublicKey:options.ownerPublicKey,agentId:options.verification.agentId,verification:options.verification,witnessPublicKeys:options.witnessPublicKeys,heldSourceRecovery:options.heldSourceRecovery,denied:target=>!!options.localErasure?.isDenied(target)||options.verification.isErased(target)||this.pendingErased.has(canonicalHash(target))});}

  private assertCurrentLossActivation(activation:GraphMembershipActivationCertificate):void{if(!activation.memberLoss)return;if(!this.custodyAuthority)throw new Error('graph-transfer-current-loss-authority-required');this.custodyAuthority.assertCurrentMemberLossActivation(activation);}
  private verify(stage:GraphSourceTransferStage,retainedInventory?:Array<{eventId:string;rewrapHash:string}>,negativePermit?:GraphMemberLossNegativeTransferPermit):void {
    const {authorization:a,previousMembership:previous,newMembership:next,currentLease:lease}=stage;
    const rebuilt=buildGraphRecoverySourceManifest(stage.records,previous);
    if(retainedInventory)for(const record of stage.records)if(record.erasure){
      if(!this.options.verification.verifyHistoricalRecord(record))throw new Error('graph-transfer-untrusted-erasure');
      const current=rebuilt.entries.find(row=>row.eventId===record.packet.eventId),original=stage.manifest.entries.find(row=>row.eventId===record.packet.eventId);
      if(!current||!original)throw new Error('graph-transfer-missing-original-entry');current.erasureHash=original.erasureHash;current.rewrapHash=original.rewrapHash;
    }
    const inventory=retainedInventory??buildGraphTransferRewrapInventory(stage.records,stage.rewraps);
    if(retainedInventory){const actual=new Map(buildGraphTransferRewrapInventory(stage.records,stage.rewraps).map(row=>[row.eventId,row.rewrapHash]));
      for(const record of stage.records)if(!record.erasure&&inventory.find(row=>row.eventId===record.packet.eventId)?.rewrapHash!==actual.get(record.packet.eventId))throw new Error('graph-transfer-envelope-inventory-mismatch');}

    if(Object.keys(stage).sort().join(',')!=='authorization,currentLease,manifest,newMembership,originalCurrentLease,previousMembership,records,revalidations,rewraps')throw new Error('graph-transfer-unknown-fields');
    for(const row of stage.rewraps)if(Object.keys(row).sort().join(',')!=='eventId,rewrap')throw new Error('graph-transfer-unknown-envelope-fields');
    if(!verifyRecoveryAuthorization(a,previous,next,this.options.ownerPublicKey)
      ||!next.members.some(member=>member.machineId===this.options.machineId)
      ||!verifyFencedLeaseBridge(lease,stage.originalCurrentLease,next)||lease.leaseEpoch!==a.fenceEpoch
      ||graphRewrapInventoryHash(inventory)!==a.rewrapInventoryHash
      ||canonicalHash(stage.manifest)!==a.sourceManifestHash
      ||canonicalHash(rebuilt)!==a.sourceManifestHash
      ||stage.manifest.highestCertifiedSequence!==a.highestCertifiedSequence||stage.manifest.highestCertifiedCoreHash!==a.highestCertifiedCoreHash
      ||stage.records.length>20000)throw new Error('graph-transfer-invalid-owner-manifest');
    const revalidations=new Map(stage.revalidations.map(proof=>[proof.idempotencyKey,proof]));
    const rewraps=new Map(stage.rewraps.map(row=>[row.eventId,row.rewrap]));
    if(revalidations.size!==stage.revalidations.length||rewraps.size!==stage.rewraps.length)throw new Error('graph-transfer-duplicate-inventory');
    for(const record of stage.records)this.verifyRecord(stage,record,rewraps.get(record.packet.eventId),revalidations.get(record.packet.idempotencyKey),retainedInventory,negativePermit);
    for(const outcome of a.pendingOutcomes)if(!stage.records.some(record=>record.packet.idempotencyKey===outcome.idempotencyKey))throw new Error('graph-transfer-missing-pending-source');
    for(const proof of stage.revalidations)if(!a.pendingOutcomes.some(outcome=>outcome.idempotencyKey===proof.idempotencyKey)||!verifyPendingRevalidation(proof,stage.records.find(record=>record.packet.idempotencyKey===proof.idempotencyKey)!.packet,next,lease))throw new Error('graph-transfer-extraneous-revalidation');
    for(const row of stage.rewraps)if(!stage.records.some(record=>record.packet.eventId===row.eventId))throw new Error('graph-transfer-extraneous-envelope');
  }

  private verifyRecord(stage:GraphTransferStageMetadata,record:ConversationGraphReplicationRecord,rewrap:GraphBundleRewrap|undefined,proof:GraphPendingRevalidation|undefined,retainedInventory?:Array<{eventId:string;rewrapHash:string}>,negativePermit?:GraphMemberLossNegativeTransferPermit,senderStage?:GraphHeldSenderStage):void{
    const a=stage.authorization,next=stage.newMembership,lease=stage.currentLease;
    if(negativePermit&&(senderStage?negativePermit.allowsForSenderStage(senderStage,record,{...stage,rewraps:rewrap?[{eventId:record.packet.eventId}]:[]}):negativePermit.allows(record,{...stage,rewraps:rewrap?[{eventId:record.packet.eventId}]:[]})))return;
      if(!this.options.verification.verifyHistoricalRecord(record))throw new Error('graph-transfer-untrusted-source');
      const outcome=a.pendingOutcomes.find(row=>row.idempotencyKey===record.packet.idempotencyKey);
      const terminal=record.certificate??record.cancellationCertificate;
      if(!terminal){
        const {packet,packetSignature,core,authorizationProof}=record;
        if(!outcome||!proof||!verifyPendingRevalidation(proof,packet,next,lease)
          ||outcome.operationHash!==canonicalHash(packet)||outcome.revalidationHash!==canonicalHash(proof)||outcome.decision!==proof.decision
          ||proof.sourceProofHash!==canonicalHash({coreType:record.coreType,packet,packetSignature,core,authorizationProof})
          ||proof.rewrapHash!==(record.erasure&&retainedInventory?retainedInventory.find(row=>row.eventId===record.packet.eventId)?.rewrapHash:canonicalHash(rewrap??null)))throw new Error('graph-transfer-invalid-pending-revalidation');
      }
      if(!record.encryptedSourceBundle&&!record.erasure&&!record.cancellation&&record.adoption?.disposition!=='refused')throw new Error('graph-transfer-live-source-missing');
      const refused=proof?.decision==='refuse'||record.adoption?.disposition==='refused';
      if(refused&&rewrap)throw new Error('graph-transfer-refused-rewrap-not-null');
      if(record.encryptedSourceBundle&&!refused){
        if(!rewrap||rewrap.writerId!==lease.writerId||!verifyBundleRewrap(rewrap,record.encryptedSourceBundle,next))throw new Error('graph-transfer-missing-new-envelope');
        const plaintext=openRewrappedGraphBundle(record.encryptedSourceBundle,rewrap,this.options.machineId,this.options.memberSealingPrivateKey,next,
          {agentId:record.packet.agentId,eventId:record.packet.eventId});
        try{const recovered=decodeGraphSourceRecoveryEnvelope({packet:record.packet,packetSignature:record.packetSignature,plaintextEnvelope:plaintext,ownerPublicKey:this.options.ownerPublicKey});try{if(!verifyGraphSourceEnvelopeControl(recovered,record)||!validateGraphApplicationSource(record.coreType,record.core,record.authorizationProof,recovered.applicationSource))throw new Error('graph-transfer-envelope-control-or-application-mismatch');}finally{recovered.applicationSource.fill(0);}}finally{plaintext.fill(0);}
      }else if(!record.encryptedSourceBundle&&!record.erasure&&record.adoption?.disposition!=='refused')throw new Error('graph-transfer-unproved-missing-source');
  }

  /** Fresh disk readback with one private record live at a time. This returns
   * validation metadata only; the signed receipt still follows local-knowledge
   * rechecks and the existing durability barriers in stageCore. */
  private async verifyStoredStream(reader:GraphTransferCustodyReader):Promise<string>{
    const negativePermit=this.custody.negativePermit(reader.key),stage=reader.metadata,a=stage.authorization,previous=stage.previousMembership,next=stage.newMembership,lease=stage.currentLease,inventory=canonicalGraphRewrapInventory(reader.inventory);
    if(Object.keys(stage).sort().join(',')!=='authorization,currentLease,manifest,newMembership,originalCurrentLease,previousMembership,revalidations'||!validateRecoverySourceManifest(stage.manifest)||!verifyRecoveryAuthorization(a,previous,next,this.options.ownerPublicKey)||!next.members.some(member=>member.machineId===this.options.machineId)||!verifyFencedLeaseBridge(lease,stage.originalCurrentLease,next)||lease.leaseEpoch!==a.fenceEpoch||reader.count!==stage.manifest.entries.length||graphRewrapInventoryHash(inventory)!==a.rewrapInventoryHash||canonicalHash(stage.manifest)!==a.sourceManifestHash||stage.manifest.highestCertifiedSequence!==a.highestCertifiedSequence||stage.manifest.highestCertifiedCoreHash!==a.highestCertifiedCoreHash)throw new Error('graph-transfer-invalid-owner-manifest');
    const limit=this.options.contextBudgetBytes??GRAPH_CONTEXT_MAX_BYTES;if(graphTransferContextCapacityBytes({previousMembership:previous,newMembership:next,authorization:a,manifest:stage.manifest,rewrapInventory:inventory,currentLease:lease,originalCurrentLease:stage.originalCurrentLease})>limit)throw new Error('graph-transfer-context-capacity');
    const proofs=new Map(stage.revalidations.map(proof=>[proof.idempotencyKey,proof]));if(proofs.size!==stage.revalidations.length)throw new Error('graph-transfer-duplicate-inventory');
    const manifest=new GraphRecoverySourceManifestAccumulator(previous,false),expectedEntries=new Map(stage.manifest.entries.map(entry=>[entry.eventId,entry])),recordHashes:Array<{sequence:number;id:string;hash:string}>=[],rewrapHashes:Array<{eventId:string;hash:string}>=[],seen=new Set<string>();
    for await(const {record,newRewrap}of reader.recordsInManifestOrder()){
      const denied=this.options.localErasure?.isDenied(record.packet.erasureIdentity)||this.options.verification.isErased(record.packet.erasureIdentity);if(denied&&(record.encryptedSourceBundle||record.rewrap||newRewrap||!record.erasure&&!record.cancellation&&!negativePermit?.allows(record,stage)))throw new Error('graph-transfer-source-locally-erased');
      const proof=proofs.get(record.packet.idempotencyKey);if(proof&&!verifyPendingRevalidation(proof,record.packet,next,lease))throw new Error('graph-transfer-extraneous-revalidation');this.verifyRecord(stage,record,newRewrap??undefined,proof,inventory,negativePermit);const entry=manifest.append(record),original=expectedEntries.get(entry.eventId);if(!original)throw new Error('graph-transfer-missing-original-entry');if(record.erasure){entry.erasureHash=original.erasureHash;entry.rewrapHash=original.rewrapHash;}if(canonicalHash(entry)!==canonicalHash(original))throw new Error('graph-transfer-invalid-owner-manifest');seen.add(record.packet.idempotencyKey);
      recordHashes.push({sequence:record.packet.sourceSequence,id:record.packet.eventId,hash:canonicalHash(this.options.verification.recordForTransport(record))});if(newRewrap)rewrapHashes.push({eventId:record.packet.eventId,hash:canonicalHash(newRewrap)});reader.releasePrivateViews();
    }
    const {entries:_rebuiltEntries,...rebuiltSummary}=manifest.finish(),{entries:_expectedEntries,...expectedSummary}=stage.manifest;
    if(canonicalHash(rebuiltSummary)!==canonicalHash(expectedSummary)||a.pendingOutcomes.some(outcome=>!seen.has(outcome.idempotencyKey))||stage.revalidations.some(proof=>!a.pendingOutcomes.some(outcome=>outcome.idempotencyKey===proof.idempotencyKey)))throw new Error('graph-transfer-invalid-owner-manifest');
    return canonicalHash({authorization:a,manifest:stage.manifest,records:recordHashes.sort((x,y)=>x.sequence-y.sequence||x.id.localeCompare(y.id)).map(row=>row.hash),rewraps:rewrapHashes.sort((x,y)=>x.eventId.localeCompare(y.eventId))});
  }
  private stageDigest(stage:GraphSourceTransferStage):string{return canonicalHash({authorization:stage.authorization,manifest:stage.manifest,records:[...stage.records].sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence||a.packet.eventId.localeCompare(b.packet.eventId)).map(record=>canonicalHash(this.options.verification.recordForTransport(record))),rewraps:[...stage.rewraps].sort((a,b)=>a.eventId.localeCompare(b.eventId)).map(row=>({eventId:row.eventId,hash:canonicalHash(row.rewrap)}))});}

  /** Owner consent to move custody cannot roll back facts this recipient has
   * already durably accepted. Check again after disk staging before its ACK. */
  private async assertRetainsLocalKnowledge(stage:GraphSourceTransferStage,negativePermit?:GraphMemberLossNegativeTransferPermit):Promise<void>{
    const incoming=new Map(stage.records.map(record=>[record.packet.eventId,record]));
    const known=[...this.options.verification.recordsForRepair(),...await this.options.verification.controlIntents()];
    for(const local of known){
      if(!negativePermit?.allows(local,stage)&&!this.options.verification.verifyHistoricalRecord(local))throw new Error('graph-transfer-local-source-untrusted');
      const next=incoming.get(local.packet.eventId);
      if(!next||canonicalHash(next.packet)!==canonicalHash(local.packet)||next.packetSignature!==local.packetSignature)throw new Error('graph-transfer-local-history-omitted');
      for(const field of ['certificate','cancellationCertificate','cancellation','preparationProof','erasedControlProof'] as const){
        if(local[field]&&canonicalHash(local[field])!==canonicalHash(next[field]??null))throw new Error('graph-transfer-local-proof-regressed');
      }
      for(const field of ['certificatePersistenceReceipts','commitProofDeliveryReceipts'] as const){
        for(const receipt of local[field]??[]){
          const retained=(next[field]??[]).some(candidate=>candidate.machineId===receipt.machineId&&candidate.certificateHash===receipt.certificateHash&&candidate.membershipEpoch===receipt.membershipEpoch&&candidate.leaseEpoch===receipt.leaseEpoch);
          if(!retained)throw new Error('graph-transfer-local-durability-regressed');
        }
      }
      // A different valid tombstone is not evidence that this already-known
      // immutable negative fact was transferred to the replacement ledger.
      if(local.erasure&&canonicalHash(local.erasure)!==canonicalHash(next.erasure??null))throw new Error('graph-transfer-local-erasure-omitted');
    }
  }

  /** Negative/pin custody scope only. This never unlocks positive writes. */
  assertLocalCustodyContext(context:{stateRoot:string;agentId:string;machineId:string;authority:GraphCustodyProfileAuthority}):void{
    if(!(context.authority instanceof GraphCustodyProfileAuthority)||!(this.options.verification instanceof ConversationGraphReplication))throw new Error('graph-transfer-actual-custody-context-required');
    const root=realpathSync(context.stateRoot),authority=context.authority;if(authority.stateRoot!==root||authority.agentId!==context.agentId||this.options.machineId!==context.machineId)throw new Error('graph-transfer-custody-scope-mismatch');
    if(!(this.options.localErasure instanceof ConversationGraphLocalErasureFence)||this.options.localErasure.stateRoot!==root)throw new Error('graph-transfer-custody-fence-scope-mismatch');
    const expected=path.join(root,'state','conversation-graph-transfer');let directory:string;try{directory=realpathSync(this.options.directory);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;directory=path.join(realpathSync(path.dirname(this.options.directory)),path.basename(this.options.directory));}if(directory!==expected)throw new Error('graph-transfer-custody-scope-mismatch');assertGraphLocalPath(root,expected);
    const publicKey=(key:crypto.KeyLike)=>key instanceof crypto.KeyObject&&key.type==='public'?key:crypto.createPublicKey(key),same=(a:crypto.KeyLike,b:crypto.KeyLike)=>publicKey(a).export({type:'spki',format:'der'}).equals(publicKey(b).export({type:'spki',format:'der'}));
    const lineage=authority.verifiedNegativeRoleLineage(),member=lineage.current.members.find(row=>row.machineId===context.machineId);if(!member||!same(this.options.ownerPublicKey,authority.ownerPublicKey)||!same(this.options.memberPrivateKey,member.signingPublicKey)||!same(this.options.memberSealingPrivateKey,member.sealingPublicKey))throw new Error('graph-transfer-custody-key-mismatch');
    this.options.verification.assertLocalCustodyContext(context);this.custodyAuthority=authority;this.custody.bindCustodyAuthority(context);
  }

  bindCustodyAuthority(authority:GraphCustodyProfileAuthority):void{this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:authority.agentId,machineId:this.options.machineId,authority});}
  storageCapacity():Promise<{quotaBytes:number;usedBytes:number;availableBytes:number}>{return this.serial(()=>this.custody.capacity());}

  /** Same authoritative v1 manifest/receipt, with one actual held original
   * and one verifiable envelope live at a time. The iterator supplies data;
   * actual Source capability + owner signatures remain the authority. */
  stageHeldSource(metadata:GraphTransferStageMetadata,source:GraphHeldSourceReader,context:{authority:GraphCustodyProfileAuthority;hold:GraphHeldSourceContext},envelopes:AsyncIterable<{eventId:string;rewrap:GraphBundleRewrap|null}>,negativeEvidence?:GraphMemberLossNegativeTransferEvidence):Promise<GraphMembershipTransferReceipt>{
    const frozen=structuredClone(metadata);return this.serial(async()=>{
      if(!(source instanceof GraphHeldSourceReader)||!(context.authority instanceof GraphCustodyProfileAuthority))throw new Error('graph-transfer-actual-held-reader-required');
      this.assertLocalCustodyContext({stateRoot:source.stateRoot,agentId:source.agentId,machineId:source.machineId,authority:context.authority});
      const hold=context.hold,a=frozen.authorization,next=frozen.newMembership,previous=frozen.previousMembership;
      const assertHeld=()=>{source.assertCurrent();if(hold.kind==='planned')context.authority.assertHeldIntent(hold.intent);else context.authority.assertMemberLossHeld(hold.intent);
        if((hold.kind==='planned'?canonicalHash(hold.intent.newMembership):hold.intent.payload.newMembershipHash)!==canonicalHash(next)||source.intentHash!==canonicalHash(hold.intent)||source.membershipHash!==canonicalHash(previous)||source.nativeLeaseHash!==canonicalHash(hold.lease)||source.agentId!==a.agentId||source.machineId!==this.options.machineId||canonicalHash(hold.originalLease)!==canonicalHash(frozen.originalCurrentLease)||hold.lease.writerId!==source.machineId||hold.lease.leaseEpoch!==frozen.currentLease.leaseEpoch||hold.lease.fencedLeaseHash!==frozen.currentLease.fencedLeaseHash)throw new Error('graph-transfer-held-scope-mismatch');};
      assertHeld();const capacity=await this.custody.capacity();if(capacity.usedBytes>capacity.quotaBytes)throw new Error('graph-stage-disk-quota');assertHeld();const descriptors=source.descriptors();if(Object.keys(frozen).sort().join(',')!=='authorization,currentLease,manifest,newMembership,originalCurrentLease,previousMembership,revalidations'||descriptors.length>20000||!Array.isArray(next.members)||next.members.length>64||!Array.isArray(frozen.revalidations)||frozen.revalidations.length>20000)throw new Error('graph-transfer-invalid-owner-manifest');
      // Hash values have fixed width: this computes exact structural context bytes, not authority.
      const contextBytes=graphTransferContextCapacityBytes({previousMembership:previous,newMembership:next,authorization:a,manifest:frozen.manifest,rewrapInventory:descriptors.map(row=>({eventId:row.eventId,rewrapHash:canonicalHash(null)})),currentLease:frozen.currentLease,originalCurrentLease:frozen.originalCurrentLease}),limit=this.options.contextBudgetBytes??GRAPH_CONTEXT_MAX_BYTES;if(!Number.isSafeInteger(limit)||limit<1024||limit>GRAPH_CONTEXT_MAX_BYTES||contextBytes>limit)throw new Error('graph-transfer-context-capacity');
      if(!validateRecoverySourceManifest(frozen.manifest)||!verifyRecoveryAuthorization(a,previous,next,this.options.ownerPublicKey)||!verifyFencedLeaseBridge(frozen.currentLease,frozen.originalCurrentLease,next)||!next.members.some(member=>member.machineId===this.options.machineId)||descriptors.length!==frozen.manifest.entries.length||canonicalHash(frozen.manifest)!==a.sourceManifestHash||a.fenceEpoch!==frozen.currentLease.leaseEpoch)throw new Error('graph-transfer-invalid-owner-manifest');
      const entries=new Map(frozen.manifest.entries.map(row=>[row.eventId,row]));for(const descriptor of descriptors)if(canonicalHash(entries.get(descriptor.eventId))!==canonicalHash(descriptor.manifestEntry))throw new Error('graph-transfer-held-manifest-mismatch');
      let negativePermit:GraphMemberLossNegativeTransferPermit|undefined;
      if(negativeEvidence){if(hold.kind!=='member-loss'||negativeEvidence.authority!==context.authority||!(this.options.localErasure instanceof ConversationGraphLocalErasureFence))throw new Error('graph-loss-negative-actual-evidence-required');const candidate=await GraphMemberLossNegativeTransferPermit.createFromHeldSource(frozen,source,negativeEvidence,this.options.verification,this.options.localErasure,this.options.memberPrivateKey);negativePermit=await this.custody.installNegativePermit(this.custody.key(frozen),candidate);assertHeld();}
      const proofs=new Map(frozen.revalidations.map(proof=>[proof.idempotencyKey,proof]));if(proofs.size!==frozen.revalidations.length)throw new Error('graph-transfer-duplicate-inventory');
      const envelopeIterator=envelopes[Symbol.asyncIterator](),verification=this.options.verification,transfer=this,recordHashes:Array<{sequence:number;id:string;hash:string}>=[],rewrapHashes:Array<{eventId:string;hash:string}>=[];
      async function* rows(){try{for(const descriptor of descriptors){assertHeld();const supplied=await envelopeIterator.next();if(supplied.done||supplied.value.eventId!==descriptor.eventId)throw new Error('graph-transfer-held-envelope-order');const record=await source.readRecord(descriptor.eventId),rewrap=supplied.value.rewrap;
          transfer.verifyRecord(frozen,record,rewrap??undefined,proofs.get(record.packet.idempotencyKey),undefined,negativePermit);if(canonicalHash(verification.recordForTransport(record))!==descriptor.recordTransportHash)throw new Error('graph-transfer-held-record-changed');recordHashes.push({sequence:record.packet.sourceSequence,id:record.packet.eventId,hash:descriptor.recordTransportHash});if(rewrap)rewrapHashes.push({eventId:record.packet.eventId,hash:canonicalHash(rewrap)});assertHeld();try{yield{record,newRewrap:rewrap};}finally{source.releasePrivateViews();}}
        if(!(await envelopeIterator.next()).done)throw new Error('graph-transfer-extraneous-envelope');source.finalize();}
        finally{if(envelopeIterator.return)await envelopeIterator.return();}}
      const key=await this.custody.persistStream(frozen,rows()),erasures=await this.erasureState(a.agentId),retained=await this.custody.openReader(key,erasures),digest=await this.verifyStoredStream(retained);
      const expected=canonicalHash({authorization:a,manifest:frozen.manifest,records:recordHashes.sort((x,y)=>x.sequence-y.sequence||x.id.localeCompare(y.id)).map(row=>row.hash),rewraps:rewrapHashes.sort((x,y)=>x.eventId.localeCompare(y.eventId))});if(digest!==expected)throw new Error('graph-transfer-reload-mismatch');
      await this.custody.syncRetained(key);const finalCapacity=await this.custody.capacity();if(finalCapacity.usedBytes>finalCapacity.quotaBytes)throw new Error('graph-stage-disk-quota');assertHeld();source.assertFinalized();
      const value={v:1 as const,agentId:a.agentId,recoveryId:a.recoveryId,newMembershipHash:canonicalHash(next),sourceManifestHash:a.sourceManifestHash,rewrapInventoryHash:a.rewrapInventoryHash,highestCertifiedSequence:a.highestCertifiedSequence,highestCertifiedCoreHash:a.highestCertifiedCoreHash,machineId:this.options.machineId,persistedAt:(this.options.now?.()??new Date()).toISOString()},receipt={...value,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.membershipTransfer,value,this.options.memberPrivateKey)};
      if(!verifyMembershipTransferReceipt(receipt,a,next))throw new Error('graph-transfer-member-signing-key-mismatch');source.assertCurrent();return receipt;
    });
  }

  stageMemberLossNegativeControls(stage:GraphSourceTransferStage,evidence:GraphMemberLossNegativeTransferEvidence):Promise<GraphMembershipTransferReceipt>{const retained=structuredClone(stage);return this.serial(async()=>{
    this.assertLocalCustodyContext({stateRoot:evidence.authority.stateRoot,agentId:evidence.authority.agentId,machineId:this.options.machineId,authority:evidence.authority});if(!(this.options.localErasure instanceof ConversationGraphLocalErasureFence))throw new Error('graph-loss-negative-actual-fence-required');
    const candidate=await GraphMemberLossNegativeTransferPermit.create(retained,evidence,this.options.verification,this.options.localErasure,this.options.memberPrivateKey),permit=await this.custody.installNegativePermit(this.custody.key(retained),candidate);const receipt=await this.stageCore(retained,permit);permit.assertCurrent();return receipt;
  });}
  private async restoreNegativePermit(stage:GraphSourceTransferStage):Promise<GraphMemberLossNegativeTransferPermit|undefined>{if(!this.custodyAuthority||!(this.options.localErasure instanceof ConversationGraphLocalErasureFence))return;this.assertLocalCustodyContext({stateRoot:this.custodyAuthority.stateRoot,agentId:this.custodyAuthority.agentId,machineId:this.options.machineId,authority:this.custodyAuthority});return this.custody.restoreNegativePermit(this.custody.key(stage),stage,this.custodyAuthority,this.options.localErasure);}
  stage(stage:GraphSourceTransferStage):Promise<GraphMembershipTransferReceipt>{return this.serial(()=>this.stageCore(stage));}
  private async stageCore(stage:GraphSourceTransferStage,negativePermit?:GraphMemberLossNegativeTransferPermit):Promise<GraphMembershipTransferReceipt>{
    if(!Array.isArray(stage.records)||stage.records.length>20000||!Array.isArray(stage.rewraps)||stage.rewraps.length>20000||!validateRecoverySourceManifest(stage.manifest)||!Array.isArray(stage.newMembership.members)||stage.newMembership.members.length>64||!Array.isArray(stage.authorization.pendingOutcomes)||stage.authorization.pendingOutcomes.length>20000)throw new Error('graph-transfer-invalid-owner-manifest');
    const limit=this.options.contextBudgetBytes??GRAPH_CONTEXT_MAX_BYTES;if(!Number.isSafeInteger(limit)||limit<1024||limit>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-transfer-context-budget-invalid');
    const bytes=graphTransferContextCapacityBytes({previousMembership:stage.previousMembership,newMembership:stage.newMembership,authorization:stage.authorization,manifest:stage.manifest,rewrapInventory:buildGraphTransferRewrapInventory(stage.records,stage.rewraps),currentLease:stage.currentLease,originalCurrentLease:stage.originalCurrentLease});
    if(bytes>limit)throw new Error('graph-transfer-context-capacity');
    const carriesKeys=(record:ConversationGraphReplicationRecord)=>!!(record.encryptedSourceBundle||record.rewrap||stage.rewraps.some(row=>row.eventId===record.packet.eventId))||!record.erasure&&!record.cancellation&&!negativePermit?.allows(record,stage);
    if(stage.records.some(record=>(this.options.localErasure?.isDenied(record.packet.erasureIdentity)||this.options.verification.isErased(record.packet.erasureIdentity))&&carriesKeys(record)))throw new Error('graph-transfer-source-locally-erased');
    const erased=await this.erasureState(stage.authorization.agentId);
    if(stage.records.some(record=>erased.some(proof=>erasureCoversPacket(proof,record.packet))&&carriesKeys(record)))throw new Error('graph-transfer-source-erased');
    this.verify(stage,undefined,negativePermit);
    await this.assertRetainsLocalKnowledge(stage,negativePermit);
    const key=await this.custody.persist(stage),reader=await this.custody.openReader(key,erased),digest=await this.verifyStoredStream(reader);
    if(digest!==this.stageDigest(stage))throw new Error('graph-transfer-reload-mismatch');
    if(stage.records.some(record=>(this.options.localErasure?.isDenied(record.packet.erasureIdentity)||this.options.verification.isErased(record.packet.erasureIdentity))&&carriesKeys(record)))throw new Error('graph-transfer-source-locally-erased');
    await this.assertRetainsLocalKnowledge(stage,negativePermit);
    await this.custody.syncRetained(key);negativePermit?.assertCurrent();
    const a=reader.metadata.authorization;const value={v:1 as const,agentId:a.agentId,recoveryId:a.recoveryId,newMembershipHash:canonicalHash(reader.metadata.newMembership),
      sourceManifestHash:a.sourceManifestHash,rewrapInventoryHash:a.rewrapInventoryHash,highestCertifiedSequence:a.highestCertifiedSequence,highestCertifiedCoreHash:a.highestCertifiedCoreHash,
      machineId:this.options.machineId,persistedAt:(this.options.now?.()??new Date()).toISOString()};
    const receipt={...value,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.membershipTransfer,value,this.options.memberPrivateKey)};
    if(!verifyMembershipTransferReceipt(receipt,a,reader.metadata.newMembership))throw new Error('graph-transfer-member-signing-key-mismatch');
    return receipt;
  }
  /** Actual Source-owned sender custody, one original/key at a time. The
   * private stage alone may read while its public Reader is mutation-held. */
  stagePromotedHeldSource(metadata:GraphTransferStageMetadata,stage:GraphHeldSenderStage,reader:GraphHeldSourceReader,authority:GraphCustodyProfileAuthority,negativeEvidence?:GraphMemberLossNegativeTransferEvidence):Promise<GraphMembershipTransferReceipt>{const frozen=structuredClone(metadata);return this.serial(async()=>{
    if(!(stage instanceof GraphHeldSenderStage)||!(reader instanceof GraphHeldSourceReader)||!(authority instanceof GraphCustodyProfileAuthority))throw new Error('graph-transfer-actual-sender-stage-required');this.assertLocalCustodyContext({stateRoot:reader.stateRoot,agentId:reader.agentId,machineId:reader.machineId,authority});stage.assertForSource(this.options.verification,reader,authority);stage.assertMetadata(frozen);const descriptors=reader.descriptors();if(canonicalHash(descriptors.map(row=>row.manifestEntry))!==canonicalHash(frozen.manifest.entries))throw new Error('graph-transfer-held-manifest-mismatch');
    let negativePermit:GraphMemberLossNegativeTransferPermit|undefined;if(negativeEvidence){if(negativeEvidence.authority!==authority||!(this.options.localErasure instanceof ConversationGraphLocalErasureFence))throw new Error('graph-loss-negative-actual-evidence-required');const candidate=await GraphMemberLossNegativeTransferPermit.createFromHeldSource(frozen,reader,negativeEvidence,this.options.verification,this.options.localErasure,this.options.memberPrivateKey);negativePermit=await this.custody.installNegativePermit(this.custody.key(frozen),candidate);stage.assertForSource(this.options.verification,reader,authority);}
    const proofs=new Map(frozen.revalidations.map(proof=>[proof.idempotencyKey,proof])),transfer=this;let final:Awaited<ReturnType<GraphHeldSenderStage['finalize']>>|undefined;
    async function* rows(){for(const descriptor of descriptors){stage.assertForSource(transfer.options.verification,reader,authority);const promoted=await stage.promotePreparedRow(descriptor.eventId);let value:Awaited<ReturnType<typeof promoted.readRecord>>|undefined;try{promoted.assertCurrent({source:transfer.options.verification,stageHash:stage.stageHash,eventId:descriptor.eventId,recordTransportHash:descriptor.recordTransportHash});value=await promoted.readRecord();transfer.verifyRecord(frozen,value.record,value.newRewrap??undefined,proofs.get(value.record.packet.idempotencyKey),undefined,negativePermit,stage);if(canonicalHash(transfer.options.verification.recordForTransport(value.record))!==descriptor.recordTransportHash)throw new Error('graph-transfer-held-record-changed');yield{record:value.record,newRewrap:value.newRewrap,heldOriginal:promoted,heldSenderStage:stage};}finally{try{value?.close();}finally{promoted.close();}}}final=await stage.finalize();final.assertCurrent();}
    let retained:GraphTransferCustodyReader|undefined,succeeded=false;try{const key=await this.custody.persistStream(frozen,rows());if(!final)throw new Error('graph-transfer-held-final-missing');final.assertCurrent();retained=await this.custody.openReader(key,await this.erasureState(frozen.authorization.agentId));await this.verifyStoredStream(retained);await this.custody.syncRetained(key);final.assertCurrent();stage.assertForSource(this.options.verification,reader,authority);const a=frozen.authorization,value={v:1 as const,agentId:a.agentId,recoveryId:a.recoveryId,newMembershipHash:canonicalHash(frozen.newMembership),sourceManifestHash:a.sourceManifestHash,rewrapInventoryHash:a.rewrapInventoryHash,highestCertifiedSequence:a.highestCertifiedSequence,highestCertifiedCoreHash:a.highestCertifiedCoreHash,machineId:this.options.machineId,persistedAt:(this.options.now?.()??new Date()).toISOString()},receipt={...value,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.membershipTransfer,value,this.options.memberPrivateKey)};if(!verifyMembershipTransferReceipt(receipt,a,frozen.newMembership))throw new Error('graph-transfer-member-signing-key-mismatch');final.assertCurrent();succeeded=true;return receipt;}finally{retained?.close();if(!succeeded){final?.close();stage.close();}}
  });}
  retainedMemberLossPreparation(recoveryId:string,authority:GraphCustodyProfileAuthority,consent:GraphOwnerMemberLossConsent,progress:GraphNativeMemberLossProgress):Promise<GraphTransferStageMetadata|null>{return this.serial(async()=>{
    if(!opaque(recoveryId)||!(authority instanceof GraphCustodyProfileAuthority)||!(progress instanceof GraphNativeMemberLossProgress)||progress.custodyAuthority!==authority||progress.stateRoot!==authority.stateRoot||progress.machineId!==this.options.machineId||progress.agentId!==authority.agentId||progress.consentHash!==canonicalHash(consent))throw new Error('graph-transfer-real-loss-preparation-scope-required');this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:authority.agentId,machineId:this.options.machineId,authority});progress.assertCurrent();const held=authority.verifiedNegativeRoleLineage().memberLossIntents.find(row=>canonicalHash(row.intent)===progress.intentHash);if(!held||!verifyGraphOwnerMemberLossConsent(consent,{ownerPublicKey:authority.ownerPublicKey,previousPublicationHash:authority.publicationHash,previousMembership:held.previousMembership,newMembership:held.newMembership,nativeIdentities:progress.nativeIdentities}))throw new Error('graph-transfer-loss-preparation-consent-invalid');authority.assertMemberLossHeld(held.intent);
    const metadata=await this.custody.retainedStageMetadata(canonicalHash({agentId:authority.agentId,recoveryId}));progress.assertCurrent();authority.assertMemberLossHeld(held.intent);if(metadata&&(metadata.authorization.recoveryId!==recoveryId||metadata.authorization.agentId!==authority.agentId||canonicalHash(metadata.previousMembership)!==progress.previousMembershipHash||canonicalHash(metadata.newMembership)!==progress.newMembershipHash||metadata.authorization.previousMembershipHash!==consent.payload.previousMembershipHash||metadata.authorization.newMembershipHash!==consent.payload.newMembershipHash))throw new Error('graph-transfer-loss-preparation-retained-mismatch');if(metadata){const expected=new Map(consent.payload.operations.map(op=>[op.eventId,op]));if(metadata.manifest.entries.length!==expected.size||metadata.manifest.entries.some(entry=>{const original=expected.get(entry.eventId);return !original||original.operationHash!==entry.operationHash||original.sourceSequence!==entry.sourceSequence||original.coreHash!==entry.coreHash||original.outcome==='pending'&&!metadata.authorization.pendingOutcomes.some(outcome=>outcome.idempotencyKey===entry.idempotencyKey&&outcome.operationHash===entry.operationHash&&outcome.decision==='refuse');})||metadata.authorization.pendingOutcomes.some(outcome=>outcome.decision!=='refuse'))throw new Error('graph-transfer-loss-preparation-original-cut-mismatch');}return metadata;
  });}
  prepareHeldRewrapInventory(options:PrepareHeldRewrapOptions):Promise<GraphPreparedTransferEnvelopes>{return this.serial(async()=>{this.assertLocalCustodyContext({stateRoot:options.context.authority.stateRoot,agentId:options.context.authority.agentId,machineId:this.options.machineId,authority:options.context.authority});return GraphPreparedTransferEnvelopes.create(options,this.options.verification,this.custody,this.options.memberPrivateKey);});}
  persistVerifiedSharedContext(proof:import('./ConversationGraphHistoricalMaterialization.js').GraphHistoricalMaterialization){return this.serial(()=>this.custody.persistVerifiedSharedContext(proof));}
  hydrateVerifiedSharedContext(reference:import('./ConversationGraphMaterializationContexts.js').GraphMaterializationContextReference){return this.custody.hydrateVerifiedSharedContext(reference);}
  /** Actual Core-held remote row capability, with the original member receipt. */
  stageOwnedSourceStreamV2(source:GraphOwnedSourceStreamReceiverV2,authority:GraphCustodyProfileAuthority):Promise<GraphMembershipTransferReceipt>{return this.serial(async()=>{
    if(!(source instanceof GraphOwnedSourceStreamReceiverV2)||!(authority instanceof GraphCustodyProfileAuthority)||source.stateRoot!==authority.stateRoot)throw new Error('graph-transfer-actual-stream-required');this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:authority.agentId,machineId:this.options.machineId,authority});source.assertCurrent();const metadata=source.metadata,key=await this.custody.persistStream(metadata,source.rows());source.assertFinalized();const reader=await this.custody.openReader(key,await this.erasureState(metadata.authorization.agentId));let heldFinal:Awaited<ReturnType<ConversationGraphTransferCustody['finalizeHeldSourceRows']>>=null;try{await this.verifyStoredStream(reader);heldFinal=await this.custody.finalizeHeldSourceRows(key);await this.custody.syncRetained(key);source.assertFinalized();heldFinal?.assertCurrent();const a=metadata.authorization,value={v:1 as const,agentId:a.agentId,recoveryId:a.recoveryId,newMembershipHash:canonicalHash(metadata.newMembership),sourceManifestHash:a.sourceManifestHash,rewrapInventoryHash:a.rewrapInventoryHash,highestCertifiedSequence:a.highestCertifiedSequence,highestCertifiedCoreHash:a.highestCertifiedCoreHash,machineId:this.options.machineId,persistedAt:(this.options.now?.()??new Date()).toISOString()},receipt={...value,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.membershipTransfer,value,this.options.memberPrivateKey)};if(!verifyMembershipTransferReceipt(receipt,a,metadata.newMembership))throw new Error('graph-transfer-member-signing-key-mismatch');source.assertFinalized();heldFinal?.assertCurrent();return receipt;}finally{heldFinal?.close();reader.close();}
  });}
  /** Mechanical access to an already-fsynced owner plan under the actual hold. */
  openPreparedHeldCustodyStage(metadata:GraphTransferStageMetadata,source:GraphHeldSourceReader,context:{authority:GraphCustodyProfileAuthority;hold:GraphHeldSourceContext}):Promise<GraphTransferCustodyReader>{return this.serial(async()=>{
    if(!(source instanceof GraphHeldSourceReader)||!(context.authority instanceof GraphCustodyProfileAuthority))throw new Error('graph-transfer-actual-held-reader-required');
    this.assertLocalCustodyContext({stateRoot:source.stateRoot,agentId:source.agentId,machineId:source.machineId,authority:context.authority});const hold=context.hold;
    const check=()=>{source.assertCurrent();if(hold.kind==='planned')context.authority.assertHeldIntent(hold.intent);else context.authority.assertMemberLossHeld(hold.intent);if(source.intentHash!==canonicalHash(hold.intent)||source.membershipHash!==canonicalHash(metadata.previousMembership)||source.nativeLeaseHash!==canonicalHash(hold.lease)||source.machineId!==this.options.machineId||canonicalHash(hold.originalLease)!==canonicalHash(metadata.originalCurrentLease))throw new Error('graph-transfer-held-scope-mismatch');};check();
    const reader=await this.custody.openReader(canonicalHash({agentId:metadata.authorization.agentId,recoveryId:metadata.authorization.recoveryId}),await this.erasureState(metadata.authorization.agentId));
    if(canonicalHash(reader.metadata)!==canonicalHash(metadata))throw new Error('graph-transfer-retained-plan-mismatch');await this.verifyStoredStream(reader);check();return reader;
  });}
  /** Read the original durable plan only after actual Core acceptance of its ACT.
   * This is metadata/private custody inspection, never positive permission. */
  openRetainedCustodyStage(activation:GraphMembershipActivationCertificate,authority:GraphCustodyProfileAuthority):Promise<GraphTransferCustodyReader>{return this.serial(async()=>{
    if(!(authority instanceof GraphCustodyProfileAuthority))throw new Error('graph-transfer-actual-core-required');
    this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:authority.agentId,machineId:this.options.machineId,authority});
    const assertAccepted=()=>{if(activation.memberLoss)authority.assertCurrentMemberLossActivation(activation);const lineage=authority.verifiedNegativeRoleLineage(),accepted=[...lineage.activations,...lineage.memberLossActivations].some(row=>canonicalHash(row.certificate)===canonicalHash(activation));
      const witness=activation.newMembership.custodyProfile?.witnessPublicKey;
      if(!accepted||!witness||!verifyMembershipActivation(activation,this.options.ownerPublicKey,witness)||activation.agentId!==authority.agentId)throw new Error('graph-transfer-retained-activation-unverified');};assertAccepted();
    const key=canonicalHash({agentId:activation.agentId,recoveryId:activation.ownerAuthorization.recoveryId}),erasures=await this.erasureState(activation.agentId),reader=await this.custody.openReader(key,erasures),metadata=reader.metadata;
    if(canonicalHash(metadata.authorization)!==canonicalHash(activation.ownerAuthorization)||canonicalHash(metadata.previousMembership)!==canonicalHash(activation.previousMembership)||canonicalHash(metadata.newMembership)!==canonicalHash(activation.newMembership))throw new Error('graph-transfer-retained-plan-mismatch');
    if(this.options.localErasure instanceof ConversationGraphLocalErasureFence)await this.custody.restoreNegativePermit(key,metadata,authority,this.options.localErasure);
    await this.verifyStoredStream(reader);await this.custody.syncRetained(key);assertAccepted();return reader;
  });}
  importTransferred(stage:GraphSourceTransferStage,activation:GraphMembershipActivationCertificate):Promise<{historicalEventIds:string[];pendingEventIds:string[]}>{return this.serial(async()=>{this.assertCurrentLossActivation(activation);
    const erasures=await this.erasureState(stage.authorization.agentId),negativePermit=await this.restoreNegativePermit(stage);
    if(!negativePermit&&!stage.records.some(record=>erasures.some(proof=>erasureCoversPacket(proof,record.packet))))await this.stageCore(stage);
    const reader=await this.custody.openReader(this.custody.key(stage),erasures);await this.verifyStoredStream(reader);const metadata=reader.metadata;
    const witness=this.options.witnessPublicKeys?.get(activation.witnessId);
    if(!witness||!verifyMembershipActivation(activation,this.options.ownerPublicKey,witness)
      ||canonicalHash(activation.ownerAuthorization)!==canonicalHash(metadata.authorization)||canonicalHash(activation.newMembership)!==canonicalHash(metadata.newMembership))throw new Error('graph-transfer-activation-invalid');
    const inventory=canonicalGraphRewrapInventory(reader.inventory);
    const historicalEventIds:string[]=[],pendingEventIds:string[]=[];
    for await(const {record,newRewrap}of reader.recordsInManifestOrder()){
      if(!record.certificate&&!record.cancellationCertificate){pendingEventIds.push(record.packet.eventId);continue;}
      const rewrapHash=inventory.find(row=>row.eventId===record.packet.eventId)!.rewrapHash;
      const materialization={activation,manifest:metadata.manifest,rewrapInventory:inventory,rewrapHash,currentLease:metadata.currentLease,originalCurrentLease:metadata.originalCurrentLease};
      const candidate={...record,materialization};delete candidate.rewrap;delete candidate.commitProofDeliveryReceipts;
      if(newRewrap&&!record.erasure)candidate.rewrap=newRewrap;
      if(record.adoption?.disposition==='refused'&&rewrapHash===canonicalHash(null))candidate.encryptedSourceBundle=null;
      this.assertCurrentLossActivation(activation);await this.options.verification.receiveHistorical(candidate);this.assertCurrentLossActivation(activation);historicalEventIds.push(record.packet.eventId);
    }this.assertCurrentLossActivation(activation);return {historicalEventIds,pendingEventIds};
  });}

  /** Same post-ACT proof using physical originals one row at a time. */
  postActivationTransferReceiptReader(input:GraphTransferCustodyReader,activation:GraphMembershipActivationCertificate,authority:GraphCustodyProfileAuthority):Promise<{receipt:GraphMembershipTransferReceipt;inventoryHash:string;historicalEventIds:string[];pendingEventIds:string[]}>{return this.serial(async()=>{
    this.custody.assertOwnReader(input);if(!(authority instanceof GraphCustodyProfileAuthority))throw new Error('graph-transfer-actual-core-required');this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:authority.agentId,machineId:this.options.machineId,authority});
    const assertAccepted=()=>{if(activation.memberLoss)authority.assertCurrentMemberLossActivation(activation);const lineage=authority.verifiedNegativeRoleLineage();if(![...lineage.activations,...lineage.memberLossActivations].some(row=>canonicalHash(row.certificate)===canonicalHash(activation)))throw new Error('graph-transfer-retained-activation-unverified');};assertAccepted();
    const reader=await this.custody.openReader(input.key,await this.erasureState(activation.agentId));try{const metadata=reader.metadata,key=reader.key;if(canonicalHash(metadata)!==canonicalHash(input.metadata)||canonicalHash(metadata.authorization)!==canonicalHash(activation.ownerAuthorization)||canonicalHash(metadata.newMembership)!==canonicalHash(activation.newMembership))throw new Error('graph-transfer-retained-plan-mismatch');
    const witness=this.options.witnessPublicKeys?.get(activation.witnessId);if(!witness||!verifyMembershipActivation(activation,this.options.ownerPublicKey,witness))throw new Error('graph-transfer-activation-invalid');if(this.options.localErasure instanceof ConversationGraphLocalErasureFence)await this.custody.restoreNegativePermit(key,metadata,authority,this.options.localErasure);await this.verifyStoredStream(reader);
    const inventory=canonicalGraphRewrapInventory(reader.inventory),hashes={activationHash:canonicalHash(activation),manifestHash:canonicalHash(metadata.manifest)},historicalEventIds:string[]=[],pendingEventIds:string[]=[],history:Array<{eventId:string;inventoryHash:string}>=[],rows:Array<{eventId:string;packetHash:string;sourceProofHash:string;terminalHash:string;erasureHash:string;bodyHash:string|null}>=[],rewraps:Array<{eventId:string;hash:string}>=[];
    for await(const {record,newRewrap}of reader.recordsInManifestOrder())try{
      if((this.options.localErasure?.isDenied(record.packet.erasureIdentity)||this.options.verification.isErased(record.packet.erasureIdentity))&&!record.erasure&&!this.custody.negativePermit(key)?.allows(record,metadata))throw new Error('graph-transfer-post-import-erasure-pending');
      if(record.certificate||record.cancellationCertificate){const rewrapHash=inventory.find(row=>row.eventId===record.packet.eventId)!.rewrapHash,materialization={activation,manifest:metadata.manifest,rewrapInventory:inventory,rewrapHash,currentLease:metadata.currentLease,originalCurrentLease:metadata.originalCurrentLease},candidate={...record,materialization};delete candidate.rewrap;delete candidate.commitProofDeliveryReceipts;if(newRewrap&&!record.erasure)candidate.rewrap=newRewrap;if(record.adoption?.disposition==='refused'&&rewrapHash===canonicalHash(null))candidate.encryptedSourceBundle=null;await this.options.verification.receiveHistorical(candidate);historicalEventIds.push(record.packet.eventId);history.push({eventId:record.packet.eventId,inventoryHash:await this.options.verification.verifyDurableHistoricalImport(record.packet.eventId,hashes.activationHash,hashes.manifestHash)});}else pendingEventIds.push(record.packet.eventId);
      rows.push({eventId:record.packet.eventId,packetHash:canonicalHash(record.packet),sourceProofHash:canonicalHash({coreType:record.coreType,packet:record.packet,packetSignature:record.packetSignature,core:record.core,authorizationProof:record.authorizationProof}),terminalHash:canonicalHash(record.certificate??record.cancellationCertificate??null),erasureHash:canonicalHash(record.erasure??null),bodyHash:record.encryptedSourceBundle?canonicalHash(record.encryptedSourceBundle):null});if(newRewrap)rewraps.push({eventId:record.packet.eventId,hash:canonicalHash(newRewrap)});
    }finally{reader.releasePrivateViews();}
    await this.custody.syncRetained(key);assertAccepted();const negativePermit=this.custody.negativePermit(key),inventoryHash=canonicalHash({v:1,activationHash:hashes.activationHash,manifestHash:hashes.manifestHash,rows,history,rewraps,...(negativePermit?{negativeControlProofHash:canonicalHash(negativePermit.proof)}:{})}),name=canonicalHash({key,activationHash:hashes.activationHash,inventoryHash,machineId:this.options.machineId})+'.post-import.json';let receipt=await this.custody.metadata(name) as GraphMembershipTransferReceipt|null;
    if(receipt){if(!verifyMembershipTransferReceipt(receipt,metadata.authorization,metadata.newMembership)||receipt.machineId!==this.options.machineId)throw new Error('graph-transfer-post-import-receipt-invalid');}else{const a=metadata.authorization,value={v:1 as const,agentId:a.agentId,recoveryId:a.recoveryId,newMembershipHash:canonicalHash(metadata.newMembership),sourceManifestHash:a.sourceManifestHash,rewrapInventoryHash:a.rewrapInventoryHash,highestCertifiedSequence:a.highestCertifiedSequence,highestCertifiedCoreHash:a.highestCertifiedCoreHash,machineId:this.options.machineId,persistedAt:(this.options.now?.()??new Date()).toISOString()};receipt={...value,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.membershipTransfer,value,this.options.memberPrivateKey)};if(!verifyMembershipTransferReceipt(receipt,a,metadata.newMembership))throw new Error('graph-transfer-member-signing-key-mismatch');await this.custody.persistMetadata(name,receipt);}
    for await(const {record}of reader.recordsInManifestOrder())try{if((this.options.localErasure?.isDenied(record.packet.erasureIdentity)||this.options.verification.isErased(record.packet.erasureIdentity))&&!record.erasure&&!this.custody.negativePermit(key)?.allows(record,metadata))throw new Error('graph-transfer-post-import-erasure-pending');}finally{reader.releasePrivateViews();}assertAccepted();return{receipt,inventoryHash,historicalEventIds,pendingEventIds};
    }finally{reader.close();}
  });}

  /** Post-ACT data import evidence. A newer authenticated erase overlays the
   * original immutable snapshot; it never restores its old key-bearing parts. */
  async postActivationTransferReceipt(stage:GraphSourceTransferStage,activation:GraphMembershipActivationCertificate):Promise<{receipt:GraphMembershipTransferReceipt;inventoryHash:string;historicalEventIds:string[];pendingEventIds:string[]}>{
    this.assertCurrentLossActivation(activation);const imported=await this.importTransferred(stage,activation);this.assertCurrentLossActivation(activation);
    return this.serial(async()=>{
      const erasures=await this.erasureState(stage.authorization.agentId),key=this.custody.key(stage),reader=await this.custody.openReader(key,erasures);await this.verifyStoredStream(reader);const metadata=reader.metadata;
      const witness=this.options.witnessPublicKeys?.get(activation.witnessId);if(!witness||!verifyMembershipActivation(activation,this.options.ownerPublicKey,witness)||canonicalHash(activation.ownerAuthorization)!==canonicalHash(metadata.authorization)||canonicalHash(activation.newMembership)!==canonicalHash(metadata.newMembership))throw new Error('graph-transfer-activation-invalid');
      const assertFences=async()=>{for await(const {record}of reader.recordsInManifestOrder())if((this.options.localErasure?.isDenied(record.packet.erasureIdentity)||this.options.verification.isErased(record.packet.erasureIdentity))&&!record.erasure&&!this.custody.negativePermit(key)?.allows(record,metadata))throw new Error('graph-transfer-post-import-erasure-pending');};await assertFences();
      await this.custody.syncRetained(key);
      const history:Array<{eventId:string;inventoryHash:string}>=[];const hashes={activationHash:canonicalHash(activation),manifestHash:canonicalHash(metadata.manifest)};
      for(const eventId of imported.historicalEventIds)history.push({eventId,inventoryHash:await this.options.verification.verifyDurableHistoricalImport(eventId,hashes.activationHash,hashes.manifestHash)});
      const rows:Array<{eventId:string;packetHash:string;sourceProofHash:string;terminalHash:string;erasureHash:string;bodyHash:string|null}>=[],rewraps:Array<{eventId:string;hash:string}>=[];
      for await(const {record,newRewrap}of reader.recordsInManifestOrder()){rows.push({eventId:record.packet.eventId,packetHash:canonicalHash(record.packet),sourceProofHash:canonicalHash({coreType:record.coreType,packet:record.packet,packetSignature:record.packetSignature,core:record.core,authorizationProof:record.authorizationProof}),terminalHash:canonicalHash(record.certificate??record.cancellationCertificate??null),erasureHash:canonicalHash(record.erasure??null),bodyHash:record.encryptedSourceBundle?canonicalHash(record.encryptedSourceBundle):null});if(newRewrap)rewraps.push({eventId:record.packet.eventId,hash:canonicalHash(newRewrap)});}
      const negativePermit=this.custody.negativePermit(key),inventoryHash=canonicalHash({v:1,activationHash:hashes.activationHash,manifestHash:hashes.manifestHash,rows,history,rewraps,...(negativePermit?{negativeControlProofHash:canonicalHash(negativePermit.proof)}:{})});
      const name=canonicalHash({key,activationHash:hashes.activationHash,inventoryHash,machineId:this.options.machineId})+'.post-import.json';let receipt=await this.custody.metadata(name) as GraphMembershipTransferReceipt|null;
      if(receipt){if(!verifyMembershipTransferReceipt(receipt,metadata.authorization,metadata.newMembership)||receipt.machineId!==this.options.machineId)throw new Error('graph-transfer-post-import-receipt-invalid');}
      else{const a=metadata.authorization,value={v:1 as const,agentId:a.agentId,recoveryId:a.recoveryId,newMembershipHash:canonicalHash(metadata.newMembership),sourceManifestHash:a.sourceManifestHash,rewrapInventoryHash:a.rewrapInventoryHash,highestCertifiedSequence:a.highestCertifiedSequence,highestCertifiedCoreHash:a.highestCertifiedCoreHash,machineId:this.options.machineId,persistedAt:(this.options.now?.()??new Date()).toISOString()};receipt={...value,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.membershipTransfer,value,this.options.memberPrivateKey)};if(!verifyMembershipTransferReceipt(receipt,a,metadata.newMembership))throw new Error('graph-transfer-member-signing-key-mismatch');await this.custody.persistMetadata(name,receipt);}
      await assertFences();this.assertCurrentLossActivation(activation);return {receipt,inventoryHash,...imported};
    });
  }

  private async erasureState(agentId:string):Promise<GraphWitnessErasure[]>{
    const proofs:GraphWitnessErasure[]=[];let names:string[];try{names=await fs.readdir(this.options.directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return proofs;throw error;}
    for(const name of names.filter(name=>/^erasure-[a-f0-9]{64}\.json$/.test(name))){const proof=JSON.parse(await fs.readFile(path.join(this.options.directory,name),'utf8')) as GraphWitnessErasure;
      const key=this.options.witnessPublicKeys?.get(proof.witnessId);if(!key||proof.agentId!==agentId||!verifyWitnessErasure(proof,key)||!this.options.verification.erasureAuthorities.has(proof))throw new Error('graph-transfer-untrusted-erasure');
      proofs.push(proof);
    }return proofs;
  }
  /** Immediate negative cleanup only; no disk custody or permission. */
  purgePrivateStageViews(target:GraphErasureIdentity):void{if(!this.options.localErasure?.isDenied(target))throw new Error('graph-transfer-local-fence-required');this.custody.purgePrivateViews(target);}
  /** Registers independently cloned private views for cleanup only. */
  retainPrivateStageViews(stage:GraphSourceTransferStage):{close():void}{if(!this.custodyAuthority)throw new Error('graph-transfer-actual-custody-context-required');this.assertLocalCustodyContext({stateRoot:this.custodyAuthority.stateRoot,agentId:this.custodyAuthority.agentId,machineId:this.options.machineId,authority:this.custodyAuthority});return this.custody.retainPrivateStageViews(stage);}
  applyErasure(proof:GraphWitnessErasure,agentId:string):Promise<void>{const pin=this.options.witnessPublicKeys?.get(proof.witnessId);if(!pin||proof.agentId!==agentId||!verifyWitnessErasure(proof,pin)||!this.options.verification.erasureAuthorities.has(proof))throw new Error('graph-transfer-untrusted-erasure');this.pendingErased.add(canonicalHash(proof.target));this.custody.purgePrivateViews(proof.target);return this.serial(async()=>{
    const key=this.options.witnessPublicKeys?.get(proof.witnessId);if(!key||proof.agentId!==agentId||!verifyWitnessErasure(proof,key)||!this.options.verification.erasureAuthorities.has(proof))throw new Error('graph-transfer-untrusted-erasure');
    await fs.mkdir(this.options.directory,{recursive:true,mode:0o700});const file=path.join(this.options.directory,`erasure-${canonicalHash(proof)}.json`);
    const temporary=`${file}.${crypto.randomUUID()}.tmp`;const handle=await fs.open(temporary,'wx',0o600);try{await handle.writeFile(canonicalJson(proof));await handle.sync();}finally{await handle.close();}
    await fs.rename(temporary,file);
    const directory=await fs.open(this.options.directory,'r');try{await directory.sync();}finally{await directory.close();}
    await this.custody.purge(record=>erasureCoversPacket(proof,record.packet));
    const after=await fs.open(this.options.directory,'r');try{await after.sync();}finally{await after.close();}
  });}
  /** Caller must persist its owner-local deny fence before invoking this. */
  eraseLocal(target:GraphErasureIdentity):Promise<void>{if(!this.options.localErasure?.isDenied(target))return Promise.reject(new Error('graph-transfer-local-fence-required'));try{this.custody.purgePrivateViews(target);}catch(error){return Promise.reject(error);}return this.serial(async()=>{
    if(!this.options.localErasure?.isDenied(target))throw new Error('graph-transfer-local-fence-required');
    await this.custody.purge(record=>sameGraphErasureIdentity(target,record.packet.erasureIdentity));
  });}
  assertLocalErasurePurged(target:GraphErasureIdentity):Promise<string>{
    if(!this.options.localErasure?.isDenied(target))return Promise.reject(new Error('graph-transfer-local-fence-required'));
    try{this.custody.purgePrivateViews(target);}catch(error){return Promise.reject(error);}return this.custody.assertPurged(target,record=>sameGraphErasureIdentity(target,record.packet.erasureIdentity));
  }
  private serial<T>(work:()=>Promise<T>):Promise<T>{const next=this.queue.then(work);this.queue=next.catch(()=>undefined);return next;}

}
