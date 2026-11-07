import {verifyGraphMemberLossPlanRevision,verifyGraphMemberLossPlanRevisionSuccessor,GRAPH_MEMBER_LOSS_REVISION_RECEIPT_DOMAIN,type GraphMemberLossPlanRevision,type GraphMemberLossRevisionReceipt} from './GraphMemberLossPlanRevision.js';
import {verifyGraphMemberLossNegativeCustody} from './GraphMemberLossNegativeCustody.js';
import {graphMemberLossActivationDomain,GRAPH_MEMBER_LOSS_SETTLED_DOMAIN,verifyGraphMemberLossActivationPins,verifyGraphMemberLossSettlement,verifyGraphMemberLossActivationAuthority,type GraphMemberLossActivationPin,type GraphMemberLossSettlementProof,type GraphMemberLossActivationAuthority} from './GraphMemberLossActivation.js';
import {GRAPH_CUSTODY_ALLOCATION_HOLD_DOMAIN,verifyGraphCustodyAllocationHold,verifyGraphCustodyHoldIntent,type GraphCustodyHoldIntent,type GraphCustodyAllocationHold} from './GraphCustodyProfileAuthority.js';
import {GRAPH_NATIVE_UPLOAD_DOMAIN,validateGraphNativeSourceUpload,decodeGraphNativeSourceUpload,GRAPH_NATIVE_UPLOAD_CHUNK_BYTES,type GraphNativeSourceUpload} from './GraphNativeSourceUpload.js';
import {GRAPH_WITNESS_LOCAL_ERASURE_SCHEMA,enforceGraphWitnessTargetErasure,purgeGraphWitnessStagedTarget,purgeGraphWitnessStagedBundle} from './GraphWitnessErasureStorage.js';
import {GRAPH_CUSTODY_RETIREMENT_DOMAIN,graphCustodyHoldsHash,verifyGraphCustodyRetirement,verifyGraphCustodyTransitionHolds,type GraphCustodyProfileStage,type GraphCustodyProfileHold,type GraphCustodyRetirementProof,type GraphOwnedTransitionProof} from './GraphCustodyProfileAuthority.js';
import {verifyGraphNativeTailBarrier,verifyGraphNativeTakeoverCustodyReceipt,type GraphNativeTakeoverCustodyReceipt,type GraphNativeTailClosure} from './ConversationGraphNativeTail.js';
import {graphTransferContextCapacityBytes} from './ConversationGraphContextCapacity.js';
/** Independent durable witness for conversation-effort-hierarchy-v3 §7.2.
 * A prepared witness proof never means an all-machine acknowledgement.
 */
import fs from 'node:fs';
import {GraphErasureWitnessLedger} from './GraphErasureWitnessLedger.js';
import {verifyGraphErasureIngress,type GraphErasureActiveEndorsement,type GraphErasureWitnessPurgeReceipt,type GraphErasureIngress,type GraphErasureMemberReceipt} from './GraphErasureProtocol.js';
import {verifyGraphControlCapsule,verifyGraphWitnessCustody,type GraphControlCapsule} from './GraphWitnessControl.js';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase } from 'better-sqlite3';
import type {GraphHistoricalMaterialization,GraphHistoricalMaterializationRef} from './ConversationGraphHistoricalMaterialization.js';
import type { LeaseRecord } from './types.js';
import { registerSqliteHandle } from './SqliteRegistry.js';
import { GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES,canonicalHash, canonicalJson, canonicalPublicKey, GRAPH_SIGNATURE_DOMAINS as D, hash, opaque, signGraphRecord,
  validateGraphErasureIdentity,sameGraphErasureIdentity,erasureCoversPacket,graphRewrapInventoryHash,verifyEncryptedBundle, exactFields, unsigned, verifyCommitCertificate, verifyCancellationCertificate, verifyWitnessCancellation, verifyWitnessErasure, verifyBackupErasureAttestation, validatePacket, verifyFencedLeaseBridge, verifyWitnessLease, verifyMemberReceipt, verifyMembershipEpoch, verifyGraphRecord, witnessActionPayload,
  verifyBundleRewrap, verifyRecoveryAuthorization, verifyPendingRevalidation, verifyAdoptionCertificate,
  verifyMembershipTransferReceipt, verifyMembershipActivation, validateRecoverySourceManifest,
  type GraphCommitCertificate, type GraphCancellationCertificate, type GraphEncryptedBundle, type GraphMemberReceipt, type GraphMembershipEpoch,
  type GraphErasureIdentity,type GraphOperationPacket, type GraphWitnessCancellation, type GraphWitnessErasure,
  type GraphWitnessLease, type GraphWitnessErasedControlProof,type GraphWitnessPrepareProof, type GraphWitnessOperationStateProof,
  type GraphAdoptionCertificate, type GraphBundleRewrap, type GraphPendingRevalidation, type GraphRecoveryAuthorization,
  type GraphMembershipActivationCertificate, type GraphRecoverySourceManifest } from './GraphWitnessTypes.js';

export class GraphWitnessError extends Error {
  constructor(public readonly code: string, public readonly status = 409) { super(code); }
}
export interface GraphWitnessEnrollment { ownerPublicKey: string; bearerToken: string; backupPolicyAuditorPublicKey?: string }
export interface GraphWitnessServiceOptions {
  databasePath: string; witnessId: string; failureDomain: string;
  signingPrivateKey: crypto.KeyLike; enrollments: Record<string, GraphWitnessEnrollment>;
  installedFailureDomains: string[]; now?: () => number;
  /** Actual locally enrolled host identity; only a matching signed owned profile admits this role. */
  ownedHost?:{machineId:string;signingPublicKey:string};
  historicalWitnessPublicKeys?: Record<string,string>;
  historicalBackupPolicyAuditorPublicKeys?:Record<string,string>;
  maxBootstrapStagingBytes?:number;
  /** Optional lower resource budget; cannot expand the recovery schema domain. */
  maxHistoryEntries?:number;
}
export interface GraphWitnessPrepareRequest {
  packet: GraphOperationPacket; lease: GraphWitnessLease; originalLease: LeaseRecord;
  encryptedSourceBundle: GraphEncryptedBundle; controlCapsule:GraphControlCapsule;
  packetSignature: string;
}
export interface GraphWitnessRecoveredSourceRequest extends GraphWitnessPrepareRequest {
 originalSourceReceipt?:GraphMemberReceipt; takeoverSourceReceipt?:GraphNativeTakeoverCustodyReceipt; closedTails:GraphNativeTailClosure[];
 revalidation:GraphPendingRevalidation;rewrap:GraphBundleRewrap;
}
export interface GraphWitnessOperation {
  packet: GraphOperationPacket; packetSignature:string; controlCapsule:GraphControlCapsule; prepareProof: GraphWitnessPrepareProof|null; erasedControlProof:GraphWitnessErasedControlProof|null;
  state: 'prepared' | 'certified' | 'canceled' | 'erased';
  certificate: GraphCommitCertificate | null; cancellation: GraphWitnessCancellation | null;
  cancellationCertificate: GraphCancellationCertificate | null;
  erasure: GraphWitnessErasure | null;
  stateProof: GraphWitnessOperationStateProof;
  adoption: GraphAdoptionCertificate | null;
  rewrap:GraphBundleRewrap|null;
  materialization:GraphWitnessMaterializationRef|null;
  certificatePersistenceReceipts: GraphMemberReceipt[];
}
export interface GraphWitnessBootstrapOperation {kind?:'member-loss-source';operation:Omit<GraphWitnessOperation,'stateProof'>&{stateProof?:GraphWitnessOperationStateProof};encryptedSourceBundle:GraphEncryptedBundle|null}
export interface GraphWitnessRecoveryRequest {
  newMembership: GraphMembershipEpoch; authorization: GraphRecoveryAuthorization;
  currentLease: GraphWitnessLease; originalCurrentLease: LeaseRecord;
  revalidations: Array<{ proof: GraphPendingRevalidation; rewrap: GraphBundleRewrap | null }>;
  stateTransferReceipts: import('./GraphWitnessTypes.js').GraphMembershipTransferReceipt[];
  sourceManifest: GraphRecoverySourceManifest;
  historicalRewraps?:Array<{eventId:string;rewrap:GraphBundleRewrap}>;
  ownedTransition?:GraphOwnedTransitionProof;
  memberLoss?:GraphMemberLossActivationAuthority;
  lossControls?:Array<{packet:GraphOperationPacket;packetSignature:string;controlCapsule:GraphControlCapsule}>;
}
export type GraphWitnessMaterializationRef=GraphHistoricalMaterializationRef;
export function validWitnessMaterializationRef(raw:unknown):raw is GraphWitnessMaterializationRef {
 const ref=raw as GraphWitnessMaterializationRef;return exactFields(ref,['epoch','activationHash','manifestHash','rewrapInventoryHash','rewrapHash','leaseHash','originalLeaseHash'])&&Number.isSafeInteger(ref.epoch)&&ref.epoch>0&&[ref.activationHash,ref.manifestHash,ref.rewrapInventoryHash,ref.rewrapHash,ref.leaseHash,ref.originalLeaseHash].every(hash);
}
export type GraphWitnessRecoveryContext=Omit<GraphHistoricalMaterialization,'rewrapHash'>;
export interface GraphWitnessArchive {activations:GraphMembershipActivationCertificate[];contexts:GraphWitnessRecoveryContext[]}
export interface GraphWitnessBootstrapRequest {
 archive?:GraphWitnessArchive;
 recovery:GraphWitnessRecoveryRequest;
 memberships:GraphMembershipEpoch[];
 operations:GraphWitnessBootstrapOperation[];
 erasures:GraphWitnessErasure[];
 backupAttestations?:import('./GraphWitnessTypes.js').GraphBackupErasureAttestation[];
 previousFenceEpoch:number;
 /** Owner signs exact imported ciphertext/immutable proof inventory and fence. */
 bootstrapSignature:string;
}
export function graphWitnessBootstrapCounts(request:Omit<GraphWitnessBootstrapRequest,'bootstrapSignature'>,operationCount=request.operations.length,archiveCounts?:Record<string,number>) {
 return {control:1,membership:request.memberships.length,operation:operationCount,erasure:request.erasures.length,revalidation:request.recovery.revalidations.length,receipt:request.recovery.stateTransferReceipts.length,entry:request.recovery.sourceManifest.entries.length,...(request.backupAttestations?{backup:request.backupAttestations.length}:{}),...(request.recovery.historicalRewraps?{'historical-rewrap':request.recovery.historicalRewraps.length}:{}),...(request.archive?{activation:request.archive.activations.length,context:request.archive.contexts.length,'context-page':request.archive.contexts.reduce((n,c)=>n+Math.max(1,Math.ceil(c.manifest.entries.length/16)),0)}:{}),...(archiveCounts??{})};
}
export function graphWitnessBootstrapPayload(request:Omit<GraphWitnessBootstrapRequest,'bootstrapSignature'>):unknown {
 return {v:1,countsHash:canonicalHash(graphWitnessBootstrapCounts(request)),recoveryHash:canonicalHash(request.recovery),membershipsHash:canonicalHash(request.memberships),operationsHash:canonicalHash(request.operations),erasuresHash:canonicalHash(request.erasures),previousFenceEpoch:request.previousFenceEpoch,...(request.backupAttestations?{backupAttestationsHash:canonicalHash(request.backupAttestations)}:{}),...(request.archive?{archiveHash:canonicalHash(request.archive)}:{})};
}
interface GraphContextArchiveHeader {epoch:number;context:GraphWitnessRecoveryContext;entryCount:number;pageOffset:number;pageCount:number}
interface GraphContextArchivePage {epoch:number;index:number;entries:GraphRecoverySourceManifest['entries'];rewrapInventory:import('./GraphWitnessTypes.js').GraphRewrapInventoryEntry[]}
export type GraphBootstrapSection='control'|'membership'|'operation'|'erasure'|'revalidation'|'receipt'|'entry'|'backup'|'historical-rewrap'|'activation'|'context'|'context-page';
export interface GraphBootstrapTransferPlan {
 transferId:string; payload:{v:1;countsHash:string;recoveryHash:string;membershipsHash:string;operationsHash:string;erasuresHash:string;previousFenceEpoch:number;backupAttestationsHash?:string;archiveHash?:string};
 bootstrapSignature:string; counts:Record<Exclude<GraphBootstrapSection,'backup'|'historical-rewrap'|'activation'|'context'|'context-page'>,number>&{backup?:number;'historical-rewrap'?:number;activation?:number;context?:number;'context-page'?:number};
}
export type GraphRecoveryUploadSection='entry'|'revalidation'|'receipt'|'historical-rewrap';
export interface GraphRecoveryUploadPlan {kind:'recovery';transferId:string;requestHash:string;header:Omit<GraphWitnessRecoveryRequest,'revalidations'|'stateTransferReceipts'|'historicalRewraps'>;counts:Record<GraphRecoveryUploadSection,number>;hasHistoricalRewraps:boolean}
export function graphRecoveryUploadId(request:Pick<GraphWitnessRecoveryRequest,'authorization'|'currentLease'>):string{return canonicalHash({authorizationHash:canonicalHash(request.authorization),leaseHash:canonicalHash(request.currentLease)});}
export interface GraphWitnessAdoptionRequest {
  currentLease: GraphWitnessLease; originalCurrentLease: LeaseRecord;
  revalidations: Array<{ proof: GraphPendingRevalidation; rewrap: GraphBundleRewrap | null }>;
}
interface StoredOperation { packet: string; packetSignature:string|null; prepareProof: string; state: GraphWitnessOperation['state']; certificate: string | null; cancellation: string | null; cancellationCertificate: string | null; adoption: string | null }
const SCHEMA = `
CREATE TABLE IF NOT EXISTS memberLossSettlements(agentId TEXT NOT NULL,epoch INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,epoch));
CREATE TABLE IF NOT EXISTS memberLossMaintenance(agentId TEXT PRIMARY KEY,epoch INTEGER NOT NULL,activationHash TEXT NOT NULL,body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ownedAllocationHolds(agentId TEXT NOT NULL,membershipHash TEXT NOT NULL,intentHash TEXT NOT NULL,intent TEXT NOT NULL,proof TEXT NOT NULL,PRIMARY KEY(agentId,membershipHash));
CREATE TABLE IF NOT EXISTS ownedRetirements(agentId TEXT NOT NULL,membershipHash TEXT NOT NULL,stageHash TEXT NOT NULL,revision INTEGER NOT NULL,stage TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,membershipHash,stageHash));
CREATE TABLE IF NOT EXISTS memberships(agentId TEXT NOT NULL, epoch INTEGER NOT NULL, hash TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(agentId,epoch));
CREATE TABLE IF NOT EXISTS witnessedTips(agentId TEXT PRIMARY KEY,sequence INTEGER NOT NULL,coreHash TEXT);
CREATE TABLE IF NOT EXISTS agents(agentId TEXT PRIMARY KEY, epoch INTEGER NOT NULL, leaseEpoch INTEGER NOT NULL DEFAULT 0, leaseHash TEXT, certifiedSequence INTEGER NOT NULL DEFAULT 0, certifiedCoreHash TEXT);
CREATE TABLE IF NOT EXISTS erasedControls(agentId TEXT NOT NULL,eventId TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,eventId));
CREATE TABLE IF NOT EXISTS controls(agentId TEXT NOT NULL,eventId TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,eventId));
CREATE TABLE IF NOT EXISTS operations(agentId TEXT NOT NULL, idempotencyKey TEXT NOT NULL, eventId TEXT NOT NULL, operationHash TEXT NOT NULL, packet TEXT NOT NULL, packetSignature TEXT NOT NULL, prepareProof TEXT NOT NULL, state TEXT NOT NULL, certificate TEXT, cancellation TEXT, cancellationCertificate TEXT, adoption TEXT, PRIMARY KEY(agentId,idempotencyKey), UNIQUE(agentId,eventId));
CREATE UNIQUE INDEX IF NOT EXISTS operations_sequence ON operations(agentId,json_extract(packet,'$.sourceSequence'));
CREATE TABLE IF NOT EXISTS bundles(agentId TEXT NOT NULL, hash TEXT NOT NULL, ciphertext TEXT, PRIMARY KEY(agentId,hash));
CREATE TABLE IF NOT EXISTS recoveryContexts(agentId TEXT NOT NULL,epoch INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,epoch));
CREATE TABLE IF NOT EXISTS materializations(agentId TEXT NOT NULL,eventId TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,eventId));
CREATE TABLE IF NOT EXISTS rewraps(agentId TEXT NOT NULL,eventId TEXT NOT NULL,body TEXT,PRIMARY KEY(agentId,eventId));
${GRAPH_WITNESS_LOCAL_ERASURE_SCHEMA};
CREATE TABLE IF NOT EXISTS targetErasures(agentId TEXT NOT NULL,sourceKind TEXT NOT NULL,sourceId TEXT NOT NULL,proof TEXT NOT NULL,PRIMARY KEY(agentId,sourceKind,sourceId));
CREATE INDEX IF NOT EXISTS operations_target ON operations(agentId,json_extract(packet,'$.erasureIdentity.sourceKind'),json_extract(packet,'$.erasureIdentity.sourceId'));
CREATE TABLE IF NOT EXISTS witnessTransferTargets(agentId TEXT NOT NULL,transferId TEXT NOT NULL,section TEXT NOT NULL,rowIndex INTEGER NOT NULL,sourceKind TEXT NOT NULL,sourceId TEXT NOT NULL,bundleHash TEXT NOT NULL,PRIMARY KEY(agentId,transferId,section,rowIndex));
CREATE INDEX IF NOT EXISTS witness_transfer_target ON witnessTransferTargets(agentId,sourceKind,sourceId,transferId);
CREATE INDEX IF NOT EXISTS witness_transfer_target_hash ON witnessTransferTargets(agentId,bundleHash);
CREATE TABLE IF NOT EXISTS erasures(agentId TEXT NOT NULL, bundleHash TEXT NOT NULL, proof TEXT NOT NULL, PRIMARY KEY(agentId,bundleHash));
CREATE TABLE IF NOT EXISTS erasureRequests(agentId TEXT NOT NULL, requestId TEXT NOT NULL, requestHash TEXT NOT NULL, proof TEXT NOT NULL, PRIMARY KEY(agentId,requestId));
CREATE TABLE IF NOT EXISTS certificateReceipts(agentId TEXT NOT NULL, eventId TEXT NOT NULL, machineId TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(agentId,eventId,machineId));
CREATE TABLE IF NOT EXISTS recoveryLog(agentId TEXT NOT NULL,recoveryId TEXT NOT NULL,requestHash TEXT NOT NULL,response TEXT NOT NULL,PRIMARY KEY(agentId,recoveryId));
CREATE INDEX IF NOT EXISTS operations_bundle ON operations(agentId,json_extract(packet,'$.sourceBundleHash'));
CREATE TABLE IF NOT EXISTS witnessTransferBindings(agentId TEXT NOT NULL,transferId TEXT NOT NULL,section TEXT NOT NULL,rowIndex INTEGER NOT NULL,bundleHash TEXT NOT NULL,PRIMARY KEY(agentId,transferId,section,rowIndex));
CREATE INDEX IF NOT EXISTS witness_transfer_bundle ON witnessTransferBindings(agentId,bundleHash,transferId);
CREATE TABLE IF NOT EXISTS witnessTransferBindingVersion(version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS witnessTransferStale(agentId TEXT NOT NULL,transferId TEXT NOT NULL,erasureHash TEXT NOT NULL,PRIMARY KEY(agentId,transferId));
CREATE TABLE IF NOT EXISTS witnessTransferUsage(agentId TEXT NOT NULL,transferId TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(agentId,transferId));
CREATE TABLE IF NOT EXISTS witnessExportSequence(agentId TEXT PRIMARY KEY,next INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS witnessExportUsage(agentId TEXT NOT NULL,exportId TEXT NOT NULL,bytes INTEGER NOT NULL,PRIMARY KEY(agentId,exportId));
CREATE TABLE IF NOT EXISTS witnessTransferAborts(agentId TEXT NOT NULL,transferId TEXT NOT NULL,signature TEXT NOT NULL,PRIMARY KEY(agentId,transferId));
CREATE TABLE IF NOT EXISTS witnessTransfers(agentId TEXT NOT NULL,transferId TEXT NOT NULL,plan TEXT NOT NULL,PRIMARY KEY(agentId,transferId));
CREATE TABLE IF NOT EXISTS witnessTransferRows(agentId TEXT NOT NULL,transferId TEXT NOT NULL,section TEXT NOT NULL,rowIndex INTEGER NOT NULL,hash TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,transferId,section,rowIndex));
CREATE INDEX IF NOT EXISTS witness_transfer_operation_key ON witnessTransferRows(agentId,transferId,json_extract(body,'$.operation.packet.idempotencyKey')) WHERE section='operation';
CREATE INDEX IF NOT EXISTS witness_transfer_event_key ON witnessTransferRows(agentId,transferId,json_extract(body,'$.operation.packet.eventId')) WHERE section='operation';
CREATE TABLE IF NOT EXISTS witnessExports(agentId TEXT NOT NULL,exportId TEXT NOT NULL,header TEXT NOT NULL,PRIMARY KEY(agentId,exportId));
CREATE TABLE IF NOT EXISTS witnessExportPages(agentId TEXT NOT NULL,exportId TEXT NOT NULL,pageIndex INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,exportId,pageIndex));
CREATE TABLE IF NOT EXISTS bootstrapRequests(agentId TEXT PRIMARY KEY,requestHash TEXT NOT NULL,response TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS backupErasureAttestations(agentId TEXT NOT NULL,requestId TEXT NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,requestId));
CREATE TABLE IF NOT EXISTS memberLossPlanRevisions(agentId TEXT NOT NULL,epoch INTEGER NOT NULL,generation INTEGER NOT NULL,revisionHash TEXT NOT NULL,body TEXT NOT NULL,receipt TEXT NOT NULL,PRIMARY KEY(agentId,epoch,generation));
CREATE TABLE IF NOT EXISTS membershipActivations(agentId TEXT NOT NULL,epoch INTEGER NOT NULL,body TEXT NOT NULL,PRIMARY KEY(agentId,epoch));
`;

export class GraphWitnessService {
  private readonly db: SqliteDatabase;
  /** Only actual, hash-checked SQLite upload rows may replace a private array. */
  private readonly stagedRecoveryRows=new WeakMap<GraphWitnessRecoveryRequest,{count:number;hash:string;index:Map<string,number>;get:(index:number)=>{eventId:string;rewrap:GraphBundleRewrap}}>();
  private readonly fleetErasure:GraphErasureWitnessLedger;
  private readonly unregister: () => void;
  private readonly now: () => number;
  readonly publicKey: string;
  constructor(private readonly options: GraphWitnessServiceOptions) {
    if(options.maxHistoryEntries!==undefined&&(!Number.isSafeInteger(options.maxHistoryEntries)||options.maxHistoryEntries<1||options.maxHistoryEntries>GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES))throw new GraphWitnessError('witness-history-budget-invalid',400);
    if (!opaque(options.witnessId) || !opaque(options.failureDomain) || (options.installedFailureDomains.includes(options.failureDomain)&&!options.ownedHost)) throw new GraphWitnessError('witness-failure-domain-not-independent', 400);
    const key = options.signingPrivateKey instanceof crypto.KeyObject ? options.signingPrivateKey : crypto.createPrivateKey(options.signingPrivateKey);
    if (key.asymmetricKeyType !== 'ed25519') throw new GraphWitnessError('witness-key-invalid', 400);
    this.publicKey = crypto.createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString();
    for (const [agentId, enrollment] of Object.entries(options.enrollments)) {
      if (!opaque(agentId) || !canonicalPublicKey(enrollment.ownerPublicKey, 'ed25519') || enrollment.ownerPublicKey === this.publicKey
        || (enrollment.backupPolicyAuditorPublicKey !== undefined && (!canonicalPublicKey(enrollment.backupPolicyAuditorPublicKey,'ed25519') || enrollment.backupPolicyAuditorPublicKey === this.publicKey || enrollment.backupPolicyAuditorPublicKey === enrollment.ownerPublicKey))
        || typeof enrollment.bearerToken !== 'string' || enrollment.bearerToken.length < 16) throw new GraphWitnessError('witness-enrollment-invalid', 400);
    }
    this.now = options.now ?? Date.now;
    fs.mkdirSync(path.dirname(options.databasePath), { recursive: true, mode: 0o700 });
    this.db = new Database(options.databasePath);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
    this.db.pragma('busy_timeout = 5000'); this.db.pragma('secure_delete = ON'); this.db.exec(SCHEMA);
    if(!(this.db.pragma('table_info(operations)') as {name:string}[]).some(column=>column.name==='packetSignature'))this.db.exec('ALTER TABLE operations ADD COLUMN packetSignature TEXT');
    this.backfillTransferBindings();
    this.fleetErasure=new GraphErasureWitnessLedger(this.db,{witnessId:options.witnessId,signingKey:options.signingPrivateKey,publicKey:this.publicKey,witnessKey:witnessId=>{const key=witnessId===this.options.witnessId?this.publicKey:this.options.historicalWitnessPublicKeys?.[witnessId];if(!key)throw new GraphWitnessError('erasure-witness-unpinned');return key;},ownerKey:agentId=>this.options.enrollments[agentId].ownerPublicKey,history:agentId=>this.activeMembershipHistory(agentId),now:()=>this.timestamp()});
    fs.chmodSync(options.databasePath, 0o600);
    const directory = fs.openSync(path.dirname(options.databasePath), 'r');
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    this.unregister = registerSqliteHandle(() => this.close());
  }
  private backfillTransferBindings():void {
    if(this.db.prepare('SELECT 1 FROM witnessTransferBindingVersion WHERE version=3').get())return;
    // One-time upgrade only. Normal erasure uses the bundle index, never scans
    // unrelated staged JSON history. Each old chunk was already size-bounded.
    this.db.transaction(()=>{
      this.db.prepare("INSERT OR IGNORE INTO witnessTransferBindings(agentId,transferId,section,rowIndex,bundleHash) SELECT agentId,transferId,section,rowIndex,json_extract(body,'$.operation.packet.sourceBundleHash') FROM witnessTransferRows WHERE section='operation' AND body!='null' AND json_type(body,'$.operation.packet.sourceBundleHash')='text' AND (json_type(body,'$.encryptedSourceBundle')='object' OR json_type(body,'$.operation.rewrap')='object')").run();
      this.db.prepare("INSERT OR IGNORE INTO witnessTransferBindings(agentId,transferId,section,rowIndex,bundleHash) SELECT agentId,transferId,section,rowIndex,json_extract(body,'$.rewrap.originalBundleHash') FROM witnessTransferRows WHERE section IN ('revalidation','historical-rewrap') AND body!='null' AND json_type(body,'$.rewrap.originalBundleHash')='text'").run();
      this.db.prepare("INSERT OR IGNORE INTO witnessTransferTargets(agentId,transferId,section,rowIndex,sourceKind,sourceId,bundleHash) SELECT r.agentId,r.transferId,r.section,r.rowIndex,json_extract(r.body,'$.operation.packet.erasureIdentity.sourceKind'),json_extract(r.body,'$.operation.packet.erasureIdentity.sourceId'),b.bundleHash FROM witnessTransferRows r JOIN witnessTransferBindings b ON r.agentId=b.agentId AND r.transferId=b.transferId AND r.section=b.section AND r.rowIndex=b.rowIndex WHERE r.section='operation' AND r.body!='null' AND json_type(r.body,'$.operation.packet.erasureIdentity.sourceId')='text'").run();
      this.db.prepare("INSERT OR IGNORE INTO witnessTransferTargets(agentId,transferId,section,rowIndex,sourceKind,sourceId,bundleHash) SELECT b.agentId,b.transferId,b.section,b.rowIndex,t.sourceKind,t.sourceId,b.bundleHash FROM witnessTransferBindings b JOIN witnessTransferTargets t ON b.agentId=t.agentId AND b.transferId=t.transferId AND b.bundleHash=t.bundleHash AND t.section='operation' WHERE b.section IN ('revalidation','historical-rewrap')").run();
      this.db.prepare('INSERT INTO witnessTransferBindingVersion(version) VALUES(3)').run();
    }).immediate();
  }
  private stagedBundleHash(section:GraphBootstrapSection,value:unknown):string|null {
    const row=value as {operation?:GraphWitnessOperation;encryptedSourceBundle?:GraphEncryptedBundle|null;rewrap?:GraphBundleRewrap|null};
    const candidate=section==='operation'&&(row?.encryptedSourceBundle||row?.operation?.rewrap)?row?.operation?.packet?.sourceBundleHash:(section==='revalidation'||section==='historical-rewrap')?row?.rewrap?.originalBundleHash:null;
    return hash(candidate)?candidate:null;
  }
  private targetFence(agentId:string,target:GraphErasureIdentity):GraphWitnessErasure|null {
    if(!validateGraphErasureIdentity(target))throw new GraphWitnessError('erasure-target-invalid',400);
    const row=this.db.prepare('SELECT proof FROM targetErasures WHERE agentId=? AND sourceKind=? AND sourceId=?').get(agentId,target.sourceKind,target.sourceId) as {proof:string}|undefined;if(row)return JSON.parse(row.proof);if(this.db.prepare('SELECT 1 FROM localTargetErasures WHERE agentId=? AND sourceKind=? AND sourceId=?').get(agentId,target.sourceKind,target.sourceId))throw new GraphWitnessError('source-locally-erased');return null;
  }
  private stagedIdentity(agentId:string,transferId:string,section:GraphBootstrapSection,value:unknown,bundleBinding:string|null):GraphErasureIdentity|null {
    if(!bundleBinding)return null;
    if(section==='operation'){const op=(value as GraphWitnessBootstrapRequest['operations'][number]).operation;return op.packet.erasureIdentity;}
    const wrap=(value as {rewrap:GraphBundleRewrap}).rewrap;
    const row=this.db.prepare("SELECT body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='operation' AND json_extract(body,'$.operation.packet.eventId')=?").get(agentId,transferId,wrap.eventId) as {body:string}|undefined;
    const target=row?(JSON.parse(row.body) as GraphWitnessBootstrapRequest['operations'][number]).operation.packet.erasureIdentity:null;
    if(!target||!validateGraphErasureIdentity(target))throw new GraphWitnessError('staged-erasure-identity-missing',403);return target;
  }
  private purgeStagedTarget(agentId:string,target:GraphErasureIdentity,proof:GraphWitnessErasure):void {purgeGraphWitnessStagedTarget(this.db,agentId,target,proof);}
  private enforceTargetErasure(agentId:string,proof:GraphWitnessErasure):void {enforceGraphWitnessTargetErasure(this.db,agentId,proof);}
  private purgeStagedBundle(agentId:string,bundleHash:string,proof:GraphWitnessErasure):void {purgeGraphWitnessStagedBundle(this.db,agentId,bundleHash,proof);}
  private ensureWitnessedTip(agentId:string):{sequence:number;coreHash:string|null} {
    const existing=this.db.prepare('SELECT sequence,coreHash FROM witnessedTips WHERE agentId=?').get(agentId) as {sequence:number;coreHash:string|null}|undefined;
    if(existing){
      if(existing.sequence){const tail=this.db.prepare("SELECT json_extract(packet,'$.coreHash') AS coreHash FROM operations WHERE agentId=? AND json_extract(packet,'$.sourceSequence')=?").get(agentId,existing.sequence) as {coreHash:string}|undefined;if(!tail||tail.coreHash!==existing.coreHash)throw new GraphWitnessError('witness-prefix-evidence-incomplete');}
      return existing;
    }
    let sequence=0,coreHash:string|null=null;
    const rows=this.db.prepare("SELECT json_extract(packet,'$.sourceSequence') AS sequence,json_extract(packet,'$.coreHash') AS coreHash,json_extract(packet,'$.predecessorHash') AS predecessorHash FROM operations WHERE agentId=? ORDER BY json_extract(packet,'$.sourceSequence')").all(agentId) as {sequence:number;coreHash:string;predecessorHash:string|null}[];
    for(const row of rows){if(row.sequence!==sequence+1)throw new GraphWitnessError('witness-prefix-missing');if(row.predecessorHash!==coreHash)throw new GraphWitnessError('witness-prefix-mismatch');sequence=row.sequence;coreHash=row.coreHash;}
    this.db.prepare('INSERT INTO witnessedTips(agentId,sequence,coreHash) VALUES(?,?,?)').run(agentId,sequence,coreHash);return {sequence,coreHash};
  }
  close(): void { this.unregister?.(); if (this.db.open) this.db.close(); }
  health() { return { witnessId: this.options.witnessId, failureDomain: this.options.failureDomain, publicKey: this.publicKey, durability: 'sqlite-wal-full' as const }; }
  authenticate(agentId: string, token: string): boolean {
    const expected = this.options.enrollments[agentId]?.bearerToken;
    const digest = (x: string) => crypto.createHash('sha256').update(x).digest();
    return !!expected && !!token && crypto.timingSafeEqual(digest(expected), digest(token));
  }
  private signed<T extends object>(domain: string, payload: T): T & { signature: string } {
    return { ...payload, signature: signGraphRecord(domain, payload, this.options.signingPrivateKey) };
  }
  private timestamp(): string { return new Date(this.now()).toISOString(); }
  private membership(agentId: string, epoch?: number): GraphMembershipEpoch {
    const row = (epoch === undefined
      ? this.db.prepare('SELECT body FROM memberships WHERE agentId=? ORDER BY epoch DESC LIMIT 1').get(agentId)
      : this.db.prepare('SELECT body FROM memberships WHERE agentId=? AND epoch=?').get(agentId, epoch)) as { body: string } | undefined;
    if (!row) throw new GraphWitnessError('membership-unknown', 404);
    return JSON.parse(row.body) as GraphMembershipEpoch;
  }
  membershipProof(agentId: string, epoch: number): GraphMembershipEpoch { return this.membership(agentId, epoch); }
  activeMembershipProof(agentId:string):GraphMembershipEpoch{return structuredClone(this.membership(agentId));}
  membershipActivation(agentId:string,epoch:number):GraphMembershipActivationCertificate|null {
    const membership=this.membership(agentId,epoch);if(epoch===1)return null;
    const row=this.db.prepare('SELECT body FROM membershipActivations WHERE agentId=? AND epoch=?').get(agentId,epoch) as {body:string}|undefined;
    if(!row)throw new GraphWitnessError('membership-activation-evidence-missing');
    const value=JSON.parse(row.body) as GraphMembershipActivationCertificate;
    if(canonicalHash(value.newMembership)!==canonicalHash(membership))throw new GraphWitnessError('membership-activation-evidence-invalid');
    return value;
  }

  registerMembership(epoch: GraphMembershipEpoch): { membershipHash: string } { return this.installMembership(epoch, false); }
  private installMembership(epoch: GraphMembershipEpoch, recoveryAuthorized: boolean): { membershipHash: string } {
    const owner = this.options.enrollments[epoch?.agentId]?.ownerPublicKey;
    if (!owner || !verifyMembershipEpoch(epoch, owner) || epoch.witnessId !== this.options.witnessId
      || epoch.failureDomain !== this.options.failureDomain || epoch.members.some((m) => m.machineId === epoch.witnessId || m.signingPublicKey === this.publicKey || m.signingPublicKey === this.options.enrollments[epoch.agentId]?.backupPolicyAuditorPublicKey)) throw new GraphWitnessError('membership-proof-invalid', 403);
    const profile=epoch.custodyProfile;
    if(this.options.ownedHost){if(!profile||profile.mode!=='owned-machine'||profile.witnessPublicKey!==this.publicKey||profile.hostMachineId!==this.options.ownedHost.machineId||profile.hostSigningPublicKey!==this.options.ownedHost.signingPublicKey)throw new GraphWitnessError('owned-custody-profile-required',403);}
    else if(profile&&(profile.mode!=='external'||profile.witnessPublicKey!==this.publicKey))throw new GraphWitnessError('custody-profile-host-mismatch',403);
    const membershipHash = canonicalHash(epoch);
    this.db.transaction(() => {
      const current = this.db.prepare('SELECT epoch FROM agents WHERE agentId=?').get(epoch.agentId) as { epoch: number } | undefined;
      if (!current) {
        if (epoch.epoch !== 1 || epoch.previousMembershipHash !== null) throw new GraphWitnessError('membership-genesis-invalid');
      } else {
        const prior = this.membership(epoch.agentId, current.epoch);
        if (epoch.epoch === current.epoch && canonicalHash(prior) === membershipHash) return;
        if (epoch.epoch !== current.epoch + 1 || epoch.previousMembershipHash !== canonicalHash(prior)) throw new GraphWitnessError('membership-transition-invalid');
        // A final decision is not proof that new members hold the history.
        // Every roster transition uses the owner-bound full-state transfer
        // ceremony, including transitions with no pending operations.
        if (!recoveryAuthorized) throw new GraphWitnessError('membership-recovery-required');
      }
      this.db.prepare('INSERT INTO memberships(agentId,epoch,hash,body) VALUES(?,?,?,?)').run(epoch.agentId, epoch.epoch, membershipHash, canonicalJson(epoch));
      this.db.prepare('INSERT INTO agents(agentId,epoch) VALUES(?,?) ON CONFLICT(agentId) DO UPDATE SET epoch=excluded.epoch').run(epoch.agentId, epoch.epoch);
    }).immediate();
    return { membershipHash };
  }
  private admission(agentId: string, lease: GraphWitnessLease, original: LeaseRecord): GraphMembershipEpoch {
    const membership = this.membership(agentId);
    if (lease.agentId !== agentId || lease.membershipEpoch !== membership.epoch || !verifyFencedLeaseBridge(lease, original, membership)
      || !verifyWitnessLease(lease, membership, this.now())) throw new GraphWitnessError('lease-proof-invalid', 403);
    const fence = this.db.prepare('SELECT leaseEpoch,leaseHash FROM agents WHERE agentId=?').get(agentId) as { leaseEpoch: number; leaseHash: string | null };
    if (lease.leaseEpoch < fence.leaseEpoch) throw new GraphWitnessError('writer-fenced');
    if (lease.leaseEpoch === fence.leaseEpoch && fence.leaseHash && (JSON.parse(fence.leaseHash) as GraphWitnessLease).writerId !== lease.writerId) throw new GraphWitnessError('writer-fenced');
    this.db.prepare('UPDATE agents SET leaseEpoch=?,leaseHash=? WHERE agentId=?').run(lease.leaseEpoch, canonicalJson(lease), agentId);
    return membership;
  }
  holdOwnedProfile(agentId:string,intent:GraphCustodyHoldIntent):GraphCustodyAllocationHold{
    const owner=this.options.enrollments[agentId]?.ownerPublicKey,membership=this.membership(agentId);if(!owner||!verifyGraphCustodyHoldIntent(intent,owner)||intent.agentId!==agentId||canonicalHash(intent.previousMembership)!==canonicalHash(membership)||membership.witnessId!==this.options.witnessId||membership.custodyProfile?.witnessPublicKey!==this.publicKey)throw new GraphWitnessError('custody-allocation-hold-invalid',403);
    return this.db.transaction(()=>{const membershipHash=canonicalHash(membership),prior=this.db.prepare('SELECT intentHash,proof FROM ownedAllocationHolds WHERE agentId=? AND membershipHash=?').get(agentId,membershipHash) as {intentHash:string;proof:string}|undefined;if(prior){const proof=JSON.parse(prior.proof) as GraphCustodyAllocationHold;if(prior.intentHash!==canonicalHash(intent)||!verifyGraphCustodyAllocationHold(proof,intent,owner))throw new GraphWitnessError('custody-allocation-hold-conflict');return proof;}const proof=this.signed(GRAPH_CUSTODY_ALLOCATION_HOLD_DOMAIN,{v:1 as const,agentId,membershipHash,intentHash:canonicalHash(intent),witnessId:this.options.witnessId,heldAt:this.timestamp()});this.db.prepare('INSERT INTO ownedAllocationHolds(agentId,membershipHash,intentHash,intent,proof) VALUES(?,?,?,?,?)').run(agentId,membershipHash,canonicalHash(intent),canonicalJson(intent),canonicalJson(proof));return proof;}).immediate();
  }
  private assertPositiveMembershipActive(agentId:string,membership:GraphMembershipEpoch,recoveryRevision?:GraphMemberLossPlanRevision):void{
    const revision=this.db.prepare('SELECT epoch,revisionHash FROM memberLossPlanRevisions WHERE agentId=? AND epoch>? ORDER BY epoch DESC,generation DESC LIMIT 1').get(agentId,membership.epoch) as {epoch:number;revisionHash:string}|undefined;
    if(revision&&(!recoveryRevision||revision.epoch!==membership.epoch+1||canonicalHash(recoveryRevision)!==revision.revisionHash))throw new GraphWitnessError('member-loss-plan-revision-held');
    const maintenance=this.db.prepare('SELECT epoch,activationHash,body FROM memberLossMaintenance WHERE agentId=?').get(agentId) as {epoch:number;activationHash:string;body:string}|undefined;
    if(maintenance){const row=this.db.prepare('SELECT body FROM memberLossSettlements WHERE agentId=? AND epoch=?').get(agentId,maintenance.epoch) as {body:string}|undefined;if(!row)throw new GraphWitnessError('member-loss-settlement-held');const activation=JSON.parse(maintenance.body) as GraphMembershipActivationCertificate,settled=JSON.parse(row.body) as {proof:GraphMemberLossSettlementProof;pins:GraphMemberLossActivationPin[]};if(canonicalHash(activation)!==maintenance.activationHash||!exactFields(settled,['proof','pins'])||!verifyMembershipActivation(activation,this.options.enrollments[agentId].ownerPublicKey,this.publicKey)||!verifyGraphMemberLossSettlement(settled.proof,activation,this.publicKey,settled.pins))throw new GraphWitnessError('member-loss-settlement-evidence-invalid');} 
    if(this.db.prepare('SELECT 1 FROM ownedRetirements WHERE agentId=? AND membershipHash=?').get(agentId,canonicalHash(membership)))throw new GraphWitnessError('custody-profile-retired');
  }
  retireOwnedProfile(agentId:string,request:{stage:GraphCustodyProfileStage;holds:GraphCustodyProfileHold[];stateTransferReceipts:import('./GraphWitnessTypes.js').GraphMembershipTransferReceipt[];lease:GraphWitnessLease;originalLease:LeaseRecord}):GraphCustodyRetirementProof{
    if(!exactFields(request,['stage','holds','stateTransferReceipts','lease','originalLease']))throw new GraphWitnessError('custody-retirement-request-invalid',400);
    this.observeLease(agentId,request.lease,request.originalLease);
    return this.db.transaction(()=>{
      const membership=this.admission(agentId,request.lease,request.originalLease),owner=this.options.enrollments[agentId]?.ownerPublicKey,{stage,holds}=request;
      if(!owner||membership.custodyProfile?.mode!=='owned-machine'||canonicalHash(membership)!==canonicalHash(stage.previousMembership)||!verifyGraphCustodyTransitionHolds(stage,holds,owner)||stage.authorization.fenceEpoch!==request.lease.leaseEpoch)throw new GraphWitnessError('custody-retirement-authority-invalid',403);
      if(!verifyGraphNativeTailBarrier(stage.closedTails,membership,request.lease))throw new GraphWitnessError('custody-retirement-tail-unclosed',403);
      const manifest=this.recoveryManifest(agentId),entries=new Map(manifest.entries.map(entry=>[entry.eventId,entry]));for(const closure of stage.closedTails)for(const tail of closure.entries){const entry=entries.get(tail.eventId);if(!entry||entry.operationHash!==tail.packetHash||entry.coreHash!==tail.coreHash||entry.sourceSequence!==tail.sourceSequence)throw new GraphWitnessError('custody-retirement-tail-omitted',403);}
      const stageHash=canonicalHash(stage),prior=this.db.prepare('SELECT body FROM ownedRetirements WHERE agentId=? AND membershipHash=? AND stageHash=?').get(agentId,canonicalHash(membership),stageHash) as {body:string}|undefined;
      if(prior){const proof=JSON.parse(prior.body) as GraphCustodyRetirementProof;if(!verifyGraphCustodyRetirement(proof,stage,holds,owner))throw new GraphWitnessError('custody-retirement-conflict');return proof;}
      const last=this.db.prepare('SELECT stageHash,revision,stage FROM ownedRetirements WHERE agentId=? AND membershipHash=? ORDER BY revision DESC LIMIT 1').get(agentId,canonicalHash(membership)) as {stageHash:string;revision:number;stage:string}|undefined;
      if(last&&(stage.revision!==last.revision+1||stage.supersedesHash!==last.stageHash||canonicalHash(stage.holdIntent)!==canonicalHash((JSON.parse(last.stage) as GraphCustodyProfileStage).holdIntent)))throw new GraphWitnessError('custody-retirement-revision-conflict');
      if(canonicalHash(this.recoveryManifest(agentId))!==stage.authorization.sourceManifestHash||!Array.isArray(request.stateTransferReceipts)||request.stateTransferReceipts.length!==stage.newMembership.members.length||new Set(request.stateTransferReceipts.map(row=>row.machineId)).size!==stage.newMembership.members.length||request.stateTransferReceipts.some(receipt=>!verifyMembershipTransferReceipt(receipt,stage.authorization,stage.newMembership)))throw new GraphWitnessError('custody-retirement-state-transfer-required',403);
      const proof=this.signed(GRAPH_CUSTODY_RETIREMENT_DOMAIN,{v:1 as const,agentId,previousMembershipHash:canonicalHash(membership),newMembershipHash:canonicalHash(stage.newMembership),stageHash,holdsHash:graphCustodyHoldsHash(holds),lease:request.lease,originalLease:request.originalLease,witnessId:this.options.witnessId,retiredAt:this.timestamp()});
      if(!verifyGraphCustodyRetirement(proof,stage,holds,owner))throw new GraphWitnessError('custody-retirement-proof-invalid');
      this.db.prepare('INSERT INTO ownedRetirements(agentId,membershipHash,stageHash,revision,stage,body) VALUES(?,?,?,?,?,?)').run(agentId,canonicalHash(membership),stageHash,stage.revision,canonicalJson(stage),canonicalJson(proof));return proof;
    }).immediate();
  }
  /** A valid higher fencing epoch is durable even if the following operation is
   * refused. Invalid payloads must not resurrect a previously fenced writer. */
  observeLease(agentId: string, lease: GraphWitnessLease, original: LeaseRecord): { membershipHash: string; leaseEpoch: number } {
    return this.db.transaction(() => {
      const membership = this.admission(agentId, lease, original);
      return { membershipHash: canonicalHash(membership), leaseEpoch: lease.leaseEpoch };
    }).immediate();
  }
  /** Routine current-writer actuation under the SAME installed membership.
   * No owner reapproval: the original accepted owner/source action stays intact. */
  adoptPending(agentId: string, request: GraphWitnessAdoptionRequest): GraphAdoptionCertificate[] {
    this.observeLease(agentId, request.currentLease, request.originalCurrentLease);
    return this.db.transaction(() => {
      const membership = this.admission(agentId, request.currentLease, request.originalCurrentLease);
      if (!Array.isArray(request.revalidations) || request.revalidations.length > 512) throw new GraphWitnessError('revalidation-set-invalid', 400);
      const seen = new Set<string>();
      return request.revalidations.map(({ proof, rewrap }) => {
        if (seen.has(proof.idempotencyKey)) throw new GraphWitnessError('revalidation-key-duplicate', 400);
        seen.add(proof.idempotencyKey);
        return this.adoptOne(agentId, membership, request.currentLease, request.originalCurrentLease, proof, rewrap, null);
      });
    }).immediate();
  }
  private adoptOne(agentId: string, membership: GraphMembershipEpoch, currentLease: GraphWitnessLease, originalCurrentLease: LeaseRecord,
    proof: GraphPendingRevalidation, rewrap: GraphBundleRewrap | null, ownerAuthorization: GraphRecoveryAuthorization | null): GraphAdoptionCertificate {
    const operation = this.operation(agentId, proof.idempotencyKey);
    if (!operation) throw new GraphWitnessError('unwitnessed-source-requires-review', 404);
    if (operation.certificate || operation.cancellationCertificate) throw new GraphWitnessError('certified-operation-must-redistribute');
    if (!verifyPendingRevalidation(proof, operation.packet, membership, currentLease) || proof.rewrapHash !== canonicalHash(rewrap)) throw new GraphWitnessError('pending-revalidation-invalid', 403);
    if ((operation.state === 'canceled' || operation.state === 'erased' || operation.adoption?.disposition === 'refused') && proof.decision !== 'refuse') throw new GraphWitnessError('terminal-decision-dominates');
    if (operation.adoption && canonicalHash(operation.adoption.revalidation) === canonicalHash(proof)
      && canonicalHash(operation.adoption.currentLease) === canonicalHash(currentLease)
      && operation.adoption.rewrapHash === canonicalHash(rewrap)
      && canonicalHash(operation.adoption.ownerAuthorization) === canonicalHash(ownerAuthorization)) return operation.adoption;
    if (proof.decision === 'adopt') {
      this.assertPositiveMembershipActive(agentId,membership);const bundle = this.recover(agentId, proof.idempotencyKey).encryptedSourceBundle;
      if (!rewrap || !bundle || rewrap.originalBundleHash !== operation.packet.sourceBundleHash || rewrap.eventId !== operation.packet.eventId
        || rewrap.writerId !== currentLease.writerId || !verifyBundleRewrap(rewrap, bundle, membership)) throw new GraphWitnessError('pending-rewrap-invalid', 403);
    } else if (rewrap) {
      const bundle = this.recover(agentId, proof.idempotencyKey).encryptedSourceBundle;
      if (!bundle || !verifyBundleRewrap(rewrap, bundle, membership)) throw new GraphWitnessError('pending-rewrap-invalid', 403);
    }
    const chain: GraphMembershipEpoch[] = [];
    for (let epoch = operation.packet.membershipEpoch; epoch <= membership.epoch; epoch++) chain.push(this.membership(agentId, epoch));
    const activationRow = this.db.prepare('SELECT body FROM membershipActivations WHERE agentId=? AND epoch=?').get(agentId, membership.epoch) as { body: string } | undefined;
    const activation = activationRow ? JSON.parse(activationRow.body) as GraphMembershipActivationCertificate : null;
    const adoption = this.signed(D.adoption, { v: 1 as const, agentId, idempotencyKey: operation.packet.idempotencyKey,
      operationHash: canonicalHash(operation.packet), originalMembershipHash: canonicalHash(chain[0]), newMembership: membership,
      currentLease, originalCurrentLease, ownerAuthorization, revalidation: proof, rewrapHash:canonicalHash(rewrap), membershipChain: chain,
      disposition: proof.decision === 'adopt' ? 'adopted' as const : 'refused' as const,
      witnessId: this.options.witnessId, adoptedAt: this.timestamp(), ...(activation ? { activation } : {}),...(operation.erasedControlProof&&!operation.prepareProof&&operation.erasure&&proof.decision==='refuse'&&proof.reason==='erased-source'&&ownerAuthorization===null?{erasedControlHash:canonicalHash(operation.erasedControlProof)}:{}) });
    if (!verifyAdoptionCertificate(adoption, operation.packet, chain[0], this.options.enrollments[agentId].ownerPublicKey, this.publicKey)) throw new GraphWitnessError('adoption-proof-invalid', 403);
    if (operation.adoption && canonicalHash(operation.adoption) === canonicalHash(adoption)) return operation.adoption;
    if(proof.decision==='refuse'&&operation.erasure&&!operation.cancellation){
      this.db.prepare('UPDATE operations SET adoption=?,state=? WHERE agentId=? AND idempotencyKey=?').run(canonicalJson(adoption),'erased',agentId,operation.packet.idempotencyKey);
    } else if (proof.decision === 'refuse') {
      const cancellation = this.signed(D.cancellation, { v: 1 as const, agentId, eventId: operation.packet.eventId,
        operationHash: canonicalHash(operation.packet), membershipEpoch: membership.epoch, leaseEpoch: currentLease.leaseEpoch,
        witnessId: this.options.witnessId, canceledAt: this.timestamp() });
      this.db.prepare('UPDATE operations SET adoption=?,state=?,cancellation=? WHERE agentId=? AND idempotencyKey=?')
        .run(canonicalJson(adoption), 'canceled', canonicalJson(cancellation), agentId, operation.packet.idempotencyKey);
    } else this.db.prepare('UPDATE operations SET adoption=? WHERE agentId=? AND idempotencyKey=?').run(canonicalJson(adoption), agentId, operation.packet.idempotencyKey);
    this.db.prepare('INSERT INTO rewraps(agentId,eventId,body) VALUES(?,?,?) ON CONFLICT(agentId,eventId) DO UPDATE SET body=excluded.body').run(agentId,operation.packet.eventId,rewrap?canonicalJson(rewrap):null);
    return adoption;
  }
  inventory(agentId: string, challenge: string): import('./GraphWitnessTypes.js').GraphWitnessInventoryCheckpoint {
    if (!/^[A-Za-z0-9_-]{32,128}$/.test(challenge)) throw new GraphWitnessError('inventory-challenge-invalid', 400);
    return this.db.transaction(() => {
      const membership = this.membership(agentId);
      this.ensureWitnessedTip(agentId);
      const fence = this.db.prepare('SELECT leaseEpoch FROM agents WHERE agentId=?').get(agentId) as {leaseEpoch:number};
      const manifest = this.recoveryManifest(agentId);
      const rows = this.db.prepare('SELECT proof FROM erasureRequests WHERE agentId=? ORDER BY requestId').all(agentId) as {proof:string}[];
      const erasures = rows.map(row => JSON.parse(row.proof) as GraphWitnessErasure).sort((a,b) => a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0);
      return this.signed('graph-inventory-v1', {v:1 as const, agentId, witnessId:this.options.witnessId, challenge,
        activeMembershipHash:canonicalHash(membership), membershipEpoch:membership.epoch, fenceEpoch:fence.leaseEpoch,
        manifest, manifestHash:canonicalHash(manifest), erasures, erasureInventoryHash:canonicalHash(erasures), issuedAt:this.timestamp()});
    })();
  }
  exportInventory(agentId:string,challenge:string):Record<string,unknown> {
    return this.db.transaction(()=>{
      const full=this.inventory(agentId,challenge);
      const sequence=(this.db.prepare('SELECT next FROM witnessExportSequence WHERE agentId=?').get(agentId) as {next:number}|undefined)?.next??0;
      const exportId=`snapshot-${sequence%8}`;this.db.prepare('INSERT INTO witnessExportSequence(agentId,next) VALUES(?,?) ON CONFLICT(agentId) DO UPDATE SET next=excluded.next').run(agentId,sequence+1);
      this.db.prepare("UPDATE witnessExportPages SET body='null' WHERE agentId=? AND exportId=?").run(agentId,exportId);
      this.db.prepare('INSERT INTO witnessExportUsage(agentId,exportId,bytes) VALUES(?,?,0) ON CONFLICT(agentId,exportId) DO UPDATE SET bytes=0').run(agentId,exportId);
      const existingBytes=(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM witnessExportUsage').get() as {n:number}).n;let exportBytes=0;
      const backupAttestations=(this.db.prepare('SELECT body FROM backupErasureAttestations WHERE agentId=? ORDER BY requestId').all(agentId) as {body:string}[]).map(row=>JSON.parse(row.body) as import('./GraphWitnessTypes.js').GraphBackupErasureAttestation);
      const pageCount=Math.max(1,Math.ceil(Math.max(full.manifest.entries.length,full.erasures.length,backupAttestations.length)/16));
      const checkpoint={...full,manifest:{...full.manifest,entries:[]},erasures:[]};
      const header=this.signed('graph-inventory-export-v1',{v:1,exportId,checkpoint,pageCount,entryCount:full.manifest.entries.length,erasureCount:full.erasures.length,backupAttestationCount:backupAttestations.length,backupAttestationsHash:canonicalHash(backupAttestations)});
      this.db.prepare('INSERT INTO witnessExports(agentId,exportId,header) VALUES(?,?,?) ON CONFLICT(agentId,exportId) DO UPDATE SET header=excluded.header').run(agentId,exportId,canonicalJson(header));
      for(let index=0;index<pageCount;index++){
        const page=this.signed('graph-inventory-page-v1',{v:1,exportId,index,headerHash:canonicalHash(header),entries:full.manifest.entries.slice(index*16,index*16+16),erasures:full.erasures.slice(index*16,index*16+16),backupAttestations:backupAttestations.slice(index*16,index*16+16)});
        const body=canonicalJson(page);exportBytes+=Buffer.byteLength(body);if(existingBytes+exportBytes>4*1024*1024*1024)throw new GraphWitnessError('inventory-snapshot-capacity-reached',413);
        this.db.prepare('INSERT INTO witnessExportPages(agentId,exportId,pageIndex,body) VALUES(?,?,?,?) ON CONFLICT(agentId,exportId,pageIndex) DO UPDATE SET body=excluded.body').run(agentId,exportId,index,body);
      }
      this.db.prepare('UPDATE witnessExportUsage SET bytes=? WHERE agentId=? AND exportId=?').run(exportBytes,agentId,exportId);
      return header;
    }).immediate();
  }
  inventoryPage(agentId:string,exportId:string,index:number):unknown {
    if(!Number.isSafeInteger(index)||index<0)throw new GraphWitnessError('inventory-page-invalid',400);
    const row=this.db.prepare('SELECT body FROM witnessExportPages WHERE agentId=? AND exportId=? AND pageIndex=?').get(agentId,exportId,index) as {body:string}|undefined;
    if(!row)throw new GraphWitnessError('inventory-snapshot-unavailable',404);return JSON.parse(row.body);
  }
  recoveryManifest(agentId: string): GraphRecoverySourceManifest {
    const membership = this.membership(agentId);
    const rows = this.db.prepare('SELECT idempotencyKey FROM operations WHERE agentId=?').all(agentId) as Array<{ idempotencyKey: string }>;
    const operations = rows.map((r) => this.operation(agentId, r.idempotencyKey)!).sort((a, b) => a.packet.sourceSequence - b.packet.sourceSequence || a.packet.eventId.localeCompare(b.packet.eventId));
    let highestCertifiedSequence = 0; let highestCertifiedCoreHash: string | null = null;
    let highestAcknowledgedSequence = 0; let highestAcknowledgedCoreHash: string | null = null;
    for (const operation of operations) {
      const certificate = operation.certificate ?? operation.cancellationCertificate;
      if (!certificate || operation.packet.sourceSequence !== highestCertifiedSequence + 1 || operation.packet.predecessorHash !== highestCertifiedCoreHash) continue;
      highestCertifiedSequence = operation.packet.sourceSequence; highestCertifiedCoreHash = operation.packet.coreHash;
      const effectiveMembership = certificate.adoption?.newMembership ?? this.membership(agentId, operation.packet.membershipEpoch);
      if (operation.packet.sourceSequence === highestAcknowledgedSequence + 1 && operation.packet.predecessorHash === highestAcknowledgedCoreHash
        && operation.certificatePersistenceReceipts.length === effectiveMembership.members.length) {
        highestAcknowledgedSequence = operation.packet.sourceSequence; highestAcknowledgedCoreHash = operation.packet.coreHash;
      }
    }
    return { v: 1, agentId, membershipHash: canonicalHash(membership), highestCertifiedSequence, highestCertifiedCoreHash,
      highestAcknowledgedSequence, highestAcknowledgedCoreHash, entries: operations.map(op=>this.recoveryEntry(op)) };
  }
  private recoveryEntry(op:GraphWitnessOperation):GraphRecoverySourceManifest['entries'][number]{return { eventId: op.packet.eventId,
        idempotencyKey: op.packet.idempotencyKey, sourceSequence: op.packet.sourceSequence, operationHash: canonicalHash(op.packet),
        coreHash: op.packet.coreHash, authorizationReceiptHash: op.packet.authorizationReceiptHash, sourceBundleHash: op.packet.sourceBundleHash,
        prepareProofHash: op.prepareProof?canonicalHash(op.prepareProof):null,erasedControlProofHash:op.erasedControlProof?canonicalHash(op.erasedControlProof):null, certificateHash: op.certificate ? canonicalHash(op.certificate) : null,
        cancellationHash: op.cancellation ? canonicalHash(op.cancellation) : null,
        cancellationCertificateHash: op.cancellationCertificate ? canonicalHash(op.cancellationCertificate) : null,
        adoptionHash: op.adoption ? canonicalHash(op.adoption) : null, rewrapHash: op.rewrap ? canonicalHash(op.rewrap) : null,
        erasureHash: op.erasure ? canonicalHash(op.erasure) : null, certificatePersistenceHash: canonicalHash(op.certificatePersistenceReceipts) };}
  /** Serializes a negative-only continuation against ACT commit in the SAME
   * SQLite writer transaction. A committed ACT always wins this race. No row
   * here grants Source custody, membership activation or operation acceptance. */
  registerMemberLossPlanRevision(agentId:string,revision:GraphMemberLossPlanRevision,loss:GraphMemberLossActivationAuthority):{kind:'revision';receipt:GraphMemberLossRevisionReceipt}|{kind:'activation';activation:GraphMembershipActivationCertificate}{
    const owner=this.options.enrollments[agentId]?.ownerPublicKey,plan=revision.plan,context={ownerPublicKey:owner!,previousPublicationHash:loss.consent.payload.previousPublicationHash,previousMembership:plan.previousMembership,newMembership:plan.newMembership,nativeIdentities:loss.nativeIdentities};
    if(!owner||agentId!==revision.agentId||plan.newMembership.witnessId!==this.options.witnessId||plan.newMembership.custodyProfile?.witnessPublicKey!==this.publicKey||!verifyGraphMemberLossPlanRevision(revision,loss.consent,canonicalHash(loss.intent),context)||!verifyGraphMemberLossActivationAuthority(loss,{agentId,previousMembership:plan.previousMembership,newMembership:plan.newMembership,ownerAuthorization:plan.authorization,activatedAt:this.timestamp()},owner)||canonicalHash(loss.currentLease)!==canonicalHash(plan.currentLease)||canonicalHash(loss.originalLease)!==canonicalHash(plan.originalCurrentLease))throw new GraphWitnessError('member-loss-plan-revision-invalid',403);
    return this.db.transaction(()=>{
      const activated=this.db.prepare('SELECT body FROM membershipActivations WHERE agentId=? AND epoch=?').get(agentId,plan.newMembership.epoch) as {body:string}|undefined;
      if(activated){const activation=JSON.parse(activated.body) as GraphMembershipActivationCertificate;if(!activation.memberLoss||canonicalHash(activation.memberLoss.consent)!==revision.consentHash||!verifyMembershipActivation(activation,owner,this.publicKey))throw new GraphWitnessError('member-loss-plan-activation-conflict');return {kind:'activation' as const,activation};}
      const current=this.db.prepare('SELECT body FROM memberships WHERE agentId=? ORDER BY epoch DESC LIMIT 1').get(agentId) as {body:string}|undefined;if(current&&canonicalHash(JSON.parse(current.body))!==canonicalHash(plan.previousMembership))throw new GraphWitnessError('member-loss-plan-membership-conflict');
      const prior=this.db.prepare('SELECT generation,body,receipt FROM memberLossPlanRevisions WHERE agentId=? AND epoch=? ORDER BY generation DESC LIMIT 1').get(agentId,plan.newMembership.epoch) as {generation:number;body:string;receipt:string}|undefined;
      if(prior){const old=JSON.parse(prior.body) as GraphMemberLossPlanRevision;if(canonicalHash(old)===canonicalHash(revision))return {kind:'revision' as const,receipt:JSON.parse(prior.receipt) as GraphMemberLossRevisionReceipt};if(!verifyGraphMemberLossPlanRevisionSuccessor(old,revision,loss.consent,canonicalHash(loss.intent),context))throw new GraphWitnessError('member-loss-plan-revision-chain-conflict');}
      else if(revision.generation!==1||revision.supersedesHash!==null)throw new GraphWitnessError('member-loss-plan-revision-gap');
      const body={v:1 as const,kind:'owned-member-loss-revision-persisted' as const,agentId,membershipHash:canonicalHash(plan.newMembership),consentHash:revision.consentHash,revisionHash:canonicalHash(revision),generation:revision.generation,witnessId:this.options.witnessId,persistedAt:this.timestamp()},receipt={...body,signature:signGraphRecord(GRAPH_MEMBER_LOSS_REVISION_RECEIPT_DOMAIN,body,this.options.signingPrivateKey)};
      this.db.prepare('INSERT INTO memberLossPlanRevisions(agentId,epoch,generation,revisionHash,body,receipt) VALUES(?,?,?,?,?,?)').run(agentId,plan.newMembership.epoch,revision.generation,canonicalHash(revision),canonicalJson(revision),canonicalJson(receipt));
      return {kind:'revision' as const,receipt};
    }).immediate();
  }
  /** Decommission/replacement is an owner-signed ceremony. Activation waits for
   * every NEW installed member's verified full-state transfer receipt. */
  recoverPending(agentId: string, request: GraphWitnessRecoveryRequest): { activation: GraphMembershipActivationCertificate; adoptions: GraphAdoptionCertificate[] } {
    if(!exactFields(request,['newMembership','authorization','currentLease','originalCurrentLease','revalidations','stateTransferReceipts','sourceManifest',...(request.historicalRewraps===undefined?[]:['historicalRewraps']),...(request.ownedTransition===undefined?[]:['ownedTransition']),...(request.memberLoss===undefined?[]:['memberLoss']),...(request.lossControls===undefined?[]:['lossControls'])]))throw new GraphWitnessError('recovery-request-fields-invalid',400);
    const authorization = request.authorization;
    const requestHash = this.stagedRecoveryRows.get(request)?.hash??canonicalHash(request);
    const prior = this.db.prepare('SELECT requestHash,response FROM recoveryLog WHERE agentId=? AND recoveryId=?').get(agentId, authorization.recoveryId) as { requestHash: string; response: string } | undefined;
    if (prior) {
      if (prior.requestHash !== requestHash) throw new GraphWitnessError('recovery-idempotency-conflict');
      return JSON.parse(prior.response) as { activation: GraphMembershipActivationCertificate; adoptions: GraphAdoptionCertificate[] };
    }
    return this.db.transaction(() => {
      const previous = this.membership(agentId); const next = request.newMembership;
      const owner = this.options.enrollments[agentId]?.ownerPublicKey;
      if (!owner || !verifyRecoveryAuthorization(authorization, previous, next, owner) || next.witnessId !== this.options.witnessId
        || next.failureDomain !== this.options.failureDomain || request.currentLease.leaseEpoch !== authorization.fenceEpoch
        || !verifyFencedLeaseBridge(request.currentLease, request.originalCurrentLease, next)
        || !verifyWitnessLease(request.currentLease, next, this.now())) throw new GraphWitnessError('owner-recovery-proof-invalid', 403);
      const fence = this.db.prepare('SELECT leaseEpoch,leaseHash,certifiedSequence,certifiedCoreHash FROM agents WHERE agentId=?').get(agentId) as { leaseEpoch: number;leaseHash:string|null; certifiedSequence: number; certifiedCoreHash: string | null };
      const revisionHead=this.db.prepare('SELECT revisionHash FROM memberLossPlanRevisions WHERE agentId=? AND epoch=? ORDER BY generation DESC LIMIT 1').get(agentId,next.epoch) as {revisionHash:string}|undefined;
      if(revisionHead&&(!request.memberLoss?.planRevision||canonicalHash(request.memberLoss.planRevision)!==revisionHead.revisionHash))throw new GraphWitnessError('member-loss-plan-revision-stale');
      if(request.memberLoss?.v===2&&!revisionHead)throw new GraphWitnessError('member-loss-plan-revision-not-durable');
      const loss=request.memberLoss;
      if(loss!==undefined){
        this.assertPositiveMembershipActive(agentId,previous,loss.planRevision);
        if(request.ownedTransition!==undefined||!verifyGraphMemberLossActivationAuthority(loss,{agentId,previousMembership:previous,newMembership:next,ownerAuthorization:authorization,activatedAt:this.timestamp()},owner)||canonicalHash(loss.currentLease)!==canonicalHash(request.currentLease)||canonicalHash(loss.originalLease)!==canonicalHash(request.originalCurrentLease))throw new GraphWitnessError('member-loss-authority-invalid',403);
        const operations=loss.consent.payload.operations,entries=request.sourceManifest.entries;
        if(operations.length!==entries.length||operations.some(op=>{const entry=entries.find(row=>row.eventId===op.eventId);return !entry||entry.operationHash!==op.operationHash||entry.coreHash!==op.coreHash||entry.sourceSequence!==op.sourceSequence||(op.outcome==='pending'?(entry.certificateHash!==null||entry.cancellationCertificateHash!==(loss.negativeAdvancements.find(row=>row.eventId===op.eventId)?.terminalHash??null)):op.terminalHash!==(op.outcome==='committed'?entry.certificateHash:entry.cancellationCertificateHash));})||request.sourceManifest.highestAcknowledgedSequence<loss.consent.payload.acknowledgedPrefix.sourceSequence)throw new GraphWitnessError('member-loss-known-cut-mismatch',403);
        for(const advance of loss.negativeAdvancements){const entry=entries.find(row=>row.eventId===advance.eventId),operation=entry?this.operation(agentId,entry.idempotencyKey):null,certificate=operation?.cancellationCertificate,original=operation?this.membership(agentId,operation.packet.membershipEpoch):null,key=certificate?.adoption?.newMembership.custodyProfile?.witnessPublicKey??original?.custodyProfile?.witnessPublicKey??(certificate?this.options.historicalWitnessPublicKeys?.[certificate.witnessId]:undefined);if(!operation||operation.certificate||!certificate||!original||!key||canonicalHash(operation.packet)!==advance.operationHash||canonicalHash(certificate)!==advance.terminalHash||certificate.outcome!==advance.outcome||!verifyCancellationCertificate(certificate,operation.packet,original,key,owner))throw new GraphWitnessError('member-loss-negative-advancement-invalid',403);}
      }
      const owned=request.ownedTransition;let sameOwnedHolder=false;
      if(loss===undefined&&(previous.custodyProfile?.mode==='owned-machine'||next.custodyProfile?.mode==='owned-machine')){if(!owned||!exactFields(owned,['stage','holds','retirement'])||canonicalHash(owned.stage.authorization)!==canonicalHash(authorization)||canonicalHash(owned.stage.previousMembership)!==canonicalHash(previous)||canonicalHash(owned.stage.newMembership)!==canonicalHash(next)||!verifyGraphCustodyRetirement(owned.retirement,owned.stage,owned.holds,owner)||owned.retirement.lease.writerId!==request.currentLease.writerId||owned.retirement.lease.leaseEpoch!==request.currentLease.leaseEpoch)throw new GraphWitnessError('owned-profile-retirement-required',403);if(previous.witnessId===this.options.witnessId&&previous.custodyProfile?.witnessPublicKey===this.publicKey){const retained=this.db.prepare('SELECT body FROM ownedRetirements WHERE agentId=? AND membershipHash=? AND stageHash=?').get(agentId,canonicalHash(previous),canonicalHash(owned.stage)) as {body:string}|undefined;if(!retained||canonicalHash(JSON.parse(retained.body))!==canonicalHash(owned.retirement))throw new GraphWitnessError('owned-retirement-not-durable');}sameOwnedHolder=request.currentLease.leaseEpoch===fence.leaseEpoch&&(fence.leaseHash?(JSON.parse(fence.leaseHash) as GraphWitnessLease).writerId===request.currentLease.writerId:owned.retirement.lease.leaseEpoch===fence.leaseEpoch&&owned.retirement.lease.writerId===request.currentLease.writerId);}
      if ((request.currentLease.leaseEpoch <= fence.leaseEpoch&&!sameOwnedHolder) || authorization.highestCertifiedSequence !== fence.certifiedSequence
        || authorization.highestCertifiedCoreHash !== fence.certifiedCoreHash) throw new GraphWitnessError('recovery-watermark-or-fence-mismatch');
      if (!validateRecoverySourceManifest(request.sourceManifest) || authorization.sourceManifestHash !== canonicalHash(request.sourceManifest)
        || request.sourceManifest.agentId !== agentId || request.sourceManifest.membershipHash !== canonicalHash(previous)
        || request.sourceManifest.highestCertifiedSequence !== fence.certifiedSequence || request.sourceManifest.highestCertifiedCoreHash !== fence.certifiedCoreHash) throw new GraphWitnessError('recovery-source-manifest-invalid');
      this.importMemberLossControls(agentId,request,owner);
      const ownManifest = this.recoveryManifest(agentId);
      const supplied = new Map(request.sourceManifest.entries.map((e) => [e.eventId, e]));
      for (const entry of ownManifest.entries) if (canonicalHash(supplied.get(entry.eventId) ?? null) !== canonicalHash(entry)) throw new GraphWitnessError('recovery-source-manifest-incomplete');
      if (!Array.isArray(request.stateTransferReceipts) || request.stateTransferReceipts.length !== next.members.length
        || new Set(request.stateTransferReceipts.map((r) => r.machineId)).size !== next.members.length
        || request.stateTransferReceipts.some((r) => !verifyMembershipTransferReceipt(r, authorization, next))) throw new GraphWitnessError('all-member-state-transfer-required', 403);
      const unfinished = (this.db.prepare('SELECT idempotencyKey,operationHash FROM operations WHERE agentId=? AND certificate IS NULL AND cancellationCertificate IS NULL').all(agentId) as Array<{ idempotencyKey: string; operationHash: string }>);
      if (authorization.pendingOutcomes.length !== unfinished.length || request.revalidations.length !== unfinished.length) throw new GraphWitnessError('recovery-pending-set-incomplete');
      const validations = new Map(request.revalidations.map((item) => [item.proof.idempotencyKey, item]));
      if (validations.size !== unfinished.length) throw new GraphWitnessError('recovery-pending-set-duplicate');
      for (const operation of unfinished) {
        const outcome = authorization.pendingOutcomes.find((o) => o.idempotencyKey === operation.idempotencyKey);
        const validation = validations.get(operation.idempotencyKey);
        if (!outcome || !validation || outcome.operationHash !== operation.operationHash || outcome.revalidationHash !== canonicalHash(validation.proof)
          || outcome.decision !== validation.proof.decision) throw new GraphWitnessError('recovery-pending-proof-mismatch', 403);
      }
      const rewrapInventory=this.recoveryRewrapInventory(agentId,request);
      if(graphTransferContextCapacityBytes({previousMembership:previous,newMembership:next,authorization,manifest:request.sourceManifest,rewrapInventory,currentLease:request.currentLease,originalCurrentLease:request.originalCurrentLease})>32*1024*1024)throw new GraphWitnessError('graph-transfer-context-capacity',413);
      const activation = this.signed(loss===undefined?D.membershipActivation:graphMemberLossActivationDomain(loss), { ...(loss===undefined?{}:{memberLoss:loss}), v: 1 as const, agentId, previousMembership: previous, newMembership: next,
        ownerAuthorization: authorization, stateTransferReceipts: [...request.stateTransferReceipts].sort((a, b) => a.machineId.localeCompare(b.machineId)),
        witnessId: this.options.witnessId, activatedAt: this.timestamp() });
      if (!verifyMembershipActivation(activation, owner, this.publicKey)) throw new GraphWitnessError('membership-activation-invalid', 403);
      if(loss!==undefined)this.db.prepare('INSERT INTO memberLossMaintenance(agentId,epoch,activationHash,body) VALUES(?,?,?,?) ON CONFLICT(agentId) DO UPDATE SET epoch=excluded.epoch,activationHash=excluded.activationHash,body=excluded.body').run(agentId,next.epoch,canonicalHash(activation),canonicalJson(activation));
      this.installMembership(next, true);
      this.db.prepare('INSERT INTO membershipActivations(agentId,epoch,body) VALUES(?,?,?)').run(agentId, next.epoch, canonicalJson(activation));
      this.admission(agentId, request.currentLease, request.originalCurrentLease);
      const context:GraphWitnessRecoveryContext={activation,manifest:request.sourceManifest,rewrapInventory,currentLease:request.currentLease,originalCurrentLease:request.originalCurrentLease};
      this.db.prepare('INSERT INTO recoveryContexts(agentId,epoch,body) VALUES(?,?,?)').run(agentId,next.epoch,canonicalJson(context));
      const historic=this.historicalRewrapAccess(request);
      for(const entry of request.sourceManifest.entries){
        const terminal=this.db.prepare('SELECT certificate,cancellationCertificate FROM operations WHERE agentId=? AND eventId=?').get(agentId,entry.eventId) as {certificate:string|null;cancellationCertificate:string|null}|undefined;
        if(!terminal?.certificate&&!terminal?.cancellationCertificate)continue;
        const rewrap=historic.get(entry.eventId);const ref:GraphWitnessMaterializationRef={epoch:next.epoch,activationHash:canonicalHash(activation),manifestHash:authorization.sourceManifestHash,rewrapInventoryHash:authorization.rewrapInventoryHash,rewrapHash:canonicalHash(rewrap),leaseHash:canonicalHash(request.currentLease),originalLeaseHash:canonicalHash(request.originalCurrentLease)};
        this.db.prepare('INSERT INTO materializations(agentId,eventId,body) VALUES(?,?,?) ON CONFLICT(agentId,eventId) DO UPDATE SET body=excluded.body').run(agentId,entry.eventId,canonicalJson(ref));
        this.db.prepare('INSERT INTO rewraps(agentId,eventId,body) VALUES(?,?,?) ON CONFLICT(agentId,eventId) DO UPDATE SET body=excluded.body').run(agentId,entry.eventId,rewrap?canonicalJson(rewrap):null);
      }
      const adoptions = request.revalidations.map(({ proof, rewrap }) => this.adoptOne(agentId, next, request.currentLease, request.originalCurrentLease, proof, rewrap, authorization));
      const response = { activation, adoptions };
      this.db.prepare('INSERT INTO recoveryLog(agentId,recoveryId,requestHash,response) VALUES(?,?,?,?)').run(agentId, authorization.recoveryId, requestHash, canonicalJson(response));
      return response;
    }).immediate();
  }
  private recoveryContext(agentId:string,epoch:number):GraphWitnessRecoveryContext {
    const row=this.db.prepare('SELECT body FROM recoveryContexts WHERE agentId=? AND epoch=?').get(agentId,epoch) as {body:string}|undefined;
    if(!row)throw new GraphWitnessError('recovery-context-unavailable',404);return JSON.parse(row.body);
  }
  recoveryContextHeader(agentId:string,epoch:number):unknown {
    const context=this.recoveryContext(agentId,epoch);
    return this.signed('graph-recovery-context-header-v1',{v:1,agentId,epoch,witnessId:this.options.witnessId,
      context:{...context,manifest:{...context.manifest,entries:[]},rewrapInventory:[]},entryCount:context.manifest.entries.length,rewrapCount:context.rewrapInventory.length,
      pageCount:Math.max(1,Math.ceil(Math.max(context.manifest.entries.length,context.rewrapInventory.length)/16))});
  }
  recoveryContextPage(agentId:string,epoch:number,index:number):unknown {
    if(!Number.isSafeInteger(index)||index<0)throw new GraphWitnessError('recovery-context-page-invalid',400);
    const context=this.recoveryContext(agentId,epoch),header=this.recoveryContextHeader(agentId,epoch) as {pageCount:number};
    if(index>=header.pageCount)throw new GraphWitnessError('recovery-context-page-invalid',404);
    return this.signed('graph-recovery-context-page-v1',{v:1,agentId,epoch,index,headerHash:canonicalHash(header),entries:context.manifest.entries.slice(index*16,index*16+16),rewrapInventory:context.rewrapInventory.slice(index*16,index*16+16)});
  }
  private historicalRewrapAccess(request:GraphWitnessRecoveryRequest):{get:(eventId:string)=>GraphBundleRewrap|null;has:(eventId:string)=>boolean;keys:()=>IterableIterator<string>} {
    const staged=this.stagedRecoveryRows.get(request),rows=request.historicalRewraps??[],index=staged?.index??new Map<string,number>();
    if(!staged)for(let i=0;i<rows.length;i++){const row=rows[i];if(!exactFields(row,['eventId','rewrap'])||index.has(row.eventId))throw new GraphWitnessError('historical-rewrap-inventory-invalid',403);index.set(row.eventId,i);}
    return {get:eventId=>{const i=index.get(eventId);return i===undefined?null:(staged?staged.get(i):rows[i]).rewrap;},has:eventId=>index.has(eventId),keys:()=>index.keys()};
  }
  private withStagedRecoveryRows<T>(agentId:string,transferId:string,request:GraphWitnessRecoveryRequest,count:number,expectedHash:string,work:()=>T):T {
    const index=new Map<string,number>();let rowIndex=0;
    const rows=()=>this.transferValues(agentId,transferId,'historical-rewrap') as Iterable<{eventId:string;rewrap:GraphBundleRewrap}>;
    for(const row of rows()){if(!exactFields(row,['eventId','rewrap'])||index.has(row.eventId))throw new GraphWitnessError('historical-rewrap-inventory-invalid',403);index.set(row.eventId,rowIndex++);}
    if(rowIndex!==count)throw new GraphWitnessError('recovery-upload-incomplete');
    const digest=crypto.createHash('sha256');digest.update('{');let first=true;
    for(const key of Object.keys(request).sort().filter(key=>(request as unknown as Record<string,unknown>)[key]!==undefined)){
      if(!first)digest.update(',');first=false;digest.update(JSON.stringify(key)+':');
      if(key==='historicalRewraps'){digest.update('[');let firstRow=true;for(const row of rows()){if(!firstRow)digest.update(',');firstRow=false;digest.update(canonicalJson(row));}digest.update(']');}
      else digest.update(canonicalJson((request as unknown as Record<string,unknown>)[key]));
    }
    digest.update('}');const hash=digest.digest('hex');if(hash!==expectedHash)throw new GraphWitnessError('recovery-upload-manifest-mismatch');
    const get=(i:number)=>{const row=this.db.prepare("SELECT body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='historical-rewrap' AND rowIndex=?").get(agentId,transferId,i) as {body:string}|undefined;if(!row)throw new GraphWitnessError('recovery-upload-incomplete');return JSON.parse(row.body) as {eventId:string;rewrap:GraphBundleRewrap};};
    this.stagedRecoveryRows.set(request,{count,hash,index,get});try{return work();}finally{this.stagedRecoveryRows.delete(request);}
  }
  private recoveryRewrapInventory(agentId:string,request:GraphWitnessRecoveryRequest):import('./GraphWitnessTypes.js').GraphRewrapInventoryEntry[]{
    const historic=this.historicalRewrapAccess(request);
    const pending=new Map(request.revalidations.map(row=>[row.proof.idempotencyKey,row]));
    const inventory:import('./GraphWitnessTypes.js').GraphRewrapInventoryEntry[]=[];
    for(const entry of request.sourceManifest.entries){
      const op=this.operation(agentId,entry.idempotencyKey);if(!op||op.packet.eventId!==entry.eventId)throw new GraphWitnessError('unwitnessed-source-requires-review');
      const terminal=!!(op.certificate||op.cancellationCertificate);const rewrap=terminal?(historic.get(entry.eventId)):(pending.get(entry.idempotencyKey)?.rewrap??null);
      if(!terminal&&historic.has(entry.eventId))throw new GraphWitnessError('historical-rewrap-pending-conflict',403);
      const erased=!!op.erasure;const refused=!terminal&&pending.get(entry.idempotencyKey)?.proof.decision==='refuse';
      if(erased||refused){if(rewrap)throw new GraphWitnessError('erased-or-refused-rewrap-invalid',403);}
      else{
        const bundle=this.recover(agentId,entry.idempotencyKey).encryptedSourceBundle;
        if(!bundle||!rewrap||rewrap.eventId!==entry.eventId||rewrap.writerId!==request.currentLease.writerId||!verifyBundleRewrap(rewrap,bundle,request.newMembership))throw new GraphWitnessError('historical-rewrap-required-or-invalid',403);
      }
      inventory.push({eventId:entry.eventId,rewrapHash:canonicalHash(rewrap)});
    }
    if([...historic.keys()].some(eventId=>!request.sourceManifest.entries.some(entry=>entry.eventId===eventId))||graphRewrapInventoryHash(inventory)!==request.authorization.rewrapInventoryHash)throw new GraphWitnessError('recovery-rewrap-inventory-mismatch',403);
    return inventory.sort((a,b)=>a.eventId<b.eventId?-1:a.eventId>b.eventId?1:0);
  }
  private historicalAuditorKey(agentId:string,witnessId:string,memberships:GraphMembershipEpoch[]):string|undefined {
    const key=this.options.historicalBackupPolicyAuditorPublicKeys?.[witnessId];
    if(!key||!canonicalPublicKey(key,'ed25519')||key===this.publicKey||key===this.options.enrollments[agentId]?.ownerPublicKey
      ||Object.values(this.options.historicalWitnessPublicKeys??{}).includes(key)||memberships.some(m=>m.members.some(member=>member.signingPublicKey===key)))return undefined;
    return key;
  }
  private *archiveContexts(agentId:string,transferId:string):Iterable<GraphWitnessRecoveryContext>{
    for(const raw of this.transferValues(agentId,transferId,'context')){const h=raw as GraphContextArchiveHeader,context=structuredClone(h.context);context.manifest.entries=[];context.rewrapInventory=[];
      for(let index=0;index<h.pageCount;index++){const row=this.db.prepare("SELECT body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='context-page' AND rowIndex=?").get(agentId,transferId,h.pageOffset+index) as {body:string}|undefined;if(!row)throw new GraphWitnessError('bootstrap-context-archive-incomplete');const page=JSON.parse(row.body) as GraphContextArchivePage;if(page.epoch!==h.epoch||page.index!==index)throw new GraphWitnessError('bootstrap-context-archive-order-invalid');context.manifest.entries.push(...page.entries);context.rewrapInventory.push(...page.rewrapInventory);}
      if(context.manifest.entries.length!==h.entryCount||context.rewrapInventory.length!==h.entryCount||Buffer.byteLength(canonicalJson(context))>32*1024*1024)throw new GraphWitnessError('bootstrap-context-archive-capacity');yield context;
    }
  }
  private assertLossSourceImport(agentId:string,row:GraphWitnessBootstrapOperation,recovery:GraphWitnessRecoveryRequest,previous:GraphMembershipEpoch,owner:string):void{
    const loss=recovery.memberLoss,op=row.operation,packet=op.packet;
    if(row.kind!=='member-loss-source'||op.stateProof!==undefined||!Array.isArray(op.certificatePersistenceReceipts)||!loss||!verifyGraphMemberLossActivationAuthority(loss,{agentId,previousMembership:previous,newMembership:recovery.newMembership,ownerAuthorization:recovery.authorization,activatedAt:this.timestamp()},owner))throw new GraphWitnessError('loss-source-import-authority-invalid',403);
    const known=loss.consent.payload.operations.find(entry=>entry.eventId===packet.eventId),advance=loss.negativeAdvancements.find(entry=>entry.eventId===packet.eventId);
    if(!known||known.operationHash!==canonicalHash(packet)||known.sourceSequence!==packet.sourceSequence||known.predecessorHash!==packet.predecessorHash||known.coreHash!==packet.coreHash)throw new GraphWitnessError('loss-source-import-outside-cut',403);
    if(op.certificate){if(known.outcome!=='committed'||known.terminalHash!==canonicalHash(op.certificate))throw new GraphWitnessError('loss-source-unadmitted-positive',403);}else if(known.outcome==='committed')throw new GraphWitnessError('loss-source-known-commit-missing',403);
    if(op.cancellationCertificate){const allowed=known.outcome==='pending'?advance?.terminalHash:known.terminalHash,outcome=known.outcome==='pending'?advance?.outcome:known.outcome;if(allowed!==canonicalHash(op.cancellationCertificate)||outcome!==op.cancellationCertificate.outcome)throw new GraphWitnessError('loss-source-negative-terminal-invalid',403);}else if(known.outcome!=='pending'&&!op.certificate||advance&&!op.cancellationCertificate)throw new GraphWitnessError('loss-source-known-terminal-missing',403);
    const derived=op.certificate?'certified':op.cancellationCertificate?.outcome??(op.cancellation?'canceled':op.erasure?'erased':'prepared');if(op.state!==derived)throw new GraphWitnessError('loss-source-state-not-proven',403);
  }
  private importMemberLossControls(agentId:string,request:GraphWitnessRecoveryRequest,owner:string):void{
    const loss=request.memberLoss;if(request.lossControls!==undefined&&(!loss||!verifyGraphMemberLossActivationAuthority(loss,{agentId,previousMembership:this.membership(agentId),newMembership:request.newMembership,ownerAuthorization:request.authorization,activatedAt:this.timestamp()},owner)))throw new GraphWitnessError('member-loss-controls-authority-invalid',403);
      if(request.lossControls!==undefined){
        if(loss===undefined||!Array.isArray(request.lossControls)||request.lossControls.length>512)throw new GraphWitnessError('member-loss-controls-invalid',403);
        const seenControls=new Set<string>();
        for(const control of [...request.lossControls].sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence)){
          if(!exactFields(control,['packet','packetSignature','controlCapsule'])||!validatePacket(control.packet)||control.packet.agentId!==agentId||seenControls.has(control.packet.eventId)||!verifyGraphControlCapsule(control.controlCapsule,control.packet,owner))throw new GraphWitnessError('member-loss-control-invalid',403);seenControls.add(control.packet.eventId);
          const packet=control.packet,operationHash=canonicalHash(packet),admitted=loss.consent.payload.operations.find(row=>row.eventId===packet.eventId),entry=request.sourceManifest.entries.find(row=>row.eventId===packet.eventId),historical=this.membership(agentId,packet.membershipEpoch),writer=historical.members.find(row=>row.machineId===packet.writerId);
          if(!admitted||admitted.outcome!=='pending'||admitted.terminalHash!==null||admitted.operationHash!==operationHash||admitted.predecessorHash!==packet.predecessorHash||!entry||entry.operationHash!==operationHash||entry.prepareProofHash!==null||entry.erasedControlProofHash!==null||entry.certificateHash!==null||entry.cancellationCertificateHash!==null||!writer||canonicalHash(control.controlCapsule.authorizationProof.membership)!==canonicalHash(historical)||!verifyGraphRecord(D.packet,packet,control.packetSignature,writer.signingPublicKey))throw new GraphWitnessError('member-loss-control-authority-invalid',403);
          const priorControl=this.db.prepare('SELECT operationHash FROM operations WHERE agentId=? AND idempotencyKey=?').get(agentId,packet.idempotencyKey) as {operationHash:string}|undefined;
          if(priorControl){if(priorControl.operationHash!==operationHash)throw new GraphWitnessError('idempotency-conflict');continue;}
          this.requireHistoryCapacity(agentId);const tip=this.ensureWitnessedTip(agentId);
          if(packet.sourceSequence!==tip.sequence+1||packet.predecessorHash!==tip.coreHash)throw new GraphWitnessError('member-loss-known-prefix-missing');
          this.db.prepare('INSERT INTO operations(agentId,idempotencyKey,eventId,operationHash,packet,packetSignature,prepareProof,state) VALUES(?,?,?,?,?,?,?,?)').run(agentId,packet.idempotencyKey,packet.eventId,operationHash,canonicalJson(packet),control.packetSignature,'null','canceled');
          this.db.prepare('INSERT INTO controls(agentId,eventId,body) VALUES(?,?,?)').run(agentId,packet.eventId,canonicalJson(control.controlCapsule));
          this.db.prepare('UPDATE witnessedTips SET sequence=?,coreHash=? WHERE agentId=?').run(packet.sourceSequence,packet.coreHash,agentId);
        }
      }
  }
  settleMemberLoss(agentId:string,request:{activationHash:string;pins:GraphMemberLossActivationPin[];lease:GraphWitnessLease;originalLease:LeaseRecord}):GraphMemberLossSettlementProof{
    if(!exactFields(request,['activationHash','pins','lease','originalLease'])||!hash(request.activationHash))throw new GraphWitnessError('member-loss-settlement-request-invalid',400);
    this.observeLease(agentId,request.lease,request.originalLease);
    return this.db.transaction(()=>{
      const membership=this.admission(agentId,request.lease,request.originalLease),activation=this.membershipActivation(agentId,membership.epoch),loss=activation?.memberLoss;
      if(!activation||!loss||canonicalHash(activation)!==request.activationHash||!verifyGraphMemberLossActivationPins(request.pins,activation))throw new GraphWitnessError('member-loss-all-physical-pins-required',403);
      const prior=this.db.prepare('SELECT body FROM memberLossSettlements WHERE agentId=? AND epoch=?').get(agentId,membership.epoch) as {body:string}|undefined;
      if(prior){const stored=JSON.parse(prior.body) as {proof:GraphMemberLossSettlementProof;pins:GraphMemberLossActivationPin[]};if(!verifyGraphMemberLossSettlement(stored.proof,activation,this.publicKey,stored.pins))throw new GraphWitnessError('member-loss-settlement-evidence-invalid');return stored.proof;}
      if(!this.db.prepare('SELECT 1 FROM memberLossMaintenance WHERE agentId=? AND activationHash=?').get(agentId,request.activationHash))throw new GraphWitnessError('member-loss-maintenance-evidence-missing');
      const inventory:Array<{eventId:string;operationHash:string;terminalHash:string;certificatePersistenceHash:string}>=[];
      for(const known of loss.consent.payload.operations){
        const row=this.db.prepare('SELECT idempotencyKey FROM operations WHERE agentId=? AND eventId=?').get(agentId,known.eventId) as {idempotencyKey:string}|undefined,operation=row?this.operation(agentId,row.idempotencyKey):null;
        const terminal=operation?.certificate??operation?.cancellationCertificate;
        if(!operation||!terminal||canonicalHash(operation.packet)!==known.operationHash)throw new GraphWitnessError('member-loss-terminal-prefix-incomplete');
        const advancement=loss.negativeAdvancements.find(row=>row.eventId===known.eventId);
        if(advancement){if(operation.certificate||!operation.cancellationCertificate||canonicalHash(operation.cancellationCertificate)!==advancement.terminalHash||operation.cancellationCertificate.outcome!==advancement.outcome)throw new GraphWitnessError('member-loss-negative-advancement-changed');}
        else if(known.outcome==='pending'){
          const adoption=operation.adoption,certificate=operation.cancellationCertificate;
          if(operation.certificate||!certificate||!adoption||canonicalHash(adoption.activation)!==request.activationHash||!verifyCancellationCertificate(certificate,operation.packet,this.membership(agentId,operation.packet.membershipEpoch),this.publicKey,this.options.enrollments[agentId].ownerPublicKey)||operation.certificatePersistenceReceipts.length!==membership.members.length||new Set(operation.certificatePersistenceReceipts.map(receipt=>receipt.machineId)).size!==membership.members.length||operation.certificatePersistenceReceipts.some(receipt=>!verifyMemberReceipt(receipt,operation.packet,membership,'certificate',canonicalHash(certificate),{membershipEpoch:membership.epoch,leaseEpoch:adoption.currentLease.leaseEpoch})))throw new GraphWitnessError('member-loss-terminal-persistence-incomplete');
        }else if(known.terminalHash!==canonicalHash(terminal)||(known.outcome==='committed'?!operation.certificate:!operation.cancellationCertificate))throw new GraphWitnessError('member-loss-known-decision-changed');
        inventory.push({eventId:known.eventId,operationHash:known.operationHash,terminalHash:canonicalHash(terminal),certificatePersistenceHash:canonicalHash(operation.certificatePersistenceReceipts)});
      }
      const last=loss.consent.payload.operations.at(-1),tip=this.db.prepare('SELECT certifiedSequence,certifiedCoreHash FROM agents WHERE agentId=?').get(agentId) as {certifiedSequence:number;certifiedCoreHash:string|null};if(tip.certifiedSequence!==(last?.sourceSequence??0)||tip.certifiedCoreHash!==(last?.coreHash??null))throw new GraphWitnessError('member-loss-terminal-prefix-incomplete');
      const pins=[...request.pins].sort((a,b)=>a.machineId<b.machineId?-1:a.machineId>b.machineId?1:0),proof=this.signed(GRAPH_MEMBER_LOSS_SETTLED_DOMAIN,{v:1 as const,kind:'owned-member-loss-settled' as const,agentId,activationHash:request.activationHash,membershipHash:canonicalHash(membership),activationPinsHash:canonicalHash(pins),terminalInventoryHash:canonicalHash(inventory),highestSequence:last?.sourceSequence??0,highestCoreHash:last?.coreHash??null,witnessId:this.options.witnessId,settledAt:this.timestamp()});
      if(!verifyGraphMemberLossSettlement(proof,activation,this.publicKey,pins))throw new GraphWitnessError('member-loss-settlement-invalid');
      this.db.prepare('INSERT INTO memberLossSettlements(agentId,epoch,body) VALUES(?,?,?)').run(agentId,membership.epoch,canonicalJson({proof,pins}));return proof;
    }).immediate();
  }
  private validArchivedContext(context:GraphWitnessRecoveryContext,activation:GraphMembershipActivationCertificate,owner:string,witnessKey:string):boolean{
    try{return Buffer.byteLength(canonicalJson(context))<=32*1024*1024&&exactFields(context,['activation','manifest','rewrapInventory','currentLease','originalCurrentLease'])&&canonicalHash(context.activation)===canonicalHash(activation)&&verifyMembershipActivation(activation,owner,witnessKey)&&validateRecoverySourceManifest(context.manifest)&&context.manifest.agentId===activation.agentId&&context.manifest.membershipHash===canonicalHash(activation.previousMembership)&&canonicalHash(context.manifest)===activation.ownerAuthorization.sourceManifestHash&&graphRewrapInventoryHash(context.rewrapInventory)===activation.ownerAuthorization.rewrapInventoryHash&&canonicalHash(context.rewrapInventory.map(row=>row.eventId).sort())===canonicalHash(context.manifest.entries.map(row=>row.eventId).sort())&&verifyFencedLeaseBridge(context.currentLease,context.originalCurrentLease,activation.newMembership)&&context.currentLease.leaseEpoch===activation.ownerAuthorization.fenceEpoch;}catch{return false;}
  }
  beginNativeSourceUpload(agentId:string,plan:GraphNativeSourceUpload):{transferId:string}{
    const membership=this.membership(agentId),owner=this.options.enrollments[agentId]?.ownerPublicKey;this.assertPositiveMembershipActive(agentId,membership);
    if(!validateGraphNativeSourceUpload(plan)||!owner||!verifyGraphRecord(GRAPH_NATIVE_UPLOAD_DOMAIN,unsigned(plan),plan.signature,membership.members.find(row=>row.machineId===plan.lease?.writerId)?.signingPublicKey??'')||plan.packet.agentId!==agentId||!verifyGraphControlCapsule(plan.controlCapsule,plan.packet,owner)||!verifyFencedLeaseBridge(plan.lease,plan.originalLease,membership)||!verifyWitnessLease(plan.lease,membership,this.now()))throw new GraphWitnessError('native-source-upload-plan-invalid',403);
    const historical=this.membership(agentId,plan.packet.membershipEpoch),writer=historical.members.find(row=>row.machineId===plan.packet.writerId);
    if(!writer||!verifyGraphRecord(D.packet,plan.packet,plan.packetSignature,writer.signingPublicKey)||this.targetFence(agentId,plan.packet.erasureIdentity))throw new GraphWitnessError('native-source-upload-authority-invalid',403);
    const body=canonicalJson(plan),prior=this.db.prepare('SELECT plan FROM witnessTransfers WHERE agentId=? AND transferId=?').get(agentId,plan.transferId) as {plan:string}|undefined;if(prior&&prior.plan!==body)throw new GraphWitnessError('native-source-upload-conflict');
    this.db.prepare('INSERT INTO witnessTransfers(agentId,transferId,plan) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(agentId,plan.transferId,body);return {transferId:plan.transferId};
  }
  private nativeSourceUpload(agentId:string,transferId:string):GraphNativeSourceUpload{
    const raw=this.db.prepare('SELECT plan FROM witnessTransfers WHERE agentId=? AND transferId=?').get(agentId,transferId) as {plan:string}|undefined;const plan=raw?JSON.parse(raw.plan):null;
    if(!validateGraphNativeSourceUpload(plan)||this.db.prepare('SELECT 1 FROM witnessTransferStale WHERE agentId=? AND transferId=?').get(agentId,transferId)||this.targetFence(agentId,plan.packet.erasureIdentity))throw new GraphWitnessError('native-source-upload-unavailable');this.assertPositiveMembershipActive(agentId,this.membership(agentId));return plan;
  }
  putNativeSourceUpload(agentId:string,transferId:string,index:number,value:unknown):{hash:string}{
    const plan=this.nativeSourceUpload(agentId,transferId);if(!Number.isSafeInteger(index)||index<0||index>=plan.chunkHashes.length||typeof value!=='string'||value.length>Math.ceil(GRAPH_NATIVE_UPLOAD_CHUNK_BYTES*4/3)||!/^[A-Za-z0-9_-]+$/.test(value)||canonicalHash(value)!==plan.chunkHashes[index])throw new GraphWitnessError('native-source-upload-chunk-invalid',400);
    return this.db.transaction(()=>{if(this.targetFence(agentId,plan.packet.erasureIdentity))throw new GraphWitnessError('source-erased');const prior=this.db.prepare("SELECT hash FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='native-source' AND rowIndex=?").get(agentId,transferId,index) as {hash:string}|undefined;if(prior){if(prior.hash!==plan.chunkHashes[index])throw new GraphWitnessError('native-source-upload-conflict');return {hash:prior.hash};}
      const body=canonicalJson(value),bytes=Buffer.byteLength(body),used=(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM witnessTransferUsage').get() as {n:number}).n;if(used+bytes>(this.options.maxBootstrapStagingBytes??64*1024*1024*1024))throw new GraphWitnessError('native-source-upload-capacity',413);
      this.db.prepare("INSERT INTO witnessTransferRows(agentId,transferId,section,rowIndex,hash,body) VALUES(?,?,'native-source',?,?,?)").run(agentId,transferId,index,plan.chunkHashes[index],body);
      this.db.prepare("INSERT INTO witnessTransferBindings(agentId,transferId,section,rowIndex,bundleHash) VALUES(?,?,'native-source',?,?)").run(agentId,transferId,index,plan.packet.sourceBundleHash);
      this.db.prepare("INSERT INTO witnessTransferTargets(agentId,transferId,section,rowIndex,sourceKind,sourceId,bundleHash) VALUES(?,?,'native-source',?,?,?,?)").run(agentId,transferId,index,plan.packet.erasureIdentity.sourceKind,plan.packet.erasureIdentity.sourceId,plan.packet.sourceBundleHash);
      this.db.prepare('INSERT INTO witnessTransferUsage(agentId,transferId,bytes) VALUES(?,?,?) ON CONFLICT(agentId,transferId) DO UPDATE SET bytes=bytes+excluded.bytes').run(agentId,transferId,bytes);return {hash:plan.chunkHashes[index]};}).immediate();
  }
  finishNativeSourceUpload(agentId:string,transferId:string):GraphWitnessOperation{
    const plan=this.nativeSourceUpload(agentId,transferId),completed=this.db.prepare("SELECT 1 FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='native-result'").get(agentId,transferId);
    if(completed){const operation=this.operation(agentId,plan.packet.idempotencyKey);if(!operation||canonicalHash(operation.packet)!==canonicalHash(plan.packet))throw new GraphWitnessError('native-source-upload-result-unavailable');return operation;}
    const rows=this.db.prepare("SELECT rowIndex,body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='native-source' ORDER BY rowIndex").all(agentId,transferId) as {rowIndex:number;body:string}[];
    if(rows.length!==plan.chunkHashes.length||rows.some((row,index)=>row.rowIndex!==index))throw new GraphWitnessError('native-source-upload-incomplete');const request=decodeGraphNativeSourceUpload(plan,rows.map(row=>JSON.parse(row.body)));
    return this.db.transaction(()=>{const operation=this.recoverPositiveSource(request);this.db.prepare("INSERT INTO witnessTransferRows(agentId,transferId,section,rowIndex,hash,body) VALUES(?,?,'native-result',0,?,'null')").run(agentId,transferId,plan.requestHash);this.db.prepare("UPDATE witnessTransferRows SET body='null' WHERE agentId=? AND transferId=? AND section='native-source'").run(agentId,transferId);this.recountTransferBytes(agentId,transferId);return operation;}).immediate();
  }
  beginRecoveryUpload(agentId:string,plan:GraphRecoveryUploadPlan):{transferId:string}{
    const header=plan?.header,previous=this.membership(agentId,header?.newMembership?.epoch?header.newMembership.epoch-1:undefined),owner=this.options.enrollments[agentId]?.ownerPublicKey;
    if(!owner||!exactFields(plan,['kind','transferId','requestHash','header','counts','hasHistoricalRewraps'])||plan.kind!=='recovery'||!hash(plan.requestHash)||plan.transferId!==graphRecoveryUploadId(header)||!exactFields(header,['newMembership','authorization','currentLease','originalCurrentLease','sourceManifest',...(header.ownedTransition===undefined?[]:['ownedTransition']),...(header.memberLoss===undefined?[]:['memberLoss']),...(header.lossControls===undefined?[]:['lossControls'])])||!verifyRecoveryAuthorization(header.authorization,previous,header.newMembership,owner)||!verifyFencedLeaseBridge(header.currentLease,header.originalCurrentLease,header.newMembership)||!verifyWitnessLease(header.currentLease,header.newMembership,this.now())||!validateRecoverySourceManifest(header.sourceManifest)||header.sourceManifest.entries.length||!exactFields(plan.counts,['entry','revalidation','receipt','historical-rewrap'])||Object.values(plan.counts).some(n=>!Number.isSafeInteger(n)||n<0)||typeof plan.hasHistoricalRewraps!=='boolean')throw new GraphWitnessError('recovery-upload-plan-invalid',403);
    const prior=this.db.prepare('SELECT requestHash FROM recoveryLog WHERE agentId=? AND recoveryId=?').get(agentId,header.authorization.recoveryId) as {requestHash:string}|undefined;
    if(prior){if(prior.requestHash!==plan.requestHash)throw new GraphWitnessError('recovery-idempotency-conflict');return {transferId:plan.transferId};}
    const own=this.recoveryManifest(agentId);
    const loss=header.memberLoss,validLoss=!!loss&&verifyGraphMemberLossActivationAuthority(loss,{agentId,previousMembership:previous,newMembership:header.newMembership,ownerAuthorization:header.authorization,activatedAt:this.timestamp()},owner)&&canonicalHash(loss.currentLease)===canonicalHash(header.currentLease)&&canonicalHash(loss.originalLease)===canonicalHash(header.originalCurrentLease)&&Array.isArray(header.lossControls)&&header.lossControls.length<=512;
    if((validLoss?plan.counts.entry!==loss!.consent.payload.operations.length:canonicalHash(own)!==header.authorization.sourceManifestHash||plan.counts.entry!==own.entries.length)||plan.counts.entry>20000||plan.counts.revalidation!==header.authorization.pendingOutcomes.length||plan.counts.revalidation>512||plan.counts.receipt!==header.newMembership.members.length||plan.counts['historical-rewrap']>own.entries.length||(!plan.hasHistoricalRewraps&&plan.counts['historical-rewrap']))throw new GraphWitnessError('recovery-upload-count-or-manifest-invalid',403);
    if(validLoss){const ids=new Set<string>();for(const control of header.lossControls!){const id=control?.packet?.idempotencyKey;if(ids.has(id)||!this.stagedLossControl(agentId,plan,id))throw new GraphWitnessError('recovery-upload-loss-control-invalid',403);ids.add(id);}}
    const old=this.db.prepare('SELECT plan FROM witnessTransfers WHERE agentId=? AND transferId=?').get(agentId,plan.transferId) as {plan:string}|undefined,body=canonicalJson(plan);if(old&&old.plan!==body)throw new GraphWitnessError('recovery-upload-conflict');
    this.db.prepare('INSERT INTO witnessTransfers(agentId,transferId,plan) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(agentId,plan.transferId,body);return {transferId:plan.transferId};
  }
  private recoveryUploadPlan(agentId:string,transferId:string):GraphRecoveryUploadPlan{
    const row=this.db.prepare('SELECT plan FROM witnessTransfers WHERE agentId=? AND transferId=?').get(agentId,transferId) as {plan:string}|undefined;if(!row)throw new GraphWitnessError('recovery-upload-unknown',404);const plan=JSON.parse(row.plan) as GraphRecoveryUploadPlan;if(plan.kind!=='recovery')throw new GraphWitnessError('recovery-upload-kind-invalid');
    if(this.db.prepare('SELECT 1 FROM witnessTransferStale WHERE agentId=? AND transferId=?').get(agentId,transferId))throw new GraphWitnessError('recovery-upload-stale-erasure');if(this.db.prepare('SELECT 1 FROM witnessTransferAborts WHERE agentId=? AND transferId=?').get(agentId,transferId))throw new GraphWitnessError('recovery-upload-aborted');return plan;
  }
  /** Inspect an original body-free control without admitting it. Only the
   * existing final loss importer may durably introduce its exact old sequence. */
  private stagedLossControl(agentId:string,plan:GraphRecoveryUploadPlan,idempotencyKey:string):NonNullable<GraphWitnessRecoveryRequest['lossControls']>[number]|null{
    if(typeof idempotencyKey!=='string')return null;const h=plan.header,loss=h.memberLoss,owner=this.options.enrollments[agentId]?.ownerPublicKey;
    if(!loss||!owner||!verifyGraphMemberLossActivationAuthority(loss,{agentId,previousMembership:this.membership(agentId,h.newMembership.epoch-1),newMembership:h.newMembership,ownerAuthorization:h.authorization,activatedAt:this.timestamp()},owner)||canonicalHash(loss.currentLease)!==canonicalHash(h.currentLease)||canonicalHash(loss.originalLease)!==canonicalHash(h.originalCurrentLease)||!Array.isArray(h.lossControls)||h.lossControls.length>512)return null;
    const matches=h.lossControls.filter(row=>row?.packet?.idempotencyKey===idempotencyKey);if(matches.length!==1)return null;const c=matches[0],p=c.packet,admitted=loss.consent.payload.operations.find(row=>row.eventId===p.eventId);
    if(!exactFields(c,['packet','packetSignature','controlCapsule'])||!validatePacket(p)||p.agentId!==agentId||!verifyGraphControlCapsule(c.controlCapsule,p,owner)||!admitted||admitted.outcome!=='pending'||admitted.terminalHash!==null||admitted.operationHash!==canonicalHash(p)||admitted.predecessorHash!==p.predecessorHash||admitted.sourceSequence!==p.sourceSequence||admitted.coreHash!==p.coreHash)return null;
    const historical=this.membership(agentId,p.membershipEpoch),writer=historical.members.find(row=>row.machineId===p.writerId);if(!writer||canonicalHash(c.controlCapsule.authorizationProof.membership)!==canonicalHash(historical)||!verifyGraphRecord(D.packet,p,c.packetSignature,writer.signingPublicKey))return null;return c;
  }
  putRecoveryUpload(agentId:string,transferId:string,section:GraphRecoveryUploadSection,index:number,value:unknown):{hash:string}{
    const plan=this.recoveryUploadPlan(agentId,transferId),owner=this.options.enrollments[agentId].ownerPublicKey;
    if(!Object.hasOwn(plan.counts,section)||!Number.isSafeInteger(index)||index<0||index>=plan.counts[section])throw new GraphWitnessError('recovery-upload-index-invalid',400);
    const header=plan.header,body=canonicalJson(value);if(Buffer.byteLength(body)>2800000)throw new GraphWitnessError('recovery-upload-row-too-large',413);
    // A completed activation changes the live entry context; replay compares the frozen row, never re-admits or restores its purged body.
    const retained=this.db.prepare('SELECT hash FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section=? AND rowIndex=?').get(agentId,transferId,section,index) as {hash:string}|undefined;
    if(retained){const digest=canonicalHash(value);if(retained.hash!==digest)throw new GraphWitnessError('recovery-upload-row-conflict');return {hash:digest};}
    let packet:GraphOperationPacket|null=null,rewrap:GraphBundleRewrap|null=null;
    if(section==='entry'){
      const entry=value as GraphRecoverySourceManifest['entries'][number],op=this.operation(agentId,entry?.idempotencyKey),control=!op?this.stagedLossControl(agentId,plan,entry?.idempotencyKey):null;
      const expected=op?this.recoveryEntry(op):control?{eventId:control.packet.eventId,idempotencyKey:control.packet.idempotencyKey,sourceSequence:control.packet.sourceSequence,operationHash:canonicalHash(control.packet),coreHash:control.packet.coreHash,authorizationReceiptHash:control.packet.authorizationReceiptHash,sourceBundleHash:control.packet.sourceBundleHash,prepareProofHash:null,erasedControlProofHash:null,certificateHash:null,cancellationHash:null,cancellationCertificateHash:null,adoptionHash:null,rewrapHash:null,erasureHash:null,certificatePersistenceHash:canonicalHash([])}:null;
      if(!expected||canonicalHash(expected)!==canonicalHash(entry))throw new GraphWitnessError('recovery-upload-entry-invalid',403);
    }else if(section==='receipt'){
      if(!verifyMembershipTransferReceipt(value as import('./GraphWitnessTypes.js').GraphMembershipTransferReceipt,header.authorization,header.newMembership))throw new GraphWitnessError('recovery-upload-receipt-invalid',403);
    }else if(section==='revalidation'){
      const row=value as GraphWitnessRecoveryRequest['revalidations'][number],op=this.operation(agentId,row?.proof?.idempotencyKey),control=!op?this.stagedLossControl(agentId,plan,row?.proof?.idempotencyKey):null,original=op?.packet??control?.packet;if(!exactFields(row,['proof','rewrap'])||!original||control&&(row.proof.decision!=='refuse'||row.proof.reason!=='operator-refused'||row.rewrap!==null)||!verifyPendingRevalidation(row.proof,original,header.newMembership,header.currentLease)||row.proof.rewrapHash!==canonicalHash(row.rewrap)||!header.authorization.pendingOutcomes.some(outcome=>outcome.idempotencyKey===row.proof.idempotencyKey&&outcome.revalidationHash===canonicalHash(row.proof)))throw new GraphWitnessError('recovery-upload-revalidation-invalid',403);packet=original;rewrap=row.rewrap;
    }else if(section==='historical-rewrap'){
      const row=value as {eventId:string;rewrap:GraphBundleRewrap};if(!exactFields(row,['eventId','rewrap']))throw new GraphWitnessError('recovery-upload-rewrap-invalid',403);const found=this.db.prepare('SELECT idempotencyKey FROM operations WHERE agentId=? AND eventId=?').get(agentId,row.eventId) as {idempotencyKey:string}|undefined;const op=found?this.operation(agentId,found.idempotencyKey):null;if(!op||(!op.certificate&&!op.cancellationCertificate))throw new GraphWitnessError('recovery-upload-history-invalid',403);packet=op.packet;rewrap=row.rewrap;
    }
    if(rewrap&&packet){const bundle=this.recover(agentId,packet.idempotencyKey).encryptedSourceBundle;if(!bundle||rewrap.eventId!==packet.eventId||rewrap.writerId!==header.currentLease.writerId||!verifyBundleRewrap(rewrap,bundle,header.newMembership))throw new GraphWitnessError('recovery-upload-rewrap-invalid',403);}
    return this.db.transaction(()=>{if(packet&&rewrap&&this.targetFence(agentId,packet.erasureIdentity))throw new GraphWitnessError('source-erased');const digest=canonicalHash(value),old=this.db.prepare('SELECT hash FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section=? AND rowIndex=?').get(agentId,transferId,section,index) as {hash:string}|undefined;if(old){if(old.hash!==digest)throw new GraphWitnessError('recovery-upload-row-conflict');return {hash:digest};}
      const used=(this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM witnessTransferUsage').get() as {n:number}).n,bytes=Buffer.byteLength(body);if(used+bytes>(this.options.maxBootstrapStagingBytes??64*1024*1024*1024))throw new GraphWitnessError('recovery-upload-capacity',413);
      this.db.prepare('INSERT INTO witnessTransferRows(agentId,transferId,section,rowIndex,hash,body) VALUES(?,?,?,?,?,?)').run(agentId,transferId,section,index,digest,body);
      if(packet&&rewrap){this.db.prepare('INSERT INTO witnessTransferBindings(agentId,transferId,section,rowIndex,bundleHash) VALUES(?,?,?,?,?)').run(agentId,transferId,section,index,packet.sourceBundleHash);this.db.prepare('INSERT INTO witnessTransferTargets(agentId,transferId,section,rowIndex,sourceKind,sourceId,bundleHash) VALUES(?,?,?,?,?,?,?)').run(agentId,transferId,section,index,packet.erasureIdentity.sourceKind,packet.erasureIdentity.sourceId,packet.sourceBundleHash);}
      this.db.prepare('INSERT INTO witnessTransferUsage(agentId,transferId,bytes) VALUES(?,?,?) ON CONFLICT(agentId,transferId) DO UPDATE SET bytes=bytes+excluded.bytes').run(agentId,transferId,bytes);return {hash:digest};}).immediate();
  }
  finishRecoveryUpload(agentId:string,transferId:string):{activation:GraphMembershipActivationCertificate;adoptionCount:number}{
    const plan=this.recoveryUploadPlan(agentId,transferId),prior=this.db.prepare('SELECT requestHash,response FROM recoveryLog WHERE agentId=? AND recoveryId=?').get(agentId,plan.header.authorization.recoveryId) as {requestHash:string;response:string}|undefined;
    if(prior){if(prior.requestHash!==plan.requestHash)throw new GraphWitnessError('recovery-idempotency-conflict');const response=JSON.parse(prior.response);return {activation:response.activation,adoptionCount:response.adoptions.length};}
    for(const [section,count]of Object.entries(plan.counts)){const row=this.db.prepare('SELECT COUNT(*) AS n FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section=?').get(agentId,transferId,section) as {n:number};if(row.n!==count)throw new GraphWitnessError('recovery-upload-incomplete');}
    const values=(section:GraphRecoveryUploadSection)=>Array.from(this.transferValues(agentId,transferId,section));const request:GraphWitnessRecoveryRequest={...plan.header,sourceManifest:{...plan.header.sourceManifest,entries:values('entry') as GraphRecoverySourceManifest['entries']},revalidations:values('revalidation') as GraphWitnessRecoveryRequest['revalidations'],stateTransferReceipts:values('receipt') as GraphWitnessRecoveryRequest['stateTransferReceipts'],...(plan.hasHistoricalRewraps?{historicalRewraps:[]}:{})};
    const apply=()=>this.db.transaction(()=>{const result=this.recoverPending(agentId,request);this.db.prepare("UPDATE witnessTransferRows SET body='null' WHERE agentId=? AND transferId=? AND section IN ('revalidation','historical-rewrap')").run(agentId,transferId);this.recountTransferBytes(agentId,transferId);return {activation:result.activation,adoptionCount:result.adoptions.length};}).immediate();
    if(plan.hasHistoricalRewraps)return this.withStagedRecoveryRows(agentId,transferId,request,plan.counts['historical-rewrap'],plan.requestHash,apply);
    if(canonicalHash(request)!==plan.requestHash)throw new GraphWitnessError('recovery-upload-manifest-mismatch');return apply();
  }
  recoveryUploadAdoption(agentId:string,transferId:string,index:number):GraphAdoptionCertificate{
    const plan=this.recoveryUploadPlan(agentId,transferId),row=this.db.prepare('SELECT response FROM recoveryLog WHERE agentId=? AND recoveryId=?').get(agentId,plan.header.authorization.recoveryId) as {response:string}|undefined;if(!row||!Number.isSafeInteger(index)||index<0)throw new GraphWitnessError('recovery-upload-result-unavailable',404);const result=JSON.parse(row.response).adoptions[index];if(!result)throw new GraphWitnessError('recovery-upload-result-unavailable',404);return result;
  }
  abortRecoveryUpload(agentId:string,transferId:string,signature:string):void{
    const row=this.db.prepare('SELECT plan FROM witnessTransfers WHERE agentId=? AND transferId=?').get(agentId,transferId) as {plan:string}|undefined;if(!row)throw new GraphWitnessError('recovery-upload-unknown',404);const plan=JSON.parse(row.plan) as GraphRecoveryUploadPlan;
    if(plan.kind!=='recovery'||!verifyGraphRecord('graph-witness-recovery-upload-abort-v1',{agentId,transferId},signature,this.options.enrollments[agentId].ownerPublicKey))throw new GraphWitnessError('recovery-upload-abort-owner-proof-required',403);
    if(this.db.prepare('SELECT 1 FROM recoveryLog WHERE agentId=? AND recoveryId=?').get(agentId,plan.header.authorization.recoveryId))throw new GraphWitnessError('recovery-upload-already-applied');
    this.db.transaction(()=>{this.db.prepare('INSERT INTO witnessTransferAborts(agentId,transferId,signature) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(agentId,transferId,signature);this.db.prepare("UPDATE witnessTransferRows SET body='null' WHERE agentId=? AND transferId=? AND section IN ('revalidation','historical-rewrap')").run(agentId,transferId);this.recountTransferBytes(agentId,transferId);}).immediate();
  }
  beginBootstrapTransfer(agentId:string,plan:GraphBootstrapTransferPlan):{transferId:string} {
    const owner=this.options.enrollments[agentId]?.ownerPublicKey;
    if(!owner||!exactFields(plan,['transferId','payload','bootstrapSignature','counts'])||!opaque(plan.transferId)
      ||plan.transferId!==canonicalHash({payload:plan.payload,signature:plan.bootstrapSignature})
      ||!exactFields(plan.payload,['v','countsHash','recoveryHash','membershipsHash','operationsHash','erasuresHash','previousFenceEpoch',...(plan.payload.backupAttestationsHash===undefined?[]:['backupAttestationsHash']),...(plan.payload.archiveHash===undefined?[]:['archiveHash'])])||plan.payload.v!==1
      ||![plan.payload.countsHash,plan.payload.recoveryHash,plan.payload.membershipsHash,plan.payload.operationsHash,plan.payload.erasuresHash].every(hash)
      ||!Number.isSafeInteger(plan.payload.previousFenceEpoch)||plan.payload.previousFenceEpoch<0
      ||canonicalHash(plan.counts)!==plan.payload.countsHash
      ||!verifyGraphRecord('graph-witness-bootstrap-v1',plan.payload,plan.bootstrapSignature,owner)
      ||!exactFields(plan.counts,['control','membership','operation','erasure','revalidation','receipt','entry',...(plan.counts.backup===undefined?[]:['backup']),...(plan.counts['historical-rewrap']===undefined?[]:['historical-rewrap']),...(plan.counts.activation===undefined?[]:['activation']),...(plan.counts.context===undefined?[]:['context']),...(plan.counts['context-page']===undefined?[]:['context-page'])])
      ||Object.values(plan.counts).some(n=>!Number.isSafeInteger(n)||n<0)||plan.counts.control!==1||plan.counts.membership<1||plan.counts.membership>128
      ||plan.counts.operation>20000||plan.counts.erasure>20000||plan.counts.entry>20000||plan.counts.revalidation>512||plan.counts.receipt>64||(plan.counts.backup??0)>20000||(plan.counts['historical-rewrap']??0)>20000||(plan.payload.backupAttestationsHash!==undefined&&!hash(plan.payload.backupAttestationsHash))||(plan.payload.archiveHash===undefined&&(plan.counts.activation!==undefined||plan.counts.context!==undefined||plan.counts['context-page']!==undefined))||(plan.payload.archiveHash!==undefined&&(!hash(plan.payload.archiveHash)||plan.counts.activation!==plan.counts.membership-1||plan.counts.context!==plan.counts.activation||(plan.counts['context-page']??0)>127*1250)))throw new GraphWitnessError('bootstrap-transfer-plan-invalid',403);
    if(this.db.prepare('SELECT 1 FROM agents WHERE agentId=?').get(agentId)){const applied=this.db.prepare('SELECT requestHash FROM bootstrapRequests WHERE agentId=?').get(agentId) as {requestHash:string}|undefined;if(!applied||applied.requestHash!==canonicalHash({payload:plan.payload,signature:plan.bootstrapSignature}))throw new GraphWitnessError('bootstrap-nonempty-refused');}
    const body=canonicalJson(plan);const old=this.db.prepare('SELECT plan FROM witnessTransfers WHERE agentId=? AND transferId=?').get(agentId,plan.transferId) as {plan:string}|undefined;
    if(old&&old.plan!==body)throw new GraphWitnessError('bootstrap-transfer-conflict');
    this.db.prepare('INSERT INTO witnessTransfers(agentId,transferId,plan) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(agentId,plan.transferId,body);
    return {transferId:plan.transferId};
  }
  private transferPlan(agentId:string,transferId:string):GraphBootstrapTransferPlan {
    const row=this.db.prepare('SELECT plan FROM witnessTransfers WHERE agentId=? AND transferId=?').get(agentId,transferId) as {plan:string}|undefined;
    if(!row)throw new GraphWitnessError('bootstrap-transfer-unknown',404);
    if(this.db.prepare('SELECT 1 FROM witnessTransferStale WHERE agentId=? AND transferId=?').get(agentId,transferId))throw new GraphWitnessError('bootstrap-transfer-stale-erasure');
    if(this.db.prepare('SELECT 1 FROM witnessTransferAborts WHERE agentId=? AND transferId=?').get(agentId,transferId))throw new GraphWitnessError('bootstrap-transfer-aborted');
    const plan=JSON.parse(row.plan);if(plan.kind!==undefined)throw new GraphWitnessError('bootstrap-transfer-kind-invalid');return plan;
  }
  private transferValues(agentId:string,transferId:string,section:GraphBootstrapSection):Iterable<unknown> {
    const db=this.db;return {[Symbol.iterator]:function*(){let after=-1;while(true){const row=db.prepare('SELECT rowIndex,body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section=? AND rowIndex>? ORDER BY rowIndex LIMIT 1').get(agentId,transferId,section,after) as {rowIndex:number;body:string}|undefined;if(!row)return;after=row.rowIndex;yield JSON.parse(row.body);}}};
  }
  putBootstrapRow(agentId:string,transferId:string,section:GraphBootstrapSection,index:number,value:unknown):{hash:string} {
    const plan=this.transferPlan(agentId,transferId);
    if(!Object.hasOwn(plan.counts,section)||!Number.isSafeInteger(index)||index<0||index>=(plan.counts[section]??0))throw new GraphWitnessError('bootstrap-chunk-index-invalid',400);
    const body=canonicalJson(value);if(Buffer.byteLength(body)>2800000)throw new GraphWitnessError('bootstrap-chunk-too-large',413);
    const applied=this.db.prepare('SELECT requestHash FROM bootstrapRequests WHERE agentId=?').get(agentId) as {requestHash:string}|undefined;
    if(applied?.requestHash===canonicalHash({payload:plan.payload,signature:plan.bootstrapSignature}))return {hash:canonicalHash(value)};
    const bundleBinding=this.stagedBundleHash(section,value);
    const identityBinding=this.stagedIdentity(agentId,transferId,section,value,bundleBinding);
    if(identityBinding&&this.targetFence(agentId,identityBinding))throw new GraphWitnessError('source-erased');
    if(bundleBinding&&this.db.prepare('SELECT 1 FROM erasures WHERE agentId=? AND bundleHash=?').get(agentId,bundleBinding))throw new GraphWitnessError('source-erased');
    const owner=this.options.enrollments[agentId].ownerPublicKey;
    const memberships=()=>Array.from(this.transferValues(agentId,transferId,'membership')) as GraphMembershipEpoch[];
    const trusted=(id:string)=>{const key=this.options.historicalWitnessPublicKeys?.[id];if(!key)throw new GraphWitnessError('bootstrap-historical-witness-unpinned',403);return key;};
    if(section==='membership'){const m=value as GraphMembershipEpoch;if(!verifyMembershipEpoch(m,owner)||m.agentId!==agentId||m.epoch!==index+1)throw new GraphWitnessError('bootstrap-chunk-membership-invalid',403);trusted(m.witnessId);}
    else if(section==='erasure'){const e=value as GraphWitnessErasure;if(e.agentId!==agentId||!verifyWitnessErasure(e,trusted(e.witnessId)))throw new GraphWitnessError('bootstrap-chunk-erasure-invalid',403);}
    else if(section==='backup'){const proof=value as import('./GraphWitnessTypes.js').GraphBackupErasureAttestation;const key=this.historicalAuditorKey(agentId,proof.witnessId,memberships());const erasures=Array.from(this.transferValues(agentId,transferId,'erasure')) as GraphWitnessErasure[];const erasure=erasures.find(e=>e.requestId===proof.requestId);if(!opaque(proof.failureDomain)||!key||!erasure||!verifyBackupErasureAttestation(proof,erasure,proof.failureDomain,key,Date.parse(proof.checkedAt)))throw new GraphWitnessError('bootstrap-backup-evidence-invalid',403);}
    else if(section==='entry'){const e=value as GraphRecoverySourceManifest['entries'][number];if(!validateRecoverySourceManifest({v:1,agentId,membershipHash:'0'.repeat(64),highestCertifiedSequence:0,highestCertifiedCoreHash:null,highestAcknowledgedSequence:0,highestAcknowledgedCoreHash:null,entries:[e]}))throw new GraphWitnessError('bootstrap-chunk-entry-invalid',403);}
    else if(section==='activation'){
      const valueActivation=value as GraphMembershipActivationCertificate,history=memberships();if(!verifyMembershipActivation(valueActivation,owner,trusted(valueActivation.witnessId))||valueActivation.newMembership.epoch!==index+2||canonicalHash(valueActivation.previousMembership)!==canonicalHash(history[index])||canonicalHash(valueActivation.newMembership)!==canonicalHash(history[index+1]))throw new GraphWitnessError('bootstrap-activation-archive-invalid',403);
    }else if(section==='context'){
      const h=value as GraphContextArchiveHeader,archived=this.db.prepare("SELECT body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='activation' AND rowIndex=?").get(agentId,transferId,index) as {body:string}|undefined;
      if(!exactFields(h,['epoch','context','entryCount','pageOffset','pageCount'])||h.epoch!==index+2||!archived||canonicalHash(h.context?.activation)!==canonicalHash(JSON.parse(archived.body))||!exactFields(h.context,['activation','manifest','rewrapInventory','currentLease','originalCurrentLease'])||!validateRecoverySourceManifest(h.context.manifest)||h.context.manifest.entries.length||!Array.isArray(h.context.rewrapInventory)||h.context.rewrapInventory.length||!verifyFencedLeaseBridge(h.context.currentLease,h.context.originalCurrentLease,h.context.activation.newMembership)||h.context.currentLease.leaseEpoch!==h.context.activation.ownerAuthorization.fenceEpoch||!Number.isSafeInteger(h.entryCount)||h.entryCount<0||h.entryCount>20000||!Number.isSafeInteger(h.pageOffset)||h.pageOffset<0||h.pageCount!==Math.max(1,Math.ceil(h.entryCount/16)))throw new GraphWitnessError('bootstrap-context-archive-header-invalid',403);
      const previous=index?this.db.prepare("SELECT body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='context' AND rowIndex=?").get(agentId,transferId,index-1) as {body:string}|undefined:undefined;const previousHeader=previous?JSON.parse(previous.body) as GraphContextArchiveHeader:null;if(h.pageOffset!==(previousHeader?previousHeader.pageOffset+previousHeader.pageCount:0)||h.pageOffset+h.pageCount>(plan.counts['context-page']??0))throw new GraphWitnessError('bootstrap-context-archive-offset-invalid',403);
    }else if(section==='context-page'){
      const row=value as GraphContextArchivePage,stored=this.db.prepare("SELECT body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='context' AND json_extract(body,'$.epoch')=?").get(agentId,transferId,row?.epoch) as {body:string}|undefined;const h=stored?JSON.parse(stored.body) as GraphContextArchiveHeader:null;
      if(!h||!exactFields(row,['epoch','index','entries','rewrapInventory'])||!Number.isSafeInteger(row.index)||row.index<0||row.index>=h.pageCount||index!==h.pageOffset+row.index||!Array.isArray(row.entries)||row.entries.length!==Math.min(16,Math.max(0,h.entryCount-row.index*16))||!Array.isArray(row.rewrapInventory)||row.rewrapInventory.length!==row.entries.length||!validateRecoverySourceManifest({...h.context.manifest,entries:row.entries})||row.rewrapInventory.some(item=>!exactFields(item,['eventId','rewrapHash'])||!hash(item.rewrapHash)))throw new GraphWitnessError('bootstrap-context-archive-page-invalid',403);
      try{graphRewrapInventoryHash(row.rewrapInventory);}catch{throw new GraphWitnessError('bootstrap-context-archive-wrap-invalid',403);}
    }
    else if(section==='operation'){
      const row=value as GraphWitnessBootstrapRequest['operations'][number],op=row?.operation,p=op?.packet;const m=memberships().find(m=>m.epoch===p?.membershipEpoch);
      const lossSource=row?.kind==='member-loss-source';if(!exactFields(row,['operation','encryptedSourceBundle',...(lossSource?['kind']:[])])||!m||!validatePacket(p)||p.agentId!==agentId
        ||!exactFields(op,['packet','packetSignature','controlCapsule','prepareProof','erasedControlProof','state','certificate','cancellation','cancellationCertificate','erasure',...(lossSource?[]:['stateProof']),'adoption','rewrap','materialization','certificatePersistenceReceipts']))throw new GraphWitnessError('bootstrap-chunk-operation-invalid',403);
      if(!verifyGraphControlCapsule(op.controlCapsule,p,owner)||canonicalHash(op.controlCapsule.authorizationProof.membership)!==canonicalHash(m))throw new GraphWitnessError('bootstrap-chunk-control-invalid',403);
      const writer=m.members.find(member=>member.machineId===p.writerId);
      if(!writer||!verifyGraphRecord(D.packet,p,op.packetSignature,writer.signingPublicKey))throw new GraphWitnessError('bootstrap-packet-signature-invalid',403);
      if(lossSource){const control=Array.from(this.transferValues(agentId,transferId,'control'))[0] as GraphWitnessRecoveryRequest|undefined;if(!control)throw new GraphWitnessError('bootstrap-control-required');this.assertLossSourceImport(agentId,row,control,memberships().at(-1)!,owner);}
      const st=op.stateProof;
      if((!verifyGraphWitnessCustody(op.prepareProof,op.erasedControlProof,p,(op.erasedControlProof?memberships().find(epoch=>epoch.epoch===op.erasedControlProof!.custodyMembershipEpoch):m)?.witnessId??'',trusted(op.erasedControlProof?.witnessId??m.witnessId),op.erasure)&&!(lossSource&&op.adoption&&verifyGraphMemberLossNegativeCustody(op,m,owner,trusted(op.adoption.witnessId))))
        ||(!lossSource&&(!st||!exactFields(st,['v','agentId','idempotencyKey','operationHash','packetSignatureHash','erasedControlProofHash','state','certificateHash','cancellationHash','cancellationCertificateHash','erasureHash','adoptionHash','certificatePersistenceHash','rewrapHash','materializationHash','witnessId','observedAt','signature'])||!verifyGraphRecord(D.operationState,unsigned(st),st.signature,trusted(st.witnessId)))))throw new GraphWitnessError('bootstrap-chunk-proof-invalid',403);
      if(row.encryptedSourceBundle){validateBundle(row.encryptedSourceBundle,m);if(canonicalHash(row.encryptedSourceBundle)!==p.sourceBundleHash)throw new GraphWitnessError('bootstrap-chunk-source-hash-invalid',403);}
      if(op.adoption&&!verifyAdoptionCertificate(op.adoption,p,m,owner,trusted(op.adoption.witnessId)))throw new GraphWitnessError('bootstrap-chunk-adoption-invalid',403);
      if(op.certificate&&!verifyCommitCertificate(op.certificate,p,m,trusted(op.certificate.witnessId),owner))throw new GraphWitnessError('bootstrap-chunk-certificate-invalid',403);
      if(op.cancellationCertificate&&!verifyCancellationCertificate(op.cancellationCertificate,p,m,trusted(op.cancellationCertificate.witnessId),owner))throw new GraphWitnessError('bootstrap-chunk-certificate-invalid',403);
      if(op.erasure&&!verifyWitnessErasure(op.erasure,trusted(op.erasure.witnessId)))throw new GraphWitnessError('bootstrap-chunk-erasure-invalid',403);
      const effective=op.adoption?.newMembership??m,context=op.adoption?{membershipEpoch:effective.epoch,leaseEpoch:op.adoption.currentLease.leaseEpoch}:undefined;
      if(op.cancellation&&!verifyWitnessCancellation(op.cancellation,p,trusted(op.cancellation.witnessId),context))throw new GraphWitnessError('bootstrap-chunk-cancellation-invalid',403);
      if(op.materialization&&!validWitnessMaterializationRef(op.materialization))throw new GraphWitnessError('bootstrap-chunk-materialization-invalid',403);
      const rewrapMembership=op.materialization?memberships().find(epoch=>epoch.epoch===op.materialization!.epoch):effective;
      if(op.rewrap&&(!rewrapMembership||!row.encryptedSourceBundle||canonicalHash(op.rewrap)!==(op.materialization?.rewrapHash??op.adoption?.rewrapHash)||!verifyBundleRewrap(op.rewrap,row.encryptedSourceBundle,rewrapMembership)))throw new GraphWitnessError('bootstrap-chunk-rewrap-invalid',403);
      if(!Array.isArray(op.certificatePersistenceReceipts)||op.certificatePersistenceReceipts.some(r=>!verifyMemberReceipt(r,p,effective,'certificate',canonicalHash(op.certificate??op.cancellationCertificate),context)))throw new GraphWitnessError('bootstrap-chunk-receipt-invalid',403);
    }else{
      const control=Array.from(this.transferValues(agentId,transferId,'control'))[0] as GraphWitnessRecoveryRequest|undefined;
      if(section==='control'){
        const c=value as GraphWitnessRecoveryRequest;const previous=memberships().at(-1);
        if(!exactFields(c,['newMembership','authorization','currentLease','originalCurrentLease','sourceManifest',...(c.ownedTransition===undefined?[]:['ownedTransition']),...(c.memberLoss===undefined?[]:['memberLoss']),...(c.lossControls===undefined?[]:['lossControls'])])||!previous||!verifyRecoveryAuthorization(c.authorization,previous,c.newMembership,owner)
          ||!verifyFencedLeaseBridge(c.currentLease,c.originalCurrentLease,c.newMembership)||!validateRecoverySourceManifest(c.sourceManifest)||c.sourceManifest.entries.length)throw new GraphWitnessError('bootstrap-chunk-control-invalid',403);
      }else if(!control)throw new GraphWitnessError('bootstrap-control-required');
      else if(section==='receipt'){if(!verifyMembershipTransferReceipt(value as import('./GraphWitnessTypes.js').GraphMembershipTransferReceipt,control.authorization,control.newMembership))throw new GraphWitnessError('bootstrap-chunk-transfer-receipt-invalid',403);}
      else if(section==='historical-rewrap'){
        const item=value as {eventId:string;rewrap:GraphBundleRewrap};
        const row=this.db.prepare("SELECT body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='operation' AND json_extract(body,'$.operation.packet.eventId')=?").get(agentId,transferId,item?.eventId) as {body:string}|undefined;
        const op=row?JSON.parse(row.body) as GraphWitnessBootstrapRequest['operations'][number]:null;
        if(!exactFields(item,['eventId','rewrap'])||!op||!op.encryptedSourceBundle||item.rewrap.eventId!==item.eventId||item.rewrap.writerId!==control.currentLease.writerId||!verifyBundleRewrap(item.rewrap,op.encryptedSourceBundle,control.newMembership))throw new GraphWitnessError('bootstrap-chunk-historical-rewrap-invalid',403);
      }
      else if(section==='revalidation'){
        const item=value as {proof:GraphPendingRevalidation;rewrap:GraphBundleRewrap|null};
        const row=this.db.prepare("SELECT body FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section='operation' AND json_extract(body,'$.operation.packet.idempotencyKey')=?").get(agentId,transferId,item?.proof?.idempotencyKey) as {body:string}|undefined;
        const op=row?JSON.parse(row.body) as GraphWitnessBootstrapRequest['operations'][number]:null;
        if(!exactFields(item,['proof','rewrap'])||!op||!verifyPendingRevalidation(item.proof,op.operation.packet,control.newMembership,control.currentLease)||item.proof.rewrapHash!==canonicalHash(item.rewrap)
          ||(item.rewrap&&(!op.encryptedSourceBundle||!verifyBundleRewrap(item.rewrap,op.encryptedSourceBundle,control.newMembership))))throw new GraphWitnessError('bootstrap-chunk-revalidation-invalid',403);
      }
    }
    const digest=canonicalHash(value);const old=this.db.prepare('SELECT hash FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section=? AND rowIndex=?').get(agentId,transferId,section,index) as {hash:string}|undefined;
    if(old&&old.hash!==digest)throw new GraphWitnessError('bootstrap-chunk-conflict');
    return this.db.transaction(()=>{
      if(identityBinding&&this.targetFence(agentId,identityBinding))throw new GraphWitnessError('source-erased');
      if(bundleBinding&&this.db.prepare('SELECT 1 FROM erasures WHERE agentId=? AND bundleHash=?').get(agentId,bundleBinding))throw new GraphWitnessError('source-erased');
      const existing=this.db.prepare('SELECT hash FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section=? AND rowIndex=?').get(agentId,transferId,section,index) as {hash:string}|undefined;
      if(existing){if(existing.hash!==digest)throw new GraphWitnessError('bootstrap-chunk-conflict');return {hash:digest};}
      const quota=this.options.maxBootstrapStagingBytes??64*1024*1024*1024;
      const used=this.db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM witnessTransferUsage').get() as {n:number};
      const bytes=Buffer.byteLength(body);if(!Number.isSafeInteger(quota)||quota<=0||used.n+bytes>quota)throw new GraphWitnessError('bootstrap-staging-capacity-reached',413);
      this.db.prepare('INSERT INTO witnessTransferRows(agentId,transferId,section,rowIndex,hash,body) VALUES(?,?,?,?,?,?)').run(agentId,transferId,section,index,digest,body);
      if(bundleBinding)this.db.prepare('INSERT INTO witnessTransferBindings(agentId,transferId,section,rowIndex,bundleHash) VALUES(?,?,?,?,?)').run(agentId,transferId,section,index,bundleBinding);
      if(bundleBinding&&identityBinding)this.db.prepare('INSERT INTO witnessTransferTargets(agentId,transferId,section,rowIndex,sourceKind,sourceId,bundleHash) VALUES(?,?,?,?,?,?,?)').run(agentId,transferId,section,index,identityBinding.sourceKind,identityBinding.sourceId,bundleBinding);
      this.db.prepare('INSERT INTO witnessTransferUsage(agentId,transferId,bytes) VALUES(?,?,?) ON CONFLICT(agentId,transferId) DO UPDATE SET bytes=bytes+excluded.bytes').run(agentId,transferId,bytes);
      return {hash:digest};
    }).immediate();
  }
  finishBootstrapTransfer(agentId:string,transferId:string):{activation:GraphMembershipActivationCertificate;adoptions:GraphAdoptionCertificate[]} {
    const plan=this.transferPlan(agentId,transferId);
    const applied=this.db.prepare('SELECT requestHash,response FROM bootstrapRequests WHERE agentId=?').get(agentId) as {requestHash:string;response:string}|undefined;
    if(applied?.requestHash===canonicalHash({payload:plan.payload,signature:plan.bootstrapSignature}))return JSON.parse(applied.response);
    for(const [section,count]of Object.entries(plan.counts)){const row=this.db.prepare('SELECT COUNT(*) AS n FROM witnessTransferRows WHERE agentId=? AND transferId=? AND section=?').get(agentId,transferId,section) as {n:number};if(row.n!==count)throw new GraphWitnessError('bootstrap-transfer-incomplete');}
    const values=(section:GraphBootstrapSection)=>Array.from(this.transferValues(agentId,transferId,section));
    const recovery=values('control')[0] as GraphWitnessRecoveryRequest;
    recovery.revalidations=values('revalidation') as GraphWitnessRecoveryRequest['revalidations'];recovery.stateTransferReceipts=values('receipt') as GraphWitnessRecoveryRequest['stateTransferReceipts'];recovery.sourceManifest.entries=values('entry') as GraphRecoverySourceManifest['entries'];
    if(plan.counts['historical-rewrap']!==undefined)recovery.historicalRewraps=[];
    const memberships=values('membership') as GraphMembershipEpoch[],erasures=values('erasure') as GraphWitnessErasure[];
    const archive=plan.payload.archiveHash===undefined?undefined:{hash:plan.payload.archiveHash,counts:{activation:plan.counts.activation??0,context:plan.counts.context??0,'context-page':plan.counts['context-page']??0},activations:()=>this.transferValues(agentId,transferId,'activation') as Iterable<GraphMembershipActivationCertificate>,contexts:()=>this.archiveContexts(agentId,transferId)};
    if(archive){const digest=crypto.createHash('sha256');digest.update('{"activations":[');let first=true;for(const activation of archive.activations()){if(!first)digest.update(',');digest.update(canonicalJson(activation));first=false;}digest.update('],"contexts":[');first=true;for(const context of archive.contexts()){if(!first)digest.update(',');digest.update(canonicalJson(context));first=false;}digest.update(']}');if(digest.digest('hex')!==archive.hash)throw new GraphWitnessError('bootstrap-archive-hash-mismatch');}
    const backupAttestations=plan.payload.backupAttestationsHash===undefined?undefined:values('backup') as import('./GraphWitnessTypes.js').GraphBackupErasureAttestation[];
    if(backupAttestations&&canonicalHash(backupAttestations)!==plan.payload.backupAttestationsHash)throw new GraphWitnessError('bootstrap-backup-evidence-manifest-mismatch');
    // Stream the potentially many gigabytes of ciphertext through SHA256 and
    // SQLite iterators. Never concatenate the full operation history in memory.
    const operationRows=()=>this.transferValues(agentId,transferId,'operation') as Iterable<GraphWitnessBootstrapRequest['operations'][number]>;
    const digest=crypto.createHash('sha256');digest.update('[');let first=true;for(const row of operationRows()){if(!first)digest.update(',');digest.update(canonicalJson(row));first=false;}digest.update(']');const operationsHash=digest.digest('hex');
    const apply=()=>{if((this.stagedRecoveryRows.get(recovery)?.hash??canonicalHash(recovery))!==plan.payload.recoveryHash||canonicalHash(memberships)!==plan.payload.membershipsHash||canonicalHash(erasures)!==plan.payload.erasuresHash||operationsHash!==plan.payload.operationsHash)throw new GraphWitnessError('bootstrap-transfer-manifest-mismatch');
    return this.db.transaction(()=>{const response=this.bootstrap(agentId,{recovery,memberships,erasures,...(archive?{archive:{activations:[],contexts:[]}}:{}),...(backupAttestations?{backupAttestations}:{}),operations:[],previousFenceEpoch:plan.payload.previousFenceEpoch,bootstrapSignature:plan.bootstrapSignature},{operationCount:plan.counts.operation,operationsHash,operations:operationRows,...(archive?{archive}:{})});
      this.db.prepare("UPDATE witnessTransferRows SET body='null' WHERE agentId=? AND transferId=? AND section IN ('operation','revalidation','historical-rewrap')").run(agentId,transferId);this.recountTransferBytes(agentId,transferId);return response;}).immediate();};
    return plan.counts['historical-rewrap']===undefined?apply():this.withStagedRecoveryRows(agentId,transferId,recovery,plan.counts['historical-rewrap'],plan.payload.recoveryHash,apply);
  }
  abortBootstrapTransfer(agentId:string,transferId:string,signature:string):void {
    this.transferPlan(agentId,transferId);const owner=this.options.enrollments[agentId]?.ownerPublicKey;
    if(!owner||!verifyGraphRecord('graph-witness-transfer-abort-v1',{agentId,transferId},signature,owner))throw new GraphWitnessError('bootstrap-abort-proof-invalid',403);
    this.db.transaction(()=>{this.db.prepare('INSERT INTO witnessTransferAborts(agentId,transferId,signature) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(agentId,transferId,signature);
      this.db.prepare("UPDATE witnessTransferRows SET body='null' WHERE agentId=? AND transferId=? AND section IN ('operation','revalidation','historical-rewrap')").run(agentId,transferId);this.recountTransferBytes(agentId,transferId);}).immediate();
  }
  private recountTransferBytes(agentId:string,transferId:string):void {const row=this.db.prepare('SELECT COALESCE(SUM(length(CAST(body AS BLOB))),0) AS n FROM witnessTransferRows WHERE agentId=? AND transferId=?').get(agentId,transferId) as {n:number};this.db.prepare('INSERT INTO witnessTransferUsage(agentId,transferId,bytes) VALUES(?,?,?) ON CONFLICT(agentId,transferId) DO UPDATE SET bytes=excluded.bytes').run(agentId,transferId,row.n);}
  bootstrapTransferAdoption(agentId:string,transferId:string,index:number):GraphAdoptionCertificate {
    const plan=this.transferPlan(agentId,transferId);const row=this.db.prepare('SELECT requestHash,response FROM bootstrapRequests WHERE agentId=?').get(agentId) as {requestHash:string;response:string}|undefined;
    if(!row||row.requestHash!==canonicalHash({payload:plan.payload,signature:plan.bootstrapSignature}))throw new GraphWitnessError('bootstrap-transfer-not-activated');
    const result=JSON.parse(row.response) as {adoptions:GraphAdoptionCertificate[]};
    if(!Number.isSafeInteger(index)||index<0||index>=result.adoptions.length)throw new GraphWitnessError('bootstrap-result-index-invalid',404);return result.adoptions[index];
  }
  /** Empty-disk replacement only. No imported bytes become admitted until the
   * owner-signed higher fence AND all new members' real source transfer verify. */
  bootstrap(agentId:string, request:GraphWitnessBootstrapRequest, staged?:{operationCount:number;operationsHash:string;operations:()=>Iterable<GraphWitnessBootstrapRequest['operations'][number]>;archive?:{hash:string;counts:Record<string,number>;activations:()=>Iterable<GraphMembershipActivationCertificate>;contexts:()=>Iterable<GraphWitnessRecoveryContext>}}):{activation:GraphMembershipActivationCertificate;adoptions:GraphAdoptionCertificate[]} {
    const owner=this.options.enrollments[agentId]?.ownerPublicKey;
    const operationCount=staged?.operationCount??request.operations.length;
    const operations=staged?.operations??(()=>request.operations);
    const stagedRows=this.stagedRecoveryRows.get(request.recovery);
    const signedPayload={...(graphWitnessBootstrapPayload(request) as Record<string,unknown>),...(stagedRows?{recoveryHash:stagedRows.hash}:{}),...(staged?{operationsHash:staged.operationsHash,countsHash:canonicalHash({...graphWitnessBootstrapCounts(request,operationCount,staged.archive?.counts),...(stagedRows?{'historical-rewrap':stagedRows.count}:{})}),...(staged.archive?{archiveHash:staged.archive.hash}:{})}:{})};
    const transition=request.recovery?.ownedTransition,ownedSameNative=!!owner&&!!transition&&verifyGraphCustodyRetirement(transition.retirement,transition.stage,transition.holds,owner)&&request.recovery.authorization.fenceEpoch===request.previousFenceEpoch&&transition.retirement.lease.leaseEpoch===request.previousFenceEpoch&&request.recovery.currentLease.leaseEpoch===request.previousFenceEpoch&&transition.retirement.lease.writerId===request.recovery.currentLease.writerId;
    if((request.archive!==undefined&&(!exactFields(request.archive,['activations','contexts'])||!Array.isArray(request.archive.activations)||!Array.isArray(request.archive.contexts)))||!owner||!exactFields(request,['recovery','memberships','operations','erasures','previousFenceEpoch','bootstrapSignature',...(request.backupAttestations===undefined?[]:['backupAttestations']),...(request.archive===undefined?[]:['archive'])])
      ||!Number.isSafeInteger(request.previousFenceEpoch)||request.previousFenceEpoch<0
      ||(request.recovery.authorization.fenceEpoch<=request.previousFenceEpoch&&!ownedSameNative)
      ||!Array.isArray(request.memberships)||!request.memberships.length||!Array.isArray(request.operations)||operationCount>20000
      ||!Array.isArray(request.erasures)||request.erasures.length>20000
      ||!verifyGraphRecord('graph-witness-bootstrap-v1',signedPayload,request.bootstrapSignature,owner))throw new GraphWitnessError('bootstrap-owner-proof-invalid',403);
    const bootstrapHash=canonicalHash({payload:signedPayload,signature:request.bootstrapSignature});
    const existingBootstrap=this.db.prepare('SELECT requestHash,response FROM bootstrapRequests WHERE agentId=?').get(agentId) as {requestHash:string;response:string}|undefined;
    if(existingBootstrap){if(existingBootstrap.requestHash!==bootstrapHash)throw new GraphWitnessError('bootstrap-idempotency-conflict');return JSON.parse(existingBootstrap.response);}
    if(this.db.prepare('SELECT 1 FROM agents WHERE agentId=?').get(agentId))throw new GraphWitnessError('bootstrap-nonempty-refused');
    const previous=request.memberships.at(-1)!;
    if(previous.agentId!==agentId||previous.witnessId===this.options.witnessId||request.recovery.authorization.previousMembershipHash!==canonicalHash(previous))throw new GraphWitnessError('bootstrap-membership-invalid',403);
    const trusted=(id:string):string=>{const key=this.options.historicalWitnessPublicKeys?.[id];if(!key||!canonicalPublicKey(key,'ed25519'))throw new GraphWitnessError('bootstrap-historical-witness-unpinned',403);return key;};
    for(let index=0;index<request.memberships.length;index++){
      const m=request.memberships[index];trusted(m.witnessId);
      if(!verifyMembershipEpoch(m,owner)||m.agentId!==agentId||m.epoch!==index+1||m.previousMembershipHash!==(index?canonicalHash(request.memberships[index-1]):null))throw new GraphWitnessError('bootstrap-membership-chain-invalid',403);
    }
    const archivedActivations=staged?.archive?.activations??(()=>request.archive?.activations??[]),archivedContexts=staged?.archive?.contexts??(()=>request.archive?.contexts??[]);
    const activationMap=new Map<number,GraphMembershipActivationCertificate>();for(const activation of archivedActivations()){
      const epoch=activation?.newMembership?.epoch;if(!Number.isSafeInteger(epoch)||epoch<2||epoch>previous.epoch||activationMap.has(epoch)||!verifyMembershipActivation(activation,owner,trusted(activation.witnessId))||canonicalHash(activation.newMembership)!==canonicalHash(request.memberships[epoch-1])||canonicalHash(activation.previousMembership)!==canonicalHash(request.memberships[epoch-2]))throw new GraphWitnessError('bootstrap-activation-archive-invalid',403);activationMap.set(epoch,activation);
    }
    if(activationMap.size!==previous.epoch-1)throw new GraphWitnessError('bootstrap-activation-archive-incomplete');
    const contextRefs=new Map<number,Omit<GraphWitnessMaterializationRef,'rewrapHash'>>();for(const context of archivedContexts()){
      const epoch=context?.activation?.newMembership?.epoch,activation=activationMap.get(epoch);if(!activation||contextRefs.has(epoch)||!this.validArchivedContext(context,activation,owner,trusted(activation.witnessId)))throw new GraphWitnessError('bootstrap-context-archive-invalid',403);
      contextRefs.set(epoch,{epoch,activationHash:canonicalHash(context.activation),manifestHash:canonicalHash(context.manifest),rewrapInventoryHash:graphRewrapInventoryHash(context.rewrapInventory),leaseHash:canonicalHash(context.currentLease),originalLeaseHash:canonicalHash(context.originalCurrentLease)});
    }
    if(contextRefs.size!==activationMap.size)throw new GraphWitnessError('bootstrap-context-archive-incomplete');
    const tombstones=new Map<string,GraphWitnessErasure>();const logicalTombstones=new Map<string,GraphWitnessErasure>();const erasureRequestIds=new Set<string>();
    for(const erasure of request.erasures){
      if(erasureRequestIds.has(erasure.requestId)||erasure.agentId!==agentId||!verifyWitnessErasure(erasure,trusted(erasure.witnessId)))throw new GraphWitnessError('bootstrap-erasure-invalid',403);
      erasureRequestIds.add(erasure.requestId);if(!logicalTombstones.has(canonicalHash(erasure.target)))logicalTombstones.set(canonicalHash(erasure.target),erasure);
      for(const bundleHash of erasure.bundleHashes)if(!tombstones.has(bundleHash))tombstones.set(bundleHash,erasure);
    }
    // An unfinished role may already have received a newer negative fact.
    // A signed older transfer cannot omit it and restore its key envelopes.
    for(const retained of this.db.prepare('SELECT proof FROM erasureRequests WHERE agentId=? UNION SELECT proof FROM targetErasures WHERE agentId=?').all(agentId,agentId) as Array<{proof:string}>){const proof=JSON.parse(retained.proof) as GraphWitnessErasure;if(!request.erasures.some(candidate=>canonicalHash(candidate)===canonicalHash(proof)))throw new GraphWitnessError('bootstrap-retained-erasure-omitted');}
    for(const retained of this.db.prepare('SELECT sourceKind,sourceId FROM localTargetErasures WHERE agentId=?').all(agentId) as Array<{sourceKind:string;sourceId:string}>){if(!request.erasures.some(proof=>proof.target.sourceKind===retained.sourceKind&&proof.target.sourceId===retained.sourceId))throw new GraphWitnessError('bootstrap-local-erasure-evidence-missing');}
    for(const proof of request.backupAttestations??[]){const key=this.historicalAuditorKey(agentId,proof.witnessId,request.memberships);const erasure=request.erasures.find(e=>e.requestId===proof.requestId);if(!opaque(proof.failureDomain)||!key||!erasure||!verifyBackupErasureAttestation(proof,erasure,proof.failureDomain,key,Date.parse(proof.checkedAt)))throw new GraphWitnessError('bootstrap-backup-evidence-invalid',403);}
    const keys=new Set<string>();const events=new Set<string>();
    for(const row of operations()){
      const lossSource=row?.kind==='member-loss-source';if(!exactFields(row,['operation','encryptedSourceBundle',...(lossSource?['kind']:[])]))throw new GraphWitnessError('bootstrap-operation-shape-invalid',403);
      const op=row.operation,p=op.packet,m=request.memberships[p.membershipEpoch-1];
      if(!m||!validatePacket(p)||p.agentId!==agentId||keys.has(p.idempotencyKey)||events.has(p.eventId)
        ||!exactFields(op,['packet','packetSignature','controlCapsule','prepareProof','erasedControlProof','state','certificate','cancellation','cancellationCertificate','erasure',...(lossSource?[]:['stateProof']),'adoption','rewrap','materialization','certificatePersistenceReceipts']))throw new GraphWitnessError('bootstrap-operation-invalid',403);
      keys.add(p.idempotencyKey);events.add(p.eventId);
      if(lossSource)this.assertLossSourceImport(agentId,row,request.recovery,previous,owner);
      if(!verifyGraphControlCapsule(op.controlCapsule,p,owner)||canonicalHash(op.controlCapsule.authorizationProof.membership)!==canonicalHash(m))throw new GraphWitnessError('bootstrap-control-invalid',403);
      const writer=m.members.find(member=>member.machineId===p.writerId);if(!writer||!verifyGraphRecord(D.packet,p,op.packetSignature,writer.signingPublicKey))throw new GraphWitnessError('bootstrap-packet-signature-invalid',403);
      if(!verifyGraphWitnessCustody(op.prepareProof,op.erasedControlProof,p,(op.erasedControlProof?request.memberships.find(epoch=>epoch.epoch===op.erasedControlProof!.custodyMembershipEpoch):m)?.witnessId??'',trusted(op.erasedControlProof?.witnessId??m.witnessId),op.erasure)&&!(lossSource&&op.adoption&&verifyGraphMemberLossNegativeCustody(op,m,owner,trusted(op.adoption.witnessId))))throw new GraphWitnessError('bootstrap-custody-invalid',403);
      const state=op.stateProof;
      if(!lossSource&&(!state||!exactFields(state,['v','agentId','idempotencyKey','operationHash','packetSignatureHash','erasedControlProofHash','state','certificateHash','cancellationHash','cancellationCertificateHash','erasureHash','adoptionHash','certificatePersistenceHash','rewrapHash','materializationHash','witnessId','observedAt','signature'])
        ||state.agentId!==agentId||state.idempotencyKey!==p.idempotencyKey||state.operationHash!==canonicalHash(p)||state.packetSignatureHash!==canonicalHash(op.packetSignature)||state.erasedControlProofHash!==(op.erasedControlProof?canonicalHash(op.erasedControlProof):null)||state.state!==op.state
        ||state.certificateHash!==(op.certificate?canonicalHash(op.certificate):null)||state.cancellationHash!==(op.cancellation?canonicalHash(op.cancellation):null)
        ||state.cancellationCertificateHash!==(op.cancellationCertificate?canonicalHash(op.cancellationCertificate):null)||state.erasureHash!==(op.erasure?canonicalHash(op.erasure):null)
        ||state.materializationHash!==(op.materialization?canonicalHash(op.materialization):null)||state.rewrapHash!==(op.rewrap?canonicalHash(op.rewrap):null)||state.adoptionHash!==(op.adoption?canonicalHash(op.adoption):null)||!Array.isArray(op.certificatePersistenceReceipts)||state.certificatePersistenceHash!==canonicalHash(op.certificatePersistenceReceipts)
        ||!verifyGraphRecord(D.operationState,unsigned(state),state.signature,trusted(state.witnessId))))throw new GraphWitnessError('bootstrap-state-invalid',403);
      if(op.adoption&&!verifyAdoptionCertificate(op.adoption,p,m,owner,trusted(op.adoption.witnessId)))throw new GraphWitnessError('bootstrap-adoption-invalid',403);
      if(op.materialization&&!validWitnessMaterializationRef(op.materialization))throw new GraphWitnessError('bootstrap-materialization-invalid',403);
      if(op.materialization){const {rewrapHash:_wrap,...ref}=op.materialization;if(canonicalHash(contextRefs.get(ref.epoch))!==canonicalHash(ref))throw new GraphWitnessError('bootstrap-materialization-archive-missing',403);}
      const rewrapMembership=op.materialization?request.memberships.find(epoch=>epoch.epoch===op.materialization!.epoch):op.adoption?.newMembership;
      if(op.rewrap&&(!rewrapMembership||canonicalHash(op.rewrap)!==(op.materialization?.rewrapHash??op.adoption?.rewrapHash)||!row.encryptedSourceBundle||!verifyBundleRewrap(op.rewrap,row.encryptedSourceBundle,rewrapMembership)))throw new GraphWitnessError('bootstrap-rewrap-invalid',403);
      if((tombstones.has(p.sourceBundleHash)||logicalTombstones.has(canonicalHash(p.erasureIdentity)))&&op.rewrap)throw new GraphWitnessError('bootstrap-erased-rewrap-returned',403);
      const effective=op.adoption?.newMembership??m;const context=op.adoption?{membershipEpoch:effective.epoch,leaseEpoch:op.adoption.currentLease.leaseEpoch}:undefined;
      if(op.certificate&&!verifyCommitCertificate(op.certificate,p,m,trusted(op.certificate.witnessId),owner))throw new GraphWitnessError('bootstrap-certificate-invalid',403);
      if(op.cancellationCertificate&&!verifyCancellationCertificate(op.cancellationCertificate,p,m,trusted(op.cancellationCertificate.witnessId),owner))throw new GraphWitnessError('bootstrap-cancellation-certificate-invalid',403);
      if(op.cancellation&&!verifyWitnessCancellation(op.cancellation,p,trusted(op.cancellation.witnessId),context))throw new GraphWitnessError('bootstrap-cancellation-invalid',403);
      if(op.erasure){if(!erasureCoversPacket(op.erasure,p)||!request.erasures.some(proof=>canonicalHash(proof)===canonicalHash(op.erasure)))throw new GraphWitnessError('bootstrap-erasure-missing',403);tombstones.set(p.sourceBundleHash,op.erasure);}
      if((op.state==='certified'&&!op.certificate)||(op.state==='canceled'&&!op.cancellation)||(op.state==='erased'&&!op.erasure))throw new GraphWitnessError('bootstrap-terminal-missing',403);
      const terminal=op.certificate??op.cancellationCertificate;
      const receiptIds=new Set<string>();for(const receipt of op.certificatePersistenceReceipts){if(!terminal||receiptIds.has(receipt.machineId)||!verifyMemberReceipt(receipt,p,effective,'certificate',canonicalHash(terminal),context))throw new GraphWitnessError('bootstrap-persistence-invalid',403);receiptIds.add(receipt.machineId);}
      if(tombstones.has(p.sourceBundleHash)||logicalTombstones.has(canonicalHash(p.erasureIdentity))){if(row.encryptedSourceBundle)throw new GraphWitnessError('bootstrap-erased-source-returned',403);}
      else{if(!row.encryptedSourceBundle||canonicalHash(row.encryptedSourceBundle)!==p.sourceBundleHash)throw new GraphWitnessError('bootstrap-source-missing',403);validateBundle(row.encryptedSourceBundle,m);}
    }
    return this.db.transaction(()=>{
      for(const m of request.memberships)this.db.prepare('INSERT INTO memberships(agentId,epoch,hash,body) VALUES(?,?,?,?)').run(agentId,m.epoch,canonicalHash(m),canonicalJson(m));
      this.db.prepare('INSERT INTO agents(agentId,epoch,leaseEpoch,certifiedSequence,certifiedCoreHash) VALUES(?,?,?,?,?)').run(agentId,previous.epoch,request.previousFenceEpoch,request.recovery.sourceManifest.highestCertifiedSequence,request.recovery.sourceManifest.highestCertifiedCoreHash);
      for(const activation of archivedActivations())this.db.prepare('INSERT INTO membershipActivations(agentId,epoch,body) VALUES(?,?,?)').run(agentId,activation.newMembership.epoch,canonicalJson(activation));
      for(const context of archivedContexts())this.db.prepare('INSERT INTO recoveryContexts(agentId,epoch,body) VALUES(?,?,?)').run(agentId,context.activation.newMembership.epoch,canonicalJson(context));
      for(const row of operations()){const op=row.operation,p=op.packet;
        this.db.prepare('INSERT INTO controls(agentId,eventId,body) VALUES(?,?,?)').run(agentId,p.eventId,canonicalJson(op.controlCapsule));
        if(op.erasedControlProof)this.db.prepare('INSERT INTO erasedControls(agentId,eventId,body) VALUES(?,?,?)').run(agentId,p.eventId,canonicalJson(op.erasedControlProof));
        this.db.prepare('INSERT INTO operations(agentId,idempotencyKey,eventId,operationHash,packet,packetSignature,prepareProof,state,certificate,cancellation,cancellationCertificate,adoption) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(agentId,p.idempotencyKey,p.eventId,canonicalHash(p),canonicalJson(p),op.packetSignature,canonicalJson(op.prepareProof),op.state,op.certificate?canonicalJson(op.certificate):null,op.cancellation?canonicalJson(op.cancellation):null,op.cancellationCertificate?canonicalJson(op.cancellationCertificate):null,op.adoption?canonicalJson(op.adoption):null);
        this.db.prepare('INSERT INTO bundles(agentId,hash,ciphertext) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(agentId,p.sourceBundleHash,row.encryptedSourceBundle?canonicalJson(row.encryptedSourceBundle):null);
        if(op.materialization)this.db.prepare('INSERT INTO materializations(agentId,eventId,body) VALUES(?,?,?)').run(agentId,p.eventId,canonicalJson(op.materialization));
        if(op.rewrap)this.db.prepare('INSERT INTO rewraps(agentId,eventId,body) VALUES(?,?,?)').run(agentId,p.eventId,canonicalJson(op.rewrap));
        for(const receipt of op.certificatePersistenceReceipts)this.db.prepare('INSERT INTO certificateReceipts(agentId,eventId,machineId,receipt) VALUES(?,?,?,?)').run(agentId,p.eventId,receipt.machineId,canonicalJson(receipt));
      }
      for(const proof of request.erasures)this.db.prepare('INSERT INTO targetErasures(agentId,sourceKind,sourceId,proof) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(agentId,proof.target.sourceKind,proof.target.sourceId,canonicalJson(proof));
      for(const [bundleHash,proof]of tombstones)this.db.prepare('INSERT INTO erasures(agentId,bundleHash,proof) VALUES(?,?,?)').run(agentId,bundleHash,canonicalJson(proof));
      for(const proof of request.erasures)this.db.prepare('INSERT INTO erasureRequests(agentId,requestId,requestHash,proof) VALUES(?,?,?,?)').run(agentId,proof.requestId,canonicalHash({target:proof.target,bundleHashes:[...proof.bundleHashes].sort(),authorizationReceiptHash:proof.authorizationReceiptHash}),canonicalJson(proof));
      for(const proof of request.backupAttestations??[])this.db.prepare('INSERT INTO backupErasureAttestations(agentId,requestId,body) VALUES(?,?,?)').run(agentId,proof.requestId,canonicalJson(proof));
      this.importMemberLossControls(agentId,request.recovery,owner);
      this.ensureWitnessedTip(agentId);
      const actual=this.recoveryManifest(agentId);
      if(canonicalHash(actual)!==canonicalHash(request.recovery.sourceManifest))throw new GraphWitnessError('bootstrap-manifest-incomplete');
      // Recompute contiguous certified chain independently of caller watermarks.
      let seq=0,core:string|null=null;
      const chain=Array.from(operations(),row=>({packet:row.operation.packet,terminal:!!(row.operation.certificate||row.operation.cancellationCertificate)})).sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence);
      for(const item of chain){const op={packet:item.packet,certificate:item.terminal,cancellationCertificate:false};if(!op.certificate&&!op.cancellationCertificate)continue;if(op.packet.sourceSequence!==seq+1||op.packet.predecessorHash!==core)throw new GraphWitnessError('bootstrap-certified-chain-gap');seq=op.packet.sourceSequence;core=op.packet.coreHash;}
      if(seq!==actual.highestCertifiedSequence||core!==actual.highestCertifiedCoreHash)throw new GraphWitnessError('bootstrap-certified-watermark-invalid');
      const response=this.recoverPending(agentId,request.recovery);
      this.db.prepare('INSERT INTO bootstrapRequests(agentId,requestHash,response) VALUES(?,?,?)').run(agentId,bootstrapHash,canonicalJson(response));
      return response;
    }).immediate();
  }
  private requireHistoryCapacity(agentId:string):void {
    // Exact recoveryManifest population: all operation states, including erased/canceled/control-only.
    const count=(this.db.prepare('SELECT COUNT(*) AS n FROM operations WHERE agentId=?').get(agentId) as {n:number}).n;
    if(count>=(this.options.maxHistoryEntries??GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES))throw new GraphWitnessError('witness-history-capacity',413);
  }
  prepare({ packet, lease, originalLease, encryptedSourceBundle, packetSignature, controlCapsule }: GraphWitnessPrepareRequest): GraphWitnessPrepareProof {
    if (!validatePacket(packet)) throw new GraphWitnessError('operation-packet-invalid', 400);
    if(!verifyGraphControlCapsule(controlCapsule,packet,this.options.enrollments[packet.agentId]?.ownerPublicKey))throw new GraphWitnessError('operation-control-invalid',403);
    this.observeLease(packet.agentId, lease, originalLease);
    return this.db.transaction(() => {
      const membership = this.admission(packet.agentId, lease, originalLease);this.assertPositiveMembershipActive(packet.agentId,membership);
      if (packet.membershipEpoch !== membership.epoch || packet.leaseEpoch !== lease.leaseEpoch || packet.writerId !== lease.writerId) throw new GraphWitnessError('operation-lease-mismatch', 403);
      if(canonicalHash(controlCapsule.authorizationProof.membership)!==canonicalHash(membership))throw new GraphWitnessError('operation-control-membership-mismatch',403);
      const signer = membership.members.find((m) => m.machineId === packet.writerId)!;
      if (!verifyGraphRecord(D.packet, packet, packetSignature, signer.signingPublicKey)) throw new GraphWitnessError('operation-signature-invalid', 403);
      validateBundle(encryptedSourceBundle, membership);
      if (canonicalHash(encryptedSourceBundle) !== packet.sourceBundleHash) throw new GraphWitnessError('source-bundle-hash-mismatch', 400);
      if(this.targetFence(packet.agentId,packet.erasureIdentity))throw new GraphWitnessError('source-erased');
      if (this.db.prepare('SELECT 1 FROM erasures WHERE agentId=? AND bundleHash=?').get(packet.agentId, packet.sourceBundleHash)) throw new GraphWitnessError('source-erased');
      const operationHash = canonicalHash(packet);
      const prior = this.db.prepare('SELECT operationHash,prepareProof FROM operations WHERE agentId=? AND (idempotencyKey=? OR eventId=?)').get(packet.agentId, packet.idempotencyKey, packet.eventId) as { operationHash: string; prepareProof: string } | undefined;
      if (prior) {
        if (prior.operationHash !== operationHash) throw new GraphWitnessError('idempotency-conflict');
        return JSON.parse(prior.prepareProof) as GraphWitnessPrepareProof;
      }
      if(this.db.prepare('SELECT 1 FROM ownedAllocationHolds WHERE agentId=? AND membershipHash=?').get(packet.agentId,canonicalHash(membership)))throw new GraphWitnessError('custody-allocation-held');
      this.requireHistoryCapacity(packet.agentId);
      const occupied=this.db.prepare("SELECT operationHash FROM operations WHERE agentId=? AND json_extract(packet,'$.sourceSequence')=?").get(packet.agentId,packet.sourceSequence) as {operationHash:string}|undefined;
      if(occupied)throw new GraphWitnessError('source-sequence-conflict');
      const tip=this.ensureWitnessedTip(packet.agentId);
      if(packet.sourceSequence!==tip.sequence+1)throw new GraphWitnessError(packet.sourceSequence>tip.sequence+1?'witness-prefix-missing':'source-sequence-conflict');
      if(packet.predecessorHash!==tip.coreHash)throw new GraphWitnessError('witness-prefix-mismatch');
      const proof = this.signed(D.prepare, { v: 1 as const, agentId: packet.agentId, eventId: packet.eventId, operationHash,
        membershipEpoch: packet.membershipEpoch, leaseEpoch: packet.leaseEpoch, witnessId: this.options.witnessId, preparedAt: this.timestamp() });
      this.db.prepare('INSERT INTO bundles(agentId,hash,ciphertext) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(packet.agentId, packet.sourceBundleHash, canonicalJson(encryptedSourceBundle));
      this.db.prepare('INSERT INTO operations(agentId,idempotencyKey,eventId,operationHash,packet,packetSignature,prepareProof,state) VALUES(?,?,?,?,?,?,?,?)')
        .run(packet.agentId, packet.idempotencyKey, packet.eventId, operationHash, canonicalJson(packet), packetSignature,canonicalJson(proof), 'prepared');
      this.db.prepare('INSERT INTO controls(agentId,eventId,body) VALUES(?,?,?)').run(packet.agentId,packet.eventId,canonicalJson(controlCapsule));
      this.db.prepare('UPDATE witnessedTips SET sequence=?,coreHash=? WHERE agentId=?').run(packet.sourceSequence,packet.coreHash,packet.agentId);
      return proof;
    }).immediate();
  }
  /** A previous native writer can have fsynced a source before reaching this
   * custody engine. Preserve that exact packet under a fresh all-member tail
   * closure; do not rewrite its original authority or allocate another sequence. */
  recoverPositiveSource(request:GraphWitnessRecoveredSourceRequest):GraphWitnessOperation {
    if((!!request.originalSourceReceipt===!!request.takeoverSourceReceipt)||!exactFields(request,['packet','packetSignature','controlCapsule','lease','originalLease','encryptedSourceBundle',...(request.originalSourceReceipt?['originalSourceReceipt']:['takeoverSourceReceipt']),'closedTails','revalidation','rewrap']))throw new GraphWitnessError('recovered-source-request-invalid',400);
    const {packet,controlCapsule,packetSignature,encryptedSourceBundle,lease,originalLease}=request,owner=this.options.enrollments[packet?.agentId]?.ownerPublicKey;
    if(!validatePacket(packet)||!owner||!verifyGraphControlCapsule(controlCapsule,packet,owner))throw new GraphWitnessError('operation-control-invalid',403);
    this.observeLease(packet.agentId,lease,originalLease);
    return this.db.transaction(()=>{
      const membership=this.admission(packet.agentId,lease,originalLease);this.assertPositiveMembershipActive(packet.agentId,membership);
      // This ordinary native failover path cannot authorize a roster/role change.
      if(packet.membershipEpoch!==membership.epoch||canonicalHash(controlCapsule.authorizationProof.membership)!==canonicalHash(membership)||packet.leaseEpoch>lease.leaseEpoch)throw new GraphWitnessError('recovered-source-membership-mismatch',403);
      const writer=membership.members.find(row=>row.machineId===packet.writerId);
      if(!writer||!verifyGraphRecord(D.packet,packet,packetSignature,writer.signingPublicKey)||(request.originalSourceReceipt&&!verifyMemberReceipt(request.originalSourceReceipt,packet,membership,'source')))throw new GraphWitnessError('recovered-source-original-proof-invalid',403);
      if(!verifyGraphNativeTailBarrier(request.closedTails,membership,lease))throw new GraphWitnessError('recovered-source-tail-unclosed',403);
      const sourceProofHash=canonicalHash({coreType:packet.coreType,packet,packetSignature,core:controlCapsule.core,authorizationProof:controlCapsule.authorizationProof});
      if(request.takeoverSourceReceipt?!verifyGraphNativeTakeoverCustodyReceipt(request.takeoverSourceReceipt,{packet,packetSignature,coreType:packet.coreType,core:controlCapsule.core,authorizationProof:controlCapsule.authorizationProof},membership,lease,request.closedTails):!request.closedTails.some(tail=>tail.receipt.machineId===request.originalSourceReceipt!.machineId&&tail.entries.some(entry=>entry.eventId===packet.eventId&&entry.packetHash===canonicalHash(packet)&&entry.sourceProofHash===sourceProofHash)))throw new GraphWitnessError('recovered-source-tail-evidence-missing',403);
      if(!verifyPendingRevalidation(request.revalidation,packet,membership,lease)||request.revalidation.decision!=='adopt'||request.revalidation.sourceProofHash!==sourceProofHash||request.revalidation.rewrapHash!==canonicalHash(request.rewrap))throw new GraphWitnessError('recovered-source-revalidation-invalid',403);
      validateBundle(encryptedSourceBundle,membership);if(canonicalHash(encryptedSourceBundle)!==packet.sourceBundleHash||!verifyBundleRewrap(request.rewrap,encryptedSourceBundle,membership))throw new GraphWitnessError('recovered-source-bundle-invalid',403);
      if(this.targetFence(packet.agentId,packet.erasureIdentity)||this.db.prepare('SELECT 1 FROM erasures WHERE agentId=? AND bundleHash=?').get(packet.agentId,packet.sourceBundleHash))throw new GraphWitnessError('source-erased');
      const operationHash=canonicalHash(packet),prior=this.db.prepare('SELECT operationHash FROM operations WHERE agentId=? AND (idempotencyKey=? OR eventId=?)').get(packet.agentId,packet.idempotencyKey,packet.eventId) as {operationHash:string}|undefined;
      if(prior){if(prior.operationHash!==operationHash)throw new GraphWitnessError('idempotency-conflict');const existing=this.operation(packet.agentId,packet.idempotencyKey)!;if(existing.certificate||existing.cancellationCertificate)return existing;if(!existing.prepareProof||existing.erasure||existing.cancellation)throw new GraphWitnessError('recovered-source-terminal-decision');}
      else{
        this.requireHistoryCapacity(packet.agentId);const tip=this.ensureWitnessedTip(packet.agentId);
        if(packet.sourceSequence!==tip.sequence+1||packet.predecessorHash!==tip.coreHash)throw new GraphWitnessError('witness-prefix-mismatch');
        const proof=this.signed(D.prepare,{v:1 as const,agentId:packet.agentId,eventId:packet.eventId,operationHash,membershipEpoch:packet.membershipEpoch,leaseEpoch:packet.leaseEpoch,witnessId:this.options.witnessId,preparedAt:this.timestamp()});
        this.db.prepare('INSERT INTO bundles(agentId,hash,ciphertext) VALUES(?,?,?) ON CONFLICT DO NOTHING').run(packet.agentId,packet.sourceBundleHash,canonicalJson(encryptedSourceBundle));
        this.db.prepare('INSERT INTO operations(agentId,idempotencyKey,eventId,operationHash,packet,packetSignature,prepareProof,state) VALUES(?,?,?,?,?,?,?,?)').run(packet.agentId,packet.idempotencyKey,packet.eventId,operationHash,canonicalJson(packet),packetSignature,canonicalJson(proof),'prepared');
        this.db.prepare('INSERT INTO controls(agentId,eventId,body) VALUES(?,?,?)').run(packet.agentId,packet.eventId,canonicalJson(controlCapsule));this.db.prepare('UPDATE witnessedTips SET sequence=?,coreHash=? WHERE agentId=?').run(packet.sourceSequence,packet.coreHash,packet.agentId);
      }
      this.adoptOne(packet.agentId,membership,lease,originalLease,request.revalidation,request.rewrap,null);
      return this.operation(packet.agentId,packet.idempotencyKey)!;
    }).immediate();
  }
  /** A loss cut closes the removed era, including negative sequence bridges.
   * Global logical erasure remains available; an unlisted old packet cannot
   * consume a successor sequence merely because its target is now denied. */
  private assertMemberLossControlCut(packet:GraphOperationPacket):void{
    for(const membership of this.activeMembershipHistory(packet.agentId)){
      if(membership.epoch<=packet.membershipEpoch)continue;
      const activation=this.membershipActivation(packet.agentId,membership.epoch),loss=activation?.memberLoss;if(!loss)continue;
      const known=loss.consent.payload.operations.find(row=>row.eventId===packet.eventId);
      if(!known||known.operationHash!==canonicalHash(packet)||known.coreHash!==packet.coreHash||known.sourceSequence!==packet.sourceSequence||known.predecessorHash!==packet.predecessorHash)throw new GraphWitnessError('member-loss-repair-outside-cut',403);
    }
  }
  /** Priority erasure may win before independent source preparation. Preserve
   * the exact frozen sequence as terminal control, never as a saved payload. */
  admitErasedControl(request:Omit<GraphWitnessPrepareRequest,'encryptedSourceBundle'>):GraphWitnessOperation {
    if(!exactFields(request,['packet','packetSignature','controlCapsule','lease','originalLease']))throw new GraphWitnessError('erased-control-request-invalid',400);
    const {packet,packetSignature,controlCapsule,lease,originalLease}=request;
    if(!validatePacket(packet)||!verifyGraphControlCapsule(controlCapsule,packet,this.options.enrollments[packet.agentId]?.ownerPublicKey))throw new GraphWitnessError('operation-control-invalid',403);
    this.observeLease(packet.agentId,lease,originalLease);
    return this.db.transaction(()=>{
      const custodyMembership=this.admission(packet.agentId,lease,originalLease);this.assertMemberLossControlCut(packet);
      const historical=this.membership(packet.agentId,packet.membershipEpoch),writer=historical.members.find(m=>m.machineId===packet.writerId);
      if(canonicalHash(historical)!==canonicalHash(controlCapsule.authorizationProof.membership)||!writer||!verifyGraphRecord(D.packet,packet,packetSignature,writer.signingPublicKey))throw new GraphWitnessError('operation-signature-invalid',403);
      const existing=this.operation(packet.agentId,packet.idempotencyKey);
      if(existing){if(canonicalHash(existing.packet)!==canonicalHash(packet))throw new GraphWitnessError('idempotency-conflict');return existing;}
      this.requireHistoryCapacity(packet.agentId);
      if(!this.targetFence(packet.agentId,packet.erasureIdentity))throw new GraphWitnessError('logical-erasure-required',403);
      if(this.db.prepare('SELECT 1 FROM operations WHERE agentId=? AND eventId=?').get(packet.agentId,packet.eventId))throw new GraphWitnessError('idempotency-conflict');
      const tip=this.ensureWitnessedTip(packet.agentId);
      if(packet.sourceSequence!==tip.sequence+1)throw new GraphWitnessError(packet.sourceSequence>tip.sequence+1?'witness-prefix-missing':'source-sequence-conflict');
      if(packet.predecessorHash!==tip.coreHash)throw new GraphWitnessError('witness-prefix-mismatch');
      const operationHash=canonicalHash(packet),proof=this.signed(D.erasedControl,{v:1 as const,agentId:packet.agentId,eventId:packet.eventId,operationHash,membershipEpoch:packet.membershipEpoch,leaseEpoch:packet.leaseEpoch,witnessId:this.options.witnessId,custodyMembershipEpoch:custodyMembership.epoch,targetHash:canonicalHash(packet.erasureIdentity),recordedAt:this.timestamp()});
      this.db.prepare('INSERT INTO controls(agentId,eventId,body) VALUES(?,?,?)').run(packet.agentId,packet.eventId,canonicalJson(controlCapsule));
      this.db.prepare('INSERT INTO operations(agentId,idempotencyKey,eventId,operationHash,packet,packetSignature,prepareProof,state) VALUES(?,?,?,?,?,?,?,?)').run(packet.agentId,packet.idempotencyKey,packet.eventId,operationHash,canonicalJson(packet),packetSignature,'null','erased');
      this.db.prepare('INSERT INTO erasedControls(agentId,eventId,body) VALUES(?,?,?)').run(packet.agentId,packet.eventId,canonicalJson(proof));
      this.db.prepare('UPDATE witnessedTips SET sequence=?,coreHash=? WHERE agentId=?').run(packet.sourceSequence,packet.coreHash,packet.agentId);
      return this.operation(packet.agentId,packet.idempotencyKey)!;
    }).immediate();
  }
  operation(agentId: string, idempotencyKey: string): GraphWitnessOperation | null {
    const row = this.db.prepare('SELECT packet,packetSignature,prepareProof,state,certificate,cancellation,cancellationCertificate,adoption FROM operations WHERE agentId=? AND idempotencyKey=?').get(agentId, idempotencyKey) as StoredOperation | undefined;
    if (!row) return null;
    const packet = JSON.parse(row.packet) as GraphOperationPacket;
    const controlRow=this.db.prepare('SELECT body FROM controls WHERE agentId=? AND eventId=?').get(agentId,packet.eventId) as {body:string}|undefined;
    const controlCapsule=controlRow?JSON.parse(controlRow.body):null;
    if(!verifyGraphControlCapsule(controlCapsule,packet,this.options.enrollments[agentId]?.ownerPublicKey))throw new GraphWitnessError('operation-control-evidence-missing');
    const writer=this.membership(agentId,packet.membershipEpoch).members.find(member=>member.machineId===packet.writerId);
    if(canonicalHash(controlCapsule.authorizationProof.membership)!==canonicalHash(this.membership(agentId,packet.membershipEpoch)))throw new GraphWitnessError('operation-control-membership-evidence-missing');
    if(!row.packetSignature||!writer||!verifyGraphRecord(D.packet,packet,row.packetSignature,writer.signingPublicKey))throw new GraphWitnessError('operation-signature-evidence-missing');
    const erasureRow = this.db.prepare('SELECT proof FROM erasures WHERE agentId=? AND bundleHash=?').get(agentId, packet.sourceBundleHash) as { proof: string } | undefined;
    const perBundle=erasureRow?JSON.parse(erasureRow.proof) as GraphWitnessErasure:null;
    const resolvedErasure=perBundle&&erasureCoversPacket(perBundle,packet)?perBundle:this.targetFence(agentId,packet.erasureIdentity);
    const rewrapRow=resolvedErasure?null:this.db.prepare('SELECT body FROM rewraps WHERE agentId=? AND eventId=?').get(agentId,packet.eventId) as {body:string|null}|undefined;
    const materializationRow=this.db.prepare('SELECT body FROM materializations WHERE agentId=? AND eventId=?').get(agentId,packet.eventId) as {body:string}|undefined;
    const erasedRow=this.db.prepare('SELECT body FROM erasedControls WHERE agentId=? AND eventId=?').get(agentId,packet.eventId) as {body:string}|undefined;
    const state = { packet,packetSignature:row.packetSignature,controlCapsule,erasedControlProof:erasedRow?JSON.parse(erasedRow.body) as GraphWitnessErasedControlProof:null,materialization:materializationRow?JSON.parse(materializationRow.body) as GraphWitnessMaterializationRef:null, rewrap:rewrapRow?.body?JSON.parse(rewrapRow.body) as GraphBundleRewrap:null, prepareProof: JSON.parse(row.prepareProof) as GraphWitnessPrepareProof|null, state: row.state,
      certificate: row.certificate ? JSON.parse(row.certificate) as GraphCommitCertificate : null,
      cancellation: row.cancellation ? JSON.parse(row.cancellation) as GraphWitnessCancellation : null,
      cancellationCertificate: row.cancellationCertificate ? JSON.parse(row.cancellationCertificate) as GraphCancellationCertificate : null,
      erasure:resolvedErasure,
      adoption: row.adoption ? JSON.parse(row.adoption) as GraphAdoptionCertificate : null,
      certificatePersistenceReceipts: (this.db.prepare('SELECT receipt FROM certificateReceipts WHERE agentId=? AND eventId=? ORDER BY machineId').all(agentId, packet.eventId) as Array<{ receipt: string }>).map((r) => JSON.parse(r.receipt) as GraphMemberReceipt) };
    return { ...state, stateProof: this.signed(D.operationState, { v: 1 as const, agentId, idempotencyKey, operationHash: canonicalHash(packet), packetSignatureHash:canonicalHash(row.packetSignature),erasedControlProofHash:state.erasedControlProof?canonicalHash(state.erasedControlProof):null,state: row.state,
      certificateHash: state.certificate ? canonicalHash(state.certificate) : null, cancellationHash: state.cancellation ? canonicalHash(state.cancellation) : null,
      cancellationCertificateHash: state.cancellationCertificate ? canonicalHash(state.cancellationCertificate) : null,
      erasureHash: state.erasure ? canonicalHash(state.erasure) : null, adoptionHash: state.adoption ? canonicalHash(state.adoption) : null,
      certificatePersistenceHash: canonicalHash(state.certificatePersistenceReceipts), rewrapHash:state.rewrap?canonicalHash(state.rewrap):null, materializationHash:state.materialization?canonicalHash(state.materialization):null,
      witnessId: this.options.witnessId, observedAt: this.timestamp() }) };
  }
  recover(agentId: string, idempotencyKey: string) {
    const operation = this.operation(agentId, idempotencyKey);
    if (!operation) throw new GraphWitnessError('operation-unknown', 404);
    const tombstone=operation.erasure?{proof:canonicalJson(operation.erasure)}:undefined;
    const row = tombstone ? null : this.db.prepare('SELECT ciphertext FROM bundles WHERE agentId=? AND hash=?').get(agentId, operation.packet.sourceBundleHash) as { ciphertext: string | null } | undefined;
    return { operation, encryptedSourceBundle: row?.ciphertext ? JSON.parse(row.ciphertext) as GraphEncryptedBundle : null,
      erasure: tombstone ? JSON.parse(tombstone.proof) as GraphWitnessErasure : null };
  }
  commit(agentId: string, idempotencyKey: string, lease: GraphWitnessLease, original: LeaseRecord, receipts: GraphMemberReceipt[]): GraphCommitCertificate {
    this.observeLease(agentId, lease, original);
    return this.db.transaction(() => {
      const membership = this.admission(agentId, lease, original);this.assertPositiveMembershipActive(agentId,membership);
      const operation = this.operation(agentId, idempotencyKey);
      if (!operation) throw new GraphWitnessError('operation-unknown', 404);
      if (operation.state === 'certified' && operation.certificate) return operation.certificate;
      if(operation.erasure)throw new GraphWitnessError('operation-erased');
      if (operation.state !== 'prepared') throw new GraphWitnessError(`operation-${operation.state}`);
      const packet = operation.packet;
      const adoption = operation.adoption;
      const context = adoption ? { membershipEpoch: membership.epoch, leaseEpoch: adoption.currentLease.leaseEpoch } : undefined;
      if (adoption ? adoption.disposition !== 'adopted' || canonicalHash(adoption.newMembership) !== canonicalHash(membership)
        || adoption.currentLease.writerId !== lease.writerId || adoption.currentLease.leaseEpoch !== lease.leaseEpoch
        || !verifyAdoptionCertificate(adoption, packet, this.membership(agentId, packet.membershipEpoch), this.options.enrollments[agentId].ownerPublicKey, this.publicKey)
        : packet.membershipEpoch !== membership.epoch || packet.leaseEpoch !== lease.leaseEpoch || packet.writerId !== lease.writerId) throw new GraphWitnessError('operation-needs-reconciliation');
      if (!Array.isArray(receipts) || receipts.length !== membership.members.length || new Set(receipts.map((r) => r.machineId)).size !== receipts.length
        || receipts.some((r) => !verifyMemberReceipt(r, packet, membership, 'source', undefined, context))) throw new GraphWitnessError('all-member-durable-receipts-required', 403);
      const tip = this.db.prepare('SELECT certifiedSequence,certifiedCoreHash FROM agents WHERE agentId=?').get(agentId) as { certifiedSequence: number; certifiedCoreHash: string | null };
      if (packet.sourceSequence !== tip.certifiedSequence + 1 || packet.predecessorHash !== tip.certifiedCoreHash) throw new GraphWitnessError('source-chain-gap');
      const certificate = this.signed(D.certificate, { v: 1 as const, agentId, eventId: packet.eventId, operationHash: canonicalHash(packet),
        coreHash: packet.coreHash, authorizationReceiptHash: packet.authorizationReceiptHash, sourceSequence: packet.sourceSequence,
        predecessorHash: packet.predecessorHash, membershipEpoch: membership.epoch, leaseEpoch: lease.leaseEpoch,
        membershipHash: canonicalHash(membership), memberReceipts: [...receipts].sort((a, b) => a.machineId.localeCompare(b.machineId)),
        witnessId: this.options.witnessId, committedAt: this.timestamp(), ...(adoption ? { adoption } : {}) });
      this.db.prepare('UPDATE operations SET state=?,certificate=? WHERE agentId=? AND idempotencyKey=?').run('certified', canonicalJson(certificate), agentId, idempotencyKey);
      this.db.prepare('UPDATE agents SET certifiedSequence=?,certifiedCoreHash=? WHERE agentId=?').run(packet.sourceSequence, packet.coreHash, agentId);
      return certificate;
    }).immediate();
  }
  acknowledgeCertificate(agentId: string, idempotencyKey: string, receipt: GraphMemberReceipt): { allMembersPersisted: boolean } {
    return this.db.transaction(() => {
      const operation = this.operation(agentId, idempotencyKey);
      const certificate = operation?.certificate ?? operation?.cancellationCertificate;
      if (!operation || !certificate) throw new GraphWitnessError('certificate-unknown', 404);
      const adoption = certificate.adoption;
      const membership = adoption?.newMembership ?? this.membership(agentId, operation.packet.membershipEpoch);
      const context = adoption ? { membershipEpoch: membership.epoch, leaseEpoch: adoption.currentLease.leaseEpoch } : undefined;
      if (!verifyMemberReceipt(receipt, operation.packet, membership, 'certificate', canonicalHash(certificate), context)) throw new GraphWitnessError('certificate-receipt-invalid', 403);
      this.db.prepare('INSERT INTO certificateReceipts(agentId,eventId,machineId,receipt) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(agentId, operation.packet.eventId, receipt.machineId, canonicalJson(receipt));
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM certificateReceipts WHERE agentId=? AND eventId=?').get(agentId, operation.packet.eventId) as { n: number };
      return { allMembersPersisted: row.n === membership.members.length };
    }).immediate();
  }
  cancel(agentId: string, idempotencyKey: string, lease: GraphWitnessLease, original: LeaseRecord, actionSignature: string): GraphWitnessCancellation {
    this.observeLease(agentId, lease, original);
    return this.db.transaction(() => {
      const membership = this.admission(agentId, lease, original);
      if (!verifyGraphRecord(D.action, witnessActionPayload('cancel', { idempotencyKey }, lease), actionSignature,
        membership.members.find((m) => m.machineId === lease.writerId)!.signingPublicKey)) throw new GraphWitnessError('cancel-signature-invalid', 403);
      const operation = this.operation(agentId, idempotencyKey);
      if (!operation) throw new GraphWitnessError('operation-unknown', 404);
      if (operation.state === 'canceled' && operation.cancellation) return operation.cancellation;
      if (operation.state !== 'prepared') throw new GraphWitnessError(`not-cancelable:${operation.state}`);
      if (operation.adoption ? operation.adoption.newMembership.epoch !== lease.membershipEpoch || operation.adoption.currentLease.leaseEpoch !== lease.leaseEpoch
        : operation.packet.membershipEpoch !== lease.membershipEpoch || operation.packet.leaseEpoch !== lease.leaseEpoch) throw new GraphWitnessError('operation-needs-reconciliation');
      const cancellation = this.signed(D.cancellation, { v: 1 as const, agentId, eventId: operation.packet.eventId, operationHash: canonicalHash(operation.packet),
        membershipEpoch: lease.membershipEpoch, leaseEpoch: lease.leaseEpoch, witnessId: this.options.witnessId, canceledAt: this.timestamp() });
      this.db.prepare('UPDATE operations SET state=?,cancellation=? WHERE agentId=? AND idempotencyKey=?').run('canceled', canonicalJson(cancellation), agentId, idempotencyKey);
      return cancellation;
    }).immediate();
  }
  certifyCancellation(agentId: string, idempotencyKey: string, lease: GraphWitnessLease, original: LeaseRecord,
    receipts: GraphMemberReceipt[]): GraphCancellationCertificate {
    this.observeLease(agentId, lease, original);
    return this.db.transaction(() => {
      const membership = this.admission(agentId, lease, original);
      const operation = this.operation(agentId, idempotencyKey);
      if (!operation) throw new GraphWitnessError('operation-unknown', 404);
      if (operation.cancellationCertificate) return operation.cancellationCertificate;
      if (operation.state !== 'canceled' && operation.state !== 'erased') throw new GraphWitnessError('operation-not-terminal');
      const packet = operation.packet;
      const adoption = operation.adoption;
      const context = adoption ? { membershipEpoch: membership.epoch, leaseEpoch: adoption.currentLease.leaseEpoch } : undefined;
      if (adoption ? canonicalHash(adoption.newMembership) !== canonicalHash(membership) || adoption.currentLease.leaseEpoch !== lease.leaseEpoch
        || adoption.currentLease.writerId !== lease.writerId || !verifyAdoptionCertificate(adoption, packet, this.membership(agentId, packet.membershipEpoch), this.options.enrollments[agentId].ownerPublicKey, this.publicKey)
        : packet.membershipEpoch !== membership.epoch || packet.leaseEpoch !== lease.leaseEpoch || packet.writerId !== lease.writerId) throw new GraphWitnessError('operation-needs-reconciliation');
      const decision = operation.cancellation ?? this.recover(agentId, idempotencyKey).erasure;
      if (!decision) throw new GraphWitnessError('terminal-decision-missing');
      const cancellationHash = canonicalHash(decision);
      if (!Array.isArray(receipts) || receipts.length !== membership.members.length || new Set(receipts.map((r) => r.machineId)).size !== receipts.length
        || receipts.some((r) => !verifyMemberReceipt(r, packet, membership, 'cancellation', cancellationHash, context))) throw new GraphWitnessError('all-member-terminal-receipts-required', 403);
      const tip = this.db.prepare('SELECT certifiedSequence,certifiedCoreHash FROM agents WHERE agentId=?').get(agentId) as { certifiedSequence: number; certifiedCoreHash: string | null };
      if (packet.sourceSequence !== tip.certifiedSequence + 1 || packet.predecessorHash !== tip.certifiedCoreHash) throw new GraphWitnessError('source-chain-gap');
      const certificate = this.signed(D.cancellationCertificate, { v: 1 as const, agentId, eventId: packet.eventId, operationHash: canonicalHash(packet),
        coreHash: packet.coreHash, authorizationReceiptHash: packet.authorizationReceiptHash, sourceSequence: packet.sourceSequence,
        predecessorHash: packet.predecessorHash, membershipEpoch: membership.epoch, leaseEpoch: lease.leaseEpoch,
        membershipHash: canonicalHash(membership), outcome: operation.state, cancellationHash,
        memberReceipts: [...receipts].sort((a, b) => a.machineId.localeCompare(b.machineId)), witnessId: this.options.witnessId, canceledAt: this.timestamp(), ...(adoption ? { adoption } : {}) });
      this.db.prepare('UPDATE operations SET cancellationCertificate=? WHERE agentId=? AND idempotencyKey=?').run(canonicalJson(certificate), agentId, idempotencyKey);
      this.db.prepare('UPDATE agents SET certifiedSequence=?,certifiedCoreHash=? WHERE agentId=?').run(packet.sourceSequence, packet.coreHash, agentId);
      return certificate;
    }).immediate();
  }
  erasureEndorsement(agentId:string,requestId:string,challenge:string):GraphErasureActiveEndorsement{
    if(!/^[A-Za-z0-9_-]{43}$/.test(challenge))throw new GraphWitnessError('erasure-authority-challenge-invalid',400);
    const row=this.db.prepare('SELECT proof FROM erasureRequests WHERE agentId=? AND requestId=?').get(agentId,requestId) as {proof:string}|undefined;if(!row)throw new GraphWitnessError('erasure-unknown',404);const proof=JSON.parse(row.proof) as GraphWitnessErasure,membership=this.membership(agentId),activation=this.membershipActivation(agentId,membership.epoch);
    return this.signed('graph-erasure-active-endorsement-v1',{v:1 as const,agentId,requestId,erasureHash:canonicalHash(proof),membershipEpoch:membership.epoch,membershipHash:canonicalHash(membership),activationHash:activation?canonicalHash(activation):null,witnessId:this.options.witnessId,challenge,recordedAt:this.timestamp()});
  }
  private activeMembershipHistory(agentId:string):GraphMembershipEpoch[]{
    const current=this.membership(agentId);if(current.epoch>128)throw new GraphWitnessError('membership-history-bound-exceeded');
    const result:GraphMembershipEpoch[]=[];
    for(let epoch=1;epoch<=current.epoch;epoch++){const membership=this.membership(agentId,epoch);
      if(!verifyMembershipEpoch(membership,this.options.enrollments[agentId].ownerPublicKey)||membership.previousMembershipHash!==(epoch===1?null:canonicalHash(result.at(-1))))throw new GraphWitnessError('membership-history-invalid');
      if(epoch>1){const activation=this.membershipActivation(agentId,epoch)!,key=activation.witnessId===this.options.witnessId?this.publicKey:this.options.historicalWitnessPublicKeys?.[activation.witnessId];if(!key||!verifyMembershipActivation(activation,this.options.enrollments[agentId].ownerPublicKey,key))throw new GraphWitnessError('membership-activation-evidence-invalid');}
      result.push(membership);
    }return result;
  }
  beginFleetErasure(agentId:string,ingress:GraphErasureIngress,bundleHashes:string[],lease:GraphWitnessLease,original:LeaseRecord,actionSignature:string){
    return this.db.transaction(()=>{const membership=this.activeMembershipHistory(agentId).find(m=>m.epoch===ingress?.membershipEpoch);
      if(ingress?.agentId!==agentId||!membership||!verifyGraphErasureIngress(ingress,membership,this.options.enrollments[agentId].ownerPublicKey))throw new GraphWitnessError('fleet-erasure-ingress-invalid',403);
      const acceptingMember=membership.members.find(m=>m.machineId===ingress.acceptedBy)!;
      const current=this.membership(agentId).members.find(m=>m.machineId===ingress.acceptedBy);
      const existing=this.db.prepare('SELECT proof FROM erasureRequests WHERE agentId=? AND requestId=?').get(agentId,ingress.requestId) as {proof:string}|undefined;
      if((!current||current.signingPublicKey!==acceptingMember.signingPublicKey)&&(!existing||(JSON.parse(existing.proof) as GraphWitnessErasure).authorizationReceiptHash!==canonicalHash(ingress)))throw new GraphWitnessError('fleet-erasure-retired-ingress-needs-owner',403);
      const proof=this.erase(agentId,ingress.requestId,ingress.target,bundleHashes,canonicalHash(ingress),lease,original,actionSignature);
      return this.fleetErasure.register(ingress,proof);
    }).immediate();
  }
  fleetErasureStatus(agentId:string,requestId:string){return this.fleetErasure.status(agentId,requestId);}
  acknowledgeFleetErasure(agentId:string,requestId:string,receipt:GraphErasureMemberReceipt){return this.db.transaction(()=>this.fleetErasure.acknowledge(agentId,requestId,receipt)).immediate();}
  pendingFleetErasures(agentId:string,offset=0){const requestIds=this.fleetErasure.pending(agentId,offset);return {requestIds,nextOffset:requestIds.length===128?offset+requestIds.length:null};}
  fleetErasureHeader(agentId:string,requestId:string){const value=this.fleetErasureStatus(agentId,requestId);return {...value,plan:{...value.plan,requiredRecipients:[]},receipts:[],recipientCount:value.plan.requiredRecipients.length,receiptCount:value.receipts.length,recipientsHash:canonicalHash(value.plan.requiredRecipients),receiptsHash:canonicalHash(value.receipts)};}
  fleetErasurePage(agentId:string,requestId:string,kind:'recipients'|'receipts',offset:number){if(!Number.isSafeInteger(offset)||offset<0||offset>8192)throw new GraphWitnessError('fleet-erasure-page-invalid',400);return {items:this.fleetErasure.page(agentId,requestId,kind,offset)};}
  erase(agentId: string, requestId: string,target:GraphErasureIdentity, bundleHashes: string[], authorizationReceiptHash: string, lease: GraphWitnessLease, original: LeaseRecord, actionSignature: string): GraphWitnessErasure {
    if (!opaque(requestId) || !validateGraphErasureIdentity(target)||!hash(authorizationReceiptHash) || !Array.isArray(bundleHashes) || bundleHashes.length > 256
      || bundleHashes.some((x) => !hash(x)) || new Set(bundleHashes).size !== bundleHashes.length) throw new GraphWitnessError('erasure-request-invalid', 400);
    this.observeLease(agentId, lease, original);
    return this.db.transaction(() => {
      const membership = this.admission(agentId, lease, original);
      if (!verifyGraphRecord(D.action, witnessActionPayload('erase', { requestId,target, bundleHashes: [...bundleHashes].sort(), authorizationReceiptHash }, lease), actionSignature,
        membership.members.find((m) => m.machineId === lease.writerId)!.signingPublicKey)) throw new GraphWitnessError('erasure-signature-invalid', 403);
      const requestHash = canonicalHash({target, bundleHashes: [...bundleHashes].sort(), authorizationReceiptHash });
      const prior = this.db.prepare('SELECT requestHash,proof FROM erasureRequests WHERE agentId=? AND requestId=?').get(agentId, requestId) as { requestHash: string; proof: string } | undefined;
      if (prior) {
        if (prior.requestHash !== requestHash) throw new GraphWitnessError('erasure-idempotency-conflict');
        return JSON.parse(prior.proof) as GraphWitnessErasure;
      }
      for(const bundleHash of bundleHashes){
        const packets=this.db.prepare("SELECT packet FROM operations WHERE agentId=? AND json_extract(packet,'$.sourceBundleHash')=?").all(agentId,bundleHash) as {packet:string}[];
        const staged=this.db.prepare('SELECT sourceKind,sourceId FROM witnessTransferTargets WHERE agentId=? AND bundleHash=?').all(agentId,bundleHash) as GraphErasureIdentity[];
        if(packets.some(row=>!sameGraphErasureIdentity((JSON.parse(row.packet) as GraphOperationPacket).erasureIdentity,target))||staged.some(identity=>!sameGraphErasureIdentity(identity,target)))throw new GraphWitnessError('erasure-target-bundle-mismatch',403);
      }
      if((this.db.prepare('SELECT COUNT(*) AS n FROM erasureRequests WHERE agentId=?').get(agentId) as {n:number}).n>=20000)throw new GraphWitnessError('erasure-history-bound');
      const proof = this.signed(D.erasure, { v: 1 as const, agentId, requestId,target, bundleHashes: [...bundleHashes].sort(), authorizationReceiptHash,
        membershipEpoch: lease.membershipEpoch, leaseEpoch: lease.leaseEpoch, witnessId: this.options.witnessId, erasedAt: this.timestamp() });
      this.enforceTargetErasure(agentId,proof);
      this.db.prepare('INSERT INTO erasureRequests(agentId,requestId,requestHash,proof) VALUES(?,?,?,?)').run(agentId, requestId, requestHash, canonicalJson(proof));
      return proof;
    }).immediate();
  }
  pending(agentId: string): GraphWitnessOperation[] {
    const rows = this.db.prepare("SELECT idempotencyKey FROM operations WHERE agentId=? ORDER BY json_extract(packet,'$.sourceSequence')").all(agentId) as Array<{ idempotencyKey: string }>;
    return rows.map((r) => this.operation(agentId, r.idempotencyKey)!).filter((operation) => {
      const certificate = operation.certificate ?? operation.cancellationCertificate;
      if (!certificate) return true;
      const membership = certificate.adoption?.newMembership ?? this.membership(agentId, operation.packet.membershipEpoch);
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM certificateReceipts WHERE agentId=? AND eventId=?').get(agentId, operation.packet.eventId) as { n: number };
      return count.n < membership.members.length;
    });
  }
  attestBackupErasure(agentId:string, proof:import('./GraphWitnessTypes.js').GraphBackupErasureAttestation):void {
    const row=this.db.prepare('SELECT proof FROM erasureRequests WHERE agentId=? AND requestId=?').get(agentId,proof.requestId) as {proof:string}|undefined;
    const key=this.options.enrollments[agentId]?.backupPolicyAuditorPublicKey;
    if(!row||!key||!canonicalPublicKey(key,'ed25519')||!verifyBackupErasureAttestation(proof,JSON.parse(row.proof),this.options.failureDomain,key,this.now())) throw new GraphWitnessError('backup-erasure-attestation-invalid',403);
    this.db.prepare('INSERT INTO backupErasureAttestations(agentId,requestId,body) VALUES(?,?,?) ON CONFLICT(agentId,requestId) DO UPDATE SET body=excluded.body').run(agentId,proof.requestId,canonicalJson(proof));
  }
  /** This proves current database/WAL purging only. Provider snapshots/backups
   * require separately verified erasure policy before fleet forget completion. */
  checkpointErasure(agentId: string, requestId: string,challenge=crypto.randomBytes(32).toString('base64url')): { localPurgeReceipt:GraphErasureWitnessPurgeReceipt|null;proof: GraphWitnessErasure; walPurged: boolean; externalBackupsVerified: boolean; backupAttestation: import('./GraphWitnessTypes.js').GraphBackupErasureAttestation | null } {
    const row = this.db.prepare('SELECT proof FROM erasureRequests WHERE agentId=? AND requestId=?').get(agentId, requestId) as { proof: string } | undefined;
    if (!row) throw new GraphWitnessError('erasure-unknown', 404);
    const retainedProof=JSON.parse(row.proof) as GraphWitnessErasure;
    this.db.transaction(()=>this.enforceTargetErasure(agentId,retainedProof)).immediate();
    let walPurged = false;
    try {
      const result = this.db.pragma('wal_checkpoint(TRUNCATE)') as Array<{ busy: number }>;
      const wal = `${this.options.databasePath}-wal`;
      walPurged = result[0]?.busy === 0 && (!fs.existsSync(wal) || fs.statSync(wal).size === 0);
    } catch { /* @silent-fallback-ok — incomplete physical purge is returned explicitly below */ }
    const proof=JSON.parse(row.proof) as GraphWitnessErasure;
    const attestationRow=this.db.prepare('SELECT body FROM backupErasureAttestations WHERE agentId=? AND requestId=?').get(agentId,requestId) as {body:string}|undefined;
    const backupAttestation=attestationRow?JSON.parse(attestationRow.body) as import('./GraphWitnessTypes.js').GraphBackupErasureAttestation:null;
    const auditor=this.options.enrollments[agentId]?.backupPolicyAuditorPublicKey;
    const externalBackupsVerified=!!backupAttestation&&!!auditor&&verifyBackupErasureAttestation(backupAttestation,proof,this.options.failureDomain,auditor,this.now());
    if(!/^[A-Za-z0-9_-]{43}$/.test(challenge))throw new GraphWitnessError('erasure-checkpoint-challenge-invalid',400);
    const localPurgeReceipt=walPurged?this.signed('graph-witness-local-erasure-v1',{v:1 as const,agentId,requestId,erasureHash:canonicalHash(proof),witnessId:this.options.witnessId,failureDomain:this.options.failureDomain,challenge,walPurged:true as const,checkedAt:this.timestamp()}):null;
    return { proof, walPurged, externalBackupsVerified, backupAttestation,localPurgeReceipt };
  }
}

function validateBundle(bundle:GraphEncryptedBundle,membership:GraphMembershipEpoch):void {
 if(!verifyEncryptedBundle(bundle,membership))throw new GraphWitnessError('encrypted-bundle-invalid',400);
}
