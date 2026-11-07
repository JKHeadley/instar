// RULE 3: EXEMPT — these classes read signed, hash-checked graph records from disk; none infers agent or provider state from output.
import {durableStamp,flushDescriptorOnce,isDurablyUnchanged,rememberDurable} from './GraphDurableFileMemo.js';
import {GraphMemberLossNegativeTransferPermit,type GraphMemberLossNegativeTransferEvidence} from './GraphMemberLossNegativeTransfer.js';
import {verifyGraphOwnerMemberLossConsent,type GraphOwnerMemberLossConsent,type GraphOwnerMemberLossContext} from './GraphOwnerMemberLoss.js';
import {verifyGraphMemberLossIntent} from './GraphMemberLossNativeProof.js';
import {GraphPreparedTransferEnvelopes} from './GraphPreparedTransferEnvelopes.js';
import {GraphTransferCustodyReader,type GraphTransferStageMetadata} from './ConversationGraphTransferCustody.js';
import {assertGraphLocalPath} from './GraphLocalFiles.js';
import {GraphOwnedSourceVerifiedRowV2} from './GraphOwnedSourceStreamV2.js';
import {assertGraphOwnedOpaqueMetadata} from './GraphOwnedControlMetadataFrames.js';
import {verifyRecoveryAuthorization,validateRecoverySourceManifest,exactFields} from './GraphWitnessTypes.js';
import {verifyGraphControlCapsule} from './GraphWitnessControl.js';
import {verifyGraphCustodyHoldIntent} from './GraphCustodyProfileAuthority.js';
import {GraphNativeMemberLossProgress} from './GraphNativeMemberLossStore.js';
import {GraphMemberLossHeldPreflight} from './GraphMemberLossHeldPreflight.js';
import {LeaseCoordinator} from './LeaseCoordinator.js';
import {MachineIdentityManager,verify as nativeMachineVerify} from './MachineIdentity.js';
import {IdentityStore} from './IdentityStore.js';
import {SingleInstanceLock} from './SingleInstanceLock.js';
import {FencedLease} from './FencedLease.js';
import {GraphPublicMetadataPages} from './GraphPublicMetadataPages.js';
import {assertGraphTransferPublicControl} from './GraphTransferPublicControl.js';
import {GraphSourceCapacityLedger,type GraphLocalSourceCapacityReservation} from './GraphSourceCapacityLedger.js';
import {GraphFrozenPhysicalInventory} from './GraphFrozenPhysicalInventory.js';
import {graphRecoverySourceManifestEntry} from './ConversationGraphRecoveryManifest.js';
import {verifyGraphMemberLossNegativeCustody} from './GraphMemberLossNegativeCustody.js';
import {GRAPH_MEMBER_LOSS_MAX_SNAPSHOT_BYTES,graphMemberLossSnapshotBudget} from './GraphMemberLossInventoryLimits.js';
import {ConversationGraphLocalErasureFence} from './ConversationGraphLocalErasure.js';
import {GraphCustodyProfileAuthority,type GraphCustodyHoldIntent} from './GraphCustodyProfileAuthority.js';
import {ConversationGraphNativeTailFloor,GRAPH_NATIVE_TAKEOVER_CUSTODY_DOMAIN,graphNativeClosedTailsHash,verifyGraphNativeTailBarrier,type GraphNativeTailClosure,type GraphNativeTakeoverCustodyReceipt} from './ConversationGraphNativeTail.js';
import {GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES} from './GraphWitnessTypes.js';
import {graphCompleteDeliveryFacts,graphDeliveryFactsHash} from './ConversationGraphDeliveryProof.js';
import {ConversationGraphErasureAuthorityStore} from './ConversationGraphErasureAuthorityStore.js';
import type {GraphErasureAuthority} from './GraphErasureProtocol.js';
import {verifyGraphCustodyAuthority} from './ConversationGraphCustodyAuthority.js';
import {verifyGraphWitnessCustody} from './GraphWitnessControl.js';
import type {GraphControlCapsule} from './GraphWitnessControl.js';
import {GraphSelectedMaterializationV2,GraphVerifiedMaterializationContextV2,validateGraphMaterializationReferenceV2,openGraphMaterializationContextV2,graphMaterializationReference,type GraphMaterializationContextReferenceV2,ConversationGraphMaterializationContexts,GRAPH_CONTEXT_MAX_BYTES,graphMaterializationSharedHashes,graphMaterializationContextSize,splitGraphMaterialization,hydrateGraphMaterialization,validateGraphMaterializationReference,type GraphMaterializationContextReference} from './ConversationGraphMaterializationContexts.js';
/** Durable source/outbox and all-member certificate replication for Conversations.
 * Spec: conversation-effort-hierarchy-v3 §7.2 and §8.1 increment A.
 *
 * Source records are immutable, bounded files, archived without automatic expiry.
 * Certificates, durable-publication markers and erasure tombstones are separate
 * fsynced sidecars. Rotating journal transport can always repair from this source.
 * No title, transcript, live credential or plaintext content key is stored here.
 */
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import fsSync,{constants as FILE_FLAGS,realpathSync} from 'node:fs';
import type {GraphMemberLossIntentProof} from './GraphMemberLossNativeProof.js';
import path from 'node:path';
import { ReplicatedStoreReader } from './ReplicatedStoreReader.js';
import { DroppedOriginRegistry } from './RollbackUnmerge.js';
import type { JournalEmitOutcome } from './CoherenceJournal.js';
import type { ReplicatedKindRegistry, StoreFieldSchema } from './ReplicatedRecordEnvelope.js';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import type { OriginRecord } from './UnionReader.js';
import { SafeFsExecutor } from './SafeFsExecutor.js';
import {graphHistoricalMaterializationRef,verifyGraphHistoricalMaterialization,verifyGraphHistoricalMaterializationContext,verifyGraphHistoricalMaterializationEntry,type GraphHistoricalMaterialization,type GraphMaterializationTrust} from './ConversationGraphHistoricalMaterialization.js';
import {validateGraphApplicationSource} from './ConversationGraphOperation.js';
import {decodeGraphSourceRecoveryEnvelope,reconstructGraphSourceRecord} from './ConversationGraphSourceRecovery.js';
import {decodeGraphSourceEnvelope,verifyGraphSourceEnvelopeControl} from './ConversationGraphSourceEnvelope.js';
import {validateGraphSourceObservationPlaintext} from './ConversationGraphSourceInventory.js';
import {describeGraphReplicationRecord,validateGraphReplicationDescriptor,type ConversationGraphReplicationDescriptor} from './ConversationGraphReplicationDescriptor.js';
import { ConversationGraphIntake } from './ConversationGraphIntake.js';
import type { LeaseRecord } from './types.js';
import type { WriteAdmission } from './WriteAdmission.js';
import {
  GRAPH_SIGNATURE_DOMAINS, erasureCoversPacket, sameGraphErasureIdentity, canonicalHash, canonicalJson, opaque, hash, validateGraphErasureIdentity, validatePacket, verifyFencedLeaseBridge, verifyWitnessLease, verifyMembershipEpoch,
  signGraphRecord, unsigned, verifyGraphRecord, verifyCommitCertificate, verifyCancellationCertificate, verifyMemberReceipt, verifyWitnessErasure, verifyAdoptionCertificate, verifyWitnessCancellation, verifyBundleRewrap,
  type GraphCommitCertificate, type GraphEncryptedBundle, type GraphMemberReceipt, type GraphWitnessPrepareProof, type GraphWitnessErasedControlProof, type GraphMembershipActivationCertificate, type GraphAdoptionCertificate, type GraphMembershipEpoch, type GraphWitnessLease,
  type GraphRecoverySourceManifest, type GraphOperationPacket, type GraphWitnessErasure, type GraphWitnessCancellation, type GraphCancellationCertificate, type GraphBundleRewrap, type GraphCoreType, type GraphErasureIdentity,
} from './GraphWitnessTypes.js';
import { verifyGraphAuthorization, type GraphAuthorizationProof } from './ConversationGraphReplicationProof.js';
import { openGraphBundle, openRewrappedGraphBundle,rewrapGraphBundle } from './GraphWitnessCrypto.js';

export const CONVERSATION_GRAPH_STORE = 'conversationGraph';
export const CONVERSATION_GRAPH_JOURNAL_KIND = 'conversation-graph-event';
import {GRAPH_REPLICATION_MAX_RECORD_BYTES,GRAPH_REPLICATION_MAX_LEASE_EPOCH,GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH} from './ConversationGraphReplicationLimits.js';
export {GRAPH_REPLICATION_MAX_RECORD_BYTES} from './ConversationGraphReplicationLimits.js';

export const graphReplicationFileStem=(operationKey:string)=>crypto.createHash('sha256').update(operationKey).digest('hex');
export interface ConversationGraphReplicationRecord {
  coreType: GraphCoreType;
  packet: GraphOperationPacket;
  packetSignature: string;
  core: Record<string, unknown>;
  authorizationProof: GraphAuthorizationProof;
  encryptedSourceBundle: GraphEncryptedBundle | null;
  adoption?: GraphAdoptionCertificate;
  /** Erasable sealed-key inventory, never embedded in an immutable certificate. */
  rewrap?: GraphBundleRewrap;
  materialization?:GraphHistoricalMaterialization;
  preparationProof?: GraphWitnessPrepareProof;
  erasedControlProof?:GraphWitnessErasedControlProof;
  custodyMembership?:GraphMembershipEpoch;
  custodyActivations?:GraphMembershipActivationCertificate[];
  certificate?: GraphCommitCertificate;
  certificatePersistenceReceipts?: GraphMemberReceipt[];
  /** Published only after every installed member's actual signed first proof
   * delivery receipt is verified and durably retained. */
  commitProofDeliveryReceipts?:GraphCommitProofDeliveryReceipt[];
  cancellation?: GraphWitnessCancellation;
  cancellationCertificate?: GraphCancellationCertificate;
  erasure?: GraphWitnessErasure;
}
/** Contexts are immutable shared proof objects; do not duplicate history per row. */
function cloneGraphRecord(record:ConversationGraphReplicationRecord):ConversationGraphReplicationRecord{
 const {materialization,...body}=record;return {...structuredClone(body),...(materialization?{materialization}:{})};
}
const DURABLE_CAPACITY_TOKEN=Symbol('actual-durable-original-capacity');
export class GraphDurableOriginalCapacityProof {
 readonly readyForSourceAck=true;readonly futureRecoveryReady=false;readonly physicalHeadroomProven=false;readonly eventId:string;readonly packetHash:string;readonly policyHash:string;#check:()=>void;
 constructor(token:symbol,value:{eventId:string;packetHash:string;policyHash:string},check:()=>void){if(token!==DURABLE_CAPACITY_TOKEN)throw new Error('graph-source-actual-capacity-proof-required');this.eventId=value.eventId;this.packetHash=value.packetHash;this.policyHash=value.policyHash;this.#check=check;Object.freeze(this);}
 assertCurrent():void{this.#check();}
}
const HELD_ORIGINAL_PROMOTION_TOKEN=Symbol('actual-source-held-original-promotion');
interface HeldOriginalPlanCommon {v:1;agentId:string;machineId:string;stageHash:string;streamHash:string;authorization:import('./GraphWitnessTypes.js').GraphRecoveryAuthorization;previousMembership:GraphMembershipEpoch;newMembership:GraphMembershipEpoch;previous:{lease:GraphWitnessLease;originalLease:LeaseRecord};signature:string}
interface HeldOriginalOrdinaryPlan extends HeldOriginalPlanCommon {kind:'held-original-plan';holdIntent:GraphCustodyHoldIntent}
interface HeldOriginalLossPlan extends HeldOriginalPlanCommon {kind:'held-member-loss-original-plan';lossIntent:GraphMemberLossIntentProof;consent:GraphOwnerMemberLossConsent;nativeIdentities:GraphOwnerMemberLossContext['nativeIdentities'];previousPublicationHash:string;sourceInventoryHash:string;sourceSnapshotInventoryHash:string;sourceErasureInventoryHash:string}
type HeldOriginalPlan=HeldOriginalOrdinaryPlan|HeldOriginalLossPlan;
function heldLossStageHash(p:Pick<HeldOriginalLossPlan,'authorization'|'consent'|'lossIntent'|'sourceInventoryHash'|'sourceSnapshotInventoryHash'|'sourceErasureInventoryHash'>):string{return canonicalHash({v:1,kind:'member-loss-held-source',authorizationHash:canonicalHash(p.authorization),consentHash:canonicalHash(p.consent),intentHash:canonicalHash(p.lossIntent),sourceInventoryHash:p.sourceInventoryHash,sourceSnapshotInventoryHash:p.sourceSnapshotInventoryHash,sourceErasureInventoryHash:p.sourceErasureInventoryHash});}

interface HeldOriginalCatalog {v:1;kind:'held-original-row';agentId:string;machineId:string;stageHash:string;eventId:string;packetHash:string;recordTransportHash:string;descriptor:GraphHeldSourceDescriptor;recordControl:Record<string,unknown>;bodyState:'sealed'|'denied';oldRewrapHash:string|null;newRewrapHash:string|null;priorCanonical:boolean;signature:string}
export type GraphHeldOriginalNativeContext={coordinator:LeaseCoordinator;nativeFloor:ConversationGraphNativeTailFloor;lease?:GraphWitnessLease;originalLease?:LeaseRecord};
export class GraphHeldOriginalStageProof {
 readonly stageHash:string;readonly inventoryHash:string;readonly readyForSourceAck=false;#check:()=>void;#close:()=>void;#closed=false;
 constructor(token:symbol,stageHash:string,inventoryHash:string,check:()=>void,close:()=>void){if(token!==HELD_ORIGINAL_PROMOTION_TOKEN)throw new Error('graph-held-original-actual-stage-proof-required');this.stageHash=stageHash;this.inventoryHash=inventoryHash;this.#check=check;this.#close=close;Object.freeze(this);}
 assertCurrent():void{if(this.#closed)throw new Error('graph-held-original-stage-proof-closed');this.#check();}
 close():void{if(this.#closed)return;this.#closed=true;this.#close();this.#close=()=>{};this.#check=()=>{throw new Error('graph-held-original-stage-proof-closed');};}
}
interface HeldOriginalInput {lossPlan?:Omit<HeldOriginalLossPlan,keyof HeldOriginalPlanCommon|'kind'>;record:ConversationGraphReplicationRecord;newRewrap:GraphBundleRewrap|null;descriptor:GraphHeldSourceDescriptor;stageHash:string|null;header:{metadata:GraphTransferStageMetadata;descriptor:unknown;inventory:Array<{eventId:string;rewrapHash:string}>;previous:{lease:GraphWitnessLease;originalLease:LeaseRecord}};assertScope(scope:{source:ConversationGraphReplication;authority:GraphCustodyProfileAuthority}):void;assertPromotionScope(source:ConversationGraphReplication,authority:GraphCustodyProfileAuthority):void}
export class GraphHeldSenderStage {
 readonly stageHash:string;readonly sourceInventoryHash:string;readonly metadataHash:string;readonly readyForSourceAck=false;#source:ConversationGraphReplication;#reader:GraphHeldSourceReader;#authority:GraphCustodyProfileAuthority;#prepared:GraphPreparedTransferEnvelopes;#recordHash:(id:string)=>string|undefined;#closed=false;#check:()=>void;#promote:(id:string,key:GraphBundleRewrap|null)=>Promise<GraphHeldOriginalPromotionProof>;#final:()=>Promise<GraphHeldOriginalStageProof>;#promotePrepared?:(id:string)=>Promise<GraphHeldOriginalPromotionProof>;#cleanup:()=>void;#session?:()=>GraphHeldSenderReadSession;#negative?:(permit:GraphMemberLossNegativeTransferPermit,record:ConversationGraphReplicationRecord,metadata:GraphTransferStageMetadata)=>void;
 constructor(token:symbol,source:ConversationGraphReplication,reader:GraphHeldSourceReader,authority:GraphCustodyProfileAuthority,prepared:GraphPreparedTransferEnvelopes,recordHash:(id:string)=>string|undefined,value:{stageHash:string;sourceInventoryHash:string;metadataHash:string},check:()=>void,promote:(id:string,key:GraphBundleRewrap|null)=>Promise<GraphHeldOriginalPromotionProof>,final:()=>Promise<GraphHeldOriginalStageProof>,promotePrepared?: (id:string)=>Promise<GraphHeldOriginalPromotionProof>,cleanup:()=>void=()=>{},negative?:(permit:GraphMemberLossNegativeTransferPermit,record:ConversationGraphReplicationRecord,metadata:GraphTransferStageMetadata)=>void,session?:()=>GraphHeldSenderReadSession){if(token!==HELD_ORIGINAL_PROMOTION_TOKEN)throw new Error('graph-held-sender-actual-stage-required');this.#source=source;this.#reader=reader;this.#authority=authority;this.#prepared=prepared;this.#recordHash=recordHash;this.stageHash=value.stageHash;this.sourceInventoryHash=value.sourceInventoryHash;this.metadataHash=value.metadataHash;this.#check=check;this.#promote=promote;this.#final=final;this.#promotePrepared=promotePrepared;this.#cleanup=cleanup;this.#negative=negative;this.#session=session;Object.freeze(this);}
 assertCurrent():void{if(this.#closed)throw new Error('graph-held-sender-stage-closed');this.#check();}
 assertMetadata(metadata:GraphTransferStageMetadata):void{if(canonicalHash(metadata)!==this.metadataHash)throw new Error('graph-held-sender-stage-metadata-invalid');this.assertCurrent();}
 assertForSource(source:ConversationGraphReplication,reader:GraphHeldSourceReader,authority:GraphCustodyProfileAuthority):void{if(source!==this.#source||reader!==this.#reader||authority!==this.#authority)throw new Error('graph-held-sender-stage-scope-invalid');this.assertCurrent();}
 assertPreparedAccess(prepared:GraphPreparedTransferEnvelopes,reader:GraphHeldSourceReader,eventId:string,record:ConversationGraphReplicationRecord):void{if(prepared!==this.#prepared||reader!==this.#reader||this.#recordHash(eventId)!==canonicalHash(this.#source.recordForTransport(record))||record.packet.eventId!==eventId)throw new Error('graph-held-sender-prepared-access-invalid');this.assertCurrent();}
 assertNegativePermitAccess(permit:GraphMemberLossNegativeTransferPermit,record:ConversationGraphReplicationRecord,metadata:GraphTransferStageMetadata):void{if(!(permit instanceof GraphMemberLossNegativeTransferPermit)||!this.#negative||canonicalHash(metadata)!==this.metadataHash||this.#recordHash(record.packet.eventId)!==canonicalHash(this.#source.recordForTransport(record)))throw new Error('graph-held-sender-negative-permit-scope');this.assertCurrent();this.#negative(permit,record,metadata);}
 async promoteRow(eventId:string,newRewrap:GraphBundleRewrap|null){this.assertCurrent();return this.#promote(eventId,newRewrap);}
 async promotePreparedRow(eventId:string){this.assertCurrent();if(!this.#promotePrepared)throw new Error('graph-held-sender-prepared-cursor-required');return this.#promotePrepared(eventId);}
 readSession():GraphHeldSenderReadSession{this.assertCurrent();if(!this.#session)throw new Error('graph-held-sender-read-session-unavailable');return this.#session();}
 async finalize(){this.assertCurrent();return this.#final();}
 close():void{if(this.#closed)return;this.#closed=true;this.#cleanup();this.#cleanup=()=>{};this.#promotePrepared=undefined;this.#check=()=>{throw new Error('graph-held-sender-stage-closed');};this.#promote=async()=>{throw new Error('graph-held-sender-stage-closed');};this.#final=async()=>{throw new Error('graph-held-sender-stage-closed');};}
}
/** Actual Source-issued bounded read continuation. Whole-cut finalization is
 * separate from per-row current scope and is mandatory at transfer/W finish. */
export class GraphHeldSenderReadSession {
 #closed=false;#source:ConversationGraphReplication;#authority:GraphCustodyProfileAuthority;#coordinator:LeaseCoordinator;#reader:GraphHeldSourceReader;#preflight:GraphMemberLossHeldPreflight;#prepared:GraphPreparedTransferEnvelopes;#check:()=>void;#final:()=>void;#read:(id:string)=>Promise<{record:ConversationGraphReplicationRecord;newRewrap:GraphBundleRewrap|null;close():void}>;#page:(hash:string,index:number)=>ReturnType<ConversationGraphReplication['contextPage']>;#rows:GraphHeldSourceDescriptor[];#keys:Array<{eventId:string;rewrapHash:string}>;#negative:{erasures:GraphWitnessErasure[];localErasureTargets:GraphErasureIdentity[]};#views=new Set<()=>void>();
 readonly stateRoot:string;readonly agentId:string;readonly machineId:string;readonly intentHash:string;readonly membershipHash:string;readonly inventoryHash:string;readonly erasureInventoryHash:string;readonly nativeLeaseHash:string;
 constructor(token:symbol,source:ConversationGraphReplication,authority:GraphCustodyProfileAuthority,coordinator:LeaseCoordinator,reader:GraphHeldSourceReader,preflight:GraphMemberLossHeldPreflight,prepared:GraphPreparedTransferEnvelopes,rows:readonly GraphHeldSourceDescriptor[],keys:Array<{eventId:string;rewrapHash:string}>,negative:{erasures:GraphWitnessErasure[];localErasureTargets:GraphErasureIdentity[]},check:()=>void,final:()=>void,read:(id:string)=>Promise<{record:ConversationGraphReplicationRecord;newRewrap:GraphBundleRewrap|null;close():void}>,page:(hash:string,index:number)=>ReturnType<ConversationGraphReplication['contextPage']>){if(token!==HELD_ORIGINAL_PROMOTION_TOKEN)throw new Error('graph-held-source-actual-read-session-required');this.#source=source;this.#authority=authority;this.#coordinator=coordinator;this.#reader=reader;this.#preflight=preflight;this.#prepared=prepared;this.#rows=rows.map(row=>structuredClone(row));this.#keys=keys;this.#negative=negative;this.#check=check;this.#final=final;this.#read=read;this.#page=page;this.stateRoot=reader.stateRoot;this.agentId=reader.agentId;this.machineId=reader.machineId;this.intentHash=reader.intentHash;this.membershipHash=reader.membershipHash;this.inventoryHash=reader.inventoryHash;this.erasureInventoryHash=reader.erasureInventoryHash;this.nativeLeaseHash=reader.nativeLeaseHash;Object.freeze(this);}
 assertForSource(reader:GraphHeldSourceReader,preflight:GraphMemberLossHeldPreflight,prepared:GraphPreparedTransferEnvelopes):void{if(reader!==this.#reader||preflight!==this.#preflight||prepared!==this.#prepared)throw new Error('graph-held-source-read-session-scope-invalid');this.assertCurrent();}
 assertRecoveryContext(source:ConversationGraphReplication,authority:GraphCustodyProfileAuthority,coordinator:LeaseCoordinator):void{if(source!==this.#source||authority!==this.#authority||coordinator!==this.#coordinator)throw new Error('graph-held-source-read-session-recovery-context');this.assertCurrent();}
 assertStore(source:ConversationGraphReplication):void{if(source!==this.#source)throw new Error('graph-held-source-read-session-store-invalid');this.assertCurrent();}
 assertCurrent():void{if(this.#closed)throw new Error('graph-held-source-read-session-closed');try{this.#check();}catch(error){this.close();throw error;}}
 descriptors():readonly GraphHeldSourceDescriptor[]{this.assertCurrent();return this.#rows.map(row=>structuredClone(row));}
 inventory():Array<{eventId:string;rewrapHash:string}>{this.assertCurrent();return this.#keys.map(row=>({...row}));}
 negativeInventory(){this.assertCurrent();return structuredClone(this.#negative);}
 async readRow(eventId:string){await new Promise(resolve=>setImmediate(resolve));this.assertCurrent();if(!this.#rows.some(row=>row.eventId===eventId))throw new Error('graph-held-source-read-session-unlisted');const value=await this.#read(eventId);try{this.assertCurrent();}catch(error){value.close();throw error;}const close=()=>{value.close();this.#views.delete(close);};this.#views.add(close);return{record:value.record,newRewrap:value.newRewrap,close};}
 async readRecord(eventId:string){await new Promise(resolve=>setImmediate(resolve));const row=await this.readRow(eventId);return row.record;}
 releasePrivateViews():void{for(const close of this.#views)close();this.#views.clear();}
 async *envelopes(){for(const entry of this.#rows){const row=await this.readRow(entry.eventId);try{yield{eventId:entry.eventId,rewrap:row.newRewrap};}finally{row.close();}}}
 async contextPage(hash:string,index:number){this.assertCurrent();if(!this.#rows.some(row=>row.materializationContext?.contextHash===hash))throw new Error('graph-held-source-read-session-context-unlisted');const page=await this.#page(hash,index);this.assertCurrent();return page;}
 finalize():void{this.assertCurrent();this.#final();this.assertCurrent();}
 assertFinalized():void{this.finalize();}
 close():void{if(this.#closed)return;this.#closed=true;this.releasePrivateViews();this.#rows=[];this.#keys=[];this.#negative={erasures:[],localErasureTargets:[]};this.#check=()=>{throw new Error('graph-held-source-read-session-closed');};this.#final=this.#check;this.#read=async()=>{throw new Error('graph-held-source-read-session-closed');};}
}
/** Actual quarantined Source custody only: no Source ACK/canonical visibility. */
export class GraphHeldOriginalPromotionProof {
 readonly readyForSourceAck=false;readonly futureRecoveryReady=false;readonly stageHash:string;readonly eventId:string;readonly recordTransportHash:string;readonly inventoryHash:string;readonly bodyState:'sealed'|'denied';
 #source:ConversationGraphReplication;#check:()=>void;#read:()=>Promise<{record:ConversationGraphReplicationRecord;newRewrap:GraphBundleRewrap|null;close():void}>;#close:()=>void;#closed=false;
 constructor(token:symbol,source:ConversationGraphReplication,value:{stageHash:string;eventId:string;recordTransportHash:string;inventoryHash:string;bodyState:'sealed'|'denied'},check:()=>void,read:()=>Promise<{record:ConversationGraphReplicationRecord;newRewrap:GraphBundleRewrap|null;close():void}>,close:()=>void){if(token!==HELD_ORIGINAL_PROMOTION_TOKEN)throw new Error('graph-held-original-actual-proof-required');this.#source=source;this.stageHash=value.stageHash;this.eventId=value.eventId;this.recordTransportHash=value.recordTransportHash;this.inventoryHash=value.inventoryHash;this.bodyState=value.bodyState;this.#check=check;this.#read=read;this.#close=close;Object.freeze(this);}
 get closed():boolean{return this.#closed;}
 assertCurrent(scope?:{source:ConversationGraphReplication;stageHash:string;eventId:string;recordTransportHash:string}):void{if(this.#closed||scope&&(scope.source!==this.#source||scope.stageHash!==this.stageHash||scope.eventId!==this.eventId||scope.recordTransportHash!==this.recordTransportHash))throw new Error('graph-held-original-proof-scope-invalid');this.#check();}
 async readRecord(){await new Promise(resolve=>setImmediate(resolve));this.assertCurrent();const value=await this.#read();try{this.assertCurrent();return value;}catch(error){value.close();throw error;}}
 releasePrivateViews():void{if(this.#closed)throw new Error('graph-held-original-proof-closed');this.#close();}
 close():void{if(this.#closed)return;this.#closed=true;this.#close();this.#close=()=>{};this.#check=()=>{throw new Error('graph-held-original-proof-closed');};this.#read=async()=>{throw new Error('graph-held-original-proof-closed');};}
}

export interface GraphLiveAdmission {
  admitted: boolean;
  writerId: string | null;
  leaseEpoch: number;
  membershipEpoch: number;
  fencedLeaseHash: string | null;
}
export interface GraphPagedHistoricalBinding {pages:GraphPublicMetadataPages;coordinator:LeaseCoordinator;floor:ConversationGraphNativeTailFloor;identity:MachineIdentityManager;identities:IdentityStore;lock:SingleInstanceLock;maxHeldBytes:number}
interface GraphPagedHistoricalHeldCatalog {v:1;kind:'graph-source-paged-history-held';agentId:string;machineId:string;eventId:string;membership:GraphMembershipEpoch;reference:GraphMaterializationContextReferenceV2;recordControl:Record<string,unknown>;oldRewrapHash:string|null;newRewrapHash:string|null;signature:string}
const PAGED_HISTORY_HELD_TOKEN=Symbol('actual-source-paged-history-held');
/** Process-local monotonic negative admission debt, never a positive cache. */
const pagedHistoryHeldRoots=new Set<string>();
export class GraphPagedHistoricalHeldProof {
 readonly state='held-recovery-export-unavailable';readonly readyForSourceAck=false;readonly futureRecoveryReady=false;readonly contextHash:string;#closed=false;#source:ConversationGraphReplication;#check:()=>void;#final:()=>void;#read:(id:string)=>Promise<{record:ConversationGraphReplicationRecord;newRewrap:GraphBundleRewrap|null;close():void}>;#views=new Set<()=>void>();
 constructor(token:symbol,contextHash:string,source:ConversationGraphReplication,check:()=>void,final:()=>void,read:(id:string)=>Promise<{record:ConversationGraphReplicationRecord;newRewrap:GraphBundleRewrap|null;close():void}>){if(token!==PAGED_HISTORY_HELD_TOKEN||!(source instanceof ConversationGraphReplication))throw new Error('graph-paged-history-actual-held-proof-required');this.contextHash=contextHash;this.#source=source;this.#check=check;this.#final=final;this.#read=read;Object.freeze(this);}
 get closed(){return this.#closed;}
 assertCurrent(source=this.#source):void{if(this.#closed||source!==this.#source)throw new Error('graph-paged-history-held-proof-unavailable');try{this.#check();}catch(error){this.close();throw error;}}
 assertFinalized():void{this.assertCurrent();try{this.#final();}catch(error){this.close();throw error;}this.assertCurrent();}
 async readRecord(eventId:string){await new Promise(resolve=>setImmediate(resolve));this.assertCurrent();let row;try{row=await this.#read(eventId);}catch(error){try{this.assertCurrent();}catch{/* assertCurrent already closed the proof when custody changed */}throw error;}try{this.assertCurrent();}catch(error){row.close();throw error;}const close=()=>{row.close();this.#views.delete(close);};this.#views.add(close);return{record:row.record,newRewrap:row.newRewrap,close};}
 releasePrivateViews():void{for(const close of this.#views)close();this.#views.clear();}
 close():void{if(this.#closed)return;this.#closed=true;this.releasePrivateViews();}
}
export interface ConversationGraphReplicationOptions {
  /** Explicit, actual-class negative custody only; no default or new ACK. */
  pagedHistorical?:GraphPagedHistoricalBinding;
  directory: string;
  /** A local resource budget may only lower the recovery protocol ceiling. */
  maxHistoryEntries?:number;
  /** Opt-in local declared byte policy. No default or peer capacity implication. */
  capacityLedger?:GraphSourceCapacityLedger;
  reservedOperationIds?:()=>Promise<ReadonlySet<string>>;
  agentId: string;
  machineId: string;
  memberPrivateKey: crypto.KeyLike;
  memberSealingPrivateKey: crypto.KeyLike;
  ownerPublicKey: crypto.KeyLike;
  /** Actual owner-signed active membership, for post-replacement erasure authority. */
  installedMembership?: GraphMembershipEpoch;
  /** Pinned historical witness keys. Current network discovery is not trust. */
  witnessPublicKeys: ReadonlyMap<string, crypto.KeyLike>;
  writeAdmission: WriteAdmission;
  /** Legacy standby guard remains authoritative while WriteAdmission is dark. */
  legacyReadOnly: () => boolean;
  /** Must delegate to installed WriteAdmission + LeaseCoordinator, synchronously. */
  liveAdmission: () => GraphLiveAdmission;
  /** The actual graph-specific schema validator (Dawn's typed event core). */
  validateCore: (core: unknown,coreType:GraphCoreType) => boolean;
  localErasure?:{isDenied(target:GraphErasureIdentity):boolean};
  now?: () => Date;
}
const LOCAL_ACK_SNAPSHOT_TOKEN=Symbol('graph-local-acknowledged-snapshot');
/** Process-local verified read capability, never a persisted current/sync flag. */
export class GraphLocalAcknowledgedSnapshot {
 #source:ConversationGraphReplication;#authority:GraphCustodyProfileAuthority;#check:()=>void;
 readonly stateRoot:string;readonly agentId:string;readonly machineId:string;readonly membershipHash:string;readonly highestAcknowledgedSequence:number;readonly revision:string;readonly acknowledgedAt:string;
 constructor(token:symbol,source:ConversationGraphReplication,authority:GraphCustodyProfileAuthority,value:{stateRoot:string;agentId:string;machineId:string;membershipHash:string;highestAcknowledgedSequence:number;revision:string;acknowledgedAt:string},check:()=>void){if(token!==LOCAL_ACK_SNAPSHOT_TOKEN)throw new Error('graph-local-snapshot-actual-proof-required');this.#source=source;this.#authority=authority;this.#check=check;this.stateRoot=value.stateRoot;this.agentId=value.agentId;this.machineId=value.machineId;this.membershipHash=value.membershipHash;this.highestAcknowledgedSequence=value.highestAcknowledgedSequence;this.revision=value.revision;this.acknowledgedAt=value.acknowledgedAt;Object.freeze(this);}
 assertCurrent(source:ConversationGraphReplication,authority:GraphCustodyProfileAuthority,membership:GraphMembershipEpoch):void{if(source!==this.#source||authority!==this.#authority||canonicalHash(membership)!==this.membershipHash)throw new Error('graph-local-snapshot-scope-mismatch');this.#check();}
}
export interface GraphMemberLossSourceEntry {eventId:string;operationHash:string;sourceProofHash:string;sourceSequence:number;predecessorHash:string|null;coreHash:string;sourceBundleHash:string;controlHash:string;outcome:'committed'|'canceled'|'erased'|'pending';terminalHash:string|null;originalSourceReceiptHash:string|null}
interface HeldPrivateView {target:GraphErasureIdentity;record:WeakRef<ConversationGraphReplicationRecord>;bundle:WeakRef<object>|null;rewrap:WeakRef<object>|null;failed:Set<WeakRef<object>>;overflow:boolean}
// Only independently parsed/cloned views enter this process-local negative
// inventory. Weak references retain no sealed body; canonical Source is untouched.
const heldPrivateViewsByRoot=new Map<string,Set<HeldPrivateView>>();
const heldPrivateFailedCounts=new Map<string,number>();
// A cap, not an allocation: a legal row at 64 members holds a bundle view and a rewrap view of about 66 objects each.
const HELD_PRIVATE_REFERENCE_BUDGET=GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES*(2*(64+2)+2);
// One bundle or rewrap holds one envelope per member; anything larger is refused before exposure.
const HELD_PRIVATE_DESCENDANT_LIMIT=4096;
function forgetHeldPrivateFailure(root:string,row:HeldPrivateView,reference:WeakRef<object>):void{
 if(!row.failed.delete(reference))return;const remaining=(heldPrivateFailedCounts.get(root)??0)-1;if(remaining>0)heldPrivateFailedCounts.set(root,remaining);else heldPrivateFailedCounts.delete(root);
}
function rememberHeldPrivateFailure(root:string,row:HeldPrivateView,value:object):void{
 // Root wrappers already have their own weak references. Descendants need
 // independent provenance after their mutable parents drop the last link.
 if(value===row.bundle?.deref()||value===row.rewrap?.deref())return;
 for(const reference of row.failed)if(reference.deref()===value)return;
 const count=heldPrivateFailedCounts.get(root)??0;if((heldPrivateViewsByRoot.get(root)?.size??0)+count>=HELD_PRIVATE_REFERENCE_BUDGET){row.overflow=true;return;}
 row.failed.add(new WeakRef(value));heldPrivateFailedCounts.set(root,count+1);
}
function clearHeldPrivateObject(value:object|undefined,seen=new WeakSet<object>(),failed?:(value:object)=>void):boolean{
 if(!value)return true;if(seen.has(value))return Object.keys(value).length===0;seen.add(value);let childrenCleared=true;
 for(const child of Object.values(value))if(child&&typeof child==='object'&&!clearHeldPrivateObject(child,seen,failed))childrenCleared=false;
 for(const key of Object.keys(value))Reflect.deleteProperty(value,key);if(Array.isArray(value)&&Object.getOwnPropertyDescriptor(value,'length')?.writable)Reflect.set(value,'length',0);
 const ownCleared=Object.keys(value).length===0;if(!ownCleared)failed?.(value);return childrenCleared&&ownCleared;
}
function releaseHeldPrivateView(root:string,row:HeldPrivateView):boolean{
 const remember=(value:object)=>rememberHeldPrivateFailure(root,row,value);
 for(const reference of [...row.failed]){const value=reference.deref();if(!value||clearHeldPrivateObject(value,new WeakSet<object>(),remember))forgetHeldPrivateFailure(root,row,reference);}
 const bundle=clearHeldPrivateObject(row.bundle?.deref(),new WeakSet<object>(),remember),rewrap=clearHeldPrivateObject(row.rewrap?.deref(),new WeakSet<object>(),remember),record=row.record.deref();
 if(record){const body=Object.getOwnPropertyDescriptor(record,'encryptedSourceBundle');if(body&&'value'in body&&body.writable)Reflect.set(record,'encryptedSourceBundle',null);const envelope=Object.getOwnPropertyDescriptor(record,'rewrap');if(envelope?.configurable)Reflect.deleteProperty(record,'rewrap');}
 const cleared=bundle&&rewrap&&row.failed.size===0&&!row.overflow;
 if(cleared){const rows=heldPrivateViewsByRoot.get(root);rows?.delete(row);if(!rows?.size)heldPrivateViewsByRoot.delete(root);}return cleared;
}
function heldPrivateDescendants(roots:Array<object|null|undefined>):object[]{
 const seen=new Set<object>(),stack:object[]=[];for(const root of roots)if(root){seen.add(root);stack.push(root);}const out:object[]=[];
 while(stack.length){for(const child of Object.values(stack.pop()!))if(child&&typeof child==='object'&&!seen.has(child)){if(out.length>=HELD_PRIVATE_DESCENDANT_LIMIT)throw new Error('graph-held-source-private-view-capacity');seen.add(child);out.push(child);stack.push(child);}}
 return out;
}
function retainHeldPrivateView(root:string,record:ConversationGraphReplicationRecord):()=>boolean{
 if(!record.encryptedSourceBundle&&!record.rewrap)return()=>true;const rows=heldPrivateViewsByRoot.get(root)??new Set<HeldPrivateView>();
 // Register every mutable descendant before exposure: a caller can detach one from its parent, and a later clear walks only what is still reachable.
 const descendants=heldPrivateDescendants([record.encryptedSourceBundle,record.rewrap]),needed=descendants.length+1;
 if(rows.size+(heldPrivateFailedCounts.get(root)??0)+needed>HELD_PRIVATE_REFERENCE_BUDGET){for(const row of rows){for(const reference of [...row.failed])if(!reference.deref())forgetHeldPrivateFailure(root,row,reference);if(!row.bundle?.deref()&&!row.rewrap?.deref()&&row.failed.size===0&&!row.overflow)rows.delete(row);}if(rows.size+(heldPrivateFailedCounts.get(root)??0)+needed>HELD_PRIVATE_REFERENCE_BUDGET)throw new Error('graph-held-source-private-view-capacity');}
 const row:HeldPrivateView={target:structuredClone(record.packet.erasureIdentity),record:new WeakRef(record),bundle:record.encryptedSourceBundle?new WeakRef(record.encryptedSourceBundle):null,rewrap:record.rewrap?new WeakRef(record.rewrap):null,failed:new Set(descendants.map(value=>new WeakRef(value))),overflow:false};if(descendants.length)heldPrivateFailedCounts.set(root,(heldPrivateFailedCounts.get(root)??0)+descendants.length);rows.add(row);heldPrivateViewsByRoot.set(root,rows);return()=>releaseHeldPrivateView(root,row);
}
function purgeHeldPrivateViews(root:string,target:GraphErasureIdentity):boolean{let cleared=true;for(const row of heldPrivateViewsByRoot.get(root)??[])if(sameGraphErasureIdentity(row.target,target)&&!releaseHeldPrivateView(root,row))cleared=false;return cleared;}
export interface GraphMemberLossHeldSourceContinuation {progress:GraphNativeMemberLossProgress;preflight:GraphMemberLossHeldPreflight;coordinator:LeaseCoordinator}
export type GraphHeldSourceContext=(({kind:'planned';intent:GraphCustodyHoldIntent;nativeFloor:ConversationGraphNativeTailFloor;nativeContinuation?:never})|({kind:'member-loss';intent:GraphMemberLossIntentProof}&({nativeFloor:ConversationGraphNativeTailFloor;nativeContinuation?:never}|{nativeFloor?:never;nativeContinuation:GraphMemberLossHeldSourceContinuation})))&{lease:GraphWitnessLease;originalLease:LeaseRecord};
export interface GraphHeldSourceDescriptor extends GraphMemberLossSourceEntry {packetHash:string;recordTransportHash:string;manifestEntry:GraphRecoverySourceManifest['entries'][number];materializationContext?:{v:1;contextHash:string;rewrapHash:string;bytes:number}}
const HELD_SOURCE_READER_TOKEN=Symbol('actual-held-source-reader');
const HELD_SOURCE_MUTATION_TOKEN=Symbol('actual-source-same-cut-mutation');
interface HeldSourceMutationBinding {snapshot:GraphMemberLossSourceSnapshot;preflight:GraphMemberLossHeldPreflight;progress:GraphNativeMemberLossProgress;coordinator:LeaseCoordinator;originalLease:LeaseRecord;intent:GraphMemberLossIntentProof}
interface HeldSourceMutation {assertCurrent():void;assertReadCurrent?():void;write(name:string,value:unknown,versioned?:boolean):void;checkpoint?():void;readRecord?(id:string):Promise<ConversationGraphReplicationRecord>;readCurrentRecord?(id:string):Promise<ConversationGraphReplicationRecord>;commit():void;abort():void}
/** Source-issued negative-held disk reader. Finalization is mandatory before
 * a consumer can produce a transfer acknowledgment; it grants no Source ACK. */
export class GraphHeldSourceReader {
 #closed=false;#finalized=false;#mutating=false;#releaseDebt=false;#readIds=new Set<string>();#privateViews=new Set<()=>boolean>();#viewLimit:number;#ids=new Set<string>();#byId=new Map<string,GraphHeldSourceDescriptor>();#descriptors:GraphHeldSourceDescriptor[];#check:()=>void;#final:()=>void;#close:()=>void;#read:(id:string)=>Promise<ConversationGraphReplicationRecord>;#page:(hash:string,index:number)=>ReturnType<ConversationGraphReplication['contextPage']>;#negative:()=>{erasures:GraphWitnessErasure[];localErasureTargets:GraphErasureIdentity[]};#mutation:(source:ConversationGraphReplication,eventId:string,binding?:HeldSourceMutationBinding)=>HeldSourceMutation;
 readonly stateRoot:string;readonly agentId:string;readonly machineId:string;readonly membershipHash:string;readonly intentHash:string;readonly nativeLeaseHash:string;readonly inventoryHash:string;readonly erasureInventoryHash:string;readonly capacityBytes:number;readonly acknowledgedPrefix:{sourceSequence:number;coreHash:string|null};
 constructor(token:symbol,value:{stateRoot:string;agentId:string;machineId:string;membershipHash:string;intentHash:string;nativeLeaseHash:string;inventoryHash:string;erasureInventoryHash:string;capacityBytes:number;acknowledgedPrefix:{sourceSequence:number;coreHash:string|null}},descriptors:GraphHeldSourceDescriptor[],check:()=>void,final:()=>void,read:(id:string)=>Promise<ConversationGraphReplicationRecord>,page:(hash:string,index:number)=>ReturnType<ConversationGraphReplication['contextPage']>,close:()=>void,negative:()=>{erasures:GraphWitnessErasure[];localErasureTargets:GraphErasureIdentity[]},mutation:(source:ConversationGraphReplication,eventId:string,binding?:HeldSourceMutationBinding)=>HeldSourceMutation){if(token!==HELD_SOURCE_READER_TOKEN)throw new Error('graph-held-source-actual-reader-required');Object.assign(this,value);this.stateRoot=value.stateRoot;this.agentId=value.agentId;this.machineId=value.machineId;this.membershipHash=value.membershipHash;this.intentHash=value.intentHash;this.nativeLeaseHash=value.nativeLeaseHash;this.inventoryHash=value.inventoryHash;this.erasureInventoryHash=value.erasureInventoryHash;this.capacityBytes=value.capacityBytes;this.acknowledgedPrefix=Object.freeze({...value.acknowledgedPrefix});this.#descriptors=descriptors;this.#viewLimit=Math.max(4,descriptors.length*4);this.#ids=new Set(descriptors.map(row=>row.eventId));this.#byId=new Map(descriptors.map(row=>[row.eventId,row]));this.#check=check;this.#final=final;this.#read=read;this.#page=page;this.#close=close;this.#negative=negative;this.#mutation=mutation;Object.freeze(this);}
 get closed():boolean{return this.#closed;}
 negativeInventory():{erasures:GraphWitnessErasure[];localErasureTargets:GraphErasureIdentity[]}{this.assertCurrent();const value=this.#negative();this.assertCurrent();return value;}
 assertCurrent():void{if(this.#closed)throw new Error('graph-held-source-reader-closed');if(this.#mutating)throw new Error('graph-held-source-reader-mutation-in-progress');try{this.#check();}catch(error){this.close();throw error;}}
 beginSourceHeldMutation(token:symbol,source:ConversationGraphReplication,eventId:string,binding?:HeldSourceMutationBinding):HeldSourceMutation{if(token!==HELD_SOURCE_MUTATION_TOKEN||!this.#ids.has(eventId))throw new Error('graph-held-source-actual-mutation-required');this.assertCurrent();const value=this.#mutation(source,eventId,binding);this.#mutating=true;let done=false;return{...(value.readCurrentRecord?{readCurrentRecord:async(id:string)=>{if(this.#closed||!this.#ids.has(id))throw new Error('graph-held-source-private-read-invalid');value.assertReadCurrent!();const record=await value.readCurrentRecord!(id);value.assertReadCurrent!();this.#privateViews.add(retainHeldPrivateView(this.stateRoot,record));return record;}}:{}),...(value.assertReadCurrent?{assertReadCurrent:()=>{if(this.#closed)throw new Error('graph-held-source-mutation-closed');value.assertReadCurrent!();}}:{}),...(value.checkpoint?{checkpoint:()=>{if(done||this.#closed)throw new Error('graph-held-source-mutation-closed');value.checkpoint!();}}:{}),...(value.readRecord?{readRecord:async(id:string)=>{if(done||this.#closed||!this.#ids.has(id))throw new Error('graph-held-source-mutation-read-invalid');const record=await value.readRecord!(id);value.assertCurrent();this.#privateViews.add(retainHeldPrivateView(this.stateRoot,record));this.#readIds.add(id);return record;}}:{}),assertCurrent:()=>{if(done||this.#closed)throw new Error('graph-held-source-mutation-closed');value.assertCurrent();},write:(name,body,versioned)=>{if(done||this.#closed)throw new Error('graph-held-source-mutation-closed');value.write(name,body,versioned);},commit:()=>{if(done)throw new Error('graph-held-source-mutation-closed');try{value.commit();this.#mutating=false;this.assertCurrent();done=true;this.#finalized=false;}catch(error){done=true;this.close();throw error;}},abort:()=>{if(done)return;done=true;value.abort();this.#mutating=false;this.close();}};}
 descriptor(eventId:string):GraphHeldSourceDescriptor{this.assertCurrent();const row=this.#byId.get(eventId);if(!row)throw new Error('graph-held-source-reader-unlisted-record');return structuredClone(row);}
 descriptors():readonly GraphHeldSourceDescriptor[]{this.assertCurrent();return Object.freeze(this.#descriptors.map(row=>Object.freeze(structuredClone(row))));}
 async readRecord(id:string):Promise<ConversationGraphReplicationRecord>{await new Promise(resolve=>setImmediate(resolve));this.assertCurrent();if(!this.#ids.has(id))throw new Error('graph-held-source-reader-unlisted-record');try{if(this.#privateViews.size>=this.#viewLimit)throw new Error('graph-held-source-private-view-capacity');const record=await this.#read(id);this.assertCurrent();this.#privateViews.add(retainHeldPrivateView(this.stateRoot,record));this.#readIds.add(id);return record;}catch(error){this.close();throw error;}}
 async contextPage(hash:string,index:number){this.assertCurrent();if(!this.#descriptors.some(row=>row.materializationContext?.contextHash===hash))throw new Error('graph-held-source-reader-unlisted-context');try{const page=await this.#page(hash,index);this.assertCurrent();return page;}catch(error){this.close();throw error;}}
 finalize():void{this.assertCurrent();if(this.#releaseDebt)throw new Error('graph-held-source-private-view-debt');if(this.#readIds.size!==this.#descriptors.length)throw new Error('graph-held-source-reader-incomplete');try{this.#final();this.assertCurrent();this.#finalized=true;}catch(error){this.close();throw error;}}
 assertFinalized():void{this.assertCurrent();if(this.#releaseDebt)throw new Error('graph-held-source-private-view-debt');if(!this.#finalized)throw new Error('graph-held-source-reader-not-finalized');try{this.#final();this.assertCurrent();}catch(error){this.close();throw error;}}
 /** Release only yielded private views after durable handoff. Descriptor/read
  * completeness and physical finalization remain mandatory and unchanged. */
 releasePrivateViews():void{let cleared=true;for(const release of this.#privateViews){if(release())this.#privateViews.delete(release);else cleared=false;}this.#releaseDebt=!cleared;if(!cleared)throw new Error('graph-held-source-private-view-debt');}
 close():void{if(this.#closed)return;this.#closed=true;this.#finalized=false;for(const release of this.#privateViews)release();this.#privateViews.clear();this.#readIds.clear();this.#ids.clear();this.#descriptors=[];this.#close();}
}
const MEMBER_LOSS_SOURCE_TOKEN=Symbol('actual-held-member-loss-source');
export class GraphMemberLossSourceSnapshot {
 #records:ConversationGraphReplicationRecord[];#borrowed:ConversationGraphReplicationRecord[]|null=null;#borrowedViews:Array<()=>void>=[];#entries:GraphMemberLossSourceEntry[];#check:()=>void;#closeDependencies:()=>void;#erasures:GraphWitnessErasure[];#localTargets:GraphErasureIdentity[];#closed=false;#mutating=false;#mutation?: (source:ConversationGraphReplication,binding:HeldSourceMutationBinding)=>HeldSourceMutation;
 readonly stateRoot:string;readonly machineId:string;readonly agentId:string;readonly membershipHash:string;readonly intentHash:string;readonly inventoryHash:string;readonly erasureInventoryHash:string;readonly capacityBytes:number;readonly capacityLimitBytes:number;readonly acknowledgedPrefix:{sourceSequence:number;coreHash:string|null};
 constructor(token:symbol,value:{stateRoot:string;machineId:string;agentId:string;membershipHash:string;intentHash:string;inventoryHash:string;erasureInventoryHash:string;capacityBytes:number;capacityLimitBytes:number;acknowledgedPrefix:{sourceSequence:number;coreHash:string|null}},records:ConversationGraphReplicationRecord[],entries:GraphMemberLossSourceEntry[],check:()=>void,negative:{erasures:GraphWitnessErasure[];localTargets:GraphErasureIdentity[]},closeDependencies:()=>void,mutation?:(source:ConversationGraphReplication,binding:HeldSourceMutationBinding)=>HeldSourceMutation){if(token!==MEMBER_LOSS_SOURCE_TOKEN)throw new Error('graph-member-loss-actual-source-proof-required');this.#records=records;this.#entries=entries;this.#check=check;this.#closeDependencies=closeDependencies;this.#mutation=mutation;this.#erasures=structuredClone(negative.erasures);this.#localTargets=structuredClone(negative.localTargets);Object.assign(this,value);this.stateRoot=value.stateRoot;this.machineId=value.machineId;this.agentId=value.agentId;this.membershipHash=value.membershipHash;this.intentHash=value.intentHash;this.inventoryHash=value.inventoryHash;this.erasureInventoryHash=value.erasureInventoryHash;this.capacityBytes=value.capacityBytes;this.capacityLimitBytes=value.capacityLimitBytes;this.acknowledgedPrefix=Object.freeze({...value.acknowledgedPrefix});Object.freeze(this);}
 assertCurrent():void{if(this.#closed)throw new Error('graph-member-loss-snapshot-closed');if(this.#mutating)throw new Error('graph-member-loss-snapshot-mutation-in-progress');try{this.#check();}catch(error){this.close();throw error;}}
 beginSourceHeldMutation(token:symbol,source:ConversationGraphReplication,binding:HeldSourceMutationBinding):HeldSourceMutation{if(token!==HELD_SOURCE_MUTATION_TOKEN||!this.#mutation||binding.snapshot!==this||!(binding.progress instanceof GraphNativeMemberLossProgress)||!(binding.preflight instanceof GraphMemberLossHeldPreflight)||!(binding.coordinator instanceof LeaseCoordinator))throw new Error('graph-member-loss-snapshot-actual-writer-required');this.assertCurrent();binding.preflight.assertSourceSnapshot(this);binding.progress.assertCurrentNativeContext(binding.coordinator,binding.originalLease);const value=this.#mutation(source,binding);this.#mutating=true;let done=false;return{...(value.assertReadCurrent?{assertReadCurrent:()=>{if(this.#closed)throw new Error('graph-member-loss-snapshot-writer-closed');value.assertReadCurrent!();}}:{}),assertCurrent:()=>{if(done||this.#closed)throw new Error('graph-member-loss-snapshot-writer-closed');value.assertCurrent();},write:(name,body,versioned)=>{if(done||this.#closed)throw new Error('graph-member-loss-snapshot-writer-closed');value.write(name,body,versioned);},commit:()=>{if(done||this.#closed)throw new Error('graph-member-loss-snapshot-writer-closed');try{value.commit();this.#mutating=false;this.assertCurrent();done=true;}catch(error){done=true;this.#mutating=false;this.close();throw error;}},abort:()=>{if(done)return;done=true;value.abort();this.#mutating=false;this.close();}};}
 get closed():boolean{return this.#closed;}
 close():void{if(this.#closed)return;this.#closed=true;for(const record of this.#records){clearHeldPrivateObject(record.encryptedSourceBundle??undefined);clearHeldPrivateObject(record.rewrap);record.encryptedSourceBundle=null;delete record.rewrap;}for(const release of this.#borrowedViews)release();this.#borrowedViews=[];if(this.#borrowed){if(Object.getOwnPropertyDescriptor(this.#borrowed,'length')?.writable)this.#borrowed.length=0;this.#borrowed=null;}this.#records=[];this.#erasures=[];this.#localTargets=[];this.#closed=true;this.#closeDependencies();}
 borrowRecords():ConversationGraphReplicationRecord[]{this.assertCurrent();if(!this.#borrowed){this.#borrowed=this.#records.map(cloneGraphRecord);try{for(const record of this.#borrowed)this.#borrowedViews.push(retainHeldPrivateView(this.stateRoot,record));}catch(error){this.close();throw error;}}this.assertCurrent();return this.#borrowed;}
 record(eventId:string):ConversationGraphReplicationRecord|null{this.assertCurrent();const found=this.#records.find(record=>record.packet.eventId===eventId);if(!found)return null;if(this.#borrowedViews.length>=GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES*4){this.close();throw new Error('graph-held-source-private-view-capacity');}const view=cloneGraphRecord(found);this.#borrowedViews.push(retainHeldPrivateView(this.stateRoot,view));this.assertCurrent();return view;}
 get records():ConversationGraphReplicationRecord[]{this.assertCurrent();return this.#records.map(cloneGraphRecord);}
 get entries():GraphMemberLossSourceEntry[]{this.assertCurrent();return structuredClone(this.#entries);}
 get erasures():GraphWitnessErasure[]{this.assertCurrent();return structuredClone(this.#erasures);}
 get localErasureTargets():GraphErasureIdentity[]{this.assertCurrent();return structuredClone(this.#localTargets);}
}
export interface GraphReplicationStatus {
  state: 'prepared' | 'certified' | 'committed' | 'canceled' | 'erased' | 'quarantined';
  missingMembers: string[];
  erased: boolean;
}
export interface GraphCommitProofDeliveryReceipt {
  v: 1; agentId: string; eventId: string; operationHash: string; certificateHash: string;
  certificatePersistenceReceiptsHash: string; materializationHash:string|null; machineId: string; membershipEpoch: number; leaseEpoch: number;
  persistedAt: string; signature: string;
}
export const GRAPH_COMMIT_PROOF_DELIVERY_DOMAIN = 'graph-commit-proof-delivery-v1';
export interface GraphDeliveryCompletionReceipt {
 v:1;agentId:string;eventId:string;operationHash:string;certificateHash:string;deliveryFactsHash:string;
 materializationHash:string|null;membershipEpoch:number;leaseEpoch:number;machineId:string;persistedAt:string;signature:string;
}
export const GRAPH_DELIVERY_COMPLETION_DOMAIN='graph-delivery-completion-v1';
export function verifyGraphCommitProofDeliveryReceipt(receipt: GraphCommitProofDeliveryReceipt, record: ConversationGraphReplicationRecord,trust?:GraphMaterializationTrust): boolean {
  try {
    const terminal = record.certificate ?? record.cancellationCertificate;
    const membership = record.materialization?.activation.newMembership??record.adoption?.newMembership ?? record.authorizationProof.membership;
    const member = membership.members.find(m => m.machineId === receipt.machineId);
    const context = record.materialization?{membershipEpoch:membership.epoch,leaseEpoch:record.materialization.currentLease.leaseEpoch}:record.adoption ? {membershipEpoch:membership.epoch,leaseEpoch:record.adoption.currentLease.leaseEpoch} : undefined;
    if (!terminal || !member || Object.keys(receipt).sort().join(',') !== 'agentId,certificateHash,certificatePersistenceReceiptsHash,eventId,leaseEpoch,machineId,materializationHash,membershipEpoch,operationHash,persistedAt,signature,v'
      || receipt.v !== 1 || receipt.agentId !== record.packet.agentId || receipt.eventId !== record.packet.eventId
      || receipt.operationHash !== canonicalHash(record.packet) || receipt.certificateHash !== canonicalHash(terminal)
      ||receipt.materializationHash!==(record.materialization?canonicalHash(graphHistoricalMaterializationRef(record.materialization)):null)
      || receipt.membershipEpoch !== membership.epoch || receipt.leaseEpoch !== (context?.leaseEpoch ?? record.packet.leaseEpoch)
      || !Number.isFinite(Date.parse(receipt.persistedAt))) return false;
    const receipts = [...(record.certificatePersistenceReceipts ?? [])].sort((a,b)=>a.machineId.localeCompare(b.machineId));
    if(record.materialization){
      if(!trust||!verifyGraphHistoricalMaterialization(record.materialization,record,trust)
        ||receipt.certificatePersistenceReceiptsHash!==canonicalHash(record.materialization.activation.stateTransferReceipts))return false;
    }else if (receipt.certificatePersistenceReceiptsHash !== canonicalHash(receipts)
      || new Set(receipts.map(r=>r.machineId)).size !== receipts.length
      || receipts.length !== membership.members.length
      || !membership.members.every(m=>receipts.some(r=>r.machineId===m.machineId && verifyMemberReceipt(r,record.packet,membership,'certificate',canonicalHash(terminal),context)))) return false;
    return verifyGraphRecord(GRAPH_COMMIT_PROOF_DELIVERY_DOMAIN,unsigned(receipt),receipt.signature,member.signingPublicKey);
  } catch { /* @silent-fallback-ok: cryptographic predicate refuses malformed/unverifiable input; no authority or alternate source is granted. */ return false; }
}

interface Stored {
  record: ConversationGraphReplicationRecord;
  sourceReceipt: GraphMemberReceipt|null;
  originalSourceReceipt?:GraphMemberReceipt|null;
  certificateReceipts: Map<string, GraphMemberReceipt>;
  emittedHash: string | null;
  quarantine: string | null;
}

/** Structure only at the journal receive boundary. Cryptographic authorization
 * is deliberately rechecked against pinned trust before projection or a receipt. */
export function validateGraphReplicationRecord(raw: unknown,localDenial?:{isDenied(target:GraphErasureIdentity):boolean}): ConversationGraphReplicationRecord | null {
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const r = raw as ConversationGraphReplicationRecord;
    if (!validatePacket(r.packet) || r.coreType!==r.packet.coreType || typeof r.packetSignature !== 'string' || !r.core || typeof r.core !== 'object' || Array.isArray(r.core)
      || !r.authorizationProof || typeof r.authorizationProof !== 'object') return null;
    if (r.encryptedSourceBundle !== null && (!r.encryptedSourceBundle || r.encryptedSourceBundle.v !== 1
      || r.encryptedSourceBundle.algorithm !== 'aes-256-gcm+x25519-hkdf-sha256'
      || !Array.isArray(r.encryptedSourceBundle.envelopes))) return null;
    if (r.encryptedSourceBundle) {
      const bundle = r.encryptedSourceBundle;
      const b64 = (value: unknown) => typeof value === 'string' && /^[A-Za-z0-9_-]*$/.test(value)
        && Buffer.from(value, 'base64url').toString('base64url') === value;
      if (Object.keys(bundle).sort().join(',') !== 'algorithm,ciphertext,envelopes,nonce,tag,v'
        || !b64(bundle.ciphertext) || !b64(bundle.nonce) || !b64(bundle.tag)) return null;
      for (const envelope of bundle.envelopes) {
        if (Object.keys(envelope).sort().join(',') !== 'ciphertext,ephemeralPublicKey,machineId,nonce,tag'
          || !opaque(envelope.machineId) || !b64(envelope.ciphertext) || !b64(envelope.nonce) || !b64(envelope.tag)
          || crypto.createPublicKey(envelope.ephemeralPublicKey).asymmetricKeyType !== 'x25519') return null;
      }
    }
    if (r.encryptedSourceBundle === null && !r.erasure&&!r.cancellation && r.adoption?.disposition !== 'refused'&&!localDenial?.isDenied(r.packet.erasureIdentity)) return null;
    const known = new Set(['coreType', 'packet', 'packetSignature', 'core', 'authorizationProof', 'encryptedSourceBundle', 'adoption', 'rewrap', 'materialization', 'preparationProof', 'erasedControlProof', 'custodyMembership', 'custodyActivations', 'certificate', 'certificatePersistenceReceipts', 'commitProofDeliveryReceipts', 'cancellation', 'cancellationCertificate', 'erasure']);
    if (Object.keys(r).some((key) => !known.has(key))) return null;
    if(r.materialization&&!(r.materialization instanceof GraphSelectedMaterializationV2)&&graphMaterializationContextSize(r.materialization)>GRAPH_CONTEXT_MAX_BYTES)return null;
    const bounded=r.materialization?{...r,materialization:graphMaterializationReference(r.materialization)}:r;
    if (Buffer.byteLength(canonicalJson(bounded)) > GRAPH_REPLICATION_MAX_RECORD_BYTES) return null;
    return r;
  } catch { /* @silent-fallback-ok: strict source parser refuses malformed input; null is explicit validation failure. */ return null; }
}

export const CONVERSATION_GRAPH_REPLICATION_SCHEMA: StoreFieldSchema = {
  knownFields: ['descriptor'],
  validate(raw) {
    if (raw.op !== 'put') return null; // immutable source events are never LWW-deleted
    const descriptor = validateGraphReplicationDescriptor(raw.descriptor);
    if (!descriptor || raw.recordKey !== descriptor.eventId || raw.origin !== descriptor.origin) return null;
    return { descriptor };
  },
};
export function registerConversationGraphReplication(registry: ReplicatedKindRegistry): void {
  registry.register({ kind: CONVERSATION_GRAPH_JOURNAL_KIND, store: CONVERSATION_GRAPH_STORE,
    schema: CONVERSATION_GRAPH_REPLICATION_SCHEMA });
}

export class ConversationGraphReplication {
  readonly erasureAuthorities:ConversationGraphErasureAuthorityStore;
  private readonly records = new Map<string, Stored>();
  private readonly inFlight = new Map<string, string>();
  private readonly erasureProofs:GraphWitnessErasure[]=[];
  private readonly pendingErasureTargets=new Map<string,Set<string>>();
  private readonly historyOperationIds=new Set<string>();
  private readonly controlTargets=new Map<string,Set<string>>();
  private readonly deliveryCompletionReceipts=new Map<string,Map<string,GraphDeliveryCompletionReceipt>>();
  private readonly deliveryReceipts = new Map<string, Map<string, GraphCommitProofDeliveryReceipt>>();
  private durableGeneration=0;
  private historicalAncestorsFlushed=false;
  private readonly heldSourceReaders=new Set<WeakRef<GraphHeldSourceReader>>();
  private readonly heldImports=new Map<string,{name:string;eventId:string;stageHash:string;priorCanonical:boolean;hash:string}>();
  private heldCatalogMetadataBytes=0;
  private readonly heldPlans=new Map<string,{name:string;stageHash:string;hash:string}>();
  private readonly heldPromotionProofs=new Set<WeakRef<GraphHeldOriginalPromotionProof>>();
  #pagedHistorical:Readonly<GraphPagedHistoricalBinding>|null=null;
  private readonly pagedHeldCatalogs=new Map<string,{eventId:string;contextHash:string;hash:string}>();
  private readonly pagedHeldProofs=new Set<WeakRef<GraphPagedHistoricalHeldProof>>();
  private readonly heldReadSessions=new Map<string,WeakRef<GraphHeldSenderReadSession>>();
  #heldNegativeContext:Readonly<{reader:ReplicatedStoreReader;dropped:DroppedOriginRegistry;root:string}>|null=null;
  private readonly memberLossSnapshots=new Set<WeakRef<GraphMemberLossSourceSnapshot>>();
  private historicalImportAuthority:GraphCustodyProfileAuthority|null=null;
  private historicalImportMembership:GraphMembershipEpoch|null=null;
  private historicalImportActivationHash:string|null=null;
  private historicalReopen:{generation:number;activationHash:string;manifestHash:string;source:Promise<ConversationGraphReplication>}|null=null;
  private readonly historicalContextFiles=new Map<string,string>();
  private queue: Promise<unknown> = Promise.resolve();
  private openingPayloadNames:Map<string,string[]>|null=null;
  private readonly contexts:ConversationGraphMaterializationContexts;
  private readonly verifiedContexts=new WeakMap<object,{owner:crypto.KeyLike;witness:crypto.KeyLike;entries:Map<string,GraphHistoricalMaterialization['manifest']['entries'][number]>;inventory:Map<string,GraphHistoricalMaterialization['rewrapInventory'][number]>}>();
  private constructor(private readonly options: ConversationGraphReplicationOptions) {this.contexts=new ConversationGraphMaterializationContexts(path.join(options.directory,'contexts'));this.erasureAuthorities=new ConversationGraphErasureAuthorityStore(path.join(options.directory,'erasure-authorities'),options.installedMembership,options.ownerPublicKey,options.witnessPublicKeys);}

  static async open(options: ConversationGraphReplicationOptions,mode:'normal'|'verify-only'='normal',historicalAuthority?:GraphCustodyProfileAuthority): Promise<ConversationGraphReplication> {
    if (!opaque(options.agentId) || !opaque(options.machineId) || !options.writeAdmission
      || typeof options.writeAdmission.guardStoreWrite !== 'function' || typeof options.legacyReadOnly !== 'function'
      || typeof options.liveAdmission !== 'function'
      || typeof options.validateCore !== 'function') throw new Error('graph-replication-invalid-options');
    if(options.installedMembership&&(!verifyMembershipEpoch(options.installedMembership,options.ownerPublicKey)||options.installedMembership.agentId!==options.agentId))throw new Error('graph-replication-invalid-installed-membership');
    if(options.maxHistoryEntries!==undefined&&(!Number.isSafeInteger(options.maxHistoryEntries)||options.maxHistoryEntries<1||options.maxHistoryEntries>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES))throw new Error('graph-source-history-budget-invalid');
    const store = new ConversationGraphReplication(options);
    await fs.mkdir(options.directory, { recursive: true, mode: 0o700 });
    if(options.pagedHistorical){store.#pagedHistorical=Object.freeze({...options.pagedHistorical});store.pagedBinding();}
    if(historicalAuthority)store.installHistoricalImportAuthority(historicalAuthority);
    await store.loadHeldImports();
    for(const reference of store.heldImports.values()){const c=store.validateHeldCatalog(store.heldRead(reference.name),reference.name),r=c.recordControl as unknown as ConversationGraphReplicationRecord;if(store.isErased(r.packet.erasureIdentity)){await store.purgePayloadFiles(c.eventId);continue;}for(const [name,expected]of [[store.file(c.eventId,'bundle'),r.packet.sourceBundleHash],...[c.oldRewrapHash,c.newRewrapHash].filter((value):value is string=>!!value).map(value=>[store.rewrapFile(c.eventId,value),value])] as Array<[string,string]>){try{if(canonicalHash(store.heldRead(name))!==expected)throw new Error('graph-held-original-restored-payload-invalid');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}}

    for(const name of await fs.readdir(options.directory))if(name.endsWith('.source.json')||name.endsWith('.intent.json'))store.rememberControl(await store.load(name) as ConversationGraphReplicationRecord);
    for(const name of (await fs.readdir(options.directory)).filter(name=>/^global-erasure-[a-f0-9]{64}\.json$/.test(name))){const proof=await store.load(name) as GraphWitnessErasure;await store.erasureAuthorities.restore(proof);await store.applyErasure(proof);}
    await store.loadPagedHeld();
    // A body without either durable acceptance control or publication intent
    // never earned a member receipt. Remove old interrupted experimental copies.
    const openingNames=await fs.readdir(options.directory),attributed=new Set([...openingNames.filter(name=>name.endsWith('.source.json')||name.endsWith('.intent.json')).map(name=>name.slice(0,64)),...[...store.heldImports.values()].map(c=>graphReplicationFileStem(c.eventId)),...[...store.pagedHeldCatalogs.values()].map(c=>graphReplicationFileStem(c.eventId))]);
    for(const name of openingNames)if(/^[a-f0-9]{64}\.(?:bundle\.json|rewrap-[a-f0-9]{64}\.json)/.test(name)&&!attributed.has(name.slice(0,64)))store.removeBundle(name);
    const sourceNames=await fs.readdir(options.directory);store.openingPayloadNames=new Map();
    for(const name of sourceNames)if(/^[a-f0-9]{64}\.(?:bundle\.json|rewrap-[a-f0-9]{64}\.json)/.test(name)){const stem=name.slice(0,64),list=store.openingPayloadNames.get(stem)??[];list.push(name);store.openingPayloadNames.set(stem,list);}
    for (const name of sourceNames.filter((n) => n.endsWith('.source.json')).sort()) {
      const raw = await store.load(name) as Pick<ConversationGraphReplicationRecord, 'coreType' | 'packet' | 'packetSignature' | 'core' | 'authorizationProof'> | null;
      if (!raw || !validatePacket(raw.packet)) throw new Error('graph-replication-corrupt-source');
      const key = raw.packet.eventId;
      const bundleName = store.file(key, 'bundle');
      const bundle = await store.load(bundleName);
      const erasure = await store.load(store.file(key, 'erasure')) as GraphWitnessErasure | null ?? store.erasureProofs.find(proof=>erasureCoversPacket(proof,raw.packet)) ?? null;
      if(erasure)await store.save(store.file(key,'erasure'),erasure);
      const record: ConversationGraphReplicationRecord = { ...raw, encryptedSourceBundle: bundle as GraphEncryptedBundle | null };
      const recovery = await store.load(store.file(key, 'adoption')) as {adoption: GraphAdoptionCertificate; cancellation?: GraphWitnessCancellation} | null;
      const adoption = recovery?.adoption;
      if(adoption)record.adoption=adoption;
      const storedMaterialization=await store.load(store.file(key,'materialization'));
      const materialization=storedMaterialization?(validateGraphMaterializationReference(storedMaterialization)?await store.contexts.hydrate(storedMaterialization):storedMaterialization as GraphHistoricalMaterialization):null;if(materialization)record.materialization=materialization;
      const rewrapHash=materialization?.rewrapHash??adoption?.rewrapHash;if(rewrapHash){const rewrap=await store.load(store.rewrapFile(key,rewrapHash)) as GraphBundleRewrap|null;if(rewrap)record.rewrap=rewrap;}
      if (recovery?.cancellation) record.cancellation = recovery.cancellation;
      const earlyCancellation=await store.load(store.file(key,'cancellation')) as GraphWitnessCancellation|null;if(earlyCancellation&&!record.cancellation)record.cancellation=earlyCancellation;
      const locallyDenied=options.localErasure?.isDenied(record.packet.erasureIdentity)??false;
      // Local suppression augments the signed terminal authority; it must never
      // hide the tombstone needed to verify erased-control custody on restart.
      if(erasure){if(!store.validErasure(record,erasure))throw new Error('graph-replication-invalid-erasure');record.erasure=erasure;}
      if(locallyDenied||erasure){record.encryptedSourceBundle=null;delete record.rewrap;await store.purgePayloadFiles(key);}
      else if (bundle) {
        if (canonicalHash(bundle) !== record.packet.sourceBundleHash) throw new Error('graph-replication-bundle-corrupt');
        record.encryptedSourceBundle = bundle as GraphEncryptedBundle;

      } else if (adoption?.disposition !== 'refused'&&!record.cancellation) throw new Error('graph-replication-bundle-missing');
      const preparation = await store.load(store.file(key, 'preparation')) as GraphWitnessPrepareProof | null;
      if (preparation) record.preparationProof = preparation;
      const erasedControl=await store.load(store.file(key,'erased-control')) as {proof:GraphWitnessErasedControlProof;membership:GraphMembershipEpoch;activations?:GraphMembershipActivationCertificate[]}|null;if(erasedControl){record.erasedControlProof=erasedControl.proof;record.custodyMembership=erasedControl.membership;if(erasedControl.activations)record.custodyActivations=erasedControl.activations;}
      const certificate = await store.load(store.file(key, 'certificate')) as GraphCommitCertificate | null;
      if (certificate) {
        if (!store.validCertificate(record, certificate)) throw new Error('graph-replication-certificate-corrupt');
        record.certificate = certificate;
      }
      const cancellation = await store.load(store.file(key, 'cancellation')) as GraphWitnessCancellation | null;
      if (cancellation && !recovery?.cancellation) record.cancellation = cancellation;
      const cancellationCertificate = await store.load(store.file(key, 'terminal')) as GraphCancellationCertificate | null;
      if (cancellationCertificate) record.cancellationCertificate = cancellationCertificate;
      if(store.heldImportBlocks(record))continue;
      if (!store.verify(record, record.packet.writerId)) throw new Error('graph-replication-untrusted-source');
      if(record.encryptedSourceBundle&&adoption?.disposition!=='refused'&&!locallyDenied)store.checkLocalRecovery(record);
      if(materialization&&!validateGraphMaterializationReference(storedMaterialization)){if(mode==='verify-only')throw new Error('graph-history-import-reference-required');const reference=await store.contexts.persistVerified(materialization);await store.save(store.file(key,'materialization'),reference);record.materialization=await store.contexts.hydrate(reference);}
      const takeoverStorage=await store.load(store.file(key,'takeover-storage'));const takeoverOnly=!!takeoverStorage&&store.validTakeoverStorage(takeoverStorage,record)&&!record.adoption&&!record.certificate;
      if(takeoverStorage&&!store.validTakeoverStorage(takeoverStorage,record))throw new Error('graph-native-takeover-storage-invalid');
      let sourceReceipt = await store.load(store.file(key, 'receipt')) as GraphMemberReceipt | null;
      if(sourceReceipt&&sourceReceipt.machineId!==options.machineId)throw new Error('graph-replication-local-receipt-machine-mismatch');
      const retainedOriginal=await store.load(store.file(key,'original-receipt')) as GraphMemberReceipt|null;
      if(retainedOriginal&&(retainedOriginal.machineId!==options.machineId||!verifyMemberReceipt(retainedOriginal,record.packet,record.authorizationProof.membership,'source')))throw new Error('graph-replication-original-receipt-invalid');
      const originalSourceReceipt=retainedOriginal??(sourceReceipt?.phase==='source'&&verifyMemberReceipt(sourceReceipt,record.packet,record.authorizationProof.membership,'source')?structuredClone(sourceReceipt):null);
      const cancellationReceipt = await store.load(store.file(key, 'cancellation-receipt')) as GraphMemberReceipt | null;
      if(cancellationReceipt){if(!store.validLocalReceipt(record,cancellationReceipt)||cancellationReceipt.phase!=='cancellation')throw new Error('graph-replication-cancellation-receipt-invalid');sourceReceipt=cancellationReceipt;}
      // A crash after immutable source fsync but before receipt fsync can be
      // repaired locally. Erased history must reuse its historical certificate
      // receipt, never create a fresh claim that removed content was persisted.
      if (sourceReceipt && !store.validLocalReceipt(record, sourceReceipt)) sourceReceipt = null;
      if(!sourceReceipt&&!materialization&&!locallyDenied&&!takeoverOnly&&store.hasPagedHistoryHold()){if(originalSourceReceipt&&store.validLocalReceipt(record,originalSourceReceipt))sourceReceipt=structuredClone(originalSourceReceipt);else throw new Error('graph-paged-history-recovery-export-unavailable');}
      if (!sourceReceipt && !materialization&&!locallyDenied&&!takeoverOnly) {
        if(mode==='verify-only')throw new Error('graph-history-import-original-receipt-missing');
        if(originalSourceReceipt)await store.save(store.file(key,'original-receipt'),originalSourceReceipt,true);
        const capacity=await store.reserveOriginalCapacity(record);if(capacity)store.verifyDurableOriginalCapacity(record,capacity).assertCurrent();
        sourceReceipt = record.cancellation ? store.receipt(record, 'cancellation', canonicalHash(record.cancellation))
          : erasure ? record.certificate?.memberReceipts.find((r) => r.machineId === options.machineId) ?? store.receipt(record,'cancellation',canonicalHash(erasure)) : store.receipt(record, 'source');
        if (sourceReceipt) await store.save(store.file(key,sourceReceipt.phase==='cancellation'?'cancellation-receipt':'receipt'), sourceReceipt);
      }
      if (!materialization&&!locallyDenied&&!takeoverOnly&&(!sourceReceipt || sourceReceipt.machineId !== options.machineId
        || !store.validLocalReceipt(record, sourceReceipt))) throw new Error('graph-replication-receipt-missing');
      const acks = await store.load(store.file(key, 'acks')) as GraphMemberReceipt[] | null;
      const validAcks = new Map<string, GraphMemberReceipt>();
      const terminal = store.terminal(record);
      for (const receipt of acks ?? []) if (terminal && verifyMemberReceipt(receipt, record.packet,
        store.certificateMembership(record), 'certificate', canonicalHash(terminal), store.certificateContext(record))) validAcks.set(receipt.machineId, receipt);
      const emitted = await store.load(store.file(key, 'emitted')) as { publicationHash?: string } | null;
      const quarantine = await store.load(store.file(key, 'quarantine')) as { reason?: string } | null;
      if (validAcks.size) record.certificatePersistenceReceipts = [...validAcks.values()].sort((a, b) => a.machineId.localeCompare(b.machineId));
      const deliveries = await store.load(store.file(key, 'deliveries')) as GraphCommitProofDeliveryReceipt[] | null;
      const validDeliveries = new Map<string, GraphCommitProofDeliveryReceipt>();
      for (const receipt of deliveries ?? []) if (verifyGraphCommitProofDeliveryReceipt(receipt,record,{ownerPublicKey:options.ownerPublicKey,witnessPublicKeys:options.witnessPublicKeys})) validDeliveries.set(receipt.machineId,receipt);
      store.deliveryReceipts.set(key,validDeliveries);if(validDeliveries.size===store.effectiveMembership(record).members.length)record.commitProofDeliveryReceipts=[...validDeliveries.values()].sort((a,b)=>a.machineId.localeCompare(b.machineId));
      const completed=await store.load(store.file(key,'delivery-completions')) as GraphDeliveryCompletionReceipt[]|null;const validCompleted=new Map<string,GraphDeliveryCompletionReceipt>();for(const receipt of completed??[])if(store.verifyDeliveryCompletionReceipt(receipt,record))validCompleted.set(receipt.machineId,receipt);store.deliveryCompletionReceipts.set(key,validCompleted);
      store.records.set(key, { record, sourceReceipt, originalSourceReceipt, certificateReceipts: validAcks,
        emittedHash: emitted?.publicationHash ?? null, quarantine: quarantine?.reason ?? null });
    }
    store.openingPayloadNames=null;return store;
  }

  /** NEW local writes only. A standby cannot append through a background path. */
  appendLocal(record: ConversationGraphReplicationRecord): Promise<{ receipt: GraphMemberReceipt; stillAdmitted: boolean }> {
    return this.serial(async () => {
      if (!this.admitted(record)) throw new Error('graph-write-refused');
      const receipt = await this.persist(record, record.packet.writerId);
      return { receipt, stillAdmitted: this.admitted(record) };
    });
  }

  /** A concrete fsynced reservation survives a same-writer native renewal before
   * source intake. It cannot authorize a new epoch/holder without adoption. */
  appendReserved(record:ConversationGraphReplicationRecord,intake:ConversationGraphIntake,lease:GraphWitnessLease,originalLease:LeaseRecord):Promise<void>{
    return this.serial(async()=>{
      if(!(intake instanceof ConversationGraphIntake)||!this.verify(record,record.packet.writerId)
        ||!this.mayActuateRecord(record,lease,originalLease))throw new Error('graph-reservation-write-fenced');
      const reserved=(await intake.reservations()).find(row=>row.packet.idempotencyKey===record.packet.idempotencyKey);
      if(!reserved||canonicalHash(reserved)!==canonicalHash(record))throw new Error('graph-reservation-not-durable');
      await this.persist(record,record.packet.writerId);
    });
  }

  /** Historical receive has no current-epoch test; the signed original proof is
   * the authority. A delayed valid epoch-1 event can therefore repair epoch 2. */
  receive(record: ConversationGraphReplicationRecord, envelopeOrigin: string): Promise<GraphMemberReceipt> {
    if(record.materialization)return Promise.reject(new Error('graph-history-receipt-not-source'));
    return this.serial(() => this.persist(record, envelopeOrigin));
  }

  /** Historical repair of a frozen Intake tail does not manufacture an old
   * source ACK. The signed marker records local storage only. */
  receiveNativeTakeover(record:ConversationGraphReplicationRecord):Promise<void>{return this.serial(async()=>{
    if(record.materialization instanceof GraphSelectedMaterializationV2||this.hasPagedHistoryHold())throw new Error('graph-paged-history-recovery-export-unavailable');
    if(!this.verify(record,record.packet.writerId)||record.preparationProof||record.adoption||record.certificate||record.cancellation||record.erasure||this.isErased(record.packet.erasureIdentity))throw new Error('graph-native-takeover-source-invalid');
    this.historicalImportAuthority?.assertMemberLossRepairAllowed(record);
    const existing=this.records.get(record.packet.eventId);if(existing){if(canonicalHash(this.immutable(existing.record))!==canonicalHash(this.immutable(record)))throw new Error('graph-native-takeover-source-conflict');return;}
    await this.assertNewHistoryCapacity(record.packet.eventId);this.checkLocalRecovery(record);
    const body={v:1,agentId:this.options.agentId,machineId:this.options.machineId,operationHash:canonicalHash(record.packet)};
    await this.save(this.file(record.packet.eventId,'intent'),this.immutable(record),true);this.rememberControl(record);
    await this.save(this.file(record.packet.eventId,'takeover-storage'),{...body,signature:signGraphRecord('graph-native-takeover-storage-v1',body,this.options.memberPrivateKey)},true);
    await this.save(this.file(record.packet.eventId,'bundle'),record.encryptedSourceBundle,true);
    if(this.isErased(record.packet.erasureIdentity)){await this.purgePayloadFiles(record.packet.eventId);throw new Error('graph-source-erasure-raced-publication');}
    await this.save(this.file(record.packet.eventId,'source'),this.immutable(record),true);
    this.records.set(record.packet.eventId,{record:cloneGraphRecord(record),sourceReceipt:null,certificateReceipts:new Map(),emittedHash:null,quarantine:null});
  });}
  private validTakeoverStorage(raw:unknown,record:ConversationGraphReplicationRecord):boolean{
    const value=raw as {v:number;agentId:string;machineId:string;operationHash:string;signature:string};const member=record.authorizationProof.membership.members.find(row=>row.machineId===this.options.machineId);
    return !!value&&Object.keys(value).sort().join(',')==='agentId,machineId,operationHash,signature,v'&&value.v===1&&value.agentId===this.options.agentId&&value.machineId===this.options.machineId&&value.operationHash===canonicalHash(record.packet)&&!!member&&verifyGraphRecord('graph-native-takeover-storage-v1',unsigned(value),value.signature,member.signingPublicKey);
  }
  nativeTakeoverCustodyReceipt(eventId:string,lease:GraphWitnessLease,originalLease:LeaseRecord,closures:GraphNativeTailClosure[]):Promise<GraphNativeTakeoverCustodyReceipt>{return this.serial(async()=>{
    if(this.hasPagedHistoryHold())throw new Error('graph-paged-history-recovery-export-unavailable');
    const record=this.records.get(eventId)?.record,membership=this.options.installedMembership,live=this.options.liveAdmission(),guard=this.options.writeAdmission.guardStoreWrite('conversationGraph.append');
    if(!record||!membership||!this.verify(record,record.packet.writerId)||this.isErased(record.packet.erasureIdentity)||guard.enforce==='refuse'||!live.admitted||lease.writerId!==this.options.machineId||live.writerId!==this.options.machineId||live.membershipEpoch!==membership.epoch||live.leaseEpoch!==lease.leaseEpoch||live.fencedLeaseHash!==lease.fencedLeaseHash||!verifyFencedLeaseBridge(lease,originalLease,membership)||!verifyWitnessLease(lease,membership,(this.options.now?.()??new Date()).getTime())||!verifyGraphNativeTailBarrier(closures,membership,lease))throw new Error('graph-native-takeover-custody-fenced');
    this.checkLocalRecovery(record);await this.save(this.file(eventId,'bundle'),record.encryptedSourceBundle,true);if(this.isErased(record.packet.erasureIdentity)){await this.purgePayloadFiles(eventId);throw new Error('graph-source-erasure-raced-publication');}await this.save(this.file(eventId,'source'),this.immutable(record),true);
    const value={v:1 as const,agentId:record.packet.agentId,eventId,operationHash:canonicalHash(record.packet),sourceProofHash:canonicalHash({coreType:record.coreType,packet:record.packet,packetSignature:record.packetSignature,core:record.core,authorizationProof:record.authorizationProof}),sourceBundleHash:record.packet.sourceBundleHash,controlHash:record.packet.controlHash,membershipHash:canonicalHash(membership),currentLeaseHash:canonicalHash(lease),closedTailsHash:graphNativeClosedTailsHash(closures),machineId:this.options.machineId,persistedAt:(this.options.now?.()??new Date()).toISOString()};
    const receipt={...value,signature:signGraphRecord(GRAPH_NATIVE_TAKEOVER_CUSTODY_DOMAIN,value,this.options.memberPrivateKey)};await this.save(this.file(eventId,'takeover-custody'),receipt);if(this.isErased(record.packet.erasureIdentity))throw new Error('graph-source-erasure-raced-receipt');return receipt;
  });}
  /** Storage-only target authorized by a genuine durable ACT. This never
   * changes installed positive membership, live admission or serving readiness. */
  /** Actual local custody scope only, never positive authority or a receipt. */
  assertLocalCustodyContext(context:{stateRoot:string;agentId:string;machineId:string;authority:GraphCustodyProfileAuthority}):void{
    const authority=context.authority;if(!(authority instanceof GraphCustodyProfileAuthority)||realpathSync(context.stateRoot)!==authority.stateRoot||realpathSync(this.options.directory)!==path.join(authority.stateRoot,'state','conversation-graph-source')||context.agentId!==this.options.agentId||authority.agentId!==context.agentId||context.machineId!==this.options.machineId||!(this.options.localErasure instanceof ConversationGraphLocalErasureFence)||this.options.localErasure.stateRoot!==authority.stateRoot)throw new Error('graph-source-local-custody-scope-mismatch');
    const publicKey=(key:crypto.KeyLike)=>key instanceof crypto.KeyObject&&key.type==='public'?key:crypto.createPublicKey(key),same=(a:crypto.KeyLike,b:crypto.KeyLike)=>publicKey(a).export({type:'spki',format:'der'}).equals(publicKey(b).export({type:'spki',format:'der'}));if(!same(authority.ownerPublicKey,this.options.ownerPublicKey))throw new Error('graph-source-local-custody-owner-mismatch');
    const lineage=authority.verifiedNegativeRoleLineage(),activations=[...lineage.activations,...lineage.memberLossActivations],member=lineage.current.members.find(row=>row.machineId===context.machineId);if(!member||!same(member.signingPublicKey,this.options.memberPrivateKey)||!same(member.sealingPublicKey,this.options.memberSealingPrivateKey)||!this.options.installedMembership||![lineage.genesis,...activations.map(row=>row.certificate.newMembership)].some(known=>canonicalHash(known)===canonicalHash(this.options.installedMembership)))throw new Error('graph-source-local-custody-member-mismatch');
    if(this.historicalImportAuthority){if(this.historicalImportAuthority!==authority)throw new Error('graph-source-local-custody-authority-mismatch');this.currentHistoricalImportMembership();}
  }
  installHistoricalImportAuthority(authority:GraphCustodyProfileAuthority):void{
    const owner=this.options.ownerPublicKey instanceof crypto.KeyObject&&this.options.ownerPublicKey.type==='public'?this.options.ownerPublicKey:crypto.createPublicKey(this.options.ownerPublicKey);
    if(!(authority instanceof GraphCustodyProfileAuthority)||authority.agentId!==this.options.agentId||realpathSync(this.options.directory)!==path.join(authority.stateRoot,'state','conversation-graph-source')||!crypto.createPublicKey(authority.ownerPublicKey).export({type:'spki',format:'der'}).equals(owner.export({type:'spki',format:'der'}))||this.historicalImportAuthority&&this.historicalImportAuthority!==authority)throw new Error('graph-history-import-actual-authority-mismatch');
    const lineage=authority.verifiedNegativeRoleLineage(),membership=lineage.current;
    if(![...lineage.activations,...lineage.memberLossActivations].some(row=>canonicalHash(row.certificate.newMembership)===canonicalHash(membership))||!membership.members.some(member=>member.machineId===this.options.machineId))throw new Error('graph-history-import-activation-missing');
    if(this.options.installedMembership&&!([lineage.genesis,...[...lineage.activations,...lineage.memberLossActivations].map(row=>row.certificate.newMembership)].some(known=>canonicalHash(known)===canonicalHash(this.options.installedMembership))))throw new Error('graph-history-import-installed-lineage-mismatch');
    const activation=[...lineage.activations,...lineage.memberLossActivations].find(row=>canonicalHash(row.certificate.newMembership)===canonicalHash(membership))!;
    this.historicalImportAuthority=authority;this.historicalImportMembership=structuredClone(membership);this.historicalImportActivationHash=canonicalHash(activation.certificate);this.historicalReopen=null;
  }
  private currentHistoricalImportMembership(requireCurrentLoss=false):GraphMembershipEpoch|undefined{
    if(!this.historicalImportAuthority)return this.options.installedMembership;
    let lineage:ReturnType<GraphCustodyProfileAuthority['verifiedNegativeRoleLineage']>;try{lineage=this.historicalImportAuthority.verifiedNegativeRoleLineage();}catch(error){this.historicalReopen=null;throw error;}const membership=lineage.current,activation=[...lineage.activations,...lineage.memberLossActivations].find(row=>canonicalHash(row.certificate.newMembership)===canonicalHash(membership));
    if(!this.historicalImportMembership||canonicalHash(membership)!==canonicalHash(this.historicalImportMembership)||!activation||canonicalHash(activation.certificate)!==this.historicalImportActivationHash){this.historicalReopen=null;throw new Error('graph-history-import-authority-changed');}
    if(requireCurrentLoss&&activation.certificate.memberLoss)this.historicalImportAuthority.assertCurrentMemberLossActivation(activation.certificate);return membership;
  }
  receiveHistorical(record:ConversationGraphReplicationRecord):Promise<void>{return this.serial(async()=>{
    const fence=this.erasureProofs.find(proof=>erasureCoversPacket(proof,record.packet));
    if(fence){record={...record,encryptedSourceBundle:null,erasure:record.erasure??fence};delete record.rewrap;}
    if(this.options.localErasure?.isDenied(record.packet.erasureIdentity)){record={...record,encryptedSourceBundle:null};delete record.rewrap;}
    if(record.erasure){record={...record,encryptedSourceBundle:null};delete record.rewrap;}
    if(record.materialization instanceof GraphSelectedMaterializationV2||validateGraphMaterializationReferenceV2(record.materialization))throw new Error('graph-paged-history-recovery-export-unavailable');
    if(!record.materialization)throw new Error('graph-history-transfer-proof-missing');
    if(!this.verify(record,record.packet.writerId))throw new Error('graph-history-transfer-source-invalid');
    this.historicalImportAuthority?.assertMemberLossRepairAllowed(record);
    if(!this.validMaterialization(record,true))throw new Error('graph-history-transfer-profile-invalid');
    if(record.erasure)this.retainPendingErasure(record.erasure);
    const existing=this.records.get(record.packet.eventId);
    if(existing&&canonicalHash(this.immutable(existing.record))!==canonicalHash(this.immutable(record)))throw new Error('graph-history-source-conflict');
    if(existing&&canonicalHash(this.descriptorFor(existing.record))===canonicalHash(this.descriptorFor(record))
      &&canonicalHash(existing.record.erasure??null)===canonicalHash(record.erasure??null)&&!!existing.record.encryptedSourceBundle===!!record.encryptedSourceBundle)return;
    if(record.encryptedSourceBundle&&record.adoption?.disposition!=='refused'&&!record.cancellation)this.checkLocalRecovery(record);
    await this.save(this.file(record.packet.eventId,'intent'),this.immutable(record),true);this.rememberControl(record);
    if(record.encryptedSourceBundle)await this.save(this.file(record.packet.eventId,'bundle'),record.encryptedSourceBundle,true);
    if(record.rewrap&&!record.erasure)await this.save(this.rewrapFile(record.packet.eventId,record.materialization.rewrapHash),record.rewrap,true);
    if(record.encryptedSourceBundle&&this.isErased(record.packet.erasureIdentity)){await this.purgePayloadFiles(record.packet.eventId);throw new Error('graph-source-erasure-raced-publication');}
    const contextReference=await this.contexts.persistVerified(record.materialization);
    await this.save(this.file(record.packet.eventId,'materialization'),contextReference);record={...record,materialization:await this.contexts.hydrate(contextReference)};
    if(record.erasure)await this.save(this.file(record.packet.eventId,'erasure'),record.erasure);
    if(record.adoption)await this.save(this.file(record.packet.eventId,'adoption'),{adoption:record.adoption,...(record.cancellation?{cancellation:record.cancellation}:{})});
    if(record.erasedControlProof)await this.save(this.file(record.packet.eventId,'erased-control'),{proof:record.erasedControlProof,membership:record.custodyMembership,activations:record.custodyActivations??[]},true);
    if(record.preparationProof)await this.save(this.file(record.packet.eventId,'preparation'),record.preparationProof,true);
    if(record.encryptedSourceBundle&&this.isErased(record.packet.erasureIdentity)){await this.purgePayloadFiles(record.packet.eventId);throw new Error('graph-source-erasure-raced-publication');}
    await this.save(this.file(record.packet.eventId,'source'),this.immutable(record),true);
    const stored:Stored={record:cloneGraphRecord(record),sourceReceipt:null,certificateReceipts:new Map(),emittedHash:existing?.emittedHash??null,quarantine:null};
    delete stored.record.commitProofDeliveryReceipts;this.records.set(record.packet.eventId,stored);
    if(record.certificate)await this.persistCertificate(stored,record.certificate);
    if(record.cancellation)await this.persistCancellation(stored,record.cancellation);
    if(record.cancellationCertificate)await this.persistCancellationCertificate(stored,record.cancellationCertificate);
    for(const receipt of record.certificatePersistenceReceipts??[])await this.persistCertificateReceipt(stored,receipt);
    for(const receipt of record.commitProofDeliveryReceipts??[])await this.persistDeliveryReceipt(stored,receipt);
    if(record.erasure&&!this.erasureProofs.some(proof=>canonicalHash(proof)===canonicalHash(record.erasure)))await this.applyErasureCore(record.erasure,record.packet.eventId);
    if(!record.commitProofDeliveryReceipts?.length)this.deliveryReceipts.delete(record.packet.eventId);this.deliveryCompletionReceipts.delete(record.packet.eventId);this.inFlight.delete(record.packet.eventId);
    if(!this.validMaterialization(record,true))throw new Error('graph-history-import-authority-changed');
  });}

  private pagedHeldName(eventId:string,contextHash:string):string{return this.file(eventId,'paged-history-'+contextHash);}
  private pagedHeldNames():string[]{return fsSync.readdirSync(this.options.directory).filter(name=>name.includes('.paged-history-')).sort();}
  private hasPagedHistoryHold():boolean{return this.pagedHeldCatalogs.size>0||pagedHistoryHeldRoots.has(realpathSync(this.options.directory))||!!this.#pagedHistorical&&this.pagedHeldNames().length>0;}
  private validatePagedHeld(raw:unknown,name:string):GraphPagedHistoricalHeldCatalog{
    const c=raw as GraphPagedHistoricalHeldCatalog;if(!exactFields(c,['v','kind','agentId','machineId','eventId','membership','reference','recordControl','oldRewrapHash','newRewrapHash','signature'])||c.v!==1||c.kind!=='graph-source-paged-history-held'||c.agentId!==this.options.agentId||c.machineId!==this.options.machineId||!validateGraphMaterializationReferenceV2(c.reference)||name!==this.pagedHeldName(c.eventId,c.reference.contextHash)||!verifyMembershipEpoch(c.membership,this.options.ownerPublicKey)||c.membership.agentId!==this.options.agentId||c.reference.rewrapHash!==(c.newRewrapHash??canonicalHash(null))||[c.oldRewrapHash,c.newRewrapHash].some(value=>value!==null&&!hash(value)))throw new Error('graph-paged-history-catalog-invalid');
    const allowed=new Set(['coreType','packet','packetSignature','core','authorizationProof','adoption','preparationProof','erasedControlProof','custodyMembership','custodyActivations','certificate','certificatePersistenceReceipts','commitProofDeliveryReceipts','cancellation','cancellationCertificate','erasure']);const self=c.membership.members.find(row=>row.machineId===c.machineId),r=c.recordControl as unknown as ConversationGraphReplicationRecord;if(!c.recordControl||Object.keys(c.recordControl).some(key=>!allowed.has(key))||!self||!verifyGraphRecord('graph-source-paged-history-held-v1',unsigned(c),c.signature,self.signingPublicKey)||!r||['encryptedSourceBundle','rewrap','materialization'].some(key=>Object.hasOwn(r,key))||r.packet?.eventId!==c.eventId||r.packet.agentId!==this.options.agentId||!verifyGraphControlCapsule({v:1,coreType:r.coreType,core:r.core,authorizationProof:r.authorizationProof},r.packet,this.options.ownerPublicKey))throw new Error('graph-paged-history-catalog-binding');this.rememberControl(r);assertGraphTransferPublicControl({...r,encryptedSourceBundle:null},{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:this.options.witnessPublicKeys,verification:this});return c;
  }
  private async loadPagedHeld():Promise<void>{for(const name of this.pagedHeldNames()){pagedHistoryHeldRoots.add(realpathSync(this.options.directory));if(!/^[a-f0-9]{64}\.paged-history-[a-f0-9]{64}\.json$/.test(name))throw new Error('graph-paged-history-unclassified-catalog');const c=this.validatePagedHeld(this.heldRead(name),name);this.pagedHeldCatalogs.set(name,{eventId:c.eventId,contextHash:c.reference.contextHash,hash:canonicalHash(c)});if(this.isErased((c.recordControl as unknown as ConversationGraphReplicationRecord).packet.erasureIdentity))await this.purgePayloadFiles(c.eventId);}}
  private pagedBinding():GraphPagedHistoricalBinding{
    const b=this.#pagedHistorical;if(!b||!(b.pages instanceof GraphPublicMetadataPages)||!(b.coordinator instanceof LeaseCoordinator)||!(b.floor instanceof ConversationGraphNativeTailFloor)||!(b.identity instanceof MachineIdentityManager)||!(b.identities instanceof IdentityStore)||!(b.lock instanceof SingleInstanceLock)||!Number.isSafeInteger(b.maxHeldBytes)||b.maxHeldBytes<1)throw new Error('graph-paged-history-actual-bindings-required');return b;
  }
  private pagedScope(context:GraphVerifiedMaterializationContextV2):void{
    const b=this.pagedBinding(),authority=this.historicalImportAuthority,root=b.pages.stateRoot;if(!authority||root!==authority.stateRoot||!(context instanceof GraphVerifiedMaterializationContextV2))throw new Error('graph-paged-history-actual-authority-required');context.assertStore(b.pages);this.assertLocalCustodyContext({stateRoot:root,agentId:this.options.agentId,machineId:this.options.machineId,authority});const membership=this.currentHistoricalImportMembership(true);if(!membership||canonicalHash(membership)!==canonicalHash(context.activation.newMembership)||this.historicalImportActivationHash!==context.hashes.activationHash||!context.trustedFor(this.options.agentId,{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:this.options.witnessPublicKeys,installedMembership:membership,machineId:this.options.machineId}))throw new Error('graph-paged-history-current-activation-required');
    if(realpathSync(b.identity.baseDir)!==root||b.identity.loadIdentity().machineId!==this.options.machineId||!b.lock.revalidate()||realpathSync(b.lock.lockPath())!==path.join(root,'local','server-instance.lock')||realpathSync(b.identities.epochPath)!==path.join(root,'state','identity-epochs.json')||b.identities.getEpoch(this.options.machineId).revokedAt)throw new Error('graph-paged-history-live-identity-required');for(const file of [b.lock.lockPath(),b.identities.epochPath]){assertGraphLocalPath(root,path.join(realpathSync(path.dirname(file)),path.basename(file)));const stat=fsSync.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('graph-paged-history-local-component-invalid');}
    const sameKey=(a:crypto.KeyLike,z:crypto.KeyLike)=>{const key=(value:crypto.KeyLike)=>value instanceof crypto.KeyObject&&value.type==='public'?value:crypto.createPublicKey(value);return key(a).equals(key(z));};if(!sameKey(b.identity.loadSigningKey(),this.options.memberPrivateKey)||!sameKey(b.identity.loadEncryptionKey(),this.options.memberSealingPrivateKey))throw new Error('graph-paged-history-current-key-required');const active=Object.entries(b.identity.loadRegistry().machines).filter(([,row])=>row.status==='active'&&!row.revokedAt).map(([id])=>id).sort();if(canonicalHash(active)!==canonicalHash(membership.members.map(row=>row.machineId).sort()))throw new Error('graph-paged-history-roster-changed');
    b.floor.assertComponentScope(root,this.options.agentId,membership);const nativePath=b.coordinator.syncOwnerDecommissionDurably();assertGraphLocalPath(root,path.join(realpathSync(path.dirname(nativePath)),path.basename(nativePath)));const native=b.coordinator.currentLease(),holder=native&&membership.members.find(row=>row.machineId===native.holder);if(b.coordinator.selfMachineId!==this.options.machineId||!native||!holder||native.released||Date.parse(native.expiresAt)<=Date.now()||!b.floor.allows(native)||!nativeMachineVerify(FencedLease.canonicalize(native),native.signature,holder.signingPublicKey))throw new Error('graph-paged-history-current-native-required');const fence=this.options.localErasure;if(!(fence instanceof ConversationGraphLocalErasureFence)||fence.stateRoot!==root)throw new Error('graph-paged-history-current-fence-required');fence.durableTargets();
  }
  private pagedHeldBytes(extra?:GraphPagedHistoricalHeldCatalog):number{
    const names=new Set<string>();let bytes=0;const rows=[...this.pagedHeldCatalogs.keys()].map(name=>this.validatePagedHeld(this.heldRead(name),name));if(extra&&!rows.some(row=>row.eventId===extra.eventId&&row.reference.contextHash===extra.reference.contextHash))rows.push(extra);for(const c of rows){bytes+=Buffer.byteLength(canonicalJson(c));names.add(this.file(c.eventId,'bundle'));for(const key of [c.oldRewrapHash,c.newRewrapHash])if(key)names.add(this.rewrapFile(c.eventId,key));}for(const name of names){try{const stat=fsSync.lstatSync(path.join(this.options.directory,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('graph-paged-history-file-invalid');bytes+=stat.size;}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}}return bytes;
  }
  /** Actual retained local transfer rows only. The result remains READ-ONLY
   * HELD: no Source ACK/custody receipt or canonical publication is issued. */
  async importPagedHistoricalHeld(context:GraphVerifiedMaterializationContextV2,retained:GraphTransferCustodyReader):Promise<GraphPagedHistoricalHeldProof>{
    if(!(retained instanceof GraphTransferCustodyReader))throw new Error('graph-paged-history-actual-transfer-reader-required');this.pagedScope(context);const b=this.pagedBinding();if(retained.stateRoot!==b.pages.stateRoot||canonicalHash(retained.metadata.authorization)!==canonicalHash(context.activation.ownerAuthorization)||canonicalHash(retained.metadata.newMembership)!==canonicalHash(context.activation.newMembership)||canonicalHash(retained.metadata.manifest)!==context.hashes.manifestHash||canonicalHash(retained.metadata.currentLease)!==context.hashes.leaseHash||canonicalHash(retained.metadata.originalCurrentLease)!==context.hashes.originalLeaseHash)throw new Error('graph-paged-history-transfer-scope');context.assertCurrent();
    for await(const item of retained.recordsInManifestOrder())try{await this.serial(async()=>{this.pagedScope(context);const record=cloneGraphRecord(item.record);delete record.materialization;const next=item.newRewrap?structuredClone(item.newRewrap):null,release=retainHeldPrivateView(b.pages.stateRoot,record);let nextRelease=()=>true;try{nextRelease=next?retainHeldPrivateView(b.pages.stateRoot,{...record,encryptedSourceBundle:null,rewrap:next}):nextRelease;const selected=context.selectRecord(record,canonicalHash(next),{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:this.options.witnessPublicKeys,installedMembership:context.activation.newMembership,machineId:this.options.machineId});const checked={...record,materialization:selected,...(next?{rewrap:next}:{})};delete checked.commitProofDeliveryReceipts;if(!this.verify(checked,record.packet.writerId))throw new Error('graph-paged-history-original-invalid');this.historicalImportAuthority!.assertMemberLossRepairAllowed(checked);if(record.encryptedSourceBundle){this.assertHeldNegativeContext(record);this.checkLocalRecovery(checked);}const existing=this.records.get(record.packet.eventId);if(existing&&canonicalHash(this.immutable(existing.record))!==canonicalHash(this.immutable(record)))throw new Error('graph-paged-history-original-conflict');await this.assertNewHistoryCapacity(record.packet.eventId);this.pagedScope(context);const {encryptedSourceBundle:_bundle,rewrap:_key,materialization:_mat,...control}=record,body={v:1 as const,kind:'graph-source-paged-history-held' as const,agentId:this.options.agentId,machineId:this.options.machineId,eventId:record.packet.eventId,membership:context.activation.newMembership,reference:selected.reference(),recordControl:control,oldRewrapHash:record.rewrap?canonicalHash(record.rewrap):null,newRewrapHash:next?canonicalHash(next):null},catalog={...body,signature:signGraphRecord('graph-source-paged-history-held-v1',body,this.options.memberPrivateKey)},name=this.pagedHeldName(catalog.eventId,catalog.reference.contextHash);if(!this.pagedHeldCatalogs.has(name)&&this.pagedHeldCatalogs.size>=GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES)throw new Error('graph-paged-history-catalog-capacity');this.validatePagedHeld(catalog,name);const projected=this.pagedHeldBytes(catalog)+(record.encryptedSourceBundle&&!fsSync.existsSync(path.join(this.options.directory,this.file(catalog.eventId,'bundle')))?Buffer.byteLength(canonicalJson(record.encryptedSourceBundle)):0)+(next&&!fsSync.existsSync(path.join(this.options.directory,this.rewrapFile(catalog.eventId,canonicalHash(next))))?Buffer.byteLength(canonicalJson(next)):0);if(projected+(record.rewrap&&!fsSync.existsSync(path.join(this.options.directory,this.rewrapFile(catalog.eventId,canonicalHash(record.rewrap))))?Buffer.byteLength(canonicalJson(record.rewrap)):0)>b.maxHeldBytes)throw new Error('graph-paged-history-explicit-byte-policy');
      // Catalog FIRST: interrupted or restored copies stay attributed and HELD.
      pagedHistoryHeldRoots.add(realpathSync(this.options.directory));await this.save(name,catalog,true);this.pagedHeldCatalogs.set(name,{eventId:catalog.eventId,contextHash:catalog.reference.contextHash,hash:canonicalHash(catalog)});this.pagedScope(context);if(this.isErased(record.packet.erasureIdentity))throw new Error('graph-paged-history-denied');await this.save(this.file(catalog.eventId,'intent'),this.immutable(record),true);this.rememberControl(record);if(record.encryptedSourceBundle)await this.save(this.file(catalog.eventId,'bundle'),record.encryptedSourceBundle,true);if(record.rewrap)await this.save(this.rewrapFile(catalog.eventId,canonicalHash(record.rewrap)),record.rewrap,true);if(next)await this.save(this.rewrapFile(catalog.eventId,canonicalHash(next)),next,true);this.pagedScope(context);if(this.isErased(record.packet.erasureIdentity)){await this.purgePayloadFiles(catalog.eventId);throw new Error('graph-paged-history-denied');}
      }finally{release();nextRelease();}});}finally{retained.releasePrivateViews();}
    this.pagedScope(context);context.assertCurrent();return this.openPagedHistoricalHeld(context.contextHash);
  }
  /** Cold entrypoint resolves ONLY a signed Source catalog through its actual
   * own policy/store. A raw reference or hash never grants a private view. */
  async openPagedHistoricalHeld(contextHash:string):Promise<GraphPagedHistoricalHeldProof>{
    if(!hash(contextHash))throw new Error('graph-paged-history-context-invalid');const b=this.pagedBinding(),catalogs=new Map<string,GraphPagedHistoricalHeldCatalog>();for(const name of this.pagedHeldNames()){const c=this.validatePagedHeld(this.heldRead(name),name);if(c.reference.contextHash===contextHash)catalogs.set(c.eventId,c);}if(!catalogs.size)throw new Error('graph-paged-history-catalog-missing');const first=catalogs.values().next().value!,context=await openGraphMaterializationContextV2(b.pages,first.reference.root,this.options.agentId,{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:this.options.witnessPublicKeys},contextHash);this.pagedScope(context);for(const c of catalogs.values())if(canonicalHash(c.reference.root)!==canonicalHash(first.reference.root))throw new Error('graph-paged-history-conflicting-root');
    const directory=realpathSync(this.options.directory),directoryStat=fsSync.lstatSync(directory,{bigint:true}),identity=(stat:fsSync.BigIntStats)=>`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`,files=new Map<string,{identity:string;hash:string}>();for(const c of catalogs.values())for(const name of [this.pagedHeldName(c.eventId,contextHash),this.file(c.eventId,'intent'),this.file(c.eventId,'bundle'),...[c.oldRewrapHash,c.newRewrapHash].filter((key):key is string=>!!key).map(key=>this.rewrapFile(c.eventId,key))]){if(files.has(name))continue;const stat=fsSync.lstatSync(path.join(this.options.directory,name),{bigint:true});files.set(name,{identity:identity(stat),hash:canonicalHash(this.heldRead(name))});}
    const negative=this.localRetainedNegativeHash(),live=this.#heldNegativeContext;if(!live||!live.reader.usesDroppedOriginRegistry(live.dropped))throw new Error('graph-held-original-negative-context-required');const dropHash=live.dropped.physicalSnapshot(b.pages.stateRoot),current=()=>{this.pagedScope(context);const now=fsSync.lstatSync(directory,{bigint:true});if(realpathSync(this.options.directory)!==directory||!now.isDirectory()||now.isSymbolicLink()||now.dev!==directoryStat.dev||now.ino!==directoryStat.ino)throw new Error('graph-paged-history-directory-changed');if(this.#heldNegativeContext!==live||!live.reader.usesDroppedOriginRegistry(live.dropped)||live.dropped.physicalSnapshot(b.pages.stateRoot)!==dropHash||this.localRetainedNegativeHash()!==negative)throw new Error('graph-paged-history-negative-changed');};
    const read=async(eventId:string)=>{current();const c=catalogs.get(eventId);if(!c)throw new Error('graph-paged-history-unlisted-row');this.assertHeldNegativeContext(c.recordControl as unknown as ConversationGraphReplicationRecord);const names=[this.pagedHeldName(eventId,contextHash),this.file(eventId,'intent'),this.file(eventId,'bundle'),...[c.oldRewrapHash,c.newRewrapHash].filter((key):key is string=>!!key).map(key=>this.rewrapFile(eventId,key))];for(const name of names){const known=files.get(name)!,stat=fsSync.lstatSync(path.join(this.options.directory,name),{bigint:true});if(identity(stat)!==known.identity||canonicalHash(this.heldRead(name))!==known.hash)throw new Error('graph-paged-history-row-changed');}const record={...structuredClone(c.recordControl),encryptedSourceBundle:this.heldRead(this.file(eventId,'bundle'))} as unknown as ConversationGraphReplicationRecord,release=retainHeldPrivateView(b.pages.stateRoot,record);let keyRelease=()=>{};try{const selected=context.selectRecord(record,c.reference.rewrapHash,{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:this.options.witnessPublicKeys,installedMembership:context.activation.newMembership,machineId:this.options.machineId});record.materialization=selected;delete record.commitProofDeliveryReceipts;if(c.newRewrapHash){record.rewrap=this.heldRead(this.rewrapFile(eventId,c.newRewrapHash)) as GraphBundleRewrap;keyRelease=retainHeldPrivateView(b.pages.stateRoot,{...record,encryptedSourceBundle:null,rewrap:record.rewrap});}if(!this.verify(record,record.packet.writerId))throw new Error('graph-paged-history-row-untrusted');this.historicalImportAuthority!.assertMemberLossRepairAllowed(record);this.checkLocalRecovery(record);current();return{record,newRewrap:record.rewrap??null,close:()=>{release();keyRelease();}};}catch(error){release();keyRelease();throw error;}};
    const final=()=>{current();for(const c of catalogs.values())this.assertHeldNegativeContext(c.recordControl as unknown as ConversationGraphReplicationRecord);context.assertCurrent();for(const [name,known]of files){const stat=fsSync.lstatSync(path.join(this.options.directory,name),{bigint:true});if(identity(stat)!==known.identity||canonicalHash(this.heldRead(name))!==known.hash)throw new Error('graph-paged-history-row-changed');}current();};final();const proof=new GraphPagedHistoricalHeldProof(PAGED_HISTORY_HELD_TOKEN,contextHash,this,current,final,read);for(const ref of this.pagedHeldProofs)if(!ref.deref()||ref.deref()!.closed)this.pagedHeldProofs.delete(ref);this.pagedHeldProofs.add(new WeakRef(proof));return proof;
  }

  /** Bind the runtime's actual live negative context once. This grants no reads. */
  bindHeldNegativeContext(reader:ReplicatedStoreReader,dropped:DroppedOriginRegistry):void{
    const root=realpathSync(path.join(this.options.directory,'..','..'));if(!(reader instanceof ReplicatedStoreReader)||!(dropped instanceof DroppedOriginRegistry)||!reader.usesDroppedOriginRegistry(dropped)||realpathSync(this.options.directory)!==path.join(root,'state','conversation-graph-source'))throw new Error('graph-held-original-negative-context-invalid');
    if(this.#heldNegativeContext&&(this.#heldNegativeContext.reader!==reader||this.#heldNegativeContext.dropped!==dropped||this.#heldNegativeContext.root!==root))throw new Error('graph-held-original-negative-context-rebind');dropped.physicalSnapshot(root);if(!this.#heldNegativeContext)this.#heldNegativeContext=Object.freeze({reader,dropped,root});
  }
  private assertHeldNegativeContext(record:ConversationGraphReplicationRecord):void{
    const context=this.#heldNegativeContext,root=realpathSync(path.join(this.options.directory,'..','..'));if(!context||context.root!==root||!context.reader.usesDroppedOriginRegistry(context.dropped))throw new Error('graph-held-original-negative-context-required');
    if(context.dropped.isDropped(CONVERSATION_GRAPH_STORE,record.packet.writerId)||context.dropped.isDropped(CONVERSATION_GRAPH_STORE,this.options.machineId)||this.isErased(record.packet.erasureIdentity))throw new Error('graph-held-original-provenance-denied');context.dropped.physicalSnapshot(root);
  }
  private heldCatalogName(eventId:string,stageHash:string):string{return this.file(eventId,`held-row-${stageHash}`);}
  private heldPlanName(stageHash:string):string{return `held-plan-${stageHash}.json`;}
  private heldRead(name:string,limit=GRAPH_REPLICATION_MAX_RECORD_BYTES):unknown{
    const root=realpathSync(path.join(this.options.directory,'..','..')),file=path.join(realpathSync(this.options.directory),name);assertGraphLocalPath(root,file);const stat=fsSync.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>limit)throw new Error('graph-held-original-file-invalid');const fd=fsSync.openSync(file,FILE_FLAGS.O_RDONLY|(FILE_FLAGS.O_NOFOLLOW??0));try{const opened=fsSync.fstatSync(fd);if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.size!==stat.size)throw new Error('graph-held-original-file-changed');const bytes=Buffer.alloc(opened.size+1),count=fsSync.readSync(fd,bytes,0,bytes.length,0);if(count!==opened.size)throw new Error('graph-held-original-file-changed');const value=JSON.parse(bytes.subarray(0,count).toString('utf8'));flushDescriptorOnce(file,fd);return value;}finally{fsSync.closeSync(fd);}
  }
  private heldOwnerPem():string{return (this.options.ownerPublicKey instanceof crypto.KeyObject?this.options.ownerPublicKey:crypto.createPublicKey(this.options.ownerPublicKey)).export({format:'pem',type:'spki'}).toString();}
  private validateHeldPlan(raw:unknown,name:string):HeldOriginalPlan{
    const p=raw as HeldOriginalPlan,base=['v','kind','agentId','machineId','stageHash','streamHash','authorization','previousMembership','newMembership','previous','signature'];if(!p||!exactFields(p,[...base,...(p.kind==='held-original-plan'?['holdIntent']:['lossIntent','consent','nativeIdentities','previousPublicationHash','sourceInventoryHash','sourceSnapshotInventoryHash','sourceErasureInventoryHash'])])||p.v!==1||!['held-original-plan','held-member-loss-original-plan'].includes(p.kind)||p.agentId!==this.options.agentId||p.machineId!==this.options.machineId||!hash(p.stageHash)||!hash(p.streamHash)||name!==this.heldPlanName(p.stageHash)||!verifyRecoveryAuthorization(p.authorization,p.previousMembership,p.newMembership,this.options.ownerPublicKey)||!exactFields(p.previous,['lease','originalLease'])||!verifyFencedLeaseBridge(p.previous.lease,p.previous.originalLease,p.previousMembership))throw new Error('graph-held-original-plan-invalid');
    if(p.kind==='held-original-plan'){if(!verifyGraphCustodyHoldIntent(p.holdIntent,this.heldOwnerPem())||canonicalHash(p.holdIntent.previousMembership)!==canonicalHash(p.previousMembership)||canonicalHash(p.holdIntent.newMembership)!==canonicalHash(p.newMembership))throw new Error('graph-held-original-plan-intent-invalid');}
    else{const context={ownerPublicKey:this.heldOwnerPem(),previousPublicationHash:p.previousPublicationHash,previousMembership:p.previousMembership,newMembership:p.newMembership,nativeIdentities:p.nativeIdentities};if(![p.previousPublicationHash,p.sourceInventoryHash,p.sourceSnapshotInventoryHash,p.sourceErasureInventoryHash].every(hash)||!verifyGraphOwnerMemberLossConsent(p.consent,context)||!verifyGraphMemberLossIntent(p.lossIntent,context)||heldLossStageHash(p)!==p.stageHash)throw new Error('graph-held-original-loss-plan-invalid');}
    const self=p.previousMembership.members.find(m=>m.machineId===this.options.machineId);if(!self||!verifyGraphRecord('graph-held-original-plan-v1',(({signature,...value})=>value)(p),p.signature,self.signingPublicKey))throw new Error('graph-held-original-plan-signature-invalid');assertGraphOwnedOpaqueMetadata(p);return p;
  }
  private heldPlanActivation(authority:GraphCustodyProfileAuthority,plan:HeldOriginalPlan):GraphMembershipActivationCertificate|undefined{const lineage=authority.verifiedNegativeRoleLineage();if(plan.kind==='held-original-plan')return lineage.activations.find(row=>canonicalHash(row.stage)===plan.stageHash&&canonicalHash(row.certificate.ownerAuthorization)===canonicalHash(plan.authorization)&&canonicalHash(row.certificate.newMembership)===canonicalHash(plan.newMembership))?.certificate;return lineage.memberLossActivations.find(row=>canonicalHash(row.certificate.ownerAuthorization)===canonicalHash(plan.authorization)&&canonicalHash(row.certificate.newMembership)===canonicalHash(plan.newMembership)&&canonicalHash(row.certificate.memberLoss?.consent)===canonicalHash(plan.consent)&&canonicalHash(row.certificate.memberLoss?.intent)===canonicalHash(plan.lossIntent)&&row.certificate.memberLoss!.sourceInventories.some(item=>item.machineId===this.options.machineId&&item.inventoryHash===plan.sourceSnapshotInventoryHash&&item.erasureInventoryHash===plan.sourceErasureInventoryHash))?.certificate;}
  private validateHeldCatalog(raw:unknown,name:string):HeldOriginalCatalog{
    const c=raw as HeldOriginalCatalog;if(!exactFields(c,['v','kind','agentId','machineId','stageHash','eventId','packetHash','recordTransportHash','descriptor','recordControl','bodyState','oldRewrapHash','newRewrapHash','priorCanonical','signature'])||c.v!==1||c.kind!=='held-original-row'||c.agentId!==this.options.agentId||c.machineId!==this.options.machineId||!hash(c.stageHash)||!hash(c.packetHash)||!hash(c.recordTransportHash)||!['sealed','denied'].includes(c.bodyState)||typeof c.priorCanonical!=='boolean'||[c.oldRewrapHash,c.newRewrapHash].some(value=>value!==null&&!hash(value))||name!==this.heldCatalogName(c.eventId,c.stageHash)||!c.recordControl||Object.hasOwn(c.recordControl,'encryptedSourceBundle')||Object.hasOwn(c.recordControl,'rewrap'))throw new Error('graph-held-original-catalog-invalid');
    const plan=this.validateHeldPlan(this.heldRead(this.heldPlanName(c.stageHash)),this.heldPlanName(c.stageHash)),self=plan.previousMembership.members.find(m=>m.machineId===this.options.machineId)!,r=c.recordControl as unknown as ConversationGraphReplicationRecord;
    if(!verifyGraphRecord('graph-held-original-row-v1',(({signature,...value})=>value)(c),c.signature,self.signingPublicKey)||r.packet?.eventId!==c.eventId||canonicalHash(r.packet)!==c.packetHash||c.descriptor?.eventId!==c.eventId||c.descriptor.recordTransportHash!==c.recordTransportHash||c.descriptor.packetHash!==c.packetHash||!verifyGraphControlCapsule({v:1,coreType:r.coreType,core:r.core,authorizationProof:r.authorizationProof},r.packet,this.options.ownerPublicKey))throw new Error('graph-held-original-catalog-binding-invalid');assertGraphOwnedOpaqueMetadata(c);return c;
  }
  private rememberHeldCatalog(c:HeldOriginalCatalog,name:string):void{const row={name,eventId:c.eventId,stageHash:c.stageHash,priorCanonical:c.priorCanonical,hash:canonicalHash(c)},prior=this.heldImports.get(name),bytes=this.heldCatalogMetadataBytes-(prior?Buffer.byteLength(canonicalJson(prior)):0)+Buffer.byteLength(canonicalJson(row));if(bytes>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-held-original-index-capacity');this.heldCatalogMetadataBytes=bytes;this.heldImports.set(name,row);this.rememberControl(c.recordControl as unknown as ConversationGraphReplicationRecord);}
  /** Known held imports are negative facts even if a separate Core hold file
   * was partially restored. They cannot bootstrap an old private-read baseline. */
  assertHeldImportsSettled(authority:GraphCustodyProfileAuthority):void{
    const allNames=fsSync.readdirSync(realpathSync(this.options.directory));if(this.hasPagedHistoryHold()||allNames.some(name=>name.includes('.paged-history-')))throw new Error('graph-paged-history-recovery-export-unavailable');
    const physical=allNames.filter(name=>name.startsWith('held-plan-')||name.includes('.held-row-')).sort(),expected=[...this.heldPlans.keys(),...this.heldImports.keys()].sort();if(canonicalHash(physical)!==canonicalHash(expected))throw new Error('graph-held-original-catalog-index-debt');if(!expected.length)return;
    this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,authority});const lineage=authority.verifiedNegativeRoleLineage(),positive=authority.currentMembership();
    for(const p of this.heldPlans.values()){const plan=this.validateHeldPlan(this.heldRead(p.name),p.name);if(canonicalHash(plan)!==p.hash)throw new Error('graph-held-original-plan-changed');if(positive.epoch<plan.newMembership.epoch||!this.heldPlanActivation(authority,plan))throw new Error('graph-held-original-awaits-activation');}
    for(const c of this.heldImports.values())if(canonicalHash(this.validateHeldCatalog(this.heldRead(c.name),c.name))!==c.hash)throw new Error('graph-held-original-catalog-changed');authority.assertPositiveWrites(positive);
  }

  private rememberHeldPlan(p:HeldOriginalPlan,name:string):void{if(!this.heldPlans.has(name)&&this.heldPlans.size>=GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES)throw new Error('graph-held-original-plan-capacity');this.heldPlans.set(name,{name,stageHash:p.stageHash,hash:canonicalHash(p)});}
  private async loadHeldImports():Promise<void>{
    for(const name of (await fs.readdir(this.options.directory)).sort()){
      if(/^held-plan-[a-f0-9]{64}\.json$/.test(name))this.rememberHeldPlan(this.validateHeldPlan(this.heldRead(name),name),name);
      else if(/^[a-f0-9]{64}\.held-row-[a-f0-9]{64}\.json$/.test(name)){const c=this.validateHeldCatalog(this.heldRead(name),name);this.rememberHeldCatalog(c,name);}
      else if(name.includes('.held-row-')||name.startsWith('held-plan-'))throw new Error('graph-held-original-publication-debt');
    }
  }
  private heldImportActivated(record:ConversationGraphReplicationRecord,c:Pick<HeldOriginalCatalog,'eventId'|'stageHash'|'priorCanonical'>):boolean{
    const activation=record.materialization?.activation??record.adoption?.activation;if(!activation||!this.historicalImportAuthority)return false;const plan=this.validateHeldPlan(this.heldRead(this.heldPlanName(c.stageHash)),this.heldPlanName(c.stageHash)),lineage=this.historicalImportAuthority.verifiedNegativeRoleLineage();return canonicalHash(activation.ownerAuthorization)===canonicalHash(plan.authorization)&&canonicalHash(this.heldPlanActivation(this.historicalImportAuthority,plan))===canonicalHash(activation);
  }
  private heldImportBlocks(record:ConversationGraphReplicationRecord):boolean{return [...this.heldImports.values()].some(c=>c.eventId===record.packet.eventId&&!c.priorCanonical&&!this.heldImportActivated(record,c));}
  private async readHeldOriginal(c:HeldOriginalCatalog,plan:HeldOriginalPlan):Promise<{record:ConversationGraphReplicationRecord;newRewrap:GraphBundleRewrap|null;close():void}>{
    const denied=this.isErased((c.recordControl as unknown as ConversationGraphReplicationRecord).packet.erasureIdentity);if(c.bodyState==='sealed'&&denied||c.bodyState==='denied'&&!denied)throw new Error('graph-held-original-negative-state-changed');
    const r={...structuredClone(c.recordControl),encryptedSourceBundle:c.bodyState==='sealed'?this.heldRead(this.file(c.eventId,'bundle')):null} as unknown as ConversationGraphReplicationRecord;
    const root=realpathSync(path.join(this.options.directory,'..','..'));let release=()=>{},oldRelease=()=>{},nextRelease=()=>{};const close=()=>{release();oldRelease();nextRelease();};
    try{release=retainHeldPrivateView(root,r);if(r.encryptedSourceBundle)this.assertHeldNegativeContext(r);
    const ref=r.materialization as unknown;if(ref){if(!validateGraphMaterializationReference(ref))throw new Error('graph-held-original-context-reference-invalid');r.materialization=await this.contexts.hydrate(ref);}
    if(c.oldRewrapHash){r.rewrap=this.heldRead(this.rewrapFile(c.eventId,c.oldRewrapHash)) as GraphBundleRewrap;oldRelease=retainHeldPrivateView(root,{...r,encryptedSourceBundle:null,rewrap:r.rewrap});}const next=c.newRewrapHash?this.heldRead(this.rewrapFile(c.eventId,c.newRewrapHash)) as GraphBundleRewrap:null;if(next)nextRelease=retainHeldPrivateView(root,{...r,encryptedSourceBundle:null,rewrap:next});
    if(canonicalHash(this.heldRead(this.file(c.eventId,'intent')))!==canonicalHash(this.immutable(r))||!this.verify(r,r.packet.writerId)||canonicalHash(this.recordForTransport(r))!==c.recordTransportHash||canonicalHash(next)!==(c.newRewrapHash??canonicalHash(null)))throw new Error('graph-held-original-readback-invalid');
    // This immutable quarantined original is provenance for negative settlement,
    // not canonical repair. Never use a terminal-looking row in this branch.
    const originalRefusal=r.encryptedSourceBundle&&!next&&plan.kind==='held-member-loss-original-plan'&&!['certificate','adoption','cancellation','cancellationCertificate','certificatePersistenceReceipts','commitProofDeliveryReceipts','materialization','erasure','erasedControlProof'].some(key=>Object.hasOwn(r,key))&&plan.consent.payload.operations.some(row=>row.eventId===r.packet.eventId&&row.operationHash===canonicalHash(r.packet)&&row.outcome==='pending'&&row.terminalHash===null)&&plan.authorization.pendingOutcomes.some(row=>row.idempotencyKey===r.packet.idempotencyKey&&row.operationHash===canonicalHash(r.packet)&&row.decision==='refuse');
    if(originalRefusal){this.assertHeldNegativeContext(r);this.checkLocalRecovery(r);this.assertHeldNegativeContext(r);return{record:r,newRewrap:null,close};}
    this.historicalImportAuthority?.assertMemberLossRepairAllowed(r);
    if(r.encryptedSourceBundle){if(!next||!verifyBundleRewrap(next,r.encryptedSourceBundle,plan.newMembership))throw new Error('graph-held-original-new-key-invalid');const sealed=openRewrappedGraphBundle(r.encryptedSourceBundle,next,this.options.machineId,this.options.memberSealingPrivateKey,plan.newMembership,{agentId:r.packet.agentId,eventId:r.packet.eventId});let decoded:ReturnType<typeof decodeGraphSourceRecoveryEnvelope>;try{decoded=decodeGraphSourceRecoveryEnvelope({packet:r.packet,packetSignature:r.packetSignature,plaintextEnvelope:sealed,ownerPublicKey:this.options.ownerPublicKey});}finally{sealed.fill(0);}try{if(!verifyGraphSourceEnvelopeControl(decoded,r)||!validateGraphApplicationSource(r.coreType,r.core,r.authorizationProof,decoded.applicationSource))throw new Error('graph-held-original-application-invalid');}finally{decoded.applicationSource.fill(0);}}
    if(r.encryptedSourceBundle)this.assertHeldNegativeContext(r);return{record:r,newRewrap:next,close};
    }catch(error){close();throw error;}
  }
  private heldOriginalProof(catalog:HeldOriginalCatalog,plan:HeldOriginalPlan,scope:()=>void):GraphHeldOriginalPromotionProof{
    const root=realpathSync(this.options.directory),rootStat=fsSync.lstatSync(root),catalogName=this.heldCatalogName(catalog.eventId,catalog.stageHash),catalogHash=canonicalHash(catalog),planHash=canonicalHash(plan),original=catalog.recordControl as unknown as ConversationGraphReplicationRecord,files=new Map<string,{hash:string;dev:number;ino:number;limit:number}>(),releases=new Set<()=>void>();
    const names=[catalogName,this.heldPlanName(catalog.stageHash),this.file(catalog.eventId,'intent'),...(catalog.bodyState==='sealed'?[this.file(catalog.eventId,'bundle')]:[]),...[catalog.oldRewrapHash,catalog.newRewrapHash].filter((value):value is string=>!!value).map(value=>this.rewrapFile(catalog.eventId,value))];if(original.materialization){if(!validateGraphMaterializationReference(original.materialization))throw new Error('graph-held-original-session-context-invalid');names.push('contexts/'+original.materialization.contextHash+'.json');}for(const name of names){const stat=fsSync.lstatSync(path.join(root,name)),limit=name.startsWith('contexts/')?GRAPH_CONTEXT_MAX_BYTES:GRAPH_REPLICATION_MAX_RECORD_BYTES;files.set(name,{hash:canonicalHash(this.heldRead(name,limit)),dev:stat.dev,ino:stat.ino,limit});}
    const check=()=>{scope();if(catalog.bodyState==='sealed')this.assertHeldNegativeContext(original);const fence=this.options.localErasure;if(!(fence instanceof ConversationGraphLocalErasureFence))throw new Error('graph-held-original-session-fence-required');fence.durableTargets();if(catalog.bodyState==='sealed'&&this.isErased(original.packet.erasureIdentity)){this.purgeMemberLossSnapshots(original.packet.erasureIdentity);throw new Error('graph-held-original-session-denied');}if(this.isErased(original.packet.erasureIdentity)!==(catalog.bodyState==='denied'))throw new Error('graph-held-original-session-negative-changed');const stat=fsSync.lstatSync(root);if(realpathSync(this.options.directory)!==root||stat.dev!==rootStat.dev||stat.ino!==rootStat.ino)throw new Error('graph-held-original-session-root-changed');for(const [name,row]of files){const current=fsSync.lstatSync(path.join(root,name));if(current.dev!==row.dev||current.ino!==row.ino||canonicalHash(this.heldRead(name,row.limit))!==row.hash)throw new Error('graph-held-original-session-file-changed');}if(canonicalHash(this.validateHeldCatalog(this.heldRead(catalogName),catalogName))!==catalogHash||canonicalHash(this.validateHeldPlan(this.heldRead(this.heldPlanName(catalog.stageHash)),this.heldPlanName(catalog.stageHash)))!==planHash||canonicalHash(this.heldRead(this.file(catalog.eventId,'intent')))!==canonicalHash(this.immutable(original))||catalog.bodyState==='sealed'&&canonicalHash(this.heldRead(this.file(catalog.eventId,'bundle')))!==original.packet.sourceBundleHash)throw new Error('graph-held-original-session-binding-changed');scope();};check();
    const proof=new GraphHeldOriginalPromotionProof(HELD_ORIGINAL_PROMOTION_TOKEN,this,{stageHash:catalog.stageHash,eventId:catalog.eventId,recordTransportHash:catalog.recordTransportHash,inventoryHash:canonicalHash({catalog:catalogHash,plan:planHash}),bodyState:catalog.bodyState},check,async()=>{check();const row=await this.readHeldOriginal(catalog,plan);try{check();}catch(error){row.close();throw error;}const close=()=>{row.close();releases.delete(close);};releases.add(close);return{record:row.record,newRewrap:row.newRewrap,close};},()=>{for(const close of releases)close();releases.clear();});for(const ref of this.heldPromotionProofs){const prior=ref.deref();if(!prior||prior.closed)this.heldPromotionProofs.delete(ref);}if(this.heldPromotionProofs.size>=HELD_PRIVATE_REFERENCE_BUDGET){proof.close();throw new Error('graph-held-original-proof-capacity');}this.heldPromotionProofs.add(new WeakRef(proof));return proof;
  }

  /** Public signed attribution only, including after a priority deny. */
  inspectHeldOriginalLocator(locator:{stageHash:string;eventId:string;recordTransportHash:string},authority:GraphCustodyProfileAuthority){
    if(!(authority instanceof GraphCustodyProfileAuthority)||!exactFields(locator,['stageHash','eventId','recordTransportHash'])||!hash(locator.stageHash)||!hash(locator.recordTransportHash))throw new Error('graph-held-original-locator-scope-invalid');this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,authority});
    const name=this.heldCatalogName(locator.eventId,locator.stageHash),catalog=this.validateHeldCatalog(this.heldRead(name),name),plan=this.validateHeldPlan(this.heldRead(this.heldPlanName(locator.stageHash)),this.heldPlanName(locator.stageHash)),lineage=authority.verifiedNegativeRoleLineage();
    if(catalog.recordTransportHash!==locator.recordTransportHash||!(plan.kind==='held-original-plan'?lineage.stages.some(stage=>canonicalHash(stage)===locator.stageHash):lineage.memberLossIntents.some(row=>canonicalHash(row.intent)===canonicalHash(plan.lossIntent)))&&!this.heldPlanActivation(authority,plan))throw new Error('graph-held-original-locator-authority-invalid');
    const r=catalog.recordControl as unknown as ConversationGraphReplicationRecord;return Object.freeze({packetHash:catalog.packetHash,controlHash:canonicalHash(catalog.recordControl),authorizationHash:canonicalHash(plan.authorization),previousMembershipHash:canonicalHash(plan.previousMembership),newMembershipHash:canonicalHash(plan.newMembership),recordTransportHash:catalog.recordTransportHash,erasureIdentity:Object.freeze(structuredClone(r.packet.erasureIdentity)),oldRewrapHash:catalog.oldRewrapHash,newRewrapHash:catalog.newRewrapHash,bodyState:catalog.bodyState});
  }
  /** Complete physical custody barrier; never a new positive Source receipt. */
  async finalizeHeldOriginalStage(input:{stageHash:string;manifest:GraphRecoverySourceManifest},authority:GraphCustodyProfileAuthority,context:GraphHeldOriginalNativeContext):Promise<GraphHeldOriginalStageProof>{
    if(!hash(input.stageHash)||!validateRecoverySourceManifest(input.manifest))throw new Error('graph-held-original-stage-manifest-invalid');input=Object.freeze({...input});context=Object.freeze({...context,...(context.lease?{lease:structuredClone(context.lease)}:{}),...(context.originalLease?{originalLease:structuredClone(context.originalLease)}:{})});const manifest=structuredClone(input.manifest),plan=this.validateHeldPlan(this.heldRead(this.heldPlanName(input.stageHash)),this.heldPlanName(input.stageHash));if(canonicalHash(manifest)!==plan.authorization.sourceManifestHash)throw new Error('graph-held-original-stage-manifest-unbound');
    const locators=manifest.entries.map(entry=>{const name=this.heldCatalogName(entry.eventId,input.stageHash),catalog=this.validateHeldCatalog(this.heldRead(name),name);if(canonicalHash(catalog.descriptor.manifestEntry)!==canonicalHash(entry))throw new Error('graph-held-original-stage-entry-unbound');return{stageHash:input.stageHash,eventId:entry.eventId,recordTransportHash:catalog.recordTransportHash};});
    if(!locators.length)throw new Error('graph-held-original-stage-empty');
    let first:GraphHeldOriginalPromotionProof|undefined;const files=new Map<string,{hash:string;limit:number;dev:number;ino:number}>();try{
      for(const locator of locators){const proof=await this.openHeldOriginalRow(locator,authority,context);try{const row=await proof.readRecord();row.close();const catalog=this.validateHeldCatalog(this.heldRead(this.heldCatalogName(locator.eventId,locator.stageHash)),this.heldCatalogName(locator.eventId,locator.stageHash)),record=catalog.recordControl as unknown as ConversationGraphReplicationRecord,names=[this.heldCatalogName(locator.eventId,locator.stageHash),this.file(locator.eventId,'intent'),...(catalog.bodyState==='sealed'?[this.file(locator.eventId,'bundle')]:[]),...[catalog.oldRewrapHash,catalog.newRewrapHash].filter((key):key is string=>!!key).map(key=>this.rewrapFile(locator.eventId,key))];for(const name of names){const stat=fsSync.lstatSync(path.join(this.options.directory,name));files.set(name,{hash:canonicalHash(this.heldRead(name)),limit:GRAPH_REPLICATION_MAX_RECORD_BYTES,dev:stat.dev,ino:stat.ino});}if(record.materialization){if(!validateGraphMaterializationReference(record.materialization))throw new Error('graph-held-original-stage-context-invalid');const name='contexts/'+record.materialization.contextHash+'.json';const contextHash=canonicalHash(this.heldRead(name,GRAPH_CONTEXT_MAX_BYTES));if(contextHash!==record.materialization.contextHash)throw new Error('graph-held-original-stage-context-changed');const stat=fsSync.lstatSync(path.join(this.options.directory,name));files.set(name,{hash:contextHash,limit:GRAPH_CONTEXT_MAX_BYTES,dev:stat.dev,ino:stat.ino});}proof.assertCurrent();if(!first)first=proof;}finally{if(first!==proof)proof.close();}}
      const anchor=first!;const check=()=>{anchor.assertCurrent();if(canonicalHash(this.heldRead(this.heldPlanName(input.stageHash)))!==canonicalHash(plan))throw new Error('graph-held-original-stage-plan-changed');const names=fsSync.readdirSync(this.options.directory).filter(name=>name.endsWith('.held-row-'+input.stageHash+'.json')).sort(),expected=locators.map(locator=>this.heldCatalogName(locator.eventId,locator.stageHash)).sort();if(canonicalHash(names)!==canonicalHash(expected))throw new Error('graph-held-original-stage-inventory-changed');for(const [name,row]of files){const stat=fsSync.lstatSync(path.join(this.options.directory,name));if(stat.dev!==row.dev||stat.ino!==row.ino||canonicalHash(this.heldRead(name,row.limit))!==row.hash)throw new Error('graph-held-original-stage-row-changed');}for(const locator of locators){const catalog=this.validateHeldCatalog(this.heldRead(this.heldCatalogName(locator.eventId,locator.stageHash)),this.heldCatalogName(locator.eventId,locator.stageHash)),record=catalog.recordControl as unknown as ConversationGraphReplicationRecord;if(this.isErased(record.packet.erasureIdentity)!==(catalog.bodyState==='denied'))throw new Error('graph-held-original-stage-negative-changed');}anchor.assertCurrent();};check();return new GraphHeldOriginalStageProof(HELD_ORIGINAL_PROMOTION_TOKEN,input.stageHash,canonicalHash({plan:canonicalHash(plan),manifest:canonicalHash(manifest),files:[...files]}),check,()=>anchor.close());
    }catch(error){first?.close();throw error;}

  }

  /** Rebind retained quarantined custody using actual live negative authority.
   * A locator identifies files; it never grants custody or Source admission. */
  async openHeldOriginalRow(locator:{stageHash:string;eventId:string;recordTransportHash:string},authority:GraphCustodyProfileAuthority,context:GraphHeldOriginalNativeContext):Promise<GraphHeldOriginalPromotionProof>{
    if(!(authority instanceof GraphCustodyProfileAuthority)||!(context?.coordinator instanceof LeaseCoordinator)||!(context.nativeFloor instanceof ConversationGraphNativeTailFloor)||!exactFields(locator,['stageHash','eventId','recordTransportHash'])||!hash(locator.stageHash)||!hash(locator.recordTransportHash))throw new Error('graph-held-original-rebind-scope-invalid');
    const name=this.heldCatalogName(locator.eventId,locator.stageHash),catalog=this.validateHeldCatalog(this.heldRead(name),name),plan=this.validateHeldPlan(this.heldRead(this.heldPlanName(locator.stageHash)),this.heldPlanName(locator.stageHash));
    if((context.lease===undefined)!==(context.originalLease===undefined))throw new Error('graph-held-original-rebind-native-pair-required');const lease=structuredClone(context.lease??plan.previous.lease),originalLease=structuredClone(context.originalLease??plan.previous.originalLease);
    if(catalog.recordTransportHash!==locator.recordTransportHash)throw new Error('graph-held-original-rebind-locator-invalid');if(plan.kind==='held-member-loss-original-plan'){
      this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,authority});const session=this.heldReadSessions.get(locator.stageHash)?.deref();if(session){try{session.assertRecoveryContext(this,authority,context.coordinator);const proof=this.heldOriginalProof(catalog,plan,()=>session.assertRecoveryContext(this,authority,context.coordinator));try{const row=await proof.readRecord();row.close();proof.assertCurrent();return proof;}catch(error){proof.close();throw error;}}catch(error){if(!this.heldPlanActivation(authority,plan))throw error;}}
      const activation=this.heldPlanActivation(authority,plan);if(!activation?.memberLoss||canonicalHash(authority.verifiedNegativeRoleLineage().current)!==canonicalHash(activation.newMembership))throw new Error('graph-held-original-loss-activation-required');authority.assertCurrentMemberLossActivation(activation);
      const activeLease=structuredClone(context.lease??activation.memberLoss.currentLease),activeOriginal=structuredClone(context.originalLease??activation.memberLoss.originalLease),coordinator=context.coordinator,activationHash=canonicalHash(activation);
      const current=()=>{this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,authority});context.nativeFloor.assertComponentScope(authority.stateRoot,this.options.agentId,activation.newMembership);authority.assertCurrentMemberLossActivation(activation);if(canonicalHash(this.heldPlanActivation(authority,plan))!==activationHash||!verifyFencedLeaseBridge(activeLease,activeOriginal,activation.newMembership)||activeLease.leaseEpoch!==plan.previous.lease.leaseEpoch||activeLease.writerId!==plan.previous.lease.writerId||activeOriginal.acquiredAt!==plan.previous.originalLease.acquiredAt||coordinator.selfMachineId!==this.options.machineId)throw new Error('graph-held-original-loss-current-context-invalid');const nativePath=coordinator.syncOwnerDecommissionDurably();assertGraphLocalPath(authority.stateRoot,path.join(realpathSync(path.dirname(nativePath)),path.basename(nativePath)));const native=coordinator.currentLease();if(!native||canonicalHash(native)!==canonicalHash(activeOriginal)||native.released||Date.parse(native.expiresAt)<=Date.now())throw new Error('graph-held-original-loss-current-native-required');};
      const proof=this.heldOriginalProof(catalog,plan,current);try{const row=await proof.readRecord();row.close();proof.assertCurrent();return proof;}catch(error){proof.close();throw error;}
    }
    locator=Object.freeze({...locator});const coordinator=context.coordinator,nativeFloor=context.nativeFloor,catalogHash=canonicalHash(catalog),planHash=canonicalHash(plan),root=authority.stateRoot,releases=new Set<()=>void>(),directory=realpathSync(this.options.directory),directoryStat=fsSync.lstatSync(directory),identities=new Map<string,{dev:number;ino:number}>();
    const original=catalog.recordControl as unknown as ConversationGraphReplicationRecord,names=[name,this.heldPlanName(locator.stageHash),this.file(catalog.eventId,'intent'),...(catalog.bodyState==='sealed'?[this.file(catalog.eventId,'bundle')]:[]),...[catalog.oldRewrapHash,catalog.newRewrapHash].filter((key):key is string=>!!key).map(key=>this.rewrapFile(catalog.eventId,key))];if(original.materialization){if(!validateGraphMaterializationReference(original.materialization))throw new Error('graph-held-original-rebind-context-invalid');names.push('contexts/'+original.materialization.contextHash+'.json');}for(const file of names){const stat=fsSync.lstatSync(path.join(directory,file));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1)throw new Error('graph-held-original-rebind-inode-invalid');identities.set(file,{dev:stat.dev,ino:stat.ino});}
    const check=()=>{this.assertLocalCustodyContext({stateRoot:root,agentId:this.options.agentId,machineId:this.options.machineId,authority});if(catalog.bodyState==='sealed')this.assertHeldNegativeContext(original);const fence=this.options.localErasure as ConversationGraphLocalErasureFence;fence.durableTargets();if(catalog.bodyState==='sealed'&&this.isErased(original.packet.erasureIdentity)){this.purgeMemberLossSnapshots(original.packet.erasureIdentity);throw new Error('graph-held-original-proof-stale');}const currentDirectory=fsSync.lstatSync(directory);if(realpathSync(this.options.directory)!==directory||!currentDirectory.isDirectory()||currentDirectory.isSymbolicLink()||currentDirectory.dev!==directoryStat.dev||currentDirectory.ino!==directoryStat.ino)throw new Error('graph-held-original-rebind-root-changed');for(const [file,identity]of identities){const stat=fsSync.lstatSync(path.join(directory,file));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.dev!==identity.dev||stat.ino!==identity.ino)throw new Error('graph-held-original-rebind-inode-changed');}

      this.assertLocalCustodyContext({stateRoot:root,agentId:this.options.agentId,machineId:this.options.machineId,authority});
      const lineage=authority.verifiedNegativeRoleLineage(),activated=lineage.activations.find(value=>canonicalHash(value.stage)===locator.stageHash&&canonicalHash(value.certificate.ownerAuthorization)===canonicalHash(plan.authorization)&&canonicalHash(value.certificate.newMembership)===canonicalHash(plan.newMembership));
      if(!activated)authority.assertHeldIntent(plan.holdIntent);
      const stage=activated?.stage??lineage.stages.find(value=>canonicalHash(value)===locator.stageHash);if(!stage||canonicalHash(stage.authorization)!==canonicalHash(plan.authorization))throw new Error('graph-held-original-rebind-stage-invalid');
      if(!verifyFencedLeaseBridge(lease,originalLease,plan.previousMembership)||lease.writerId!==plan.previous.lease.writerId||lease.leaseEpoch!==plan.previous.lease.leaseEpoch||originalLease.acquiredAt!==plan.previous.originalLease.acquiredAt||coordinator.selfMachineId!==this.options.machineId)throw new Error('graph-held-original-rebind-native-invalid');
      const nativePath=coordinator.syncOwnerDecommissionDurably();assertGraphLocalPath(root,path.join(realpathSync(path.dirname(nativePath)),path.basename(nativePath)));nativeFloor.assertObservedContext(root,this.options.agentId,plan.previousMembership,lease,originalLease);
      const current=coordinator.currentLease();if(!current||current.released||Date.parse(current.expiresAt)<=Date.now()||current.holder!==lease.writerId||current.epoch!==lease.leaseEpoch||current.acquiredAt!==originalLease.acquiredAt||canonicalHash(current)!==canonicalHash(originalLease))throw new Error('graph-held-original-rebind-native-current-required');
      if(canonicalHash(this.validateHeldCatalog(this.heldRead(name),name))!==catalogHash||canonicalHash(this.validateHeldPlan(this.heldRead(this.heldPlanName(locator.stageHash)),this.heldPlanName(locator.stageHash)))!==planHash)throw new Error('graph-held-original-rebind-files-changed');
      const r=catalog.recordControl as unknown as ConversationGraphReplicationRecord;if(this.isErased(r.packet.erasureIdentity)!==(catalog.bodyState==='denied')||canonicalHash(this.heldRead(this.file(catalog.eventId,'intent')))!==canonicalHash(this.immutable(r)))throw new Error('graph-held-original-proof-stale');
      if(catalog.bodyState==='sealed'&&canonicalHash(this.heldRead(this.file(catalog.eventId,'bundle')))!==r.packet.sourceBundleHash)throw new Error('graph-held-original-proof-body-changed');for(const key of [catalog.oldRewrapHash,catalog.newRewrapHash])if(key&&canonicalHash(this.heldRead(this.rewrapFile(catalog.eventId,key)))!==key)throw new Error('graph-held-original-proof-key-changed');
      const finalLineage=authority.verifiedNegativeRoleLineage();if(activated&&!finalLineage.activations.some(value=>canonicalHash(value.certificate)===canonicalHash(activated.certificate)))throw new Error('graph-held-original-rebind-activation-changed');if(!activated)authority.assertHeldIntent(plan.holdIntent);
    };
    check();const initial=await this.readHeldOriginal(catalog,plan);try{check();}finally{initial.close();}
    const proof=new GraphHeldOriginalPromotionProof(HELD_ORIGINAL_PROMOTION_TOKEN,this,{stageHash:locator.stageHash,eventId:catalog.eventId,recordTransportHash:catalog.recordTransportHash,inventoryHash:canonicalHash({catalog:catalogHash,plan:planHash}),bodyState:catalog.bodyState},check,async()=>{check();const value=await this.readHeldOriginal(catalog,plan);try{check();}catch(error){value.close();throw error;}const close=()=>{value.close();releases.delete(close);};releases.add(close);return{record:value.record,newRewrap:value.newRewrap,close};},()=>{for(const close of releases)close();releases.clear();});
    for(const ref of this.heldPromotionProofs){const old=ref.deref();if(!old||old.closed)this.heldPromotionProofs.delete(ref);}if(this.heldPromotionProofs.size>=HELD_PRIVATE_REFERENCE_BUDGET){proof.close();throw new Error('graph-held-original-proof-capacity');}this.heldPromotionProofs.add(new WeakRef(proof));return proof;
  }

  prepareHeldSenderStage(input:{reader:GraphHeldSourceReader;prepared:GraphPreparedTransferEnvelopes;metadata:GraphTransferStageMetadata;context:{authority:GraphCustodyProfileAuthority;hold:GraphHeldSourceContext};ledger:GraphSourceCapacityLedger;coordinator:LeaseCoordinator}):GraphHeldSenderStage{
    const {reader,prepared,context:{authority,hold},ledger,coordinator}=input;if(!(reader instanceof GraphHeldSourceReader)||!(prepared instanceof GraphPreparedTransferEnvelopes)||!(authority instanceof GraphCustodyProfileAuthority)||!(ledger instanceof GraphSourceCapacityLedger)||!(coordinator instanceof LeaseCoordinator))throw new Error('graph-held-sender-actual-components-required');if(hold.kind!=='planned')throw new Error('graph-held-sender-loss-domain-required');
    const metadata=structuredClone(input.metadata);if(!verifyRecoveryAuthorization(metadata.authorization,metadata.previousMembership,metadata.newMembership,this.options.ownerPublicKey)||!validateRecoverySourceManifest(metadata.manifest)||canonicalHash(metadata.manifest)!==metadata.authorization.sourceManifestHash||!verifyFencedLeaseBridge(metadata.currentLease,metadata.originalCurrentLease,metadata.newMembership)||canonicalHash(metadata.originalCurrentLease)!==canonicalHash(hold.originalLease))throw new Error('graph-held-sender-owner-metadata-invalid');
    const stage=authority.verifiedNegativeRoleLineage().stages.find(stage=>canonicalHash(stage.authorization)===canonicalHash(metadata.authorization)&&canonicalHash(stage.holdIntent)===canonicalHash(hold.intent));if(!stage)throw new Error('graph-held-sender-owner-stage-required');const stageHash=canonicalHash(stage),descriptors=reader.descriptors(),byId=new Map(descriptors.map(row=>[row.eventId,row]));if(canonicalHash(descriptors.map(row=>row.manifestEntry))!==canonicalHash(metadata.manifest.entries))throw new Error('graph-held-sender-original-manifest-mismatch');
    const nativeContext=():GraphHeldOriginalNativeContext=>{const originalLease=coordinator.currentLease();if(!originalLease)throw new Error('graph-held-sender-native-unavailable');if(originalLease.holder!==this.options.machineId){if(canonicalHash(originalLease)!==canonicalHash(hold.originalLease)||!verifyFencedLeaseBridge(hold.lease,hold.originalLease,metadata.previousMembership))throw new Error('graph-held-sender-observed-bridge-required');return{coordinator,nativeFloor:hold.nativeFloor,lease:hold.lease,originalLease:hold.originalLease};}if(!coordinator.holdsLease())throw new Error('graph-held-sender-native-unavailable');const body={v:1 as const,agentId:this.options.agentId,membershipEpoch:metadata.previousMembership.epoch,leaseEpoch:originalLease.epoch,writerId:this.options.machineId,issuedAt:originalLease.acquiredAt,expiresAt:originalLease.expiresAt,fencedLeaseHash:canonicalHash(originalLease)},lease={...body,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.lease,body,this.options.memberPrivateKey)};return{coordinator,nativeFloor:hold.nativeFloor,lease,originalLease};};
    const coreScope=()=>{this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,authority});const nativePath=coordinator.syncOwnerDecommissionDurably();assertGraphLocalPath(authority.stateRoot,path.join(realpathSync(path.dirname(nativePath)),path.basename(nativePath)));authority.assertHeldIntent(hold.intent);if(!authority.verifiedNegativeRoleLineage().stages.some(row=>canonicalHash(row)===stageHash))throw new Error('graph-held-sender-stage-changed');hold.nativeFloor.assertObservedContext(authority.stateRoot,this.options.agentId,metadata.previousMembership,hold.lease,hold.originalLease);const native=coordinator.currentLease();if(!native||coordinator.selfMachineId!==this.options.machineId||native.holder!==hold.lease.writerId||(native.holder===this.options.machineId?!coordinator.holdsLease():canonicalHash(native)!==canonicalHash(hold.originalLease))||!verifyFencedLeaseBridge(hold.lease,hold.originalLease,metadata.previousMembership)||native.epoch!==hold.lease.leaseEpoch||native.acquiredAt!==hold.originalLease.acquiredAt||native.released||Date.parse(native.expiresAt)<=Date.now())throw new Error('graph-held-sender-native-changed');ledger.assertLocalContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,signingPublicKey:crypto.createPublicKey(this.options.memberPrivateKey),ownerPublicKey:this.options.ownerPublicKey});};
    const check=()=>{coreScope();reader.assertCurrent();if(reader.intentHash!==canonicalHash(hold.intent)||reader.nativeLeaseHash!==canonicalHash(hold.lease)||reader.membershipHash!==canonicalHash(metadata.previousMembership)||reader.stateRoot!==authority.stateRoot||reader.machineId!==this.options.machineId)throw new Error('graph-held-sender-reader-scope-invalid');prepared.assertInventoryHashForSource(reader,metadata.authorization.recoveryId,metadata.newMembership,metadata.authorization.rewrapInventoryHash);};check();
    const sender:GraphHeldSenderStage=new GraphHeldSenderStage(HELD_ORIGINAL_PROMOTION_TOKEN,this,reader,authority,prepared,id=>byId.get(id)?.recordTransportHash,{stageHash,sourceInventoryHash:reader.inventoryHash,metadataHash:canonicalHash(metadata)},check,(eventId,newRewrap)=>this.serial(async()=>{check();const descriptor=byId.get(eventId);if(!descriptor)throw new Error('graph-held-sender-unlisted-original');prepared.assertEnvelopeForSource(reader,metadata.authorization.recoveryId,metadata.newMembership,eventId,newRewrap);const record=await reader.readRecord(eventId);let mutation:HeldSourceMutation|undefined,ownedRow:HeldOriginalInput|undefined;try{check();mutation=reader.beginSourceHeldMutation(HELD_SOURCE_MUTATION_TOKEN,this,eventId);const active=mutation,live=()=>{active.assertCurrent();coreScope();};const row:HeldOriginalInput={record,newRewrap,descriptor,stageHash,header:{metadata,descriptor:{v:1,kind:'source-held-sender-original',sourceInventoryHash:reader.inventoryHash,intentHash:reader.intentHash,nativeLeaseHash:reader.nativeLeaseHash},inventory:[{eventId,rewrapHash:canonicalHash(newRewrap)}],previous:{lease:hold.lease,originalLease:hold.originalLease}},assertScope:scope=>{if(scope.source!==this||scope.authority!==authority)throw new Error('graph-held-sender-scope-invalid');live();},assertPromotionScope:(source,core)=>{if(source!==this||core!==authority)throw new Error('graph-held-sender-scope-invalid');check();}};ownedRow=row;return await this.promoteHeldOriginalInput(row,authority,ledger,mutation);}catch(error){mutation?.abort();throw error;}finally{if(ownedRow){ownedRow.newRewrap=null;ownedRow.record={...record,encryptedSourceBundle:null};delete ownedRow.record.rewrap;}reader.releasePrivateViews();}}),async()=>{check();reader.finalize();reader.assertFinalized();const proof=await this.finalizeHeldOriginalStage({stageHash,manifest:metadata.manifest},authority,nativeContext());try{reader.assertFinalized();proof.assertCurrent();return proof;}catch(error){proof.close();throw error;}},async eventId=>{check();const record=await reader.readRecord(eventId);const value=await prepared.readEnvelopeForSenderStage(sender,eventId,record);try{return await sender.promoteRow(eventId,value.rewrap);}finally{value.close();reader.releasePrivateViews();}});return sender;
  }

  private finalizedHeldSenderProof(stageHash:string,manifest:GraphRecoverySourceManifest,scope:()=>void,originalFinal:()=>void):GraphHeldOriginalStageProof{
    scope();originalFinal();const plan=this.validateHeldPlan(this.heldRead(this.heldPlanName(stageHash)),this.heldPlanName(stageHash)),planHash=canonicalHash(plan),files=new Map<string,{hash:string;dev:number;ino:number;limit:number}>(),expected:string[]=[];
    if(plan.authorization.sourceManifestHash!==canonicalHash(manifest))throw new Error('graph-held-sender-final-owner-manifest');
    const capture=(name:string,expectedHash?:string,limit=GRAPH_REPLICATION_MAX_RECORD_BYTES)=>{const value=this.heldRead(name,limit),digest=canonicalHash(value),stat=fsSync.lstatSync(path.join(this.options.directory,name));if(expectedHash&&digest!==expectedHash)throw new Error('graph-held-sender-final-file-invalid');files.set(name,{hash:digest,dev:stat.dev,ino:stat.ino,limit});};capture(this.heldPlanName(stageHash),planHash);
    for(const entry of manifest.entries){const name=this.heldCatalogName(entry.eventId,stageHash),catalog=this.validateHeldCatalog(this.heldRead(name),name),record=catalog.recordControl as unknown as ConversationGraphReplicationRecord;if(canonicalHash(catalog.descriptor.manifestEntry)!==canonicalHash(entry))throw new Error('graph-held-sender-final-row-manifest');expected.push(name);capture(name);capture(this.file(entry.eventId,'intent'),canonicalHash(this.immutable(record)));if(catalog.bodyState==='sealed')capture(this.file(entry.eventId,'bundle'),record.packet.sourceBundleHash);for(const key of [catalog.oldRewrapHash,catalog.newRewrapHash])if(key)capture(this.rewrapFile(entry.eventId,key),key);if(record.materialization){if(!validateGraphMaterializationReference(record.materialization))throw new Error('graph-held-sender-final-context-invalid');capture('contexts/'+record.materialization.contextHash+'.json',record.materialization.contextHash,GRAPH_CONTEXT_MAX_BYTES);}}
    const check=()=>{scope();originalFinal();const names=fsSync.readdirSync(this.options.directory).filter(name=>name.endsWith('.held-row-'+stageHash+'.json')).sort();if(canonicalHash(names)!==canonicalHash([...expected].sort()))throw new Error('graph-held-sender-final-inventory-changed');for(const [name,row]of files){const stat=fsSync.lstatSync(path.join(this.options.directory,name));if(stat.dev!==row.dev||stat.ino!==row.ino||canonicalHash(this.heldRead(name,row.limit))!==row.hash)throw new Error('graph-held-sender-final-file-changed');}scope();};check();return new GraphHeldOriginalStageProof(HELD_ORIGINAL_PROMOTION_TOKEN,stageHash,canonicalHash({stageHash,manifest:canonicalHash(manifest),files:[...files]}),check,()=>{});
  }
  /** No writes, promotion, credit reservation or ACK: an actual post-CAS
   * original/retained vector is rechecked in full before witness finish. */
  verifyMemberLossReadSession(input:{reader:GraphHeldSourceReader;prepared:GraphPreparedTransferEnvelopes;retained:GraphTransferCustodyReader;metadata:GraphTransferStageMetadata;context:{authority:GraphCustodyProfileAuthority;hold:GraphHeldSourceContext};evidence:Omit<GraphMemberLossNegativeTransferEvidence,'nativeStore'>}):GraphHeldSenderReadSession{
    const {reader,prepared,retained,context:{authority,hold},evidence:e}=input;if(!(reader instanceof GraphHeldSourceReader)||!(prepared instanceof GraphPreparedTransferEnvelopes)||!(retained instanceof GraphTransferCustodyReader)||!(authority instanceof GraphCustodyProfileAuthority)||!(e.snapshot instanceof GraphMemberLossSourceSnapshot)||!(e.preflight instanceof GraphMemberLossHeldPreflight)||!(e.progress instanceof GraphNativeMemberLossProgress)||hold.kind!=='member-loss'||!hold.nativeContinuation||e.authority!==authority||e.preflight!==hold.nativeContinuation.preflight||e.progress!==hold.nativeContinuation.progress||e.coordinator!==hold.nativeContinuation.coordinator||canonicalHash(e.intent)!==canonicalHash(hold.intent))throw new Error('graph-loss-read-session-actual-scope-required');this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,authority});e.preflight.assertSourceSnapshot(e.snapshot);e.progress.assertCurrentNativeContext(e.coordinator,hold.originalLease);reader.assertFinalized();
    const metadata=structuredClone(input.metadata),retainedMetadata=retained.metadata,freeze=(value:unknown):void=>{if(value&&typeof value==='object'&&!Object.isFrozen(value)){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};if(retained.stateRoot!==authority.stateRoot||canonicalHash(retainedMetadata)!==canonicalHash(metadata)||!verifyRecoveryAuthorization(metadata.authorization,metadata.previousMembership,metadata.newMembership,this.options.ownerPublicKey)||!validateRecoverySourceManifest(metadata.manifest)||canonicalHash(metadata.manifest)!==metadata.authorization.sourceManifestHash||reader.intentHash!==canonicalHash(e.intent)||reader.membershipHash!==canonicalHash(metadata.previousMembership)||reader.nativeLeaseHash!==canonicalHash(hold.lease))throw new Error('graph-loss-read-session-retained-plan-invalid');freeze(retainedMetadata);const descriptors=reader.descriptors(),keys=prepared.inventory(),negative=reader.negativeInventory();if(canonicalHash(descriptors.map(row=>row.manifestEntry))!==canonicalHash(metadata.manifest.entries))throw new Error('graph-loss-read-session-manifest-mismatch');prepared.assertInventoryHashForSource(reader,metadata.authorization.recoveryId,metadata.newMembership,metadata.authorization.rewrapInventoryHash);
    const context={ownerPublicKey:authority.ownerPublicKey,previousPublicationHash:authority.publicationHash,previousMembership:metadata.previousMembership,newMembership:metadata.newMembership,nativeIdentities:e.preflight.nativeIdentities};if(!verifyGraphOwnerMemberLossConsent(e.consent,context)||!verifyGraphMemberLossIntent(e.intent,context)||e.progress.consentHash!==canonicalHash(e.consent))throw new Error('graph-loss-read-session-consent-invalid');
    const transfer=new GraphFrozenPhysicalInventory(authority.stateRoot,path.join(authority.stateRoot,'state','conversation-graph-transfer'),{maxFileBytes:GRAPH_CONTEXT_MAX_BYTES,maxTotalBytes:Number.MAX_SAFE_INTEGER,maxFiles:100000}),stageHash=canonicalHash({kind:'member-loss-original-read-session',metadata:canonicalHash(metadata),inventoryHash:reader.inventoryHash,consentHash:canonicalHash(e.consent)}),byId=new Map(descriptors.map(row=>[row.eventId,row])),baselineTargets=new Set(negative.localErasureTargets.map(canonicalHash)),binding:HeldSourceMutationBinding={snapshot:e.snapshot,preflight:e.preflight,progress:e.progress,coordinator:e.coordinator,originalLease:hold.originalLease,intent:e.intent};
    if(!descriptors.length)throw new Error('graph-loss-read-session-empty-original');const privateRead=reader.beginSourceHeldMutation(HELD_SOURCE_MUTATION_TOKEN,this,descriptors[0].eventId,binding);privateRead.commit();reader.finalize();reader.assertFinalized();
    const current=()=>{this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,authority});authority.assertMemberLossHeld(e.intent);e.progress.assertCurrentNativeContext(e.coordinator,hold.originalLease);if(retained.metadata!==retainedMetadata||retained.stateRoot!==authority.stateRoot)throw new Error('graph-loss-read-session-retained-scope-changed');transfer.assertScope();const fence=this.options.localErasure;if(!(fence instanceof ConversationGraphLocalErasureFence))throw new Error('graph-loss-read-session-fence-required');for(const target of fence.durableTargets())if(!baselineTargets.has(canonicalHash(target))){this.purgeMemberLossSnapshots(target);throw new Error('graph-loss-read-session-denied');}privateRead.assertReadCurrent!();};
    const final=()=>{current();reader.assertFinalized();e.preflight.assertCurrent();transfer.assertCurrent();current();};
    const facade:GraphHeldSenderStage=new GraphHeldSenderStage(HELD_ORIGINAL_PROMOTION_TOKEN,this,reader,authority,prepared,id=>byId.get(id)?.recordTransportHash,{stageHash,sourceInventoryHash:reader.inventoryHash,metadataHash:canonicalHash(metadata)},current,async()=>{throw new Error('graph-loss-read-session-read-only');},async()=>{throw new Error('graph-loss-read-session-read-only');});
    const read=async(id:string)=>{current();if(!byId.has(id))throw new Error('graph-loss-read-session-unlisted');const record=await privateRead.readCurrentRecord!(id);let value:Awaited<ReturnType<GraphPreparedTransferEnvelopes['readEnvelopeForSenderStage']>>|undefined;try{current();value=await prepared.readEnvelopeForSenderStage(facade,id,record);current();return{record,newRewrap:value.rewrap,close:()=>{value!.close();reader.releasePrivateViews();}};}catch(error){value?.close();reader.releasePrivateViews();throw error;}};
    const session=new GraphHeldSenderReadSession(HELD_ORIGINAL_PROMOTION_TOKEN,this,authority,e.coordinator,reader,e.preflight,prepared,descriptors,keys,negative,current,final,read,(hash,index)=>this.contextPage(hash,index));final();this.heldReadSessions.set(stageHash,new WeakRef(session));return session;
  }

  prepareMemberLossHeldSenderStage(input:{reader:GraphHeldSourceReader;prepared:GraphPreparedTransferEnvelopes;metadata:GraphTransferStageMetadata;context:{authority:GraphCustodyProfileAuthority;hold:GraphHeldSourceContext};ledger:GraphSourceCapacityLedger;evidence:Omit<GraphMemberLossNegativeTransferEvidence,'nativeStore'>}):GraphHeldSenderStage{
    const {reader,prepared,context:{authority,hold},ledger,evidence:e}=input,coordinator=e.coordinator;if(!(reader instanceof GraphHeldSourceReader)||!(prepared instanceof GraphPreparedTransferEnvelopes)||!(authority instanceof GraphCustodyProfileAuthority)||!(ledger instanceof GraphSourceCapacityLedger)||!(e.snapshot instanceof GraphMemberLossSourceSnapshot)||!(e.preflight instanceof GraphMemberLossHeldPreflight)||!(e.progress instanceof GraphNativeMemberLossProgress)||!(coordinator instanceof LeaseCoordinator)||hold.kind!=='member-loss'||!hold.nativeContinuation||e.authority!==authority||e.progress!==hold.nativeContinuation.progress||e.preflight!==hold.nativeContinuation.preflight||coordinator!==hold.nativeContinuation.coordinator||canonicalHash(e.intent)!==canonicalHash(hold.intent))throw new Error('graph-loss-held-sender-actual-continuation-required');
    e.preflight.assertSourceSnapshot(e.snapshot);e.progress.assertCurrentNativeContext(coordinator,hold.originalLease);const metadata=structuredClone(input.metadata),context={ownerPublicKey:authority.ownerPublicKey,previousPublicationHash:authority.publicationHash,previousMembership:metadata.previousMembership,newMembership:metadata.newMembership,nativeIdentities:e.preflight.nativeIdentities};if(!verifyGraphOwnerMemberLossConsent(e.consent,context)||!verifyGraphMemberLossIntent(e.intent,context)||e.progress.consentHash!==canonicalHash(e.consent)||!verifyRecoveryAuthorization(metadata.authorization,metadata.previousMembership,metadata.newMembership,this.options.ownerPublicKey)||!validateRecoverySourceManifest(metadata.manifest)||canonicalHash(metadata.manifest)!==metadata.authorization.sourceManifestHash||!verifyFencedLeaseBridge(metadata.currentLease,metadata.originalCurrentLease,metadata.newMembership)||canonicalHash(metadata.originalCurrentLease)!==canonicalHash(hold.originalLease)||metadata.authorization.pendingOutcomes.some(row=>row.decision!=='refuse'))throw new Error('graph-loss-held-sender-owner-cut-invalid');
    const descriptors=reader.descriptors(),byId=new Map(descriptors.map(row=>[row.eventId,row])),keys=prepared.inventory(),negative=reader.negativeInventory(),lossPlan:Omit<HeldOriginalLossPlan,keyof HeldOriginalPlanCommon|'kind'>={lossIntent:structuredClone(e.intent),consent:structuredClone(e.consent),nativeIdentities:structuredClone(e.preflight.nativeIdentities),previousPublicationHash:authority.publicationHash,sourceInventoryHash:reader.inventoryHash,sourceSnapshotInventoryHash:e.preflight.inventoryHash,sourceErasureInventoryHash:e.preflight.erasureInventoryHash},stageHash=heldLossStageHash({...lossPlan,authorization:metadata.authorization});
    if(canonicalHash(descriptors.map(row=>row.manifestEntry))!==canonicalHash(metadata.manifest.entries)||reader.stateRoot!==authority.stateRoot||reader.machineId!==this.options.machineId||reader.intentHash!==canonicalHash(e.intent)||reader.membershipHash!==canonicalHash(metadata.previousMembership)||reader.nativeLeaseHash!==canonicalHash(hold.lease)||descriptors.length!==e.preflight.currentOperations.length||descriptors.some(row=>!e.preflight.currentOperations.some(op=>op.eventId===row.eventId&&op.operationHash===row.operationHash&&op.terminalHash===row.terminalHash)))throw new Error('graph-loss-held-sender-original-cut-mismatch');prepared.assertInventoryHashForSource(reader,metadata.authorization.recoveryId,metadata.newMembership,metadata.authorization.rewrapInventoryHash);
    let mutation:HeldSourceMutation|undefined,finished=false,readSession:GraphHeldSenderReadSession|undefined,finalProof:GraphHeldOriginalStageProof|undefined;const promoted=new Set<string>(),baselineTargets=new Set(negative.localErasureTargets.map(canonicalHash));
    const current=()=>{this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,authority});authority.assertMemberLossHeld(e.intent);const fence=this.options.localErasure;if(!(fence instanceof ConversationGraphLocalErasureFence))throw new Error('graph-loss-held-sender-fence-required');const targets=fence.durableTargets();for(const target of targets)if(!baselineTargets.has(canonicalHash(target))){this.purgeMemberLossSnapshots(target);throw new Error('graph-loss-held-sender-negative-changed');}e.progress.assertCurrentNativeContext(coordinator,hold.originalLease);ledger.assertLocalContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,signingPublicKey:crypto.createPublicKey(this.options.memberPrivateKey),ownerPublicKey:this.options.ownerPublicKey});if(mutation){if(finished)mutation.assertReadCurrent!();else mutation.assertCurrent();}else{e.preflight.assertSourceSnapshot(e.snapshot);reader.assertCurrent();prepared.assertInventoryHashForSource(reader,metadata.authorization.recoveryId,metadata.newMembership,metadata.authorization.rewrapInventoryHash);}};current();
    const binding:HeldSourceMutationBinding={snapshot:e.snapshot,preflight:e.preflight,progress:e.progress,coordinator,originalLease:hold.originalLease,intent:e.intent};
    const openProof=(id:string)=>{current();const descriptor=byId.get(id);if(!descriptor||!promoted.has(id))throw new Error('graph-loss-held-sender-row-not-durable');const name=this.heldCatalogName(id,stageHash),catalog=this.validateHeldCatalog(this.heldRead(name),name),plan=this.validateHeldPlan(this.heldRead(this.heldPlanName(stageHash)),this.heldPlanName(stageHash));if(catalog.recordTransportHash!==descriptor.recordTransportHash)throw new Error('graph-loss-held-sender-row-transport-changed');return this.heldOriginalProof(catalog,plan,current);};
    const originalFinal=()=>{current();reader.assertFinalized();e.preflight.assertCurrent();};
    const sender:GraphHeldSenderStage=new GraphHeldSenderStage(HELD_ORIGINAL_PROMOTION_TOKEN,this,reader,authority,prepared,id=>byId.get(id)?.recordTransportHash,{stageHash,sourceInventoryHash:reader.inventoryHash,metadataHash:canonicalHash(metadata)},current,async()=>{throw new Error('graph-loss-held-sender-private-prepared-row-required');},async()=>{current();if(promoted.size!==descriptors.length)throw new Error('graph-loss-held-sender-incomplete');if(!finished){mutation!.commit();finished=true;reader.finalize();reader.assertFinalized();finalProof=this.finalizedHeldSenderProof(stageHash,metadata.manifest,current,originalFinal);const read=async(id:string)=>{const proof=openProof(id);try{const row=await proof.readRecord();return{record:row.record,newRewrap:row.newRewrap,close:()=>{row.close();proof.close();}};}catch(error){proof.close();throw error;}};readSession=new GraphHeldSenderReadSession(HELD_ORIGINAL_PROMOTION_TOKEN,this,authority,e.coordinator,reader,e.preflight,prepared,descriptors,keys,negative,current,()=>{originalFinal();finalProof!.assertCurrent();},read,(hash,index)=>reader.contextPage(hash,index));this.heldReadSessions.set(stageHash,new WeakRef(readSession));}finalProof!.assertCurrent();return finalProof!;},id=>this.serial(async()=>{current();if(finished||!byId.has(id)||promoted.has(id))throw new Error('graph-loss-held-sender-row-state-invalid');if(!mutation)mutation=reader.beginSourceHeldMutation(HELD_SOURCE_MUTATION_TOKEN,this,id,binding);const record=await mutation.readRecord!(id),envelope=await prepared.readEnvelopeForSenderStage(sender,id,record);let owned:HeldOriginalInput|undefined;try{current();const descriptor=byId.get(id)!;owned={lossPlan,record,newRewrap:envelope.rewrap,descriptor,stageHash,header:{metadata,descriptor:{v:1,kind:'member-loss-source-held-sender',sourceInventoryHash:reader.inventoryHash,intentHash:reader.intentHash,nativeLeaseHash:reader.nativeLeaseHash},inventory:[{eventId:id,rewrapHash:canonicalHash(envelope.rewrap)}],previous:{lease:hold.lease,originalLease:hold.originalLease}},assertScope:scope=>{if(scope.source!==this||scope.authority!==authority)throw new Error('graph-loss-held-sender-source-mismatch');current();},assertPromotionScope:(source,core)=>{if(source!==this||core!==authority)throw new Error('graph-loss-held-sender-source-mismatch');current();}};const proof=await this.promoteHeldOriginalInput(owned,authority,ledger,mutation);promoted.add(id);return proof;}catch(error){mutation.abort();throw error;}finally{if(owned){owned.newRewrap=null;owned.record={...record,encryptedSourceBundle:null};delete owned.record.rewrap;}envelope.close();reader.releasePrivateViews();}}),()=>{if(!finished)mutation?.abort();readSession?.close();finalProof?.close();if(this.heldReadSessions.get(stageHash)?.deref()===readSession)this.heldReadSessions.delete(stageHash);},(permit,record)=>{current();permit.assertHeldEvidence({...e,source:this});if(record.encryptedSourceBundle||record.rewrap||!this.isErased(record.packet.erasureIdentity)||!e.consent.payload.operations.some(row=>row.eventId===record.packet.eventId&&row.operationHash===canonicalHash(record.packet)&&row.outcome==='pending'))throw new Error('graph-loss-held-sender-negative-control-invalid');},()=>{if(!finished||!readSession)throw new Error('graph-loss-held-sender-read-session-not-finalized');readSession.assertCurrent();return readSession;});return sender;
  }

  /** Durable negative-held Source custody, never a Source receipt or canonical import. */
  promoteHeldOriginalRow(row:GraphOwnedSourceVerifiedRowV2,authority:GraphCustodyProfileAuthority,ledger:GraphSourceCapacityLedger):Promise<GraphHeldOriginalPromotionProof>{if(!(row instanceof GraphOwnedSourceVerifiedRowV2))return Promise.reject(new Error('graph-held-original-actual-components-required'));return this.serial(()=>this.promoteHeldOriginalInput(row,authority,ledger));}
  private async promoteHeldOriginalInput(row:HeldOriginalInput,authority:GraphCustodyProfileAuthority,ledger:GraphSourceCapacityLedger,mutation?:HeldSourceMutation):Promise<GraphHeldOriginalPromotionProof>{
    if(!(authority instanceof GraphCustodyProfileAuthority)||!(ledger instanceof GraphSourceCapacityLedger))throw new Error('graph-held-original-actual-components-required');row.assertScope({source:this,authority});this.assertLocalCustodyContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,authority});ledger.assertLocalContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,signingPublicKey:crypto.createPublicKey(this.options.memberPrivateKey),ownerPublicKey:this.options.ownerPublicKey});
    const write=async(name:string,value:unknown)=>{mutation?.write(name,value);await this.save(name,value,true);};const record=cloneGraphRecord(row.record),next=row.newRewrap?structuredClone(row.newRewrap):null,metadata=row.header.metadata,stageHash=row.stageHash!;let release=()=>{},extra=()=>{};
    try{
      // Register exact owned clones BEFORE the first awaited capacity lookup.
      // A priority deny may run while that lookup is blocked.
      release=retainHeldPrivateView(authority.stateRoot,record);if(next)extra=retainHeldPrivateView(authority.stateRoot,{...record,rewrap:next});
      if(!this.verify(record,record.packet.writerId)||canonicalHash(this.recordForTransport(record))!==row.descriptor.recordTransportHash||canonicalHash(next)!==row.header.inventory.find(value=>value.eventId===record.packet.eventId)?.rewrapHash)throw new Error('graph-held-original-decoded-binding-invalid');this.historicalImportAuthority?.assertMemberLossRepairAllowed(record);await this.assertNewHistoryCapacity(record.packet.eventId);
      const denied=this.isErased(record.packet.erasureIdentity);if(denied&&(record.encryptedSourceBundle||record.rewrap||next)||!denied&&!record.encryptedSourceBundle)throw new Error('graph-held-original-payload-state-invalid');
      const live=()=>{row.assertScope({source:this,authority});if(this.isErased(record.packet.erasureIdentity)!==denied)throw new Error('graph-held-original-erasure-raced');};
      const reservation=record.encryptedSourceBundle?await ledger.reserve(record):null;reservation?.assertCurrent();live();
      const stage=authority.verifiedNegativeRoleLineage().stages.find(value=>canonicalHash(value)===stageHash);if(!row.lossPlan&&!stage)throw new Error('graph-held-original-owner-stage-missing');
      const common={v:1 as const,agentId:this.options.agentId,machineId:this.options.machineId,stageHash,streamHash:canonicalHash(row.header.descriptor),authorization:metadata.authorization,previousMembership:metadata.previousMembership,newMembership:metadata.newMembership,previous:row.header.previous},planBody=row.lossPlan?{...common,kind:'held-member-loss-original-plan' as const,...row.lossPlan}:{...common,kind:'held-original-plan' as const,holdIntent:stage!.holdIntent},plan:HeldOriginalPlan={...planBody,signature:signGraphRecord('graph-held-original-plan-v1',planBody,this.options.memberPrivateKey)};
      await write(this.heldPlanName(stageHash),plan);this.rememberHeldPlan(this.validateHeldPlan(this.heldRead(this.heldPlanName(stageHash)),this.heldPlanName(stageHash)),this.heldPlanName(stageHash));live();
      const {encryptedSourceBundle:_body,rewrap:_old,...control}=this.recordForTransport(record) as Record<string,unknown>,name=this.heldCatalogName(record.packet.eventId,stageHash),prior=this.heldImports.get(name),catalogBody={v:1 as const,kind:'held-original-row' as const,agentId:this.options.agentId,machineId:this.options.machineId,stageHash,eventId:record.packet.eventId,packetHash:canonicalHash(record.packet),recordTransportHash:row.descriptor.recordTransportHash,descriptor:row.descriptor,recordControl:control,bodyState:denied?'denied' as const:'sealed' as const,oldRewrapHash:record.rewrap?canonicalHash(record.rewrap):null,newRewrapHash:next?canonicalHash(next):null,priorCanonical:prior?.priorCanonical??this.records.has(record.packet.eventId)},catalog:HeldOriginalCatalog={...catalogBody,signature:signGraphRecord('graph-held-original-row-v1',catalogBody,this.options.memberPrivateKey)};
      // Marker MUST precede generic intent: cold repair cannot turn a partial
      // held row into a new old-epoch Source ACK or canonical publication.
      await write(name,catalog);this.rememberHeldCatalog(this.validateHeldCatalog(this.heldRead(name),name),name);live();
      await write(this.file(record.packet.eventId,'intent'),this.immutable(record));this.rememberControl(record);live();
      if(record.materialization){const split=splitGraphMaterialization(record.materialization);mutation?.write('contexts/'+split.reference.contextHash+'.json',split.context,false);await this.contexts.persistVerified(record.materialization);}live();
      if(record.encryptedSourceBundle)await write(this.file(record.packet.eventId,'bundle'),record.encryptedSourceBundle);live();
      for(const key of [record.rewrap,next])if(key){await write(this.rewrapFile(record.packet.eventId,canonicalHash(key)),key);live();}
      reservation?.assertCurrent();const readback=await this.readHeldOriginal(catalog,plan);try{live();}finally{readback.close();}if(mutation?.checkpoint)mutation.checkpoint();else mutation?.commit();
      const releases=new Set<()=>void>();const check=()=>{row.assertPromotionScope(this,authority);ledger.assertLocalContext({stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,signingPublicKey:crypto.createPublicKey(this.options.memberPrivateKey),ownerPublicKey:this.options.ownerPublicKey});reservation?.assertCurrent();if(this.isErased((catalog.recordControl as unknown as ConversationGraphReplicationRecord).packet.erasureIdentity)!==(catalog.bodyState==='denied')||canonicalHash(this.validateHeldCatalog(this.heldRead(name),name))!==canonicalHash(catalog))throw new Error('graph-held-original-proof-stale');const original=catalog.recordControl as unknown as ConversationGraphReplicationRecord;
        if(canonicalHash(this.heldRead(this.heldPlanName(stageHash)))!==canonicalHash(plan)||canonicalHash(this.heldRead(this.file(catalog.eventId,'intent')))!==canonicalHash(this.immutable(original)))throw new Error('graph-held-original-proof-file-changed');
        if(catalog.bodyState==='sealed'&&canonicalHash(this.heldRead(this.file(catalog.eventId,'bundle')))!==original.packet.sourceBundleHash)throw new Error('graph-held-original-proof-body-changed');for(const key of [catalog.oldRewrapHash,catalog.newRewrapHash])if(key&&canonicalHash(this.heldRead(this.rewrapFile(catalog.eventId,key)))!==key)throw new Error('graph-held-original-proof-key-changed');
        row.assertPromotionScope(this,authority);if(this.isErased(original.packet.erasureIdentity)!==(catalog.bodyState==='denied'))throw new Error('graph-held-original-proof-stale');};
      check();const proof=new GraphHeldOriginalPromotionProof(HELD_ORIGINAL_PROMOTION_TOKEN,this,{stageHash,eventId:catalog.eventId,recordTransportHash:catalog.recordTransportHash,inventoryHash:canonicalHash({catalog:canonicalHash(catalog),plan:canonicalHash(plan)}),bodyState:catalog.bodyState},check,async()=>{check();const value=await this.readHeldOriginal(catalog,plan);try{check();}catch(error){value.close();throw error;}const close=()=>{value.close();releases.delete(close);};releases.add(close);return{record:value.record,newRewrap:value.newRewrap,close};},()=>{for(const close of releases)close();releases.clear();});for(const ref of this.heldPromotionProofs){const old=ref.deref();if(!old||old.closed)this.heldPromotionProofs.delete(ref);}if(this.heldPromotionProofs.size>=HELD_PRIVATE_REFERENCE_BUDGET){proof.close();throw new Error('graph-held-original-proof-capacity');}this.heldPromotionProofs.add(new WeakRef(proof));return proof;
    }catch(error){if(this.isErased(record.packet.erasureIdentity))await this.purgePayloadFiles(record.packet.eventId);throw error;}finally{release();extra();}
  }

  private async reserveOriginalCapacity(record:ConversationGraphReplicationRecord):Promise<GraphLocalSourceCapacityReservation|undefined>{
    if(!this.options.capacityLedger||!record.encryptedSourceBundle||record.erasure||record.cancellation||record.adoption?.disposition==='refused')return undefined;
    const ledger=this.options.capacityLedger;if(!(ledger instanceof GraphSourceCapacityLedger))throw new Error('graph-source-actual-capacity-ledger-required');if(!(this.options.localErasure instanceof ConversationGraphLocalErasureFence)||this.options.localErasure.stateRoot!==ledger.stateRoot)throw new Error('graph-source-capacity-fence-scope-invalid');
    ledger.assertLocalContext({stateRoot:realpathSync(path.join(this.options.directory,'..','..')),agentId:this.options.agentId,machineId:this.options.machineId,signingPublicKey:crypto.createPublicKey(this.options.memberPrivateKey),ownerPublicKey:this.options.ownerPublicKey});
    if(realpathSync(this.options.directory)!==path.join(ledger.stateRoot,'state','conversation-graph-source'))throw new Error('graph-source-capacity-root-invalid');const reservation=await ledger.reserve(record);reservation.assertCurrent();return reservation;
  }
  private verifyDurableOriginalCapacity(record:ConversationGraphReplicationRecord,reservation:GraphLocalSourceCapacityReservation):GraphDurableOriginalCapacityProof{
    const generation=this.durableGeneration,root=this.options.capacityLedger!.stateRoot;
    const check=()=>{reservation.assertCurrent();const live=this.options.liveAdmission(),context=this.receiptContext(record);if(live.writerId!==(record.adoption?.currentLease.writerId??record.packet.writerId)||live.leaseEpoch!==(context?.leaseEpoch??record.packet.leaseEpoch)||live.membershipEpoch!==this.effectiveMembership(record).epoch)throw new Error('graph-source-capacity-native-context-changed');if(this.durableGeneration!==generation||this.isErased(record.packet.erasureIdentity)||!this.verify(record,record.packet.writerId))throw new Error('graph-source-capacity-original-stale');
      if((heldPrivateViewsByRoot.get(root)?.size??0)+(heldPrivateFailedCounts.get(root)??0)+4>HELD_PRIVATE_REFERENCE_BUDGET)throw new Error('graph-source-capacity-private-view-budget');
      for(const [kind,expected]of [['intent',this.immutable(record)],['source',this.immutable(record)],['bundle',record.encryptedSourceBundle]] as const){const file=path.join(this.options.directory,this.file(record.packet.eventId,kind));const stat=fsSync.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size>GRAPH_REPLICATION_MAX_RECORD_BYTES)throw new Error('graph-source-capacity-original-file-invalid');const fd=fsSync.openSync(file,FILE_FLAGS.O_RDONLY|(FILE_FLAGS.O_NOFOLLOW??0));try{const opened=fsSync.fstatSync(fd);if(opened.ino!==stat.ino||opened.dev!==stat.dev||opened.size!==stat.size)throw new Error('graph-source-capacity-original-file-changed');const data=Buffer.alloc(opened.size+1),count=fsSync.readSync(fd,data,0,data.length,0);if(count!==opened.size||canonicalHash(JSON.parse(data.subarray(0,count).toString('utf8')))!==canonicalHash(expected))throw new Error('graph-source-capacity-original-readback-invalid');fsSync.fsyncSync(fd);}finally{fsSync.closeSync(fd);}}
      this.checkLocalRecovery(record);const fd=fsSync.openSync(this.options.directory,'r');try{fsSync.fsyncSync(fd);}finally{fsSync.closeSync(fd);}reservation.assertCurrent();const after=this.options.liveAdmission();if(after.writerId!==live.writerId||after.leaseEpoch!==live.leaseEpoch||after.membershipEpoch!==live.membershipEpoch||this.durableGeneration!==generation||this.isErased(record.packet.erasureIdentity))throw new Error('graph-source-capacity-original-stale');};
    check();return new GraphDurableOriginalCapacityProof(DURABLE_CAPACITY_TOKEN,{eventId:record.packet.eventId,packetHash:canonicalHash(record.packet),policyHash:reservation.policyHash},check);
  }
  private async persist(record: ConversationGraphReplicationRecord, origin: string): Promise<GraphMemberReceipt> {
    if(record.materialization instanceof GraphSelectedMaterializationV2)throw new Error('graph-paged-history-recovery-export-unavailable');
    if(this.options.localErasure?.isDenied(record.packet.erasureIdentity)&&!this.erasureProofs.some(proof=>erasureCoversPacket(proof,record.packet))&&!this.validMemberLossNegativeCustody(record))throw new Error('graph-source-locally-erased');
    const fence=this.erasureProofs.find(proof=>erasureCoversPacket(proof,record.packet));
    if(fence){record={...record,encryptedSourceBundle:null,erasure:record.erasure??fence};delete record.rewrap;}
    if(record.erasure){record={...record,encryptedSourceBundle:null};delete record.rewrap;}
    if (!this.verify(record, origin)) throw new Error('graph-replication-untrusted-record');
    this.historicalImportAuthority?.assertMemberLossRepairAllowed(record);
    if(this.heldImportBlocks(record))throw new Error('graph-held-original-awaits-activation');
    await this.assertNewHistoryCapacity(record.packet.eventId);
    if(record.erasure)this.retainPendingErasure(record.erasure);
    for (const stored of this.records.values()) if (stored.record.packet.idempotencyKey === record.packet.idempotencyKey
      && stored.record.packet.eventId !== record.packet.eventId) throw new Error('graph-replication-idempotency-conflict');
    const existing = this.records.get(record.packet.eventId);
    if (existing) {
      if (canonicalHash(this.immutable(existing.record)) !== canonicalHash(this.immutable(record))) {
        existing.quarantine = 'duplicate-event-id-different-payload';
        await this.save(this.file(record.packet.eventId, 'quarantine'), { reason: existing.quarantine });
        throw new Error('graph-replication-event-conflict');
      }
      if (record.adoption) await this.persistAdoption(existing, record);
      if (record.preparationProof) await this.persistPreparation(existing, record.preparationProof);
      if(record.erasedControlProof)await this.persistErasedControl(existing,record.erasedControlProof,record.custodyMembership!,record.custodyActivations??[]);
      if (record.certificate) await this.persistCertificate(existing, record.certificate);
      if (record.erasure) await this.persistErasure(existing, record.erasure);
      if (record.cancellation) await this.persistCancellation(existing, record.cancellation);
      if (record.cancellationCertificate) await this.persistCancellationCertificate(existing, record.cancellationCertificate);
      for (const ack of record.certificatePersistenceReceipts ?? []) await this.persistCertificateReceipt(existing, ack);
      for(const receipt of record.commitProofDeliveryReceipts??[])await this.persistDeliveryReceipt(existing,receipt);
      return record.cancellation || (record.erasure&&!record.certificate) ? this.cancellationReceipt(record.packet.eventId) : existing.sourceReceipt??(()=>{throw new Error('graph-history-receipt-not-source');})();
    }
    if(!record.erasure&&!record.cancellation&&this.hasPagedHistoryHold())throw new Error('graph-paged-history-recovery-export-unavailable');
    const capacity=await this.reserveOriginalCapacity(record);
    if (!record.erasure&&!record.cancellation && record.adoption?.disposition !== 'refused' && (!record.encryptedSourceBundle || canonicalHash(record.encryptedSourceBundle) !== record.packet.sourceBundleHash)) throw new Error('graph-replication-bundle-invalid');
    const member = this.effectiveMembership(record).members.find((m) => m.machineId === this.options.machineId);
    if (!member) throw new Error('graph-replication-not-installed-member');
    if (record.encryptedSourceBundle && record.adoption?.disposition !== 'refused'&&!record.cancellation) this.checkLocalRecovery(record);
    await this.save(this.file(record.packet.eventId,'intent'),this.immutable(record),true);this.rememberControl(record);
    if (record.encryptedSourceBundle) await this.save(this.file(record.packet.eventId, 'bundle'), record.encryptedSourceBundle, true);
    if (record.erasure) await this.save(this.file(record.packet.eventId, 'erasure'), record.erasure);
    if(record.preparationProof)await this.save(this.file(record.packet.eventId,'preparation'),record.preparationProof,true);
    if(record.erasedControlProof)await this.save(this.file(record.packet.eventId,'erased-control'),{proof:record.erasedControlProof,membership:record.custodyMembership,activations:record.custodyActivations??[]},true);
    // Immutable source contains no sealed content key, enabling bundle erasure
    // without changing event/receipt hashes. The hash binds the separate bundle.
    if(record.rewrap&&record.adoption&&!record.erasure)await this.save(this.rewrapFile(record.packet.eventId,record.adoption.rewrapHash),record.rewrap,true);
    if (record.adoption) await this.save(this.file(record.packet.eventId, 'adoption'), {adoption:record.adoption,...(record.cancellation ? {cancellation:record.cancellation} : {})});
    if(record.encryptedSourceBundle&&this.isErased(record.packet.erasureIdentity)){await this.purgePayloadFiles(record.packet.eventId);throw new Error('graph-source-erasure-raced-publication');}
    await this.save(this.file(record.packet.eventId, 'source'), this.immutable(record), true);
    const capacityProof=capacity?this.verifyDurableOriginalCapacity(record,capacity):null;capacityProof?.assertCurrent();
    const receipt = record.cancellation ? this.receipt(record, 'cancellation', canonicalHash(record.cancellation))
      : record.erasure ? record.certificate?.memberReceipts.find((r) => r.machineId === this.options.machineId) ?? this.receipt(record,'cancellation',canonicalHash(record.erasure)) : this.receipt(record, 'source');
    if (!receipt) throw new Error('graph-replication-erased-history-needs-certificate');
    if (!this.validLocalReceipt(record, receipt)) throw new Error('graph-replication-member-key-mismatch');
    await this.save(this.file(record.packet.eventId, 'receipt'), receipt, true);
    if(record.encryptedSourceBundle&&this.isErased(record.packet.erasureIdentity)){await this.purgePayloadFiles(record.packet.eventId);throw new Error('graph-source-erasure-raced-receipt');}
    const stored: Stored = { record: structuredClone(record), sourceReceipt: receipt, originalSourceReceipt:receipt.phase==='source'?structuredClone(receipt):null,
      certificateReceipts: new Map(), emittedHash: null, quarantine: null };
    delete stored.record.commitProofDeliveryReceipts;this.records.set(record.packet.eventId, stored);
    if(record.erasure)await this.applyErasureCore(record.erasure);
    if (record.preparationProof) await this.persistPreparation(stored, record.preparationProof);
    if (record.certificate) await this.persistCertificate(stored, record.certificate);
    if (record.cancellation) await this.persistCancellation(stored, record.cancellation);
    if (record.cancellationCertificate) await this.persistCancellationCertificate(stored, record.cancellationCertificate);
    for (const ack of record.certificatePersistenceReceipts ?? []) await this.persistCertificateReceipt(stored, ack);
    for(const receipt of record.commitProofDeliveryReceipts??[])await this.persistDeliveryReceipt(stored,receipt);
    return record.cancellation || (record.erasure&&!record.certificate) ? this.cancellationReceipt(record.packet.eventId) : receipt;
  }

  cancellationReceipt(eventId:string):GraphMemberReceipt {
    const stored=this.required(eventId),record=stored.record;const decision=record.cancellation??record.erasure;
    if(!decision||!this.verify(record,record.packet.writerId))throw new Error('graph-replication-no-durable-cancellation');
    if(stored.sourceReceipt?.phase==='cancellation'&&this.validLocalReceipt(record,stored.sourceReceipt))return structuredClone(stored.sourceReceipt);
    return this.receipt(record,'cancellation',canonicalHash(decision));
  }

  attachErasedControl(eventId:string,proof:GraphWitnessErasedControlProof,membership:GraphMembershipEpoch,activations:GraphMembershipActivationCertificate[]=[]):Promise<void>{return this.serial(()=>this.persistErasedControl(this.required(eventId),proof,membership,activations));}
  private async persistErasedControl(stored:Stored,proof:GraphWitnessErasedControlProof,membership:GraphMembershipEpoch,activations:GraphMembershipActivationCertificate[]=[]):Promise<void>{
    const record={...stored.record,erasedControlProof:proof,custodyMembership:membership,custodyActivations:activations};if(record.preparationProof||!record.erasure||!this.validErasedControl(record))throw new Error('graph-erased-control-authority-invalid');
    await this.save(this.file(record.packet.eventId,'erased-control'),{proof,membership,activations},true);stored.record.erasedControlProof=structuredClone(proof);stored.record.custodyMembership=structuredClone(membership);stored.record.custodyActivations=structuredClone(activations);this.inFlight.delete(record.packet.eventId);
  }
  attachPreparation(eventId: string, proof: GraphWitnessPrepareProof): Promise<void> {
    return this.serial(() => this.persistPreparation(this.required(eventId), proof));
  }
  private async persistPreparation(stored: Stored, proof: GraphWitnessPrepareProof): Promise<void> {
    if (!this.validPreparation(stored.record, proof)) throw new Error('graph-replication-invalid-preparation');
    if (stored.record.preparationProof && canonicalHash(stored.record.preparationProof) !== canonicalHash(proof)) throw new Error('graph-replication-preparation-conflict');
    await this.save(this.file(stored.record.packet.eventId, 'preparation'), proof, true);
    stored.record.preparationProof = structuredClone(proof);
    this.inFlight.delete(stored.record.packet.eventId);
  }

  attachCertificate(eventId: string, certificate: GraphCommitCertificate): Promise<GraphMemberReceipt> {
    return this.serial(async () => {
      const stored = this.required(eventId);if(stored.record.materialization)throw new Error('graph-history-receipt-not-source');
      await this.persistCertificate(stored, certificate);
      const receipt = stored.certificateReceipts.get(this.options.machineId) ?? this.receipt(stored.record, 'certificate', canonicalHash(certificate));
      await this.persistCertificateReceipt(stored, receipt);
      return receipt;
    });
  }
  recordCertificateReceipt(eventId: string, receipt: GraphMemberReceipt): Promise<void> {
    return this.serial(() => this.persistCertificateReceipt(this.required(eventId), receipt));
  }
  /** Cancellation is independently durable before an installed member signs its
   * phase:cancellation receipt. A witness decision alone is not chain completion. */
  attachCancellation(eventId: string, decision: GraphWitnessCancellation): Promise<GraphMemberReceipt> {
    return this.serial(async () => {
      const stored = this.required(eventId);
      await this.persistCancellation(stored, decision);
      return stored.sourceReceipt!;
    });
  }
  attachCancellationCertificate(eventId: string, certificate: GraphCancellationCertificate): Promise<GraphMemberReceipt> {
    return this.serial(async () => {
      const stored = this.required(eventId);if(stored.record.materialization)throw new Error('graph-history-receipt-not-source');
      await this.persistCancellationCertificate(stored, certificate);
      const receipt = stored.certificateReceipts.get(this.options.machineId) ?? this.receipt(stored.record, 'certificate', canonicalHash(certificate));
      await this.persistCertificateReceipt(stored, receipt);
      return receipt;
    });
  }
  private async persistCancellation(stored: Stored, decision: GraphWitnessCancellation): Promise<void> {
    if (stored.record.certificate || !this.validCancellation(stored.record, decision)) throw new Error('graph-replication-invalid-cancellation');
    await this.save(this.file(stored.record.packet.eventId, 'cancellation'), decision);
    stored.record.cancellation = structuredClone(decision);
    const receipt=this.receipt(stored.record,'cancellation',canonicalHash(decision));
    await this.save(this.file(stored.record.packet.eventId,'cancellation-receipt'),receipt);
    stored.sourceReceipt=receipt;
    this.inFlight.delete(stored.record.packet.eventId);
  }
  private async persistCancellationCertificate(stored: Stored, certificate: GraphCancellationCertificate): Promise<void> {
    if (stored.record.certificate || !this.validCancellationCertificate(stored.record, certificate)) throw new Error('graph-replication-invalid-terminal-certificate');
    if (stored.record.cancellationCertificate && canonicalHash(stored.record.cancellationCertificate) !== canonicalHash(certificate)) throw new Error('graph-replication-terminal-certificate-conflict');
    await this.save(this.file(stored.record.packet.eventId, 'terminal'), certificate);
    stored.record.cancellationCertificate = structuredClone(certificate);
    this.inFlight.delete(stored.record.packet.eventId);
  }
  private async persistCertificate(stored: Stored, certificate: GraphCommitCertificate): Promise<void> {
    if (stored.record.cancellation || stored.record.cancellationCertificate || !this.validCertificate(stored.record, certificate)) throw new Error('graph-replication-invalid-certificate');
    this.historicalImportAuthority?.assertMemberLossRepairAllowed({...stored.record,certificate});
    if (stored.record.certificate && canonicalHash(stored.record.certificate) !== canonicalHash(certificate)) {
      stored.quarantine = 'conflicting-final-certificate';
      await this.save(this.file(stored.record.packet.eventId, 'quarantine'), { reason: stored.quarantine });
      throw new Error('graph-replication-certificate-conflict');
    }
    await this.save(this.file(stored.record.packet.eventId, 'certificate'), certificate);
    stored.record.certificate = structuredClone(certificate);
    this.inFlight.delete(stored.record.packet.eventId);
  }
  private async persistCertificateReceipt(stored: Stored, receipt: GraphMemberReceipt): Promise<void> {
    const terminal = this.terminal(stored.record);
    if (!terminal || !verifyMemberReceipt(receipt, stored.record.packet, this.certificateMembership(stored.record),
      'certificate', canonicalHash(terminal), this.certificateContext(stored.record))) throw new Error('graph-replication-invalid-certificate-receipt');
    // A member's first durable receipt for this exact final certificate is an
    // immutable fact. Retries must not manufacture new HLC-identical payloads.
    if (stored.certificateReceipts.has(receipt.machineId)) return;
    const next = new Map(stored.certificateReceipts); next.set(receipt.machineId, receipt);
    await this.save(this.file(stored.record.packet.eventId, 'acks'), [...next.values()]);
    stored.certificateReceipts = next;
    stored.record.certificatePersistenceReceipts = [...next.values()].sort((a, b) => a.machineId.localeCompare(b.machineId));
    this.inFlight.delete(stored.record.packet.eventId);
  }

  status(eventId: string): GraphReplicationStatus {
    const stored = this.required(eventId);
    const missingMembers = stored.record.materialization&&this.validMaterialization(stored.record)?[]:this.effectiveMembership(stored.record).members
      .filter((m) => !stored.certificateReceipts.has(m.machineId)).map((m) => m.machineId).sort();
    return { state: stored.quarantine ? 'quarantined' : !this.terminal(stored.record) ? 'prepared'
      : missingMembers.length ? 'certified' : stored.record.cancellationCertificate?.outcome ?? 'committed', missingMembers, erased: !!stored.record.erasure };
  }
  /** Original request success additionally rechecks live admission. A certificate
   * status lookup after reconciliation can still truthfully show the old commit. */
  mayAcknowledgeNewWrite(eventId: string, actuation?: {lease: GraphWitnessLease; originalLease: LeaseRecord}): boolean {
    return this.status(eventId).state === 'committed' && (actuation
      ? this.mayContinue(eventId, actuation.lease, actuation.originalLease) : this.admitted(this.required(eventId).record));
  }
  commitProofDeliveryReceipt(eventId: string): GraphCommitProofDeliveryReceipt {
    const stored = this.required(eventId); const record = stored.record; const terminal = this.terminal(record);
    if (!terminal || stored.quarantine || !this.verify(record,record.packet.writerId) || !this.fullyPersisted(record)) throw new Error('graph-replication-proof-not-durable');
    const original=this.deliveryReceipts.get(eventId)?.get(this.options.machineId);if(original&&this.verifyCommitProofDeliveryReceipt(original,record))return structuredClone(original);
    const membership = this.effectiveMembership(record); const context = this.receiptContext(record);
    const value = {v:1 as const,agentId:record.packet.agentId,eventId,operationHash:canonicalHash(record.packet),certificateHash:canonicalHash(terminal),
      certificatePersistenceReceiptsHash:record.materialization?canonicalHash(record.materialization.activation.stateTransferReceipts):canonicalHash([...(record.certificatePersistenceReceipts??[])].sort((a,b)=>a.machineId.localeCompare(b.machineId))),materializationHash:record.materialization?canonicalHash(graphHistoricalMaterializationRef(record.materialization)):null,
      machineId:this.options.machineId,membershipEpoch:membership.epoch,leaseEpoch:context?.leaseEpoch??record.packet.leaseEpoch,
      persistedAt:(this.options.now?.()??new Date()).toISOString()};
    const receipt = {...value,signature:signGraphRecord(GRAPH_COMMIT_PROOF_DELIVERY_DOMAIN,value,this.options.memberPrivateKey)};
    if (!this.verifyCommitProofDeliveryReceipt(receipt,record)) throw new Error('graph-replication-proof-signing-key-mismatch');
    return receipt;
  }

  verifyCommitProofDeliveryReceipt(receipt:GraphCommitProofDeliveryReceipt,record:ConversationGraphReplicationRecord):boolean{
    return verifyGraphCommitProofDeliveryReceipt(receipt,record,{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:this.options.witnessPublicKeys,installedMembership:this.options.installedMembership});
  }
  recordCommitProofDeliveryReceipt(eventId:string,receipt:GraphCommitProofDeliveryReceipt):Promise<void>{return this.serial(()=>this.persistDeliveryReceipt(this.required(eventId),receipt));}
  private async persistDeliveryReceipt(stored:Stored,receipt:GraphCommitProofDeliveryReceipt):Promise<void>{
    const id=stored.record.packet.eventId;if(!this.verifyCommitProofDeliveryReceipt(receipt,stored.record))throw new Error('graph-replication-invalid-delivery-receipt');
    const next=new Map([...(this.deliveryReceipts.get(id)??[])].filter(([,prior])=>this.verifyCommitProofDeliveryReceipt(prior,stored.record)));if(next.has(receipt.machineId))return;next.set(receipt.machineId,structuredClone(receipt));
    await this.save(this.file(id,'deliveries'),[...next.values()].sort((a,b)=>a.machineId.localeCompare(b.machineId)));this.deliveryReceipts.set(id,next);
    if(next.size===this.effectiveMembership(stored.record).members.length)stored.record.commitProofDeliveryReceipts=[...next.values()].sort((a,b)=>a.machineId.localeCompare(b.machineId));
    this.inFlight.delete(id);
  }
  /** Persist a member's first delivery attestation before returning it. */
  durableCommitProofDeliveryReceipt(eventId:string):Promise<GraphCommitProofDeliveryReceipt>{return this.serial(async()=>{const receipt=this.commitProofDeliveryReceipt(eventId);await this.persistDeliveryReceipt(this.required(eventId),receipt);return receipt;});}
  verifyDeliveryCompletionReceipt(receipt:GraphDeliveryCompletionReceipt,record:ConversationGraphReplicationRecord):boolean{
    const membership=this.effectiveMembership(record),member=membership.members.find(member=>member.machineId===receipt?.machineId),terminal=this.terminal(record),epoch=this.receiptContext(record)?.leaseEpoch??record.packet.leaseEpoch;
    return !!member&&!!terminal&&Object.keys(receipt).sort().join(',')==='agentId,certificateHash,deliveryFactsHash,eventId,leaseEpoch,machineId,materializationHash,membershipEpoch,operationHash,persistedAt,signature,v'
      &&receipt.v===1&&receipt.agentId===record.packet.agentId&&receipt.eventId===record.packet.eventId&&receipt.operationHash===canonicalHash(record.packet)&&receipt.certificateHash===canonicalHash(terminal)
      &&graphCompleteDeliveryFacts(record).length===membership.members.length&&receipt.deliveryFactsHash===graphDeliveryFactsHash(record)&&receipt.membershipEpoch===membership.epoch&&receipt.leaseEpoch===epoch
      &&receipt.materializationHash===(record.materialization?canonicalHash(graphHistoricalMaterializationRef(record.materialization)):null)&&Number.isFinite(Date.parse(receipt.persistedAt))
      &&verifyGraphRecord(GRAPH_DELIVERY_COMPLETION_DOMAIN,unsigned(receipt),receipt.signature,member.signingPublicKey);
  }
  durableDeliveryCompletionReceipt(eventId:string):Promise<GraphDeliveryCompletionReceipt>{return this.serial(async()=>{
    const stored=this.required(eventId),record=stored.record;if(!this.allCommitProofDelivered(eventId))throw new Error('graph-delivery-completion-not-durable');
    const disk=await this.load(this.file(eventId,'deliveries')) as GraphCommitProofDeliveryReceipt[]|null;
    if(!disk||disk.length!==this.effectiveMembership(record).members.length||new Set(disk.map(receipt=>receipt.machineId)).size!==disk.length||disk.some(receipt=>!this.verifyCommitProofDeliveryReceipt(receipt,record))||graphDeliveryFactsHash({...record,commitProofDeliveryReceipts:disk})!==graphDeliveryFactsHash(record))throw new Error('graph-delivery-completion-not-durable');
    const prior=this.deliveryCompletionReceipts.get(eventId)?.get(this.options.machineId);if(prior&&this.verifyDeliveryCompletionReceipt(prior,record))return structuredClone(prior);
    const membership=this.effectiveMembership(record),value={v:1 as const,agentId:record.packet.agentId,eventId,operationHash:canonicalHash(record.packet),certificateHash:canonicalHash(this.terminal(record)),deliveryFactsHash:graphDeliveryFactsHash(record),materializationHash:record.materialization?canonicalHash(graphHistoricalMaterializationRef(record.materialization)):null,membershipEpoch:membership.epoch,leaseEpoch:this.receiptContext(record)?.leaseEpoch??record.packet.leaseEpoch,machineId:this.options.machineId,persistedAt:(this.options.now?.()??new Date()).toISOString()};
    const receipt={...value,signature:signGraphRecord(GRAPH_DELIVERY_COMPLETION_DOMAIN,value,this.options.memberPrivateKey)};await this.persistDeliveryCompletionReceipt(stored,receipt);return receipt;
  });}
  private async persistDeliveryCompletionReceipt(stored:Stored,receipt:GraphDeliveryCompletionReceipt):Promise<void>{
    if(!this.verifyDeliveryCompletionReceipt(receipt,stored.record))throw new Error('graph-delivery-completion-receipt-invalid');const id=stored.record.packet.eventId,next=new Map(this.deliveryCompletionReceipts.get(id)??[]);if(next.has(receipt.machineId))return;next.set(receipt.machineId,structuredClone(receipt));await this.save(this.file(id,'delivery-completions'),[...next.values()].sort((a,b)=>a.machineId.localeCompare(b.machineId)));this.deliveryCompletionReceipts.set(id,next);
  }
  recordDeliveryCompletionReceipt(eventId:string,receipt:GraphDeliveryCompletionReceipt):Promise<void>{return this.serial(()=>this.persistDeliveryCompletionReceipt(this.required(eventId),receipt));}
  allDeliveryCompletionPersisted(eventId:string):boolean{const record=this.required(eventId).record;if(!this.allCommitProofDelivered(eventId))return false;return this.effectiveMembership(record).members.every(member=>{const receipt=this.deliveryCompletionReceipts.get(eventId)?.get(member.machineId);return !!receipt&&this.verifyDeliveryCompletionReceipt(receipt,record);});}
  /** Replay truth for an old terminal operation transferred under an actual
   * activated full-state plan. It is not a live-write/delivery acknowledgment. */
  /** Verify acknowledged local memory without electing a role or allocating a
   * source slot. The caller must separately check every reachable peer's debt. */
  async verifyLocalAcknowledgedSnapshot(reader:ReplicatedStoreReader,dropped:DroppedOriginRegistry,authority:GraphCustodyProfileAuthority):Promise<GraphLocalAcknowledgedSnapshot>{
    if(!(reader instanceof ReplicatedStoreReader)||!(dropped instanceof DroppedOriginRegistry)||!(authority instanceof GraphCustodyProfileAuthority)||authority.agentId!==this.options.agentId||realpathSync(this.options.directory)!==path.join(authority.stateRoot,'state','conversation-graph-source'))throw new Error('graph-local-snapshot-actual-components-required');
    const owner=this.options.ownerPublicKey instanceof crypto.KeyObject&&this.options.ownerPublicKey.type==='public'?this.options.ownerPublicKey:crypto.createPublicKey(this.options.ownerPublicKey),membership=this.options.installedMembership;
    if(!membership||!crypto.createPublicKey(authority.ownerPublicKey).export({type:'spki',format:'der'}).equals(owner.export({type:'spki',format:'der'}))||!(this.options.localErasure instanceof ConversationGraphLocalErasureFence))throw new Error('graph-local-snapshot-authority-mismatch');
    const member=membership.members.find(row=>row.machineId===this.options.machineId),signer=this.options.memberPrivateKey instanceof crypto.KeyObject&&this.options.memberPrivateKey.type==='public'?this.options.memberPrivateKey:crypto.createPublicKey(this.options.memberPrivateKey);if(!member||!crypto.createPublicKey(member.signingPublicKey).export({type:'spki',format:'der'}).equals(signer.export({type:'spki',format:'der'})))throw new Error('graph-local-snapshot-member-key-mismatch');
    const fence=this.options.localErasure;if(fence.stateRoot!==authority.stateRoot||!reader.usesDroppedOriginRegistry(dropped))throw new Error('graph-local-snapshot-component-scope-mismatch');
    authority.assertPositiveWrites(membership);this.assertHeldImportsSettled(authority);const generation=this.durableGeneration,negative=this.localRetainedNegativeHash(),dropHash=dropped.physicalSnapshot(authority.stateRoot);
    const union=this.certifiedUnion(reader,dropped);if(union.quarantined.length||union.missingEventIds.length)throw new Error('graph-local-snapshot-incomplete-source');
    const reopened=await ConversationGraphReplication.open(this.options,'verify-only',this.historicalImportAuthority??undefined),terminal=reopened.recordsForRepair().filter(record=>!!reopened.terminal(record)).sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence);
    const prefix:ConversationGraphReplicationRecord[]=[];let sequence=0,predecessor:string|null=null;
    for(const record of terminal){if(record.packet.sourceSequence!==sequence+1||record.packet.predecessorHash!==predecessor||!reopened.verifyHistoricalRecord(record)||dropped.droppedOrigins(CONVERSATION_GRAPH_STORE).has(record.packet.writerId))throw new Error('graph-local-snapshot-source-gap');if(!reopened.fullyPersisted(record)||!record.materialization&&!reopened.allCommitProofDelivered(record.packet.eventId))break;prefix.push(record);sequence=record.packet.sourceSequence;predecessor=record.packet.coreHash;}
    if(!prefix.length)throw new Error('graph-local-snapshot-no-acknowledged-memory');const unionIds=new Set(union.records.map(record=>record.packet.eventId));
    if(union.records.some(record=>record.packet.sourceSequence>sequence)||prefix.some(record=>record.certificate&&!this.options.localErasure?.isDenied(record.packet.erasureIdentity)&&!unionIds.has(record.packet.eventId)))throw new Error('graph-local-snapshot-reader-mismatch');
    const verifiedContexts=new Set<string>();for(const record of prefix){
      if(this.durableGeneration!==generation||this.localRetainedNegativeHash()!==negative)throw new Error('graph-local-snapshot-state-changed');
      for(const [suffix,value]of [['source',this.immutable(record)],['intent',this.immutable(record)],...(record.certificate?[['certificate',record.certificate]]:[]),...(record.cancellationCertificate?[['terminal',record.cancellationCertificate]]:[])] as Array<[string,unknown]>){if((await this.syncHistoricalFile(this.file(record.packet.eventId,suffix),GRAPH_REPLICATION_MAX_RECORD_BYTES)).hash!==canonicalHash(value))throw new Error('graph-local-snapshot-file-mismatch');}
      if(!record.materialization){await this.syncHistoricalFile(this.file(record.packet.eventId,'acks'),GRAPH_REPLICATION_MAX_RECORD_BYTES);await this.syncHistoricalFile(this.file(record.packet.eventId,'deliveries'),GRAPH_REPLICATION_MAX_RECORD_BYTES);}
      if(record.materialization){const ref=splitGraphMaterialization(record.materialization).reference;if((await this.syncHistoricalFile(this.file(record.packet.eventId,'materialization'),GRAPH_REPLICATION_MAX_RECORD_BYTES)).hash!==canonicalHash(ref))throw new Error('graph-local-snapshot-context-mismatch');if(!verifiedContexts.has(ref.contextHash)){if((await this.syncHistoricalFile(path.join('contexts',ref.contextHash+'.json'),GRAPH_CONTEXT_MAX_BYTES)).hash!==ref.contextHash)throw new Error('graph-local-snapshot-context-mismatch');verifiedContexts.add(ref.contextHash);}}
      if(record.certificate&&!reopened.isErased(record.packet.erasureIdentity)){if(!record.encryptedSourceBundle||(await this.syncHistoricalFile(this.file(record.packet.eventId,'bundle'),GRAPH_REPLICATION_MAX_RECORD_BYTES)).hash!==record.packet.sourceBundleHash)throw new Error('graph-local-snapshot-body-unavailable');if(record.rewrap){const digest=record.materialization?.rewrapHash??record.adoption?.rewrapHash;if(!digest||(await this.syncHistoricalFile(this.rewrapFile(record.packet.eventId,digest),GRAPH_REPLICATION_MAX_RECORD_BYTES)).hash!==digest)throw new Error('graph-local-snapshot-key-unavailable');}const body=reopened.openVerifiedPayload(record);body.fill(0);}
    }
    const check=()=>{authority.assertPositiveWrites(membership);this.assertHeldImportsSettled(authority);if(this.options.localErasure!==fence||fence.stateRoot!==authority.stateRoot||realpathSync(this.options.directory)!==path.join(authority.stateRoot,'state','conversation-graph-source')||!reader.usesDroppedOriginRegistry(dropped)||this.durableGeneration!==generation||this.localRetainedNegativeHash()!==negative||dropped.physicalSnapshot(authority.stateRoot)!==dropHash)throw new Error('graph-local-snapshot-state-changed');};check();
    const revision=canonicalHash(prefix.map(record=>({id:record.packet.eventId,packetHash:canonicalHash(record.packet),terminalHash:canonicalHash(reopened.terminal(record)),materialization:record.materialization?graphHistoricalMaterializationRef(record.materialization):null}))),last=prefix.at(-1),acknowledgedAt=last?.certificate?.committedAt??last?.cancellationCertificate?.canceledAt??(this.options.now?.()??new Date()).toISOString();
    return new GraphLocalAcknowledgedSnapshot(LOCAL_ACK_SNAPSHOT_TOKEN,this,authority,{stateRoot:authority.stateRoot,agentId:this.options.agentId,machineId:this.options.machineId,membershipHash:canonicalHash(membership),highestAcknowledgedSequence:sequence,revision,acknowledgedAt},check);
  }
  /** Negative-held inventory only. It issues neither lease nor Source ACK. */
  async verifyMemberLossInventory(reader:ReplicatedStoreReader,dropped:DroppedOriginRegistry,intake:ConversationGraphIntake,authority:GraphCustodyProfileAuthority,intent:GraphMemberLossIntentProof,policy:{maxSnapshotBytes?:number}={}):Promise<GraphMemberLossSourceSnapshot>{
    const capacityLimitBytes=graphMemberLossSnapshotBudget(policy.maxSnapshotBytes),fence=this.options.localErasure,root=authority.stateRoot,membership=this.options.installedMembership;
    const scope=()=>{if(!(reader instanceof ReplicatedStoreReader)||!(dropped instanceof DroppedOriginRegistry)||!(intake instanceof ConversationGraphIntake)||!(authority instanceof GraphCustodyProfileAuthority)||!(fence instanceof ConversationGraphLocalErasureFence)||this.options.localErasure!==fence||fence.stateRoot!==root||realpathSync(this.options.directory)!==path.join(root,'state','conversation-graph-source')||authority.agentId!==this.options.agentId||!membership||canonicalHash(authority.currentMembership())!==canonicalHash(membership)||!reader.usesDroppedOriginRegistry(dropped))throw new Error('graph-member-loss-component-scope');const owner=this.options.ownerPublicKey instanceof crypto.KeyObject&&this.options.ownerPublicKey.type==='public'?this.options.ownerPublicKey:crypto.createPublicKey(this.options.ownerPublicKey);if(!crypto.createPublicKey(authority.ownerPublicKey).export({type:'spki',format:'der'}).equals(owner.export({type:'spki',format:'der'})))throw new Error('graph-member-loss-owner-scope');const member=membership.members.find(row=>row.machineId===this.options.machineId),signer=this.options.memberPrivateKey instanceof crypto.KeyObject&&this.options.memberPrivateKey.type==='public'?this.options.memberPrivateKey:crypto.createPublicKey(this.options.memberPrivateKey);if(!member||!crypto.createPublicKey(member.signingPublicKey).export({type:'spki',format:'der'}).equals(signer.export({type:'spki',format:'der'})))throw new Error('graph-member-loss-member-key-scope');authority.assertMemberLossHeld(intent);if(intent.payload.removed.some(row=>row.machineId===this.options.machineId))throw new Error('graph-member-loss-removed-source');};scope();
    await this.serial(async()=>{this.assertNativeTailReadable();});scope();const localTargets=(fence as ConversationGraphLocalErasureFence).durableTargets(),negativeMetadataBytes=Buffer.byteLength(canonicalJson(localTargets));if(negativeMetadataBytes>capacityLimitBytes)throw new Error('graph-member-loss-snapshot-byte-capacity');const physical=this.memberLossPhysicalInventory(true,capacityLimitBytes-negativeMetadataBytes);this.memberLossMemoryCapacity(capacityLimitBytes-negativeMetadataBytes);const readView=()=>{const view=this.certifiedUnion(reader,dropped);if(view.quarantined.length||view.missingEventIds.length)throw new Error('graph-member-loss-reader-evidence-missing');return {records:view.records,hash:canonicalHash({accepted:view.records.map(row=>({eventId:row.packet.eventId,operationHash:canonicalHash(row.packet),terminalHash:canonicalHash(this.terminal(row))})).sort((a,b)=>a.eventId<b.eventId?-1:1),pending:[...view.pendingEventIds].sort()})};};let generation=this.durableGeneration;const adopted=new Map<string,{hash:string;dev:number;ino:number;limit:number}>(),originalNames=new Set(physical.names),negative=this.localRetainedNegativeHash(),dropHash=dropped.physicalSnapshot(root);
    const heldIntake=await intake.verifyHeldReservations(root,this.options.ownerPublicKey,fence as ConversationGraphLocalErasureFence,capacityLimitBytes-physical.capacityBytes-negativeMetadataBytes);scope();const readerView=readView();
    const capacityBytes=physical.capacityBytes+heldIntake.capacityBytes+negativeMetadataBytes,reopened=await ConversationGraphReplication.open(this.options,'verify-only',this.historicalImportAuthority??undefined),sourceRecords=[...reopened.recordsForRepair(),...await reopened.controlIntents()],merged=new Map<string,ConversationGraphReplicationRecord>();
    for(const record of [...sourceRecords,...heldIntake.records]){if(!this.verify(record,record.packet.writerId))throw new Error('graph-member-loss-untrusted-record');const prior=merged.get(record.packet.eventId);if(prior&&canonicalHash(this.immutable(prior))!==canonicalHash(this.immutable(record)))throw new Error('graph-member-loss-source-conflict');if(!prior)merged.set(record.packet.eventId,record);}
    if(readerView.records.some(record=>!merged.has(record.packet.eventId)||canonicalHash(merged.get(record.packet.eventId)!.packet)!==canonicalHash(record.packet)))throw new Error('graph-member-loss-reader-evidence-missing');
    if(merged.size>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES)throw new Error('graph-member-loss-source-capacity');const records=[...merged.values()].sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence),entries:GraphMemberLossSourceEntry[]=[];let predecessor:string|null=null,sequence=0,ackSequence=0,ackCore:string|null=null,ackOpen=true;
    for(const record of records){scope();if(this.durableGeneration!==generation||this.localRetainedNegativeHash()!==negative)throw new Error('graph-member-loss-source-state-changed');if(record.packet.sourceSequence!==sequence+1||record.packet.predecessorHash!==predecessor)throw new Error('graph-member-loss-known-predecessor-gap');sequence=record.packet.sourceSequence;predecessor=record.packet.coreHash;const denied=this.isErased(record.packet.erasureIdentity);if(!denied&&!record.cancellation&&record.adoption?.disposition!=='refused')this.checkLocalRecovery(record);if(denied){if(record.encryptedSourceBundle)throw new Error('graph-member-loss-denied-payload-remains');await this.assertLocalErasurePurged(record.packet.erasureIdentity);}
      const known=reopened.records.get(record.packet.eventId),terminal=known&&reopened.terminal(known.record),ack=!!known&&!!terminal&&reopened.fullyPersisted(known.record)&&(!!known.record.materialization||reopened.allCommitProofDelivered(record.packet.eventId));if(ackOpen&&ack){ackSequence=sequence;ackCore=record.packet.coreHash;}else ackOpen=false;
      const outcome=record.certificate?'committed':record.cancellationCertificate?.outcome==='erased'?'erased':record.cancellationCertificate?'canceled':'pending';const receipt=known?reopened.retainedOriginalSourceReceipt(record.packet.eventId):null;entries.push({eventId:record.packet.eventId,operationHash:canonicalHash(record.packet),sourceProofHash:canonicalHash({coreType:record.coreType,packet:record.packet,packetSignature:record.packetSignature,core:record.core,authorizationProof:record.authorizationProof}),sourceSequence:sequence,predecessorHash:record.packet.predecessorHash,coreHash:record.packet.coreHash,sourceBundleHash:record.packet.sourceBundleHash,controlHash:record.packet.controlHash,outcome,terminalHash:record.certificate?canonicalHash(record.certificate):record.cancellationCertificate?canonicalHash(record.cancellationCertificate):null,originalSourceReceiptHash:receipt?canonicalHash(receipt):null});
    }
    const erasureInventoryHash=canonicalHash({source:this.erasureProofs.map(canonicalHash).sort(),local:(fence as ConversationGraphLocalErasureFence).targets().map(canonicalHash).sort(),intake:heldIntake.erasureInventoryHash});
    const current=()=>{scope();heldIntake.assertCurrent();if(this.durableGeneration!==generation||this.localRetainedNegativeHash()!==negative||dropped.physicalSnapshot(root)!==dropHash||readView().hash!==readerView.hash)throw new Error('graph-member-loss-source-state-changed');};const check=()=>{current();if(this.memberLossPhysicalInventory(false,capacityLimitBytes,new Set(adopted.keys())).hash!==physical.hash)throw new Error('graph-member-loss-source-state-changed');for(const [name,row]of adopted){const stat=fsSync.lstatSync(path.join(this.options.directory,name));if(stat.dev!==row.dev||stat.ino!==row.ino||canonicalHash(this.heldRead(name,row.limit))!==row.hash)throw new Error('graph-member-loss-adopted-file-changed');}};check();
    const mutation=(source:ConversationGraphReplication,binding:HeldSourceMutationBinding):HeldSourceMutation=>{if(source!==this||binding.snapshot!==snapshot||binding.progress.custodyAuthority!==authority||binding.progress.stateRoot!==root||binding.progress.intentHash!==canonicalHash(intent)||binding.preflight.stateRoot!==root||binding.preflight.intentHash!==canonicalHash(intent)||binding.preflight.inventoryHash!==snapshot.inventoryHash)throw new Error('graph-member-loss-snapshot-writer-scope');check();let expected=generation,done=false;const writes=new Map<string,{hash:string;limit:number}>();const readCurrent=()=>{scope();heldIntake.assertCurrent();binding.progress.assertCurrentNativeContext(binding.coordinator,binding.originalLease);if(this.durableGeneration!==expected||this.localRetainedNegativeHash()!==negative||dropped.physicalSnapshot(root)!==dropHash)throw new Error('graph-member-loss-snapshot-writer-state-changed');},live=()=>{if(done)throw new Error('graph-member-loss-snapshot-writer-closed');readCurrent();};return{assertReadCurrent:readCurrent,assertCurrent:live,write:(name,value,versioned=true)=>{live();writes.set(name,{hash:canonicalHash(value),limit:name.startsWith('contexts/')?GRAPH_CONTEXT_MAX_BYTES:GRAPH_REPLICATION_MAX_RECORD_BYTES});if(versioned)expected++;},commit:()=>{live();for(const [name,row]of writes){if(canonicalHash(this.heldRead(name,row.limit))!==row.hash)throw new Error('graph-member-loss-snapshot-writer-readback');if(!originalNames.has(name)){const stat=fsSync.lstatSync(path.join(this.options.directory,name));adopted.set(name,{...row,dev:stat.dev,ino:stat.ino});}}generation=expected;check();done=true;},abort:()=>{done=true;}};};
    const snapshot=new GraphMemberLossSourceSnapshot(MEMBER_LOSS_SOURCE_TOKEN,{stateRoot:root,machineId:this.options.machineId,agentId:this.options.agentId,membershipHash:canonicalHash(membership),intentHash:canonicalHash(intent),inventoryHash:canonicalHash({entries,sourceFiles:physical.hash,intake:heldIntake.inventoryHash,erasureInventoryHash,droppedOriginsHash:dropHash,readerHash:readerView.hash}),erasureInventoryHash,capacityBytes,capacityLimitBytes,acknowledgedPrefix:{sourceSequence:ackSequence,coreHash:ackCore}},records,entries,check,{erasures:this.erasureProofs,localTargets},()=>heldIntake.close(),mutation);for(const reference of this.memberLossSnapshots){const prior=reference.deref();if(!prior||prior.closed)this.memberLossSnapshots.delete(reference);}if(this.memberLossSnapshots.size>=64){snapshot.close();throw new Error('graph-member-loss-snapshot-capacity');}this.memberLossSnapshots.add(new WeakRef(snapshot));return snapshot;
  }
  /** Post-CAS loss continuation only. The current real native bridge replaces
   * no archived floor and grants no positive graph authority or Source ACK. */
  async verifyMemberLossHeldSourceReader(reader:ReplicatedStoreReader,dropped:DroppedOriginRegistry,intake:ConversationGraphIntake,authority:GraphCustodyProfileAuthority,input:GraphMemberLossHeldSourceContinuation&{intent:GraphMemberLossIntentProof;lease:GraphWitnessLease;originalLease:LeaseRecord}):Promise<{reader:GraphHeldSourceReader;hold:GraphHeldSourceContext}>{
    if(!(input.progress instanceof GraphNativeMemberLossProgress)||!(input.preflight instanceof GraphMemberLossHeldPreflight)||!(input.coordinator instanceof LeaseCoordinator))throw new Error('graph-loss-held-source-actual-continuation-required');
    const hold:GraphHeldSourceContext=Object.freeze({kind:'member-loss',intent:structuredClone(input.intent),lease:structuredClone(input.lease),originalLease:structuredClone(input.originalLease),nativeContinuation:Object.freeze({progress:input.progress,preflight:input.preflight,coordinator:input.coordinator})});
    const held=await this.verifyHeldSourceReader(reader,dropped,intake,authority,hold);try{const actual=held.descriptors().map(row=>({eventId:row.eventId,operationHash:row.operationHash,coreHash:row.coreHash,predecessorHash:row.predecessorHash,sourceSequence:row.sourceSequence,outcome:row.outcome,terminalHash:row.terminalHash}));if(canonicalHash(actual)!==canonicalHash(input.preflight.currentOperations))throw new Error('graph-loss-held-source-cut-changed');input.preflight.assertCurrent();held.assertCurrent();return{reader:held,hold};}catch(error){held.close();throw error;}
  }
  /** Physical metadata and one-record reads, never a full source-body array. */
  async verifyHeldSourceReader(reader:ReplicatedStoreReader,dropped:DroppedOriginRegistry,intake:ConversationGraphIntake,authority:GraphCustodyProfileAuthority,hold:GraphHeldSourceContext):Promise<GraphHeldSourceReader>{
    // Copy only plain signed context; actual authority/native instances retain
    // their identities. A caller cannot retarget a live reader across awaits.
    const captured={...hold,intent:structuredClone(hold.intent),lease:structuredClone(hold.lease),originalLease:structuredClone(hold.originalLease),...(hold.nativeContinuation?{nativeContinuation:Object.freeze({...hold.nativeContinuation})}:{})};
    const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};freeze(captured.intent);freeze(captured.lease);freeze(captured.originalLease);hold=Object.freeze(captured) as GraphHeldSourceContext;
    const root=authority.stateRoot,fence=this.options.localErasure,membership=this.options.installedMembership;let activeWriter:{snapshot:HeldSourceMutation;expectedGeneration:number;finalized?:boolean}|undefined;
    const scope=(writer?:symbol)=>{if(!(authority instanceof GraphCustodyProfileAuthority)||!(reader instanceof ReplicatedStoreReader)||!(dropped instanceof DroppedOriginRegistry)||!(intake instanceof ConversationGraphIntake)||(!hold.nativeContinuation&&!(hold.nativeFloor instanceof ConversationGraphNativeTailFloor))||!(fence instanceof ConversationGraphLocalErasureFence)||this.options.localErasure!==fence||fence.stateRoot!==root||!membership||!reader.usesDroppedOriginRegistry(dropped)||canonicalHash(authority.currentMembership())!==canonicalHash(membership))throw new Error('graph-held-source-component-scope');this.assertLocalCustodyContext({stateRoot:root,agentId:this.options.agentId,machineId:this.options.machineId,authority});if(hold.kind==='planned')authority.assertHeldIntent(hold.intent);else{authority.assertMemberLossHeld(hold.intent);if(hold.intent.payload.removed.some(row=>row.machineId===this.options.machineId))throw new Error('graph-held-source-removed-recorder');}if(hold.nativeContinuation){const {progress,preflight,coordinator}=hold.nativeContinuation;if(hold.kind!=='member-loss'||!(progress instanceof GraphNativeMemberLossProgress)||!(preflight instanceof GraphMemberLossHeldPreflight)||!(coordinator instanceof LeaseCoordinator)||progress.custodyAuthority!==authority||progress.stateRoot!==root||progress.agentId!==this.options.agentId||progress.machineId!==this.options.machineId||progress.intentHash!==canonicalHash(hold.intent)||progress.previousMembershipHash!==canonicalHash(membership)||preflight.stateRoot!==root||preflight.agentId!==this.options.agentId||preflight.intentHash!==progress.intentHash||canonicalHash(preflight.previousMembership)!==canonicalHash(membership)||canonicalHash(preflight.newMembership)!==progress.newMembershipHash||!verifyFencedLeaseBridge(hold.lease,hold.originalLease,membership)||hold.lease.writerId!==this.options.machineId)throw new Error('graph-loss-held-source-continuation-scope');if(writer!==HELD_SOURCE_MUTATION_TOKEN||!activeWriter)preflight.assertCurrent();else if(activeWriter.finalized)activeWriter.snapshot.assertReadCurrent!();else activeWriter.snapshot.assertCurrent();progress.assertCurrentNativeContext(coordinator,hold.originalLease);}else hold.nativeFloor!.assertObservedContext(root,this.options.agentId,membership,hold.lease,hold.originalLease);const native=this.options.liveAdmission();if(native.writerId!==hold.lease.writerId||native.leaseEpoch!==hold.lease.leaseEpoch)throw new Error('graph-held-source-native-context-changed');};scope();await this.serial(async()=>this.assertNativeTailReadable());scope();
    const loss=hold.kind==='member-loss',maxBytes=loss?GRAPH_MEMBER_LOSS_MAX_SNAPSHOT_BYTES:Number.MAX_SAFE_INTEGER,localTargets=(fence as ConversationGraphLocalErasureFence).durableTargets(),negativeBytes=Buffer.byteLength(canonicalJson(localTargets)),adopted=new Map<string,{hash:string;dev:number;ino:number;limit:number}>(),physical=new GraphFrozenPhysicalInventory(root,this.options.directory,{maxFileBytes:GRAPH_CONTEXT_MAX_BYTES,maxBytesForFile:name=>/^(?:contexts\/[a-f0-9]{64}\.json|erasure-authorities\/[a-f0-9]{64}\.role\.json)$/.test(name)?GRAPH_CONTEXT_MAX_BYTES:GRAPH_REPLICATION_MAX_RECORD_BYTES,maxTotalBytes:maxBytes-negativeBytes,maxFiles:GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES*32,skip:(name,isDirectory)=>!isDirectory&&(adopted.has(name)||/^[a-f0-9]{64}\.emitted\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(name))}),negative=this.localRetainedNegativeHash(),dropHash=dropped.physicalSnapshot(root),sourceNames=new Set(physical.names());
    let generation=this.durableGeneration;
    for(const name of sourceNames)if(!/^(?:[a-f0-9]{64}\.(?:source|intent|bundle|rewrap-[a-f0-9]{64}|adoption|materialization|preparation|erased-control|certificate|cancellation|terminal|erasure|receipt|original-receipt|cancellation-receipt|acks|deliveries|delivery-completions|takeover-storage|takeover-custody|quarantine|held-row-[a-f0-9]{64})\.json|held-plan-[a-f0-9]{64}\.json|global-erasure-[a-f0-9]{64}\.json|contexts\/[a-f0-9]{64}\.json|erasure-authorities\/[a-f0-9]{64}\.(?:role|authority)\.json)$/.test(name))throw new Error('graph-held-source-unclassified-physical-file');
    const heldIntake=await intake.verifyHeldReservationReader(root,this.options.ownerPublicKey,fence as ConversationGraphLocalErasureFence,maxBytes-physical.capacityBytes-negativeBytes);scope();
    const physicalErasureHashes=[...sourceNames].filter(name=>/^global-erasure-[a-f0-9]{64}\.json$/.test(name)).map(name=>{const proof=physical.readJson(name) as GraphWitnessErasure;if(name!=='global-erasure-'+canonicalHash(proof)+'.json')throw new Error('graph-held-source-negative-inventory-invalid');return canonicalHash(proof);}).sort(),knownErasureHashes=this.erasureProofs.map(canonicalHash).sort();if(canonicalHash(physicalErasureHashes)!==canonicalHash(knownErasureHashes))throw new Error('graph-held-source-negative-inventory-stale');
    const negativeProofs=new Map(this.erasureProofs.map(proof=>[canonicalHash(proof),proof]));for(const proof of heldIntake.negativeInventory()){if(!this.erasureAuthorities.has(proof)||!this.erasureAuthorities.verificationKey(proof.witnessId)||!verifyWitnessErasure(proof,this.erasureAuthorities.verificationKey(proof.witnessId)!))throw new Error('graph-held-source-negative-inventory-unreconciled');negativeProofs.set(canonicalHash(proof),proof);}
    const check=(writer?:symbol)=>{scope(writer);heldIntake.assertCurrent();physical.assertScope();const expected=writer===HELD_SOURCE_MUTATION_TOKEN&&activeWriter?activeWriter.expectedGeneration:generation;if(this.durableGeneration!==expected||this.localRetainedNegativeHash()!==negative||dropped.physicalSnapshot(root)!==dropHash)throw new Error('graph-held-source-state-changed');};
    const contextProofs=new Map<string,Omit<GraphHistoricalMaterialization,'rewrapHash'>>(),contextSizes=new Map<string,number>(),physicalOriginalReceipts=new Map<string,string|null>(),physicalAcknowledged=new Map<string,boolean>(),payloadStems=new Set([...sourceNames].filter(name=>/^[a-f0-9]{64}\.(?:bundle|rewrap-)/.test(name)).map(name=>name.slice(0,64)));
    const readSource=async(id:string,writer?:symbol):Promise<ConversationGraphReplicationRecord>=>{check(writer);const source=this.file(id,'source'),intent=this.file(id,'intent'),base=(sourceNames.has(source)?physical.readJson(source):sourceNames.has(intent)?physical.readJson(intent):null) as ConversationGraphReplicationRecord|null;if(!base?.packet||base.packet.eventId!==id)throw new Error('graph-held-source-original-missing');if(sourceNames.has(source)&&sourceNames.has(intent)&&canonicalHash(base)!==canonicalHash(physical.readJson(intent)))throw new Error('graph-held-source-original-conflict');
      const load=(suffix:string):unknown=>{const name=this.file(id,suffix);return sourceNames.has(name)?physical.readJson(name):null;},adopt=load('adoption') as {adoption:GraphAdoptionCertificate;cancellation?:GraphWitnessCancellation}|null,materialization=load('materialization');let record:ConversationGraphReplicationRecord={...base,encryptedSourceBundle:null};if(adopt){record.adoption=adopt.adoption;if(adopt.cancellation)record.cancellation=adopt.cancellation;}
      if(materialization){if(!validateGraphMaterializationReference(materialization))throw new Error('graph-held-source-context-reference-required');let common=contextProofs.get(materialization.contextHash);if(!common){const value=physical.readJson(path.join('contexts',materialization.contextHash+'.json')),bytes=Buffer.from(canonicalJson(value));if(canonicalHash(value)!==materialization.contextHash)throw new Error('graph-held-source-context-changed');contextSizes.set(materialization.contextHash,bytes.length);const hydrated=hydrateGraphMaterialization(materialization,bytes),{rewrapHash:_rewrap,...shared}=hydrated;common=shared;contextProofs.set(materialization.contextHash,common);}record.materialization=this.contexts.intern({...common,rewrapHash:materialization.rewrapHash});}
      for(const [suffix,field]of [['preparation','preparationProof'],['certificate','certificate'],['cancellation','cancellation'],['terminal','cancellationCertificate']] as const){const value=load(suffix);if(value)(record as unknown as Record<string,unknown>)[field]=value;}
      const erased=load('erased-control') as {proof:GraphWitnessErasedControlProof;membership:GraphMembershipEpoch;activations?:GraphMembershipActivationCertificate[]}|null;if(erased){record.erasedControlProof=erased.proof;record.custodyMembership=erased.membership;if(erased.activations)record.custodyActivations=erased.activations;}const erasure=load('erasure') as GraphWitnessErasure|null??this.erasureProofs.find(proof=>erasureCoversPacket(proof,record.packet));if(erasure)record.erasure=erasure;
      const bundleName=this.file(id,'bundle'),denied=this.isErased(record.packet.erasureIdentity);if(denied){if(sourceNames.has(bundleName)||payloadStems.has(graphReplicationFileStem(id)))throw new Error('graph-held-source-denied-body-remains');}else{record.encryptedSourceBundle=load('bundle') as GraphEncryptedBundle|null;const rewrapHash=record.materialization?.rewrapHash??record.adoption?.rewrapHash;if(rewrapHash){const name=this.rewrapFile(id,rewrapHash);if(sourceNames.has(name))record.rewrap=physical.readJson(name) as GraphBundleRewrap;}}
      // Preserve historical on-disk receipts, but reconstruct ONLY facts
      // valid for this materialized membership/context (same as cold open).
      const terminal=this.terminal(record),acks=(load('acks') as GraphMemberReceipt[]|null)??[],validAcks=acks.filter(receipt=>terminal&&verifyMemberReceipt(receipt,record.packet,this.certificateMembership(record),'certificate',canonicalHash(terminal),this.certificateContext(record)));if(validAcks.length)record.certificatePersistenceReceipts=validAcks;
      const deliveries=((load('deliveries') as GraphCommitProofDeliveryReceipt[]|null)??[]).filter(receipt=>verifyGraphCommitProofDeliveryReceipt(receipt,record,{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:this.options.witnessPublicKeys}));if(deliveries.length===this.effectiveMembership(record).members.length)record.commitProofDeliveryReceipts=deliveries;
      if(!this.verify(record,record.packet.writerId))throw new Error('graph-held-source-physical-record-untrusted');if(sourceNames.has(source)&&!record.materialization&&!denied){const receipt=(load('cancellation-receipt')??load('receipt')) as GraphMemberReceipt|null,takeover=load('takeover-storage');if(receipt&&!this.validLocalReceipt(record,receipt)||takeover&&!this.validTakeoverStorage(takeover,record))throw new Error('graph-held-source-physical-receipt-invalid');}const original=(load('original-receipt')??load('receipt')) as GraphMemberReceipt|null;if(sourceNames.has(source)&&original?.phase==='source'){if(original.machineId!==this.options.machineId||!verifyMemberReceipt(original,record.packet,record.authorizationProof.membership,'source')){if(sourceNames.has(this.file(id,'original-receipt')))throw new Error('graph-held-source-original-receipt-invalid');physicalOriginalReceipts.set(id,null);}else physicalOriginalReceipts.set(id,canonicalHash(original));}else physicalOriginalReceipts.set(id,null);
      if(!denied&&!record.cancellation&&record.adoption?.disposition!=='refused')this.checkLocalRecovery(record);check(writer);return record;
    };
    const locations=new Map<string,'source'|'intake'>();for(const name of sourceNames)if(/^[a-f0-9]{64}\.(?:source|intent)\.json$/.test(name)){const raw=physical.readJson(name) as ConversationGraphReplicationRecord;if(!raw?.packet||!validatePacket(raw.packet))throw new Error('graph-held-source-original-invalid');locations.set(raw.packet.eventId,'source');}for(const row of heldIntake.descriptors()){if(!locations.has(row.eventId))locations.set(row.eventId,'intake');else{const raw=await readSource(row.eventId);if(canonicalHash(this.immutable(raw))!==row.sourceProofHash)throw new Error('graph-held-source-intake-conflict');}}if(locations.size>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES)throw new Error('graph-held-source-history-capacity');
    const readRecord=async(id:string,writer?:symbol)=>{check(writer);const origin=locations.get(id);if(!origin)throw new Error('graph-held-source-unlisted-record');const record=origin==='source'?await readSource(id,writer):heldIntake.readRecord(id);if(!this.verify(record,record.packet.writerId))throw new Error('graph-held-source-physical-record-untrusted');if(!this.isErased(record.packet.erasureIdentity)&&!record.cancellation&&record.adoption?.disposition!=='refused')this.checkLocalRecovery(record);check(writer);return record;};
    let metadataBytes=2;const descriptors:GraphHeldSourceDescriptor[]=[];for(const [id]of locations){const record=await readRecord(id),ref=record.materialization?splitGraphMaterialization(record.materialization).reference:null;descriptors.push({eventId:id,operationHash:canonicalHash(record.packet),packetHash:canonicalHash(record.packet),sourceProofHash:canonicalHash(this.immutable(record)),sourceSequence:record.packet.sourceSequence,predecessorHash:record.packet.predecessorHash,coreHash:record.packet.coreHash,sourceBundleHash:record.packet.sourceBundleHash,controlHash:record.packet.controlHash,outcome:record.certificate?'committed':record.cancellationCertificate?.outcome??'pending',terminalHash:record.certificate?canonicalHash(record.certificate):record.cancellationCertificate?canonicalHash(record.cancellationCertificate):null,originalSourceReceiptHash:physicalOriginalReceipts.get(id)??null,recordTransportHash:canonicalHash(this.recordForTransport(record)),manifestEntry:graphRecoverySourceManifestEntry(record),...(ref?{materializationContext:{v:1 as const,contextHash:ref.contextHash,rewrapHash:ref.rewrapHash,bytes:contextSizes.get(ref.contextHash)!}}:{})});physicalAcknowledged.set(id,!!this.terminal(record)&&this.fullyPersisted(record)&&(!!record.materialization||!!record.commitProofDeliveryReceipts?.length&&this.effectiveMembership(record).members.every(member=>record.commitProofDeliveryReceipts!.some(receipt=>receipt.machineId===member.machineId&&this.verifyCommitProofDeliveryReceipt(receipt,record)))));metadataBytes+=Buffer.byteLength(canonicalJson(descriptors[descriptors.length-1]))+1;if(metadataBytes>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-held-source-metadata-capacity');}
    descriptors.sort((a,b)=>a.sourceSequence-b.sourceSequence);let sequence=0,predecessor:string|null=null,ackSequence=0,ackCore:string|null=null,ackOpen=true;for(const row of descriptors){if(row.sourceSequence!==sequence+1||row.predecessorHash!==predecessor)throw new Error('graph-held-source-known-predecessor-gap');sequence=row.sourceSequence;predecessor=row.coreHash;const ack=physicalAcknowledged.get(row.eventId)===true;if(ackOpen&&ack){ackSequence=sequence;ackCore=predecessor;}else ackOpen=false;}
    const readerHash=()=>{const rows:Array<{id:string;descriptor:string}>=[];for(const [id,union]of reader.readAll(CONVERSATION_GRAPH_STORE)){const descriptor=validateGraphReplicationDescriptor(union.value?.data.descriptor),stored=this.records.get(id);if(union.conflict||union.divergenceFlag||!descriptor||!stored||stored.quarantine||!union.value||!this.verify(stored.record,union.value.origin)||canonicalHash(descriptor)!==canonicalHash(this.descriptorFor(stored.record))||!locations.has(id))throw new Error('graph-held-source-reader-evidence-missing');rows.push({id,descriptor:canonicalHash(descriptor)});}return canonicalHash(rows.sort((a,b)=>a.id.localeCompare(b.id)));},readerInventory=readerHash(),erasureInventoryHash=canonicalHash({proofs:[...negativeProofs.keys()].sort(),local:localTargets.map(canonicalHash).sort(),intake:heldIntake.erasureInventoryHash}),inventoryHash=canonicalHash({descriptors,source:physical.inventoryHash,intake:heldIntake.inventoryHash,reader:readerInventory,dropHash,erasureInventoryHash}),capacityBytes=physical.capacityBytes+heldIntake.capacityBytes+negativeBytes;
    if(hold.nativeContinuation){const operations=descriptors.map(row=>({eventId:row.eventId,operationHash:row.operationHash,coreHash:row.coreHash,predecessorHash:row.predecessorHash,sourceSequence:row.sourceSequence,outcome:row.outcome,terminalHash:row.terminalHash}));if(canonicalHash(operations)!==canonicalHash(hold.nativeContinuation.preflight.currentOperations))throw new Error('graph-loss-held-source-cut-changed');}
    const assertAdopted=()=>{for(const [name,row]of adopted){const stat=fsSync.lstatSync(path.join(this.options.directory,name));if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.dev!==row.dev||stat.ino!==row.ino||canonicalHash(this.heldRead(name,row.limit))!==row.hash)throw new Error('graph-held-source-adopted-file-changed');}};
    const mutation=(source:ConversationGraphReplication,eventId:string,binding?:HeldSourceMutationBinding):HeldSourceMutation=>{
      if(source!==this||!locations.has(eventId))throw new Error('graph-held-source-mutation-source-invalid');check();let expectedGeneration=generation,done=false;const writes=new Map<string,{hash:string;limit:number}>(),pending=new Set<string>();let snapshotWriter:HeldSourceMutation|undefined;
      if(binding){if(hold.kind!=='member-loss'||!hold.nativeContinuation||binding.preflight!==hold.nativeContinuation.preflight||binding.progress!==hold.nativeContinuation.progress||binding.coordinator!==hold.nativeContinuation.coordinator||canonicalHash(binding.intent)!==canonicalHash(hold.intent)||canonicalHash(binding.originalLease)!==canonicalHash(hold.originalLease))throw new Error('graph-held-source-mutation-loss-binding');binding.preflight.assertSourceSnapshot(binding.snapshot);snapshotWriter=binding.snapshot.beginSourceHeldMutation(HELD_SOURCE_MUTATION_TOKEN,this,binding);activeWriter={snapshot:snapshotWriter,expectedGeneration};}
      const live=()=>{if(done)throw new Error('graph-held-source-mutation-closed');if(snapshotWriter){snapshotWriter.assertCurrent();check(HELD_SOURCE_MUTATION_TOKEN);}else{scope();heldIntake.assertCurrent();physical.assertScope();if(this.durableGeneration!==expectedGeneration||this.localRetainedNegativeHash()!==negative||dropped.physicalSnapshot(root)!==dropHash)throw new Error('graph-held-source-mutation-state-changed');}};
      const verifyWrites=(names:Iterable<string>)=>{for(const name of names){const row=writes.get(name)!;if(canonicalHash(this.heldRead(name,row.limit))!==row.hash)throw new Error('graph-held-source-mutation-readback-invalid');}};
      return{...(snapshotWriter?{assertReadCurrent:()=>{check(HELD_SOURCE_MUTATION_TOKEN);},readCurrentRecord:async(id:string)=>{check(HELD_SOURCE_MUTATION_TOKEN);if(!locations.has(id))throw new Error('graph-held-source-private-read-unlisted');const record=await readRecord(id,HELD_SOURCE_MUTATION_TOKEN),descriptor=byId.get(id);if(!descriptor||canonicalHash(this.recordForTransport(record))!==descriptor.recordTransportHash)throw new Error('graph-held-source-private-read-changed');check(HELD_SOURCE_MUTATION_TOKEN);return record;},checkpoint:()=>{live();verifyWrites(pending);pending.clear();},readRecord:async(id:string)=>{live();if(!locations.has(id))throw new Error('graph-held-source-mutation-unlisted-record');const record=await readRecord(id,HELD_SOURCE_MUTATION_TOKEN);const descriptor=byId.get(id);if(!descriptor||canonicalHash(this.recordForTransport(record))!==descriptor.recordTransportHash)throw new Error('graph-held-source-mutation-original-changed');live();return record;}}:{}),assertCurrent:live,write:(name,value,versioned=true)=>{live();if(name.includes('..')||path.isAbsolute(name)||!name.endsWith('.json'))throw new Error('graph-held-source-mutation-name-invalid');const row={hash:canonicalHash(value),limit:name.startsWith('contexts/')?GRAPH_CONTEXT_MAX_BYTES:GRAPH_REPLICATION_MAX_RECORD_BYTES},prior=writes.get(name);if(prior&&prior.hash!==row.hash)throw new Error('graph-held-source-mutation-conflicting-write');snapshotWriter?.write(name,value,versioned);writes.set(name,row);pending.add(name);if(versioned)expectedGeneration++;if(activeWriter)activeWriter.expectedGeneration=expectedGeneration;},commit:()=>{live();verifyWrites(writes.keys());for(const [name,row]of writes)if(!sourceNames.has(name)){const stat=fsSync.lstatSync(path.join(this.options.directory,name));adopted.set(name,{...row,dev:stat.dev,ino:stat.ino});}snapshotWriter?.commit();generation=expectedGeneration;if(activeWriter)activeWriter.finalized=true;done=true;},abort:()=>{done=true;snapshotWriter?.abort();activeWriter=undefined;}};
    };
    const byId=new Map(descriptors.map(row=>[row.eventId,row]));const final=()=>{check();physical.assertCurrent();assertAdopted();heldIntake.finalize();if(readerHash()!==readerInventory)throw new Error('graph-held-source-reader-state-changed');check();};check();const proof=new GraphHeldSourceReader(HELD_SOURCE_READER_TOKEN,{stateRoot:root,agentId:this.options.agentId,machineId:this.options.machineId,membershipHash:canonicalHash(membership),intentHash:canonicalHash(hold.intent),nativeLeaseHash:canonicalHash(hold.lease),inventoryHash,erasureInventoryHash,capacityBytes,acknowledgedPrefix:{sourceSequence:ackSequence,coreHash:ackCore}},descriptors,check,final,async id=>{const record=await readRecord(id),descriptor=byId.get(id)!;if(canonicalHash(this.recordForTransport(record))!==descriptor.recordTransportHash)throw new Error('graph-held-source-record-changed');return record;},(hash,index)=>this.contextPage(hash,index),()=>heldIntake.close(),()=>({erasures:structuredClone([...negativeProofs.values()]),localErasureTargets:structuredClone(localTargets)}),mutation);for(const reference of this.heldSourceReaders){const old=reference.deref();if(!old||old.closed)this.heldSourceReaders.delete(reference);}if(this.heldSourceReaders.size>=64){proof.close();throw new Error('graph-held-source-reader-capacity');}this.heldSourceReaders.add(new WeakRef(proof));return proof;
  }
  private memberLossMemoryCapacity(maxBytes:number):void{let bytes=0;const contexts=new Set<object>();for(const {record}of this.records.values()){const {materialization,...body}=record;bytes+=Buffer.byteLength(canonicalJson(body));if(bytes>maxBytes)throw new Error('graph-member-loss-snapshot-byte-capacity');if(materialization&&!contexts.has(materialization.manifest)){contexts.add(materialization.manifest);bytes+=Buffer.byteLength(canonicalJson(splitGraphMaterialization(materialization).context));if(bytes>maxBytes)throw new Error('graph-member-loss-snapshot-byte-capacity');}}}
  private memberLossPhysicalInventory(sync:boolean,maxBytes:number,adopted?:ReadonlySet<string>):{hash:string;capacityBytes:number;names:string[]}{
    let capacityBytes=0;const root=realpathSync(this.options.directory),rows:Array<{name:string;hash:string}>=[];const walk=(directory:string)=>{for(const name of fsSync.readdirSync(directory).sort()){if(/^[a-f0-9]{64}\.emitted\.json(?:\.[a-f0-9-]+\.tmp)?$/.test(name))continue;const file=path.join(directory,name),stat=fsSync.lstatSync(file);if(stat.isSymbolicLink())throw new Error('graph-member-loss-source-symlink');if(stat.isDirectory()){walk(file);continue;}if(!stat.isFile()||stat.nlink!==1||stat.size>GRAPH_CONTEXT_MAX_BYTES||/\.(tmp|pending)$/.test(name))throw new Error('graph-member-loss-source-file-invalid');if(adopted?.has(path.relative(root,file)))continue;capacityBytes+=stat.size;if(capacityBytes>maxBytes)throw new Error('graph-member-loss-snapshot-byte-capacity');const fd=fsSync.openSync(file,FILE_FLAGS.O_RDONLY|(FILE_FLAGS.O_NOFOLLOW??0));try{const opened=fsSync.fstatSync(fd);if(opened.dev!==stat.dev||opened.ino!==stat.ino)throw new Error('graph-member-loss-source-file-changed');if(opened.size>GRAPH_CONTEXT_MAX_BYTES)throw new Error('graph-member-loss-source-file-changed');const storage=Buffer.alloc(opened.size+1),count=fsSync.readSync(fd,storage,0,storage.length,0);if(count!==opened.size)throw new Error('graph-member-loss-source-file-changed');const bytes=storage.subarray(0,count);JSON.parse(bytes.toString('utf8'));if(sync)fsSync.fsyncSync(fd);rows.push({name:path.relative(root,file),hash:crypto.createHash('sha256').update(bytes).digest('hex')});if(rows.length>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES*32)throw new Error('graph-member-loss-source-file-capacity');}finally{fsSync.closeSync(fd);}}if(sync){const fd=fsSync.openSync(directory,'r');try{fsSync.fsyncSync(fd);}finally{fsSync.closeSync(fd);}}};walk(root);return {hash:canonicalHash(rows),capacityBytes,names:rows.map(row=>row.name)};
  }
  private localRetainedNegativeHash():string{const fence=this.options.localErasure;if(!(fence instanceof ConversationGraphLocalErasureFence))throw new Error('graph-local-snapshot-actual-fence-required');return canonicalHash({local:fence.targets().map(canonicalHash).sort(),pending:[...this.pendingErasureTargets.keys()].sort()});}
  historicalTerminalProof(eventId:string):{state:'committed'|'canceled'|'erased';activationHash:string;manifestHash:string}|null{
    const stored=this.records.get(eventId),record=stored?.record;if(!stored||stored.quarantine||!record?.materialization||!this.terminal(record)||!this.verify(record,record.packet.writerId)||!this.validMaterialization(record))return null;
    const proof=this.contexts.intern(record.materialization),hashes=graphMaterializationSharedHashes(proof);return {state:record.cancellationCertificate?.outcome??'committed',activationHash:hashes.activationHash,manifestHash:hashes.manifestHash};
  }
  /** Actual cold-store verification for an activation persistence pin. Reopen
   * once per immutable ACT/manifest + local mutation generation, then verify and
   * fsync each requested record from disk. No old receipt is synthesized. */
  async verifyDurableHistoricalImport(eventId:string,activationHash:string,manifestHash:string):Promise<string>{try{return await this.verifyDurableHistoricalImportCore(eventId,activationHash,manifestHash);}catch(error){this.historicalReopen=null;throw error;}}
  private async verifyDurableHistoricalImportCore(eventId:string,activationHash:string,manifestHash:string):Promise<string>{
    if(!hash(activationHash)||!hash(manifestHash))throw new Error('graph-history-import-proof-invalid');this.currentHistoricalImportMembership(true);const generation=this.durableGeneration;
    let cached=this.historicalReopen;if(!cached||cached.generation!==generation||cached.activationHash!==activationHash||cached.manifestHash!==manifestHash){cached={generation,activationHash,manifestHash,source:ConversationGraphReplication.open(this.options,'verify-only',this.historicalImportAuthority??undefined).then(reopened=>{if(this.historicalImportAuthority)reopened.installHistoricalImportAuthority(this.historicalImportAuthority);return reopened;})};this.historicalReopen=cached;}
    let reopened:ConversationGraphReplication;try{reopened=await cached.source;}catch(error){if(this.historicalReopen===cached)this.historicalReopen=null;throw error;}
    const proof=reopened.historicalTerminalProof(eventId),record=reopened.repairRecord(eventId);if(!proof||!record?.materialization||!reopened.validMaterialization(record,true)||proof.activationHash!==activationHash||proof.manifestHash!==manifestHash)throw new Error('graph-history-import-terminal-evidence-missing');
    const expected=new Map<string,unknown>([[this.file(eventId,'source'),this.immutable(record)],[this.file(eventId,'intent'),this.immutable(record)]]);
    const reference=splitGraphMaterialization(record.materialization).reference;expected.set(this.file(eventId,'materialization'),reference);
    if(record.certificate)expected.set(this.file(eventId,'certificate'),record.certificate);if(record.cancellationCertificate)expected.set(this.file(eventId,'terminal'),record.cancellationCertificate);
    if(record.cancellation)expected.set(this.file(eventId,'cancellation'),record.cancellation);if(record.erasure)expected.set(this.file(eventId,'erasure'),record.erasure);
    const denied=this.isErased(record.packet.erasureIdentity)||reopened.isErased(record.packet.erasureIdentity);if(denied){await reopened.assertLocalErasurePurged(record.packet.erasureIdentity);}else if(record.encryptedSourceBundle){expected.set(this.file(eventId,'bundle'),record.encryptedSourceBundle);if(record.rewrap)expected.set(this.rewrapFile(eventId,record.materialization.rewrapHash),record.rewrap);}
    const files:Array<{name:string;hash:string}>=[];for(const [name,value]of expected){const actual=await this.syncHistoricalFile(name,GRAPH_REPLICATION_MAX_RECORD_BYTES);if(actual.hash!==canonicalHash(value))throw new Error('graph-history-import-file-mismatch');files.push({name,hash:actual.hash});}
    const contextName=path.join('contexts',reference.contextHash+'.json'),contextPath=path.join(this.options.directory,contextName),stat=await fs.lstat(contextPath,{bigint:true});const stamp=`${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
    if(!stat.isFile()||stat.isSymbolicLink())throw new Error('graph-history-import-context-invalid');if(this.historicalContextFiles.get(reference.contextHash)!==stamp){const actual=await this.syncHistoricalFile(contextName,GRAPH_CONTEXT_MAX_BYTES);if(actual.hash!==reference.contextHash)throw new Error('graph-history-import-context-invalid');this.historicalContextFiles.set(reference.contextHash,actual.stamp);while(this.historicalContextFiles.size>2)this.historicalContextFiles.delete(this.historicalContextFiles.keys().next().value!);}
    if(!denied&&record.encryptedSourceBundle){const plaintext=reopened.openVerifiedPayload(record);try{if(this.isErased(record.packet.erasureIdentity))throw new Error('graph-history-import-erasure-race');}finally{plaintext.fill(0);}}
    // The row's own directory always flushes, and an instance's first row flushes every ancestor because creating the chain did not. After that ancestors rarely change, so flush them only when they did.
    for(let parent=this.options.directory;;parent=path.dirname(parent)){if(parent===this.options.directory||!this.historicalAncestorsFlushed||!isDurablyUnchanged(parent)){const stamp=durableStamp(parent),dir=await fs.open(parent,'r');try{rememberDurable(parent,null);await dir.sync();rememberDurable(parent,stamp);}finally{await dir.close();}}if(path.dirname(parent)===parent)break;}this.historicalAncestorsFlushed=true;
    if(this.durableGeneration!==generation||(this.isErased(record.packet.erasureIdentity)||reopened.isErased(record.packet.erasureIdentity))!==denied)throw new Error('graph-history-import-state-changed');
    if(record.materialization?.activation.memberLoss)this.historicalImportAuthority!.assertCurrentMemberLossActivation(record.materialization.activation);if(!this.validMaterialization(record,true)||!reopened.validMaterialization(record,true))throw new Error('graph-history-import-authority-changed');
    return canonicalHash({v:1,machineId:this.options.machineId,eventId,packetHash:canonicalHash(record.packet),activationHash,manifestHash,contextHash:reference.contextHash,state:proof.state,body:denied?'erased':record.encryptedSourceBundle?'verified':'terminal-without-body',files});
  }
  private async syncHistoricalFile(name:string,limit:number):Promise<{hash:string;stamp:string}>{
    const file=path.join(this.options.directory,name),before=await fs.lstat(file,{bigint:true});if(!before.isFile()||before.isSymbolicLink()||before.size>BigInt(limit))throw new Error('graph-history-import-file-invalid');
    const fd=await fs.open(file,FILE_FLAGS.O_RDONLY|(FILE_FLAGS.O_NOFOLLOW??0));try{const opened=await fd.stat({bigint:true});if(opened.ino!==before.ino||opened.dev!==before.dev||!opened.isFile())throw new Error('graph-history-import-file-changed');const bytes=await fd.readFile();if(bytes.length>limit)throw new Error('graph-history-import-file-invalid');await fd.sync();const after=await fd.stat({bigint:true});if(after.size!==opened.size||after.mtimeNs!==opened.mtimeNs||after.ctimeNs!==opened.ctimeNs)throw new Error('graph-history-import-file-changed');return {hash:canonicalHash(JSON.parse(bytes.toString('utf8'))),stamp:`${after.dev}:${after.ino}:${after.size}:${after.mtimeNs}:${after.ctimeNs}`};}finally{await fd.close();}
  }

  allCommitProofDelivered(eventId: string): boolean {
    const stored=this.required(eventId);const record=stored.record;
    if(stored.quarantine||!this.verify(record,record.packet.writerId)||!this.fullyPersisted(record))return false;
    const receipts=this.deliveryReceipts.get(eventId);
    return this.effectiveMembership(record).members.every(member=>{
      const receipt=receipts?.get(member.machineId);return !!receipt&&this.verifyCommitProofDeliveryReceipt(receipt,record);
    });
  }

  effectiveContext(eventId: string): {membership: GraphMembershipEpoch; lease: GraphWitnessLease; originalLease: LeaseRecord; receipt: GraphMemberReceipt|null} {
    const stored = this.required(eventId); const record = stored.record;
    if (stored.quarantine || !this.verify(record, record.packet.writerId)) throw new Error('graph-replication-untrusted-context');
    return structuredClone({membership:this.effectiveMembership(record),lease:record.materialization?.currentLease??record.adoption?.currentLease ?? record.authorizationProof.lease,
      originalLease:record.materialization?.originalCurrentLease??record.adoption?.originalCurrentLease ?? record.authorizationProof.originalLease,receipt:stored.sourceReceipt});
  }
  lookupByIdempotencyKey(key: string): ConversationGraphReplicationRecord | null {
    const matches = [...this.records.values()].filter((stored) => stored.record.packet.idempotencyKey === key);
    if (matches.length !== 1 || matches[0].quarantine) return null;
    return structuredClone(matches[0].record);
  }
  /** Continuation never reauthors the already fsynced immutable source. Native
   * same-writer/same-epoch renewal may actuate it under a fresh current bridge;
   * changed epoch/writer requires a separately verified adoption sidecar. */
  mayContinue(eventId: string, lease: GraphWitnessLease, originalLease: LeaseRecord): boolean {
    const stored = this.records.get(eventId);
    if(stored&&this.isErased(stored.record.packet.erasureIdentity))return false;
    if (!stored || stored.quarantine || stored.record.adoption?.disposition === 'refused' || !this.verify(stored.record, stored.record.packet.writerId)) return false;
    return this.mayActuateRecord(stored.record,lease,originalLease);
  }
  mayContinueCancellation(eventId:string,lease:GraphWitnessLease,originalLease:LeaseRecord):boolean{
    const stored=this.records.get(eventId);return !!stored&&!stored.quarantine&&!!(stored.record.cancellation||stored.record.erasure)
      &&this.verify(stored.record,stored.record.packet.writerId)&&this.mayActuateRecord(stored.record,lease,originalLease);
  }
  private mayActuateRecord(record:ConversationGraphReplicationRecord,lease:GraphWitnessLease,originalLease:LeaseRecord):boolean {
    const membership = this.effectiveMembership(record);
    const guard = this.options.writeAdmission.guardStoreWrite('conversationGraph.append');
    if (guard.enforce === 'refuse' || (guard.enforce === 'legacy' && this.options.legacyReadOnly())) return false;
    const live = this.options.liveAdmission(); const context = this.receiptContext(record);
    return live.admitted && lease.writerId === this.options.machineId && live.writerId === lease.writerId
      && lease.membershipEpoch === membership.epoch && live.membershipEpoch === membership.epoch
      && lease.leaseEpoch === (context?.leaseEpoch ?? record.packet.leaseEpoch) && live.leaseEpoch === lease.leaseEpoch
      && lease.writerId === (record.adoption?.currentLease.writerId ?? record.packet.writerId)
      && live.fencedLeaseHash === lease.fencedLeaseHash
      && verifyFencedLeaseBridge(lease, originalLease, membership)
      && verifyWitnessLease(lease, membership, (this.options.now?.() ?? new Date()).getTime());
  }

  /** No enqueue outcome is a durable publication. Only the journal's post-sync
   * observer may call journalCommitted; a restart reconstructs this outbox. */
  async drainOutbox(emit: (record: ConversationGraphReplicationRecord) => JournalEmitOutcome): Promise<Record<string, JournalEmitOutcome>> {
    const outcomes: Record<string, JournalEmitOutcome> = {};
    for (const [id, stored] of this.records) {
      if (stored.quarantine || stored.record.packet.writerId !== this.options.machineId) continue;
      const publicationHash = canonicalHash(this.descriptorFor(stored.record));
      if (stored.emittedHash === publicationHash || this.inFlight.get(id) === publicationHash) continue;
      const outcome = emit(cloneGraphRecord(stored.record));
      outcomes[id] = outcome;
      if (outcome === 'accepted') this.inFlight.set(id, publicationHash);
    }
    return outcomes;
  }
  journalCommitted(eventId: string, publicationHash: string): Promise<void> {
    return this.serial(async () => {
      const stored = this.required(eventId);
      if (canonicalHash(this.descriptorFor(stored.record)) !== publicationHash) return;
      await this.save(this.file(eventId, 'emitted'), { publicationHash });
      stored.emittedHash = publicationHash; this.inFlight.delete(eventId);
    });
  }
  /** Restarted/failed flusher may re-drive accepted but not durably observed work. */
  releaseInFlight(): void { this.inFlight.clear(); }

  async eraseBundle(eventId:string,proof:GraphWitnessErasure,authority?:GraphErasureAuthority):Promise<void>{
    if(!erasureCoversPacket(proof,this.required(eventId).record.packet))throw new Error('graph-replication-invalid-erasure');await this.applyErasure(proof,authority);
  }
  get agentId():string{return this.options.agentId;}
  isErased(target:GraphErasureIdentity):boolean{return this.pendingErasureTargets.has(canonicalHash(target))||!!this.options.localErasure?.isDenied(target)||this.erasureProofs.some(proof=>proof.agentId===this.options.agentId&&sameGraphErasureIdentity(proof.target,target));}
  /** Source-owned derived snapshots only; never a fleet purge receipt. */
  purgeMemberLossSnapshots(target:GraphErasureIdentity):void{if(!validateGraphErasureIdentity(target)||!this.isErased(target))throw new Error('graph-member-loss-snapshot-deny-required');for(const ref of this.pagedHeldProofs)ref.deref()?.close();this.pagedHeldProofs.clear();for(const reference of this.memberLossSnapshots)reference.deref()?.close();this.memberLossSnapshots.clear();for(const reference of this.heldReadSessions.values())reference.deref()?.close();this.heldReadSessions.clear();for(const reference of this.heldPromotionProofs)reference.deref()?.close();this.heldPromotionProofs.clear();for(const reference of this.heldSourceReaders)reference.deref()?.close();this.heldSourceReaders.clear();if(this.options.localErasure instanceof ConversationGraphLocalErasureFence)purgeHeldPrivateViews(this.options.localErasure.stateRoot,target);}
  /** Local deny is deliberately not a signed fleet erasure acknowledgment. */
  eraseLocal(target:GraphErasureIdentity):Promise<void>{return (async()=>{this.purgeMemberLossSnapshots(target);await this.serial(async()=>{
    if(!this.options.localErasure?.isDenied(target))throw new Error('graph-local-erasure-fence-required');
    const ids:string[]=[];for(const stored of this.records.values())if(sameGraphErasureIdentity(target,stored.record.packet.erasureIdentity)){
      stored.record.encryptedSourceBundle=null;delete stored.record.rewrap;this.inFlight.delete(stored.record.packet.eventId);
      ids.push(stored.record.packet.eventId);
    }ids.push(...await this.intentIds(target));await this.purgePayloadFilesMany(ids);await this.scrubUnattributedPayloads();await this.syncDirectory();
  });})();}
  applyErasure(proof:GraphWitnessErasure,authority?:GraphErasureAuthority):Promise<void>{return (async()=>{
    const key=this.erasureAuthorities.verificationKey(proof.witnessId);if(!key||proof.agentId!==this.options.agentId||!verifyWitnessErasure(proof,key))throw new Error('graph-replication-invalid-erasure');
    const preflight=()=>this.erasureHashPreflight(proof);
    preflight();await this.erasureAuthorities.accept(proof,authority);preflight();
    this.retainPendingErasure(proof);try{await this.serial(()=>this.applyErasureCore(proof));}catch(error){if((error as Error).message==='graph-erasure-cross-target-hash')this.releasePendingErasure(proof);throw error;}
  })();}
  private async persistErasure(stored:Stored,proof:GraphWitnessErasure):Promise<void>{if(stored.record.erasure&&canonicalHash(stored.record.erasure)===canonicalHash(proof)&&stored.record.encryptedSourceBundle===null&&!stored.record.rewrap&&this.erasureProofs.some(existing=>canonicalHash(existing)===canonicalHash(proof)))return;await this.applyErasureCore(proof,stored.record.packet.eventId);}
  private async applyErasureCore(proof:GraphWitnessErasure,canonicalEventId?:string):Promise<void>{
    const key=this.erasureAuthorities.verificationKey(proof.witnessId);
    if(!key||proof.agentId!==this.options.agentId||!verifyWitnessErasure(proof,key)||!this.erasureAuthorities.has(proof))throw new Error('graph-replication-invalid-erasure');
    this.erasureHashPreflight(proof);
    const matches=[...this.records.values()].filter(stored=>erasureCoversPacket(proof,stored.record.packet));
    const changed=new Set(matches.filter(stored=>!stored.record.erasure||stored.record.packet.eventId===canonicalEventId&&canonicalHash(stored.record.erasure)!==canonicalHash(proof)).map(stored=>stored.record.packet.eventId));
    for(const stored of matches){stored.record.encryptedSourceBundle=null;delete stored.record.rewrap;if(!stored.record.erasure||stored.record.packet.eventId===canonicalEventId)stored.record.erasure=structuredClone(proof);this.inFlight.delete(stored.record.packet.eventId);}
    await this.save(`global-erasure-${canonicalHash(proof)}.json`,proof,true);
    if(!this.erasureProofs.some(existing=>canonicalHash(existing)===canonicalHash(proof)))this.erasureProofs.push(structuredClone(proof));
    for(const stored of matches)if(changed.has(stored.record.packet.eventId))await this.save(this.file(stored.record.packet.eventId,'erasure'),stored.record.erasure);
    await this.purgePayloadFilesMany([...matches.map(stored=>stored.record.packet.eventId),...await this.intentIds(proof.target)]);await this.scrubUnattributedPayloads();
    // Include crash-orphaned bundle/rewrap publication temporaries even when no
    // immutable .source record ever became visible before the process stopped.
    for(const name of await fs.readdir(this.options.directory)){
      if(!/^[A-Za-z0-9_-]+\.(?:bundle\.json|rewrap-[a-f0-9]{64}\.json)(?:\.[a-f0-9-]+\.tmp)?$/.test(name))continue;
      const raw=await this.load(name) as GraphEncryptedBundle|GraphBundleRewrap|null;
      if(raw&&(proof.bundleHashes.includes(canonicalHash(raw))||('originalBundleHash'in raw&&proof.bundleHashes.includes(raw.originalBundleHash))))this.removeBundle(name);
    }
    await this.syncDirectory();
  }

  /** Transport-retention repair reads the durable source, never the rotated
   * journal. A tombstone dominates even an older caller's requested version. */
  /** The peer wire carries a bounded pointer, never O(history) per record. */
  recordForTransport(record:ConversationGraphReplicationRecord):unknown{const safe=this.exportRecord(record);return safe.materialization?{...safe,materialization:splitGraphMaterialization(safe.materialization).reference}:safe;}
  contextPage(contextHash:string,index:number){return this.contexts.page(contextHash,index);}
  async hydrateTransportRecordCached(raw:unknown):Promise<ConversationGraphReplicationRecord|null>{
    const wire=raw as ConversationGraphReplicationRecord&{materialization:GraphMaterializationContextReference};
    if(!wire?.materialization)return wire;if(!validateGraphMaterializationReference(wire.materialization))throw new Error('graph-context-wire-reference-invalid');
    try{const record={...wire,materialization:await this.contexts.hydrate(wire.materialization)};if(!this.verify(record,record.packet.writerId))throw new Error('graph-context-wire-proof-invalid');return record;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
  hydrateTransportRecord(raw:unknown,contextBytes:Uint8Array):ConversationGraphReplicationRecord{
    const wire=raw as ConversationGraphReplicationRecord&{materialization:GraphMaterializationContextReference};
    if(!wire||!validateGraphMaterializationReference(wire.materialization))throw new Error('graph-context-wire-reference-invalid');
    const record={...wire,materialization:hydrateGraphMaterialization(wire.materialization,contextBytes)};
    if(!this.verify(record,record.packet.writerId))throw new Error('graph-context-wire-proof-invalid');return record;
  }
  repairRecord(eventId: string): ConversationGraphReplicationRecord | null {
    const stored = this.records.get(eventId);
    return !stored || stored.quarantine ? null : this.exportRecord(stored.record);
  }

  /** Durable-source contribution for ReplicatedStoreReader.loadOriginRecords.
   * Keeping this INSIDE that funnel preserves live origin-drop/conflict rules
   * even when the journal's transport copy has rotated away. These deterministic
   * HLCs order only versions of one immutable id, never placement authority. */
  /** Frozen publication intent reserves its original source-chain slot even if
   * priority erasure removed the body before a member receipt was possible. */
  /** A paged held row with no canonical Source record leaves only through its
   * gated proof. Read from disk so another same-root instance's import counts. */
  private assertNoPagedHeldOnlyExport():void{
    if(!fsSync.existsSync(this.options.directory))return;const canonical=new Set([...this.records.keys()].map(graphReplicationFileStem));
    for(const name of new Set([...this.pagedHeldNames(),...this.pagedHeldCatalogs.keys()])){if(canonical.has(name.slice(0,64)))continue;if(!fsSync.existsSync(path.join(this.options.directory,name)))throw new Error('graph-paged-history-recovery-export-unavailable');const catalog=this.validatePagedHeld(this.heldRead(name),name),erasure=(catalog.recordControl as unknown as ConversationGraphReplicationRecord).packet.erasureIdentity;if(!this.isErased(erasure))throw new Error('graph-paged-history-recovery-export-unavailable');}
  }
  async controlIntents():Promise<ConversationGraphReplicationRecord[]>{
    this.assertNoPagedHeldOnlyExport();
    const result:ConversationGraphReplicationRecord[]=[];
    for(const name of await fs.readdir(this.options.directory))if(name.endsWith('.intent.json')){
      const raw=await this.load(name) as ConversationGraphReplicationRecord;
      if(!raw?.packet||!validatePacket(raw.packet))throw new Error('graph-source-intent-packet-invalid');
      const known=this.records.get(raw.packet.eventId);if(known){if(canonicalHash(this.immutable(known.record))!==canonicalHash(raw))throw new Error('graph-source-intent-conflict');continue;}
      if(!this.options.validateCore(raw.core,raw.coreType))throw new Error('graph-source-intent-core-invalid');
      const verdict=verifyGraphAuthorization(raw.packet,raw.core,raw.authorizationProof,this.options.ownerPublicKey,raw.packet.writerId);if(!verdict.ok)throw new Error('graph-source-intent-authority-invalid:'+verdict.reason);
      const member=raw.authorizationProof.membership.members.find(row=>row.machineId===raw.packet.writerId);
      if(!member||!verifyGraphRecord('graph-operation-packet-v1',raw.packet,raw.packetSignature,member.signingPublicKey))throw new Error('graph-source-intent-signature-invalid');
      const erasure=this.erasureProofs.find(proof=>erasureCoversPacket(proof,raw.packet));
      const bundle=this.isErased(raw.packet.erasureIdentity)?null:await this.load(this.file(raw.packet.eventId,'bundle')) as GraphEncryptedBundle|null;
      result.push({...raw,encryptedSourceBundle:bundle,...(erasure?{erasure}:{} )});
    }return result;
  }
  /** Original fsynced member source receipt; never manufactures a receipt for
   * a recovery request or substitutes a new actuation lease. */
  nativeTailRecords():Promise<ConversationGraphReplicationRecord[]>{return this.serial(async()=>{this.assertNativeTailReadable();return [...this.recordsForRepair(),...await this.controlIntents()];});}
  assertNativeTailReadable():void{this.assertNoPagedHeldOnlyExport();for(const c of this.heldImports.values()){const known=this.records.get(c.eventId)?.record;if(!c.priorCanonical&&(!known||!this.heldImportActivated(known,c)))throw new Error('graph-held-original-awaits-activation');}for(const stored of this.records.values())if(stored.quarantine)throw new Error('graph-native-tail-quarantined-source');}
  /** The member-loss gate a repair write would apply, for callers that may skip that write. */
  assertRepairStillAllowed(record:ConversationGraphReplicationRecord):void{this.historicalImportAuthority?.assertMemberLossRepairAllowed(record);}
  retainedOriginalSourceReceipt(eventId:string):GraphMemberReceipt|null{
    const stored=this.records.get(eventId),receipt=stored?.originalSourceReceipt??stored?.sourceReceipt;if(!stored||stored.quarantine||!receipt||receipt.machineId!==this.options.machineId||receipt.phase!=='source'||!this.verify(stored.record,stored.record.packet.writerId))return null;
    return verifyMemberReceipt(receipt,stored.record.packet,stored.record.authorizationProof.membership,'source')?structuredClone(receipt):null;
  }
  recordsForRepair():ConversationGraphReplicationRecord[]{return [...this.records.values()].filter(stored=>!stored.quarantine).map(stored=>this.exportRecord(stored.record));}
  private exportRecord(record:ConversationGraphReplicationRecord):ConversationGraphReplicationRecord{const safe=cloneGraphRecord(record);if(this.isErased(record.packet.erasureIdentity)){safe.encryptedSourceBundle=null;delete safe.rewrap;}return safe;}
  descriptorFor(record:ConversationGraphReplicationRecord):ConversationGraphReplicationDescriptor{return describeGraphReplicationRecord(record);}
  private graphHlc(record:ConversationGraphReplicationRecord):HlcTimestamp{return {physical:Date.parse(String(record.core.createdAt))||0,
    logical:this.descriptorFor(record).publicationVersion,node:record.packet.writerId};}
  originRecordKeys(): string[] {return [...this.records.values()].filter(stored=>!stored.quarantine).map(({record})=>record.packet.eventId);}
  /** One record's origin row. Building every row to filter down to one made each read of the graph quadratic in records. */
  originRecordsFor(eventId:string): OriginRecord[] {
    const stored=this.records.get(eventId);if(!stored||stored.quarantine)return [];const {record}=stored;
    return [{origin:record.packet.writerId,envelope:{recordKey:record.packet.eventId,op:'put',origin:record.packet.writerId,hlc:this.graphHlc(record)},data:{descriptor:this.descriptorFor(record)}}];
  }
  originRecords(): OriginRecord[] {
    return [...this.records.values()].filter(stored=>!stored.quarantine).map(({record})=>({origin:record.packet.writerId,
      envelope:{recordKey:record.packet.eventId,op:'put',origin:record.packet.writerId,hlc:this.graphHlc(record)},data:{descriptor:this.descriptorFor(record)}}));
  }

  /** Every peer value MUST come through the existing no-clobber reader. A local
   * source may fill an un-emitted OWN record, but cannot bypass dropped origins
   * or a reader conflict for the same event id. */
  certifiedUnion(reader: ReplicatedStoreReader, dropped: DroppedOriginRegistry, excludedPendingEventIds?: ReadonlySet<string>): { records: ConversationGraphReplicationRecord[]; partial: boolean; quarantined: string[];pendingEventIds:string[];missingEventIds:string[] } {
    const candidates = new Map<string, ConversationGraphReplicationRecord>();
    const blocked = new Set<string>();
    const pending=new Set<string>();const missing=new Set<string>();
    const peerErasures = new Map<string, GraphWitnessErasure>();
    const droppedOrigins = dropped.droppedOrigins(CONVERSATION_GRAPH_STORE);
    let partial = false;
    for (const [key, union] of reader.readAll(CONVERSATION_GRAPH_STORE)) {
      if (union.conflict || union.divergenceFlag) { blocked.add(key); partial = true; continue; }
      const descriptor=validateGraphReplicationDescriptor(union.value?.data.descriptor);
      const stored=this.records.get(key);const record=stored?.record;
      if(!descriptor||!record||!union.value||stored?.quarantine||!this.verify(record,union.value.origin)
        ||canonicalHash(descriptor)!==canonicalHash(this.descriptorFor(record))){partial=true;blocked.add(key);continue;}
      if(record.erasure)peerErasures.set(key,record.erasure);
      if(this.terminal(record))candidates.set(key,record);
      if(!this.fullyPersisted(record)){pending.add(key);if(!(excludedPendingEventIds?.has(key)&&!this.terminal(record)&&!record.erasure&&!record.cancellation))partial=true;}
    }
    for (const [key, stored] of this.records) {
      if (stored.record.packet.writerId !== this.options.machineId || droppedOrigins.has(this.options.machineId)) continue;
      if (stored.quarantine || blocked.has(key)) { blocked.add(key); partial = true; continue; }
      if(!this.fullyPersisted(stored.record)){pending.add(key);if(!(excludedPendingEventIds?.has(key)&&!this.terminal(stored.record)&&!stored.record.erasure&&!stored.record.cancellation))partial=true;}
      if(!this.terminal(stored.record))continue;
      const peer = candidates.get(key);
      if (peer && canonicalHash(this.immutable(peer)) !== canonicalHash(this.immutable(stored.record))) { blocked.add(key); partial = true; continue; }
      const ownTerminal = this.terminal(stored.record); const peerTerminal = peer ? this.terminal(peer) : undefined;
      if (ownTerminal && peerTerminal && canonicalHash(ownTerminal) !== canonicalHash(peerTerminal)) { blocked.add(key); partial = true; continue; }
      // A validated peer tombstone cannot be overridden by an older local
      // source copy while its asynchronous source-side apply is catching up.
      const chosen = cloneGraphRecord(peer ?? stored.record);
      const erasure = peerErasures.get(key) ?? peer?.erasure ?? stored.record.erasure;
      if (erasure) { chosen.erasure = erasure; chosen.encryptedSourceBundle = null; delete chosen.rewrap; }
      candidates.set(key, chosen);
    }
    for (const id of blocked) candidates.delete(id);
    const sequenceOwners = new Map<number, string[]>();
    for (const [id, record] of candidates) {
      const ids = sequenceOwners.get(record.packet.sourceSequence) ?? []; ids.push(id); sequenceOwners.set(record.packet.sourceSequence, ids);
    }
    for (const ids of sequenceOwners.values()) if (ids.length > 1) {
      for (const id of ids) { candidates.delete(id); blocked.add(id); }
      partial = true;
    }
    const sorted = [...candidates.values()].sort((a, b) => a.packet.sourceSequence - b.packet.sourceSequence || a.packet.eventId.localeCompare(b.packet.eventId));
    const accepted: ConversationGraphReplicationRecord[] = [];
    let previous: GraphOperationPacket | null = null;
    for (const record of sorted) {
      try{this.historicalImportAuthority?.assertMemberLossRepairAllowed(record);}catch{/* @silent-fallback-ok: actual loss-cut refusal is observable as a quarantined, partial canonical inventory; it never selects an alternate positive. */blocked.add(record.packet.eventId);partial=true;continue;}
      if ((previous === null && (record.packet.sourceSequence !== 1 || record.packet.predecessorHash !== null))
        || (previous !== null && (record.packet.sourceSequence !== previous.sourceSequence + 1
          || record.packet.predecessorHash !== previous.coreHash))) { partial = true; missing.add(record.packet.eventId); continue; }
      if (record.certificate&&this.fullyPersisted(record)&&(record.coreType==='graph-event'||!this.options.localErasure?.isDenied(record.packet.erasureIdentity))) accepted.push(cloneGraphRecord(record));
      previous = record.packet;
    }
    return { records: accepted, partial, quarantined: [...blocked].sort(),pendingEventIds:[...pending].sort(),missingEventIds:[...new Set([...missing,...blocked])].sort() };
  }

  envelope(record: ConversationGraphReplicationRecord, hlc: HlcTimestamp, observed?: HlcTimestamp): Record<string, unknown> {
    if(record.materialization instanceof GraphSelectedMaterializationV2)throw new Error('graph-paged-history-recovery-export-unavailable');
    if (record.packet.writerId !== this.options.machineId || !this.verify(record, this.options.machineId)) throw new Error('graph-replication-origin-mismatch');
    return { recordKey: record.packet.eventId, hlc:this.graphHlc(record), op: 'put', origin: this.options.machineId,
      ...(observed ? { observed } : {}), descriptor:this.descriptorFor(record) };
  }

  verifyHistoricalRecord(record: ConversationGraphReplicationRecord): boolean {
    return this.verify(record, record.packet.writerId);
  }

  private fullyPersisted(record: ConversationGraphReplicationRecord): boolean {
    if(record.materialization)return this.validMaterialization(record);
    const terminal = this.terminal(record);
    if (!terminal) return false;
    const receipts = record.certificatePersistenceReceipts ?? [];
    return this.effectiveMembership(record).members.every((member) => receipts.some((receipt) =>
      receipt.machineId === member.machineId && verifyMemberReceipt(receipt, record.packet,
        this.effectiveMembership(record), 'certificate', canonicalHash(terminal), this.receiptContext(record))));
  }

  private immutable(record: ConversationGraphReplicationRecord): Record<string, unknown> {
    return { coreType:record.coreType, packet: record.packet, packetSignature: record.packetSignature, core: record.core, authorizationProof: record.authorizationProof };
  }
  private verify(record: ConversationGraphReplicationRecord, origin: string): boolean {
    try{if(record.materialization)record={...record,materialization:this.contexts.intern(record.materialization)};
    if (!validateGraphReplicationRecord(record,{isDenied:target=>this.isErased(target)}) || record.packet.agentId !== this.options.agentId
      || !this.options.validateCore(record.core,record.coreType)
      || !verifyGraphAuthorization(record.packet, record.core, record.authorizationProof, this.options.ownerPublicKey, origin).ok) return false;
    const publicationEpoch=record.materialization?.currentLease.leaseEpoch??record.adoption?.currentLease.leaseEpoch??record.packet.leaseEpoch,publicationMembership=Math.max(record.packet.membershipEpoch,record.materialization?.activation.newMembership.epoch??0,record.adoption?.newMembership.epoch??0,record.erasedControlProof?.custodyMembershipEpoch??0,record.erasure?.membershipEpoch??0);if(publicationEpoch>GRAPH_REPLICATION_MAX_LEASE_EPOCH||publicationMembership>GRAPH_REPLICATION_MAX_MEMBERSHIP_EPOCH)return false;
    if(this.options.installedMembership){const negativeOnly=record.adoption?.activation?.memberLoss&&this.validMemberLossNegativeCustody(record),active=negativeOnly?this.currentHistoricalImportMembership()!:this.options.installedMembership;if(negativeOnly&&(!this.historicalImportAuthority||canonicalHash(record.adoption!.activation!)!==this.historicalImportActivationHash))return false;for(const membership of [record.authorizationProof.membership,record.adoption?.newMembership].filter((m):m is GraphMembershipEpoch=>!!m)){if(membership.epoch>active.epoch||membership.epoch===active.epoch&&canonicalHash(membership)!==canonicalHash(active))return false;}}
    const writer = record.authorizationProof.membership.members.find((m) => m.machineId === record.packet.writerId);
    if (!writer || !verifyGraphRecord('graph-operation-packet-v1', record.packet, record.packetSignature, writer.signingPublicKey)) return false;
    if (record.encryptedSourceBundle !== null && canonicalHash(record.encryptedSourceBundle) !== record.packet.sourceBundleHash) return false;
    if (record.adoption && !this.validAdoption(record)) return false;
    if(record.adoption?.activation?.memberLoss&&record.adoption.disposition==='refused'&&!record.preparationProof&&!record.erasedControlProof&&!this.validMemberLossNegativeCustody(record))return false;
    if(record.adoption?.disposition==='refused'&&!record.erasure&&!record.cancellation)return false;
    if(record.materialization&&!this.validMaterialization(record))return false;
    const expectedRewrapHash=record.materialization?.rewrapHash??record.adoption?.rewrapHash;
    if(record.rewrap&&(!expectedRewrapHash||canonicalHash(record.rewrap)!==expectedRewrapHash))return false;
    if((record.materialization||record.adoption?.disposition==='adopted')&&record.encryptedSourceBundle!==null&&record.adoption?.disposition!=='refused'&&(!record.rewrap||!verifyBundleRewrap(record.rewrap,record.encryptedSourceBundle,this.effectiveMembership(record))))return false;
    if (record.preparationProof && !this.validPreparation(record, record.preparationProof)) return false;
    if((record.custodyMembership||record.custodyActivations)&&!record.erasedControlProof)return false;
    if(record.erasedControlProof&&(!record.erasure||record.preparationProof||!this.validErasedControl(record)))return false;
    if (record.erasure && !this.validErasure(record, record.erasure)) return false;
    if (record.certificate && (record.cancellation || record.cancellationCertificate)) return false;
    if (record.cancellation && !this.validCancellation(record, record.cancellation)) return false;
    if (record.cancellationCertificate && !this.validCancellationCertificate(record, record.cancellationCertificate)) return false;
    if (record.certificatePersistenceReceipts !== undefined) {
      if (!Array.isArray(record.certificatePersistenceReceipts)) return false;
      const terminal = this.terminal(record); const ids = new Set<string>();
      for (const receipt of record.certificatePersistenceReceipts) {
        if (!terminal || ids.has(receipt.machineId) || !verifyMemberReceipt(receipt, record.packet,
          this.certificateMembership(record), 'certificate', canonicalHash(terminal), this.certificateContext(record))) return false;
        ids.add(receipt.machineId);
      }
    }
    if(record.commitProofDeliveryReceipts!==undefined){const receipts=record.commitProofDeliveryReceipts,membership=this.effectiveMembership(record);if(!Array.isArray(receipts)||receipts.length!==membership.members.length||new Set(receipts.map(receipt=>receipt.machineId)).size!==receipts.length||receipts.some(receipt=>!this.verifyCommitProofDeliveryReceipt(receipt,record)))return false;}
    return !record.certificate || this.validCertificate(record, record.certificate);
    }catch{/* @silent-fallback-ok: historical authority predicate fails closed; caller cannot publish or acknowledge this record. */return false;}
  }
  private effectiveMembership(record: ConversationGraphReplicationRecord): GraphMembershipEpoch {
    return record.materialization?.activation.newMembership??record.adoption?.newMembership ?? record.authorizationProof.membership;
  }
  private receiptContext(record: ConversationGraphReplicationRecord) {
    return record.materialization?{membershipEpoch:record.materialization.activation.newMembership.epoch,leaseEpoch:record.materialization.currentLease.leaseEpoch}:record.adoption ? {membershipEpoch: record.adoption.newMembership.epoch, leaseEpoch: record.adoption.currentLease.leaseEpoch} : undefined;
  }
  private certificateMembership(record:ConversationGraphReplicationRecord):GraphMembershipEpoch{return record.adoption?.newMembership??record.authorizationProof.membership;}
  private certificateContext(record:ConversationGraphReplicationRecord){return record.adoption?{membershipEpoch:record.adoption.newMembership.epoch,leaseEpoch:record.adoption.currentLease.leaseEpoch}:undefined;}
  private validMaterialization(record:ConversationGraphReplicationRecord,current=false):boolean{
    if(record.materialization instanceof GraphSelectedMaterializationV2){const proof=record.materialization;try{const b=this.pagedBinding();proof.context.assertStore(b.pages);this.pagedScope(proof.context);proof.assertCurrent();return proof.trustedFor(this.options.agentId,{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:this.options.witnessPublicKeys,installedMembership:proof.activation.newMembership,machineId:this.options.machineId})&&proof.matches(record);}catch{/* @silent-fallback-ok: unavailable selected held metadata never authorizes publication or a receipt. */return false;}}
    if(!record.materialization)return false;const proof=this.contexts.intern(record.materialization),witness=this.options.witnessPublicKeys.get(proof.activation.witnessId);
    if(!witness||proof.activation.agentId!==record.packet.agentId)return false;
    let verified=this.verifiedContexts.get(proof.manifest);
    if(!verified||verified.owner!==this.options.ownerPublicKey||verified.witness!==witness){
      if(!verifyGraphHistoricalMaterializationContext(proof,this.options.agentId,{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:this.options.witnessPublicKeys}))return false;
      verified={owner:this.options.ownerPublicKey,witness,entries:new Map(proof.manifest.entries.map(entry=>[entry.eventId,entry])),inventory:new Map(proof.rewrapInventory.map(entry=>[entry.eventId,entry]))};this.verifiedContexts.set(proof.manifest,verified);
    }
    const importMembership=current?this.currentHistoricalImportMembership(true):this.options.installedMembership;
    if(current&&(importMembership&&canonicalHash(importMembership)!==canonicalHash(proof.activation.newMembership)
      ||!proof.activation.newMembership.members.some(member=>member.machineId===this.options.machineId)))return false;
    return verifyGraphHistoricalMaterializationEntry(proof,record,verified.entries.get(record.packet.eventId),verified.inventory.get(record.packet.eventId));
  }
  private validMemberLossNegativeCustody(record:ConversationGraphReplicationRecord):boolean{
    const key=record.adoption&&this.options.witnessPublicKeys.get(record.adoption.witnessId);return !!key&&verifyGraphMemberLossNegativeCustody({packet:record.packet,packetSignature:record.packetSignature,controlCapsule:{v:1,coreType:record.coreType,core:record.core,authorizationProof:record.authorizationProof},prepareProof:record.preparationProof??null,erasedControlProof:record.erasedControlProof??null,certificate:record.certificate??null,adoption:record.adoption??null,cancellation:record.cancellation??null},record.authorizationProof.membership,this.options.ownerPublicKey,key);
  }
  private validAdoption(record: ConversationGraphReplicationRecord): boolean {
    const adoption = record.adoption;
    if (!adoption) return true;
    if(adoption.erasedControlHash&&(!record.erasedControlProof||adoption.erasedControlHash!==canonicalHash(record.erasedControlProof)||record.preparationProof||record.certificate||!record.erasure||!this.validErasedControl(record)))return false;
    const key = this.options.witnessPublicKeys.get(adoption.newMembership.witnessId);
    return !!key && adoption.revalidation.sourceProofHash === canonicalHash(this.immutable(record))
      && verifyAdoptionCertificate(adoption, record.packet, record.authorizationProof.membership, this.options.ownerPublicKey, key);
  }
  private validLocalReceipt(record: ConversationGraphReplicationRecord, receipt: GraphMemberReceipt): boolean {
    const refused = !!record.cancellation||record.adoption?.disposition === 'refused' || !!record.erasure&&!record.certificate;
    const decision=record.cancellation??record.erasure;
    return verifyMemberReceipt(receipt, record.packet, this.effectiveMembership(record), refused ? 'cancellation' : 'source',
      refused && decision ? canonicalHash(decision) : undefined, this.receiptContext(record));
  }
  private async persistAdoption(stored: Stored, incoming: ConversationGraphReplicationRecord): Promise<void> {
    if (!incoming.adoption || !this.validAdoption(incoming)) throw new Error('graph-replication-invalid-adoption');
    if (canonicalHash(stored.record.adoption ?? null) === canonicalHash(incoming.adoption)) {
      if(incoming.rewrap&&!stored.record.erasure){if(this.isErased(incoming.packet.erasureIdentity))throw new Error('graph-source-erasure-raced-publication');await this.save(this.rewrapFile(incoming.packet.eventId,incoming.adoption.rewrapHash),incoming.rewrap,true);if(this.isErased(incoming.packet.erasureIdentity)){await this.purgePayloadFiles(incoming.packet.eventId);throw new Error('graph-source-erasure-raced-publication');}stored.record.rewrap=structuredClone(incoming.rewrap);}
      return;
    }
    if (this.terminal(stored.record)) throw new Error('graph-replication-cannot-readopt-terminal');
    if((stored.record.cancellation||stored.record.erasure||stored.record.adoption?.disposition==='refused')&&incoming.adoption.disposition!=='refused')throw new Error('graph-replication-terminal-decision-dominates');
    const previous=stored.record.adoption;if(previous&&(incoming.adoption.newMembership.epoch<previous.newMembership.epoch
      ||incoming.adoption.newMembership.epoch===previous.newMembership.epoch&&incoming.adoption.currentLease.leaseEpoch<previous.currentLease.leaseEpoch))throw new Error('graph-replication-stale-adoption');
    if (incoming.adoption.disposition === 'refused' && !incoming.cancellation&&!incoming.erasure) throw new Error('graph-replication-refusal-needs-cancellation');
    if (incoming.adoption.disposition === 'adopted'&&incoming.encryptedSourceBundle&&!incoming.erasure&&!incoming.cancellation) this.checkLocalRecovery(incoming);
    if(incoming.rewrap&&!incoming.erasure){if(this.isErased(incoming.packet.erasureIdentity))throw new Error('graph-source-erasure-raced-publication');await this.save(this.rewrapFile(incoming.packet.eventId,incoming.adoption.rewrapHash),incoming.rewrap,true);if(this.isErased(incoming.packet.erasureIdentity)){await this.purgePayloadFiles(incoming.packet.eventId);throw new Error('graph-source-erasure-raced-publication');}}
    // Adoption + refusal decision form one atomic recovery sidecar, so a crash
    // cannot publish new receipt epochs without their cancellation authority.
    await this.save(this.file(incoming.packet.eventId, 'adoption'), {adoption:incoming.adoption,...(incoming.cancellation ? {cancellation:incoming.cancellation} : {})});
    const receipt = incoming.adoption.disposition === 'refused'||!!incoming.cancellation||!!incoming.erasure
      ? this.receipt(incoming, 'cancellation', canonicalHash(incoming.cancellation??incoming.erasure)) : this.receipt(incoming, 'source');
    if (!this.validLocalReceipt(incoming, receipt)) throw new Error('graph-replication-invalid-recovery-receipt');
    if(receipt.phase==='source'&&this.isErased(incoming.packet.erasureIdentity)){await this.purgePayloadFiles(incoming.packet.eventId);throw new Error('graph-source-erasure-raced-publication');}
    const original=stored.originalSourceReceipt??stored.sourceReceipt;
    if(original?.phase==='source'&&original.machineId===this.options.machineId&&verifyMemberReceipt(original,incoming.packet,incoming.authorizationProof.membership,'source')){await this.save(this.file(incoming.packet.eventId,'original-receipt'),original,true);stored.originalSourceReceipt=structuredClone(original);}
    if(receipt.phase==='cancellation')await this.save(this.file(incoming.packet.eventId,'cancellation-receipt'),receipt);
    else await this.save(this.file(incoming.packet.eventId, 'receipt'), receipt);
    if(receipt.phase==='source'&&this.isErased(incoming.packet.erasureIdentity)){await this.purgePayloadFiles(incoming.packet.eventId);throw new Error('graph-source-erasure-raced-publication');}
    await this.save(this.file(incoming.packet.eventId, 'acks'), []);
    stored.record.adoption = structuredClone(incoming.adoption);
    if(incoming.rewrap&&!incoming.erasure)stored.record.rewrap=structuredClone(incoming.rewrap);else delete stored.record.rewrap;
    if (incoming.cancellation) stored.record.cancellation = structuredClone(incoming.cancellation);
    delete stored.record.certificatePersistenceReceipts;
    stored.sourceReceipt = receipt; stored.certificateReceipts.clear();delete stored.record.commitProofDeliveryReceipts;this.deliveryCompletionReceipts.delete(incoming.packet.eventId); this.deliveryReceipts.delete(incoming.packet.eventId); this.inFlight.delete(incoming.packet.eventId);
  }

  private validErasedControl(record:ConversationGraphReplicationRecord):boolean{
    const proof=record.erasedControlProof;if(!proof||!record.erasure||!this.validErasure(record,record.erasure))return false;
    const key=this.options.witnessPublicKeys.get(proof.witnessId),issuers=[record.authorizationProof.membership,record.adoption?.newMembership,record.materialization?.activation.newMembership,this.options.installedMembership,record.custodyMembership];
    return !!key&&issuers.some(m=>m&&verifyGraphCustodyAuthority(proof,record.authorizationProof.membership,m,record.custodyActivations??(record.adoption?.activation?[record.adoption.activation]:record.materialization?[record.materialization.activation]:undefined),{ownerPublicKey:this.options.ownerPublicKey,witnessPublicKeys:this.options.witnessPublicKeys}))&&verifyGraphWitnessCustody(null,proof,record.packet,proof.witnessId,key,record.erasure);
  }
  private validPreparation(record: ConversationGraphReplicationRecord, proof: GraphWitnessPrepareProof): boolean {
    const key = this.options.witnessPublicKeys.get(record.authorizationProof.membership.witnessId);
    return !!key && Object.keys(proof).sort().join(',') === 'agentId,eventId,leaseEpoch,membershipEpoch,operationHash,preparedAt,signature,v,witnessId'
      && proof.v === 1 && proof.agentId === record.packet.agentId && proof.eventId === record.packet.eventId
      && proof.operationHash === canonicalHash(record.packet) && proof.membershipEpoch === record.packet.membershipEpoch
      && proof.leaseEpoch === record.packet.leaseEpoch && proof.witnessId === record.authorizationProof.membership.witnessId
      && Number.isFinite(Date.parse(proof.preparedAt))
      && verifyGraphRecord(GRAPH_SIGNATURE_DOMAINS.prepare, unsigned(proof), proof.signature, key);
  }
  private validCertificate(record: ConversationGraphReplicationRecord, certificate: GraphCommitCertificate): boolean {
    const key = this.options.witnessPublicKeys.get(certificate.witnessId);
    return !!key && verifyCommitCertificate(certificate, record.packet, record.authorizationProof.membership, key, this.options.ownerPublicKey)
      && canonicalHash(certificate.adoption ?? null) === canonicalHash(record.adoption ?? null);
  }
  private validErasure(record: ConversationGraphReplicationRecord, erasure: GraphWitnessErasure): boolean {
    const issuers=[record.authorizationProof.membership,record.adoption?.newMembership,...(record.adoption?.membershipChain??[]),record.materialization?.activation.previousMembership,record.materialization?.activation.newMembership,record.custodyMembership,this.options.installedMembership].filter((value):value is GraphMembershipEpoch=>!!value);
    const key = this.erasureAuthorities.verificationKey(erasure.witnessId);
    try{this.erasureHashPreflight(erasure);}catch{/* @silent-fallback-ok: historical authority predicate fails closed; caller cannot publish or acknowledge this record. */return false;}
    return this.erasureAuthorities.has(erasure) && !!key && erasure.agentId === record.packet.agentId
      && erasureCoversPacket(erasure,record.packet) && verifyWitnessErasure(erasure, key);
  }
  private validCancellation(record: ConversationGraphReplicationRecord, decision: GraphWitnessCancellation): boolean {
    const membership = this.certificateMembership(record);
    const key = this.options.witnessPublicKeys.get(membership.witnessId);
    return !!key && decision.witnessId === membership.witnessId
      && verifyWitnessCancellation(decision, record.packet, key, this.certificateContext(record));
  }
  private validCancellationCertificate(record: ConversationGraphReplicationRecord, certificate: GraphCancellationCertificate): boolean {
    const key = this.options.witnessPublicKeys.get(certificate.witnessId);
    const decision = certificate.outcome === 'canceled' ? record.cancellation : record.erasure;
    return !!key && !!decision && certificate.cancellationHash === canonicalHash(decision)
      && verifyCancellationCertificate(certificate, record.packet, record.authorizationProof.membership, key, this.options.ownerPublicKey)
      && canonicalHash(certificate.adoption ?? null) === canonicalHash(record.adoption ?? null);
  }
  private terminal(record: ConversationGraphReplicationRecord): GraphCommitCertificate | GraphCancellationCertificate | undefined {
    return record.certificate ?? record.cancellationCertificate;
  }
  private admitted(record: ConversationGraphReplicationRecord): boolean {
    if(this.heldPlans.size){if(!this.historicalImportAuthority)return false;try{this.assertHeldImportsSettled(this.historicalImportAuthority);}catch{/* @silent-fallback-ok: an unresolved/corrupt held-import fact refuses new positive admission; custody/negative repair remains separate. */return false;}}
    if(this.isErased(record.packet.erasureIdentity))return false;
    const guard = this.options.writeAdmission.guardStoreWrite('conversationGraph.append');
    if (guard.enforce === 'refuse' || (guard.enforce === 'legacy' && this.options.legacyReadOnly())) return false;
    const live = this.options.liveAdmission();
    const lease = record.adoption?.currentLease;
    return live.admitted && (lease?.writerId ?? record.packet.writerId) === this.options.machineId && live.writerId === this.options.machineId
      && live.leaseEpoch === (lease?.leaseEpoch ?? record.packet.leaseEpoch) && live.membershipEpoch === (lease?.membershipEpoch ?? record.packet.membershipEpoch)
      && live.fencedLeaseHash === (lease?.fencedLeaseHash ?? record.authorizationProof.receipt.fencedLeaseHash);
  }
  private receipt(record: ConversationGraphReplicationRecord, phase: GraphMemberReceipt['phase'], certificateHash?: string): GraphMemberReceipt {
    const payload = { agentId: record.packet.agentId, eventId: record.packet.eventId, operationHash: canonicalHash(record.packet),
      membershipEpoch: this.receiptContext(record)?.membershipEpoch ?? record.packet.membershipEpoch, leaseEpoch: this.receiptContext(record)?.leaseEpoch ?? record.packet.leaseEpoch, machineId: this.options.machineId,
      phase, ...(certificateHash ? { certificateHash } : {}), persistedAt: (this.options.now?.() ?? new Date()).toISOString() };
    return { ...payload, signature: signGraphRecord(GRAPH_SIGNATURE_DOMAINS.memberReceipt, payload, this.options.memberPrivateKey) };
  }
  /** Reconstruct exact original acceptance from the independent witness, never
   * from caller-invented core/receipt or a newly signed replacement packet. */
  async reconstructFromWitness(input:Omit<ConversationGraphReplicationRecord,'coreType'|'core'|'authorizationProof'>&{controlCapsule:GraphControlCapsule},originalMembership:GraphMembershipEpoch):Promise<GraphMemberReceipt|null>{
    if(!input.preparationProof&&!input.erasedControlProof){const key=input.adoption&&this.options.witnessPublicKeys.get(input.adoption.witnessId);if(!key||!verifyGraphMemberLossNegativeCustody({packet:input.packet,packetSignature:input.packetSignature,controlCapsule:input.controlCapsule,prepareProof:null,erasedControlProof:null,certificate:input.certificate??null,adoption:input.adoption??null,cancellation:input.cancellation??null},originalMembership,this.options.ownerPublicKey,key))throw new Error('graph-witness-custody-evidence-missing');}
    const recovered=reconstructGraphSourceRecord({...input,originalMembership},
      {machineId:this.options.machineId,sealingPrivateKey:this.options.memberSealingPrivateKey,ownerPublicKey:this.options.ownerPublicKey,
       witnessPublicKeys:this.options.witnessPublicKeys,installedMembership:this.options.installedMembership,custodyMembership:input.custodyMembership,custodyActivations:input.custodyActivations,knownErasures:this.erasureProofs});
    recovered.applicationSource.fill(0);
    if(recovered.record.materialization){await this.receiveHistorical(recovered.record);return null;}
    return this.receive(recovered.record,recovered.record.packet.writerId);
  }

  /** Key custody only, not viewer authority. Caller must first use the actual
   * certified union and current view grant. Returned plaintext must be zeroed. */
  openVerifiedPayload(record:ConversationGraphReplicationRecord):Buffer{
    const stored=this.records.get(record.packet.eventId);const live=stored?.record;
    if(!live||stored?.quarantine||canonicalHash(this.immutable(live))!==canonicalHash(this.immutable(record))
      ||!this.verify(live,live.packet.writerId))throw new Error('graph-source-payload-unverified');
    if(this.isErased(live.packet.erasureIdentity))throw new Error('graph-source-locally-erased');
    if(live.erasure||this.erasureProofs.some(proof=>erasureCoversPacket(proof,live.packet)))throw new Error('graph-source-payload-erased');
    if(!live.encryptedSourceBundle)throw new Error('graph-source-payload-unavailable');
    return this.decryptPayload(live);
  }
  rewrapVerifiedPayload(record:ConversationGraphReplicationRecord,membership:GraphMembershipEpoch,writerId:string,signingKey:crypto.KeyLike,at:string):GraphBundleRewrap{
    const checked=this.openVerifiedPayload(record);checked.fill(0);const live=this.required(record.packet.eventId).record;
    if(!verifyMembershipEpoch(membership,this.options.ownerPublicKey)||membership.agentId!==this.options.agentId||writerId!==this.options.machineId)throw new Error('graph-source-rewrap-authority-invalid');
    const result=rewrapGraphBundle(live.encryptedSourceBundle!,this.options.machineId,this.options.memberSealingPrivateKey,membership,writerId,signingKey,
      {agentId:live.packet.agentId,eventId:live.packet.eventId},at,live.rewrap?{rewrap:live.rewrap,membership:this.effectiveMembership(live)}:undefined);
    if(!verifyBundleRewrap(result,live.encryptedSourceBundle!,membership))throw new Error('graph-source-rewrap-signing-key-invalid');return result;
  }
  private decryptPayload(record:ConversationGraphReplicationRecord):Buffer{
    if(!record.encryptedSourceBundle)throw new Error('graph-source-payload-unavailable');
    const binding={agentId:record.packet.agentId,eventId:record.packet.eventId};
    const sealed=record.rewrap&&(record.adoption||record.materialization)?openRewrappedGraphBundle(record.encryptedSourceBundle,record.rewrap,this.options.machineId,
      this.options.memberSealingPrivateKey,this.effectiveMembership(record),binding):openGraphBundle(record.encryptedSourceBundle,this.options.machineId,this.options.memberSealingPrivateKey,binding);
    let decoded:ReturnType<typeof decodeGraphSourceEnvelope>;try{decoded=decodeGraphSourceRecoveryEnvelope({packet:record.packet,packetSignature:record.packetSignature,plaintextEnvelope:sealed,ownerPublicKey:this.options.ownerPublicKey});}finally{sealed.fill(0);}
    if(!verifyGraphSourceEnvelopeControl(decoded,record)){decoded.applicationSource.fill(0);throw new Error('graph-source-envelope-control-mismatch');}return decoded.applicationSource;
  }
  private checkLocalRecovery(record: ConversationGraphReplicationRecord): void {
    if(this.isErased(record.packet.erasureIdentity))throw new Error('graph-source-locally-erased');
    if (!record.encryptedSourceBundle) throw new Error('graph-replication-bundle-unavailable');
    // A structurally valid ciphertext/envelope is insufficient evidence that
    // this installed machine can recover its original source. Never sign a
    // durable-source receipt until its actual local sealing key opens the bundle.
    const plaintext=this.decryptPayload(record);
    try{if(!validateGraphApplicationSource(record.coreType,record.core,record.authorizationProof,plaintext))throw new Error('graph-replication-application-source-invalid');}finally{plaintext.fill(0);}
  }
  private rewrapFile(eventId:string,hash:string):string{return this.file(eventId,`rewrap-${hash}`);}
  private async purgePayloadFiles(eventId:string):Promise<void>{
    const prefix=graphReplicationFileStem(eventId);
    for(const name of (this.openingPayloadNames?(this.openingPayloadNames.get(prefix)??[]):await fs.readdir(this.options.directory)))if(name.startsWith(`${prefix}.bundle.json`)||name.startsWith(`${prefix}.rewrap-`))this.removeBundle(name);
  }
  /** Independent filesystem inspection, not an in-memory success flag. */
  async assertLocalErasurePurged(target:GraphErasureIdentity):Promise<string>{
    if(!this.isErased(target))throw new Error('graph-source-erasure-fence-required');
    if(this.options.localErasure instanceof ConversationGraphLocalErasureFence&&!purgeHeldPrivateViews(this.options.localErasure.stateRoot,target))throw new Error('graph-source-held-private-view-debt');
    const ids=new Set([...await this.intentIds(target),...[...this.records.values()].filter(stored=>sameGraphErasureIdentity(target,stored.record.packet.erasureIdentity)).map(stored=>stored.record.packet.eventId)]),stems=new Set([...ids].map(graphReplicationFileStem));
    const names=await fs.readdir(this.options.directory),attributed=new Set([...names.filter(name=>name.endsWith('.source.json')||name.endsWith('.intent.json')).map(name=>name.slice(0,64)),...[...this.records.keys()].map(graphReplicationFileStem),...[...this.heldImports.values()].map(c=>graphReplicationFileStem(c.eventId)),...[...this.pagedHeldCatalogs.values()].map(c=>graphReplicationFileStem(c.eventId))]);
    for(const name of names)if(/^[a-f0-9]{64}\.(?:bundle\.json|rewrap-[a-f0-9]{64}\.json)/.test(name)&&!attributed.has(name.slice(0,64)))throw new Error('graph-source-erasure-unattributed-key-copy');
    for(const name of names)if(stems.has(name.slice(0,64))&&(name.slice(64).startsWith('.bundle.json')||name.slice(64).startsWith('.rewrap-')))throw new Error('graph-source-erasure-key-copy-remains');
    if(this.pagedHeldNames().length)throw new Error('graph-paged-history-public-census-pending');
    return canonicalHash({v:1,scope:'graph-source',agentId:this.options.agentId,target,controls:[...ids].sort(),keyCopies:[]});
  }
  private async scrubUnattributedPayloads():Promise<void>{
    const names=await fs.readdir(this.options.directory),known=new Set([...names.filter(name=>name.endsWith('.source.json')||name.endsWith('.intent.json')).map(name=>name.slice(0,64)),...[...this.records.keys()].map(graphReplicationFileStem),...[...this.heldImports.values()].map(c=>graphReplicationFileStem(c.eventId)),...[...this.pagedHeldCatalogs.values()].map(c=>graphReplicationFileStem(c.eventId))]);
    for(const name of names)if(/^[a-f0-9]{64}\.(?:bundle\.json|rewrap-[a-f0-9]{64}\.json)/.test(name)&&!known.has(name.slice(0,64)))this.removeBundle(name);
  }
  private async assertNewHistoryCapacity(eventId:string):Promise<void>{
    if(this.historyOperationIds.has(eventId))return;
    const ids=new Set([...this.historyOperationIds,...await this.options.reservedOperationIds?.()??[]]);
    const budget=this.options.maxHistoryEntries??GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES;
    if(ids.size>budget||(!ids.has(eventId)&&ids.size>=budget))throw new Error('graph-source-history-capacity');
  }
  private rememberControl(raw:ConversationGraphReplicationRecord):void{
    if(!raw?.packet||!validatePacket(raw.packet)||!this.options.validateCore(raw.core,raw.coreType)
      ||!verifyGraphAuthorization(raw.packet,raw.core,raw.authorizationProof,this.options.ownerPublicKey,raw.packet.writerId).ok)throw new Error('graph-source-control-index-untrusted');
    const signer=raw.authorizationProof.membership.members.find(member=>member.machineId===raw.packet.writerId);
    if(!signer||!verifyGraphRecord('graph-operation-packet-v1',raw.packet,raw.packetSignature,signer.signingPublicKey))throw new Error('graph-source-control-index-signature-invalid');
    this.historyOperationIds.add(raw.packet.eventId);
    const targets=this.controlTargets.get(raw.packet.sourceBundleHash)??new Set<string>();targets.add(canonicalHash(raw.packet.erasureIdentity));this.controlTargets.set(raw.packet.sourceBundleHash,targets);
  }
  private erasureHashPreflight(proof:GraphWitnessErasure):void{
    const target=canonicalHash(proof.target);for(const hash of proof.bundleHashes)for(const known of this.controlTargets.get(hash)??[])if(known!==target)throw new Error('graph-erasure-cross-target-hash');
  }
  private retainPendingErasure(proof:GraphWitnessErasure):void{const target=canonicalHash(proof.target),proofs=this.pendingErasureTargets.get(target)??new Set<string>();proofs.add(canonicalHash(proof));this.pendingErasureTargets.set(target,proofs);this.purgeMemberLossSnapshots(proof.target);}
  private releasePendingErasure(proof:GraphWitnessErasure):void{const target=canonicalHash(proof.target),proofs=this.pendingErasureTargets.get(target);proofs?.delete(canonicalHash(proof));if(!proofs?.size)this.pendingErasureTargets.delete(target);}
  private async intentIds(target:GraphErasureIdentity):Promise<string[]>{
    const ids:string[]=[];for(const name of await fs.readdir(this.options.directory))if(name.endsWith('.intent.json')||name.endsWith('.source.json')){
      const raw=await this.load(name) as Pick<ConversationGraphReplicationRecord,'coreType'|'packet'|'packetSignature'|'core'|'authorizationProof'>;
      if(!raw?.packet||!validatePacket(raw.packet))throw new Error('graph-source-intent-corrupt');
      if(!sameGraphErasureIdentity(target,raw.packet.erasureIdentity))continue;
      const record={...raw,encryptedSourceBundle:null};
      if(!this.verify(record,record.packet.writerId))throw new Error('graph-source-intent-authority-invalid');ids.push(record.packet.eventId);
    }for(const c of this.heldImports.values()){const catalog=this.validateHeldCatalog(this.heldRead(c.name),c.name),packet=(catalog.recordControl as unknown as ConversationGraphReplicationRecord).packet;if(sameGraphErasureIdentity(target,packet.erasureIdentity))ids.push(catalog.eventId);}for(const name of this.pagedHeldNames()){const c=this.validatePagedHeld(this.heldRead(name),name),r=c.recordControl as unknown as ConversationGraphReplicationRecord;if(sameGraphErasureIdentity(target,r.packet.erasureIdentity))ids.push(c.eventId);}return [...new Set(ids)];
  }
  private async purgePayloadFilesMany(ids:string[]):Promise<void>{
    const prefixes=new Set(ids.map(graphReplicationFileStem));
    for(const name of await fs.readdir(this.options.directory))if(prefixes.has(name.slice(0,64))&&(name.slice(64).startsWith('.bundle.json')||name.slice(64).startsWith('.rewrap-')))this.removeBundle(name);
  }
  private required(id: string): Stored {
    const stored = this.records.get(id); if (!stored) throw new Error('graph-replication-event-unavailable'); return stored;
  }
  private file(id: string, suffix: string): string { return `${graphReplicationFileStem(id)}.${suffix}.json`; }
  private async load(name: string): Promise<unknown | null> {
    try {
      const handle = await fs.open(path.join(this.options.directory, name), 'r');
      try {
        if ((await handle.stat()).size > GRAPH_REPLICATION_MAX_RECORD_BYTES) throw new Error('graph-replication-oversize-source');
        return JSON.parse(await handle.readFile('utf8'));
      } finally { await handle.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private async save(name: string, value: unknown, immutable = false): Promise<void> {
    // Outbox publication bookkeeping cannot change any historical source,
    // certificate, body or authority fact. It remains durably written below,
    // but must not invalidate a concurrent proof of those unchanged facts.
    if(!/^[a-f0-9]{64}\.emitted\.json$/.test(name))this.durableGeneration++;
    const bytes = canonicalJson(value);
    if (Buffer.byteLength(bytes) > GRAPH_REPLICATION_MAX_RECORD_BYTES) throw new Error('graph-replication-oversize-source');
    const target = path.join(this.options.directory, name);
    const temporary = `${target}.${crypto.randomUUID()}.tmp`;
    const handle = await fs.open(temporary, 'wx', 0o600);
    try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (immutable) {
      try { await fs.link(temporary, target); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || canonicalJson(await this.load(name)) !== bytes) throw new Error('graph-replication-immutable-source-conflict');
      } finally {
        SafeFsExecutor.safeUnlinkSync(temporary, { operation: 'conversation-graph:publish-immutable-source' });
      }
    } else await fs.rename(temporary, target);
    await this.syncDirectory();
  }
  private async syncDirectory(): Promise<void> {
    const directory = await fs.open(this.options.directory, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
  private removeBundle(name: string): void {
    this.durableGeneration++;
    try { SafeFsExecutor.safeUnlinkSync(path.join(this.options.directory, name), { operation: 'conversation-graph:erase-encrypted-bundle' }); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn); this.queue = next.catch(() => undefined); return next;
  }
}
