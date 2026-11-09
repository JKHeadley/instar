import {GraphSourceCapacityLedger,type GraphSourceCapacityPolicy} from '../core/GraphSourceCapacityLedger.js';
import {isPeerUrlAllowedForCredentials} from './peerUrlGuard.js';
import {assertGraphLocalPath,ensureGraphLocalDirectory} from '../core/GraphLocalFiles.js';
import {GraphNativeMemberLossProgress} from '../core/GraphNativeMemberLossStore.js';
import {FencedLease} from '../core/FencedLease.js';
import {GraphOwnedControlFrameCache} from '../core/GraphOwnedControlFrameCache.js';
import {verifiedEntityName} from '../messaging/shared/channelIdentity.js';
import {realpathSync,lstatSync,openSync,fstatSync,fsyncSync,closeSync,constants as FILE_FLAGS} from 'node:fs';
import {GraphCustodyPeerFrontier} from '../core/GraphCustodyPeerFrontier.js';
import {inspectGraphCustodyRoleFiles} from '../core/GraphCustodyRetiredRolesInventory.js';
import {GraphCustodyRetiredRoles,GraphCustodyRolePurgeDebt} from '../core/GraphCustodyRetiredRoles.js';
import {ConversationGraphQueuedIntentSpool,type GraphQueuedIntentTransfer} from '../core/ConversationGraphQueuedIntent.js';
import {GraphCustodyProfileAuthority,type GraphCustodyHoldIntent} from '../core/GraphCustodyProfileAuthority.js';
import {ConversationGraphNativeTailFloor,GRAPH_NATIVE_TAIL_DOMAIN,graphNativeTailEntries,verifyGraphNativeTailClosure,verifyGraphNativeTailBarrier,type GraphNativeTailClosure} from '../core/ConversationGraphNativeTail.js';
import {hasSeparateGraphPendingCopy} from '../core/ConversationGraphPendingCustody.js';
import {graphCustodyRequiresRoleFrontier,type GraphCustodyTransport} from '../core/GraphCustodyTransport.js';
import {GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES} from '../core/GraphWitnessTypes.js';
import {DegradationReporter} from '../monitoring/DegradationReporter.js';
import {GRAPH_REPLICATION_MAX_LEASE_EPOCH} from '../core/ConversationGraphReplicationLimits.js';
import {verifyRemoteGraphDelegationSource,type SignedRemoteGraphDelegationSource} from '../core/ConversationGraphDelegationRemote.js';
import {GraphFleetErasureCoordinator} from '../core/GraphFleetErasureCoordinator.js';
import type {GraphErasureIngress} from '../core/GraphErasureProtocol.js';
import {createGraphControlCapsule} from '../core/GraphWitnessControl.js';
import {validateGraphContextPage,validateGraphMaterializationReference,type GraphMaterializationContextReference} from '../core/ConversationGraphMaterializationContexts.js';
import {sourceSweepEventId} from '../core/ConversationGraphSourceSweep.js';
import {GraphSourceObservationRecoveryCoordinator} from '../core/ConversationGraphSourceObservationRecovery.js';
import {ConversationGraphLocalErasureFence} from '../core/ConversationGraphLocalErasure.js';
/** Actual Conversations source/peer composition. Configuration absence is inert;
 * registering a journal kind never certifies increment A or enables graph reads. */
import crypto from 'node:crypto';
import path from 'node:path';
import {Router,type RequestHandler} from 'express';
import {MachineIdentityManager} from '../core/MachineIdentity.js';
import {IdentityStore} from '../core/IdentityStore.js';
import {LeaseCoordinator} from '../core/LeaseCoordinator.js';
import {SingleInstanceLock} from '../core/SingleInstanceLock.js';
import {WriteAdmission} from '../core/WriteAdmission.js';
import {PeerEndpointResolver} from '../core/PeerEndpointResolver.js';
import {GraphWitnessClient} from '../core/GraphWitnessClient.js';
import {graphHistoricalMaterializationRef} from '../core/ConversationGraphHistoricalMaterialization.js';
import {validateGraphReplicationDescriptor,type ConversationGraphReplicationDescriptor} from '../core/ConversationGraphReplicationDescriptor.js';
import {ConversationGraphReplication,CONVERSATION_GRAPH_JOURNAL_KIND,CONVERSATION_GRAPH_STORE,
 type ConversationGraphReplicationRecord,verifyGraphCommitProofDeliveryReceipt,registerConversationGraphReplication} from '../core/ConversationGraphReplication.js';
import {ConversationGraphReplicationTransfer,buildGraphRecoverySourceManifest} from '../core/ConversationGraphReplicationTransfer.js';
import {assertGraphSourceObservationCachePurged,purgeLocallyDeniedGraphSourceObservationCache,materializeGraphSourceInventory,assertGraphSourceObservationAdmission,prepareGraphSourceOperation,verifyGraphSourceOperationCapture,sourceObservationEventId,purgeGraphSourceObservationCache,type CapturedGraphSourceOperation} from '../core/ConversationGraphSourceInventory.js';
import {GraphWitnessRecoveryCoordinator} from '../core/GraphWitnessRecoveryCoordinator.js';
import type {ScopeVerifier} from '../core/ScopeVerifier.js';
import {encodeGraphSourceRecoveryEnvelope} from '../core/ConversationGraphSourceRecovery.js';
import {encodeGraphSourceEnvelope} from '../core/ConversationGraphSourceEnvelope.js';
import {ConversationGraphIntake} from '../core/ConversationGraphIntake.js';
import type {GraphLocalOwnerIntentInput,GraphLocalOwnerIntent,GraphQueuedIntentView,GraphQueuedRefusal} from '../core/ConversationGraphQueuedIntent.js';
import type {GraphAuthorizationProof} from '../core/ConversationGraphReplicationProof.js';
import {sealGraphBundle} from '../core/GraphWitnessCrypto.js';
import {validateGraphOperationCore,graphOperationIdentity,deriveGraphErasureIdentity,validateGraphApplicationSource} from '../core/ConversationGraphOperation.js';
import {nodeKey,validateGraphEvent,validateNodeRef,type ConversationRef} from '../core/conversationGraph.js';
import {ReplicatedStoreReader} from '../core/ReplicatedStoreReader.js';
import {ReplicatedPeerStreamReader} from '../core/ReplicatedPeerStreamReader.js';
import type {ReplicatedKindRegistry} from '../core/ReplicatedRecordEnvelope.js';
import type {DroppedOriginRegistry} from '../core/RollbackUnmerge.js';
import type {ConflictStore} from '../core/ConflictStore.js';
import type {HybridLogicalClock} from '../core/HybridLogicalClock.js';
import type {CoherenceJournal,JournalEntry,JournalKind} from '../core/CoherenceJournal.js';
import {ConversationGraphCommitCoordinator,type GraphCommitOutcome,type GraphCommitMember} from '../core/ConversationGraphCommitCoordinator.js';
import {canonicalHash,canonicalJson,exactFields,signGraphRecord,unsigned,verifyGraphRecord,verifyMembershipEpoch,verifyFencedLeaseBridge,verifyMemberReceipt,witnessActionPayload,graphOperationKey,
 type GraphMembershipEpoch,type GraphWitnessLease,type GraphCancellationCertificate,type GraphCoreType,type GraphErasureIdentity,type GraphOperationPacket,type GraphWitnessErasedControlProof,type GraphMembershipActivationCertificate} from '../core/GraphWitnessTypes.js';

const REQUEST_DOMAIN='graph-peer-request-v1',RESPONSE_DOMAIN='graph-peer-response-v1';
const PREFIX='/internal/conversation-graph';
const MAX_BYTES=4*1024*1024,MAX_SKEW=30000;
type Action='source'|'certificate'|'proof'|'repair'|'observe'|'context'|'erase-forward'|'erase-purge'|'delegate'|'custody'|'owner-current'|'completion'|'tail-close'|'tail-page'|'tail-record'|'owner-intent'|'custody-transition';
interface PeerRequest {v:1;agentId:string;membershipHash:string;sender:string;target:string;action:Action;requestId:string;issuedAt:string;body:unknown;signature:string}
interface PeerResponse {v:1;agentId:string;sender:string;target:string;requestHash:string;body:unknown;signature:string}
export interface ConversationGraphRuntimeConfiguration {
 agentId:string;membership:GraphMembershipEpoch;ownerPublicKey:string;stagingDiskQuotaBytes?:number;maxHistoryEntries?:number;localCapacityPolicy?:GraphSourceCapacityPolicy;
 witnessPublicKeys:ReadonlyMap<string,string>;witness:GraphWitnessClient;localCustodyTransport?:GraphCustodyTransport;
 /** Existing server authentication; request signatures remain independent. */
 peerBearerToken:string;
}
export interface ConversationGraphReplicationRuntimeOptions {
 stateDir:string;scopeVerifier?:ScopeVerifier;telegramChatId?:string;configuration?:ConversationGraphRuntimeConfiguration;
 custodyAuthority?:GraphCustodyProfileAuthority;
 memberLossProgress?:GraphNativeMemberLossProgress;
 identity:MachineIdentityManager;identities:IdentityStore;leaseCoordinator:LeaseCoordinator;writeAdmission:WriteAdmission;
 instanceLock:SingleInstanceLock;endpointResolver:PeerEndpointResolver;journal:CoherenceJournal;
 registry:ReplicatedKindRegistry;peerStreams:ReplicatedPeerStreamReader;clock:HybridLogicalClock;
 droppedOrigins:DroppedOriginRegistry;conflictStore:ConflictStore;
}
function key(value:string):crypto.KeyObject{return value.includes('BEGIN PUBLIC KEY')?crypto.createPublicKey(value):crypto.createPublicKey({key:Buffer.from(value,'base64'),format:'der',type:'spki'});}
function sameKey(a:string,b:string):boolean{try{return key(a).export({format:'der',type:'spki'}).equals(key(b).export({format:'der',type:'spki'}));}catch{/* @silent-fallback-ok: invalid public-key encoding is a failed identity equality predicate, never a replacement identity. */return false;}}

export class ConversationGraphReplicationRuntime {
 readonly source:ConversationGraphReplication;
 readonly reader:ReplicatedStoreReader;
 readonly router:Router;
 readonly coordinator:ConversationGraphCommitCoordinator;
 readonly intake:ConversationGraphIntake;
 readonly transfer:ConversationGraphReplicationTransfer;
 private ownedControlFrames:GraphOwnedControlFrameCache|null=null;
 private recovery:GraphWitnessRecoveryCoordinator|null=null;
 private remoteDelegationIntake:((source:SignedRemoteGraphDelegationSource,token:symbol)=>Promise<GraphCommitOutcome>)|null=null;
 private queuedOwnerPromoter:((intent:GraphLocalOwnerIntent,token:symbol)=>Promise<GraphCommitOutcome|{refused:GraphQueuedRefusal}>)|null=null;
 private queuedOwnerCursor:string|null=null;
 private custodyTransitionHandler:((payload:unknown,sender:string)=>Promise<unknown>)|null=null;
 private recordedOwnerAuthority:((intent:GraphLocalOwnerIntent)=>boolean|Promise<boolean>)|null=null;
 private readonly observationRecovery:GraphSourceObservationRecoveryCoordinator;
 readonly machineId:string;
 readonly localErasure:ConversationGraphLocalErasureFence;
 readonly erasure:GraphFleetErasureCoordinator;
 private stopped=false;
 private readyAt=0;
 private lastReadinessFailure:string|null=null;
 private lastVerifiedAt=0;
 private readyLeaseEpoch=0;
 private timer:ReturnType<typeof setInterval>|null=null;
 private refreshInFlight:Promise<boolean>|null=null;
 private readonly reconciledOperations=new Map<string,string>();
 private readonly settledRecords=new Map<string,string>();
 private readonly acknowledgedCertificates=new Map<string,string>();
 private readonly recordedCertificateReceipts=new Map<string,string>();
 private background:Promise<unknown>|null=null;
 private readonly pending=new Set<Promise<unknown>>();
 private queue:Promise<unknown>=Promise.resolve();
 private publications:Promise<unknown>=Promise.resolve();
 private mutations:Promise<unknown>=Promise.resolve();
 private activeMutation:symbol|null=null;
 private custodyAuthority:GraphCustodyProfileAuthority|null=null;
 private memberLossOpenOnly=false;
 private peerFrontier:GraphCustodyPeerFrontier|null=null;
 private nativeTailPreparing:Promise<void>|null=null;
 private closedNativeTail:string|null=null;
 private closedNativeTailProof:GraphNativeTailClosure[]=[];
 private tailSnapshot:GraphNativeTailClosure|null=null;
 private readonly replays=new Map<string,number>();
 private readonly appliedErasureHashes=new Set<string>();
 private constructor(private readonly options:ConversationGraphReplicationRuntimeOptions,source:ConversationGraphReplication,machineId:string,private readonly signingKey:string,localErasure:ConversationGraphLocalErasureFence,private readonly nativeTailFloor:ConversationGraphNativeTailFloor,readonly localSourceCapacityLedger:GraphSourceCapacityLedger|null){
  this.localErasure=localErasure;
  this.source=source;this.machineId=machineId;
  this.intake=new ConversationGraphIntake(path.join(options.stateDir,'state','conversation-graph-intake'),this.config.ownerPublicKey,this.config.witnessPublicKeys,this.localErasure,source.erasureAuthorities,{maxHistoryEntries:this.config.maxHistoryEntries,operationIds:async()=>new Set([...source.recordsForRepair(),...await source.controlIntents()].map(record=>record.packet.eventId)),knownIdempotencyKey:async key=>!!source.lookupByIdempotencyKey(key)||(await source.controlIntents()).some(record=>record.packet.idempotencyKey===key)});
  if(this.localSourceCapacityLedger){ensureGraphLocalDirectory(this.localSourceCapacityLedger.stateRoot,path.join(this.localSourceCapacityLedger.stateRoot,'state','conversation-graph-intake'));this.intake.bindCapacityLedger(this.localSourceCapacityLedger);}
  this.intake.configureOwnerQueue({stateDir:options.stateDir,agentId:this.config.agentId,machineId,signingPrivateKey:signingKey,sealingPrivateKey:options.identity.loadEncryptionKey(),ownerPublicKey:this.config.ownerPublicKey,membership:()=>this.trustedInstalledSet()&&this.positiveCustodyAllowed()?this.config.membership:null,enrollment:{identity:options.identity,identities:options.identities},canServePrivate:()=>false,isErased:target=>source.isErased(target),promotionTarget:key=>source.lookupByIdempotencyKey(key)?.packet.erasureIdentity??null});
  this.transfer=new ConversationGraphReplicationTransfer({heldSourceRecovery:{coordinator:options.leaseCoordinator,nativeFloor:this.nativeTailFloor},diskQuotaBytes:this.config.stagingDiskQuotaBytes,localErasure:this.localErasure,directory:path.join(options.stateDir,'state','conversation-graph-transfer'),machineId,memberPrivateKey:signingKey,memberSealingPrivateKey:options.identity.loadEncryptionKey(),ownerPublicKey:this.config.ownerPublicKey,verification:source,witnessPublicKeys:this.config.witnessPublicKeys});
  this.erasure=new GraphFleetErasureCoordinator({directory:path.join(options.stateDir,'state','conversation-graph-erasure-ingress'),agentId:this.config.agentId,machineId,signingKey,ownerPublicKey:this.config.ownerPublicKey,
   membership:()=>this.config.membership,witness:this.config.witness,actuation:()=>this.nativeActuation(),localDeny:target=>this.denyLocalErasure(target),localDenied:target=>this.localErasure.isDenied(target),
   localPurge:(target,proof,ingress)=>this.localFleetPurge(target,proof,ingress),peerCall:(id,action,body)=>this.request(id,action,body),
   machineName:id=>{const machine=options.identity.loadRegistry().machines[id],name=verifiedEntityName(id,machine?.nickname??machine?.name);return name?.slice(0,120)||'An earlier installed machine';}});
  this.coordinator=new ConversationGraphCommitCoordinator({source,witness:this.config.witness,machineId,member:id=>this.member(id),actuation:()=>this.actuation()});
  this.reader=new ReplicatedStoreReader({registry:options.registry,stores:{conversationGraph:{enabled:true}},tierOf:()=> 'high',
   droppedOrigins:options.droppedOrigins,conflictStore:options.conflictStore,
   listRecordKeys:store=>store===CONVERSATION_GRAPH_STORE?[...new Set([...options.peerStreams.listRecordKeys(store),...source.originRecordKeys()])]:[],
   loadOriginRecords:(store,id)=>store===CONVERSATION_GRAPH_STORE?[...options.peerStreams.loadOriginRecords(store,id),...source.originRecordsFor(id)]:[]});
  source.bindHeldNegativeContext(this.reader,options.droppedOrigins);
  // No Telegram chat is valid: no Telegram subject can match it, and efforts need none. Requiring one left owner changes unrecoverable on agents without Telegram.
  if(options.scopeVerifier&&options.telegramChatId!==undefined)this.recovery=new GraphWitnessRecoveryCoordinator({source,reader:this.reader,dropped:options.droppedOrigins,
   machineId,signingPrivateKey:signingKey,sealingPrivateKey:options.identity.loadEncryptionKey(),ownerPublicKey:this.config.ownerPublicKey,writeAdmission:options.writeAdmission,
   legacyReadOnly:()=>!options.leaseCoordinator.holdsLease()||!options.instanceLock.revalidate(),liveAdmission:()=>this.liveAdmission(),
   actuation:()=>({membership:this.config.membership,...this.actuation()}),scopeVerifier:options.scopeVerifier,telegramChatId:options.telegramChatId});
  this.observationRecovery=new GraphSourceObservationRecoveryCoordinator({source,reader:this.reader,dropped:options.droppedOrigins,stateDir:options.stateDir,
   machineId,signingPrivateKey:signingKey,ownerPublicKey:this.config.ownerPublicKey,writeAdmission:options.writeAdmission,
   legacyReadOnly:()=>!options.leaseCoordinator.holdsLease()||!options.instanceLock.revalidate(),liveAdmission:()=>this.liveAdmission(),
   actuation:()=>({membership:this.config.membership,...this.actuation()})});
  this.router=Router();this.router.post('/replicate',async(req,res)=>{
   res.setHeader('Cache-Control','no-store');
   try{const token=req.headers.authorization;const expected=`Bearer ${this.config.peerBearerToken}`;
    if(typeof token!=='string'||Buffer.byteLength(token)!==Buffer.byteLength(expected)||!crypto.timingSafeEqual(Buffer.from(token),Buffer.from(expected)))throw new Error('graph-peer-auth');
    const request=req.body as PeerRequest;this.authenticate(request);if(['observe','delegate','owner-intent'].includes(request.action))await this.prepareNativeTailClosure();const work=['repair','context','erase-forward','erase-purge','custody','custody-transition','owner-current','tail-close','tail-page','tail-record'].includes(request.action)?this.execute(request.action,request.body,request.sender):this.withMutation(token=>this.execute(request.action,request.body,request.sender,token));this.pending.add(work);let result:unknown;try{result=await work;}finally{this.pending.delete(work);}
    const value={v:1 as const,agentId:this.config.agentId,sender:this.machineId,target:request.sender,requestHash:canonicalHash(request),body:result};
    res.json({...value,signature:signGraphRecord(RESPONSE_DOMAIN,value,this.signingKey)});
   }catch{res.status(409).json({code:'graph-peer-refused'});}
  });
 }
 admissionGuard():RequestHandler{return (req,res,next)=>{
  const token=req.headers.authorization;const expected=`Bearer ${this.config.peerBearerToken}`;
  if(!this.alive()||typeof token!=='string'||Buffer.byteLength(token)!==Buffer.byteLength(expected)||!crypto.timingSafeEqual(Buffer.from(token),Buffer.from(expected))){res.status(401).json({code:'graph-peer-auth-required'});return;}
  const declared=req.headers['content-length'];if(declared!==undefined&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BYTES)){res.status(413).json({code:'graph-peer-body-too-large'});return;}next();
 };}
 private get config(){return this.options.configuration!;}
 static async open(options:ConversationGraphReplicationRuntimeOptions):Promise<ConversationGraphReplicationRuntime|null>{
  if(!options.configuration)return null;
  const config=options.configuration;const local=options.identity.loadIdentity();
  if(!config.peerBearerToken||!options.instanceLock.revalidate()||!verifyMembershipEpoch(config.membership,config.ownerPublicKey)||config.membership.agentId!==config.agentId)throw new Error('graph-runtime-invalid-configuration');
  const authority=options.custodyAuthority;if(authority!==undefined&&(!(authority instanceof GraphCustodyProfileAuthority)||authority.stateRoot!==realpathSync(options.stateDir)||authority.agentId!==config.agentId||!sameKey(authority.ownerPublicKey,config.ownerPublicKey)||canonicalHash(authority.currentMembership())!==canonicalHash(config.membership)))throw new Error('graph-runtime-cold-custody-authority-mismatch');
  // Genesis has no activation to import. Later cold roles must install the
  // exact already-activated class before any historical source is loaded.
  const historicalAuthority=authority&&authority.verifiedNegativeRoleLineage().current.epoch>1?authority:undefined;
  const progress=options.memberLossProgress;
  const assertRecoveryLoad=()=>{if(progress===undefined)return;
   if(!(progress instanceof GraphNativeMemberLossProgress)||!authority||progress.custodyAuthority!==authority||progress.stateRoot!==realpathSync(options.stateDir)||progress.agentId!==config.agentId||progress.machineId!==local.machineId||progress.previousPublicationHash!==authority.publicationHash||progress.previousMembershipHash!==canonicalHash(config.membership)||!(options.identity instanceof MachineIdentityManager)||realpathSync(options.identity.baseDir)!==progress.stateRoot||!(options.identities instanceof IdentityStore)||realpathSync(options.identities.epochPath)!==path.join(progress.stateRoot,'state','identity-epochs.json')||!(options.instanceLock instanceof SingleInstanceLock)||realpathSync(options.instanceLock.lockPath())!==path.join(progress.stateRoot,'local','server-instance.lock')||!(options.leaseCoordinator instanceof LeaseCoordinator)||options.leaseCoordinator.selfMachineId!==local.machineId||!options.instanceLock.revalidate())throw new Error('graph-runtime-member-loss-recovery-scope');
   const epochFile=options.identities.epochPath,epochStat=lstatSync(epochFile);if(!epochStat.isFile()||epochStat.isSymbolicLink()||epochStat.nlink!==1)throw new Error('graph-runtime-member-loss-epoch-file-invalid');const canonicalEpoch=path.join(realpathSync(path.dirname(epochFile)),path.basename(epochFile));assertGraphLocalPath(progress.stateRoot,canonicalEpoch);if(canonicalEpoch!==path.join(progress.stateRoot,'state','identity-epochs.json'))throw new Error('graph-runtime-member-loss-epoch-file-invalid');const epochFd=openSync(epochFile,FILE_FLAGS.O_RDONLY|(FILE_FLAGS.O_NOFOLLOW??0));try{const opened=fstatSync(epochFd);if(opened.dev!==epochStat.dev||opened.ino!==epochStat.ino||opened.nlink!==1||!opened.isFile())throw new Error('graph-runtime-member-loss-epoch-file-changed');fsyncSync(epochFd);}finally{closeSync(epochFd);}
   progress.assertCurrent();const nativePath=options.leaseCoordinator.syncOwnerDecommissionDurably();assertGraphLocalPath(progress.stateRoot,path.join(realpathSync(path.dirname(nativePath)),path.basename(nativePath)));const held=authority.verifiedNegativeRoleLineage().memberLossIntents.find(row=>canonicalHash(row.intent)===progress.intentHash&&canonicalHash(row.previousMembership)===progress.previousMembershipHash&&canonicalHash(row.newMembership)===progress.newMembershipHash);if(!held||held.intent.payload.requestId!==progress.requestId||held.intent.payload.acceptingMachineId!==local.machineId||canonicalHash(held.nativeIdentities)!==progress.nativeRosterHash)throw new Error('graph-runtime-member-loss-recovery-intent');authority.assertMemberLossHeld(held.intent);
   const revoked=new Set(progress.revokedMachineIds),removed=new Set(held.intent.payload.removed.map(row=>row.machineId)),nativeIdentities=progress.nativeIdentities;if(canonicalHash(nativeIdentities)!==progress.nativeRosterHash||[...revoked].some(id=>!removed.has(id)))throw new Error('graph-runtime-member-loss-recovery-roster');const actual=new Set(Object.entries(options.identity.loadRegistry().machines).filter(([,row])=>row.status==='active'&&!row.revokedAt).map(([id])=>id)),expected=config.membership.members.filter(row=>!revoked.has(row.machineId));if(canonicalHash([...actual].sort())!==canonicalHash(expected.map(row=>row.machineId).sort()))throw new Error('graph-runtime-member-loss-recovery-roster');
   for(const member of expected){const identity=member.machineId===local.machineId?options.identity.loadIdentity():options.identities.loadIdentity(member.machineId,'remote'),epoch=options.identities.getEpoch(member.machineId),recorded=nativeIdentities.find(row=>row.machineId===member.machineId);if(!identity||!recorded||epoch.revokedAt||epoch.keyEpoch!==recorded.nativeKeyEpoch||!sameKey(identity.signingPublicKey,member.signingPublicKey)||!sameKey(identity.encryptionPublicKey,member.sealingPublicKey))throw new Error('graph-runtime-member-loss-recovery-key');}
   const survivor=held.newMembership.members.find(row=>row.machineId===local.machineId);if(!survivor||!sameKey(options.identity.loadIdentity().signingPublicKey,survivor.signingPublicKey)||!sameKey(options.identity.loadIdentity().encryptionPublicKey,survivor.sealingPublicKey))throw new Error('graph-runtime-member-loss-recovery-self');const floor=progress.originalFloor,native=options.leaseCoordinator.currentLease();if(floor.machineId!==local.machineId||!native||native.epoch!==options.leaseCoordinator.currentEpoch()||native.epoch<floor.epoch||native.epoch===floor.epoch&&native.holder!==floor.lease.holder)throw new Error('graph-runtime-member-loss-recovery-native');const holder=(native.epoch===floor.epoch?config.membership:held.newMembership).members.find(row=>row.machineId===native.holder);if(!holder||native.epoch>floor.epoch&&revoked.has(holder.machineId)||revoked.has(holder.machineId)&&canonicalHash(native)!==canonicalHash(floor.lease)||!crypto.verify(null,Buffer.from(FencedLease.canonicalize(native)),key(holder.signingPublicKey),Buffer.from(native.signature,'base64')))throw new Error('graph-runtime-member-loss-recovery-native-key');progress.assertCurrent();
  };assertRecoveryLoad();
  const signing=options.identity.loadSigningKey();
  const localErasure=new ConversationGraphLocalErasureFence(options.stateDir);await localErasure.refresh();
  const nativeTailFloor=new ConversationGraphNativeTailFloor(options.stateDir,config.agentId,config.ownerPublicKey);await nativeTailFloor.open();
  // Explicit local resource policy is not a Source ACK or future-recovery grant.
  const capacityLedger=config.localCapacityPolicy?new GraphSourceCapacityLedger({stateRoot:options.stateDir,agentId:config.agentId,identity:options.identity,lock:options.instanceLock,ownerPublicKey:config.ownerPublicKey,policy:config.localCapacityPolicy}):null;
  let runtime:ConversationGraphReplicationRuntime|undefined;
  registerConversationGraphReplicationIfMissing(options.registry);
  const source=await ConversationGraphReplication.open({directory:path.join(options.stateDir,'state','conversation-graph-source'),...(capacityLedger?{capacityLedger}:{}),agentId:config.agentId,machineId:local.machineId,
   memberPrivateKey:signing,memberSealingPrivateKey:options.identity.loadEncryptionKey(),ownerPublicKey:config.ownerPublicKey,witnessPublicKeys:config.witnessPublicKeys,
   maxHistoryEntries:config.maxHistoryEntries,reservedOperationIds:async()=>new Set((await runtime?.intake.frozenReservations()??[]).map(record=>record.packet.eventId)),
   localErasure,installedMembership:config.membership,writeAdmission:options.writeAdmission,legacyReadOnly:()=>!options.instanceLock.revalidate()||!options.leaseCoordinator.holdsLease(),
   liveAdmission:()=>{const native=options.leaseCoordinator.currentLease();return {admitted:!!runtime&&!runtime.stopped&&runtime.trustedInstalledSet()&&runtime.positiveCustodyAllowed()&&runtime.nativeTailAdmissionAllowed(native)&&options.instanceLock.revalidate()&&options.leaseCoordinator.holdsLease()&&nativeTailFloor.allows(native),
    writerId:native?.holder??null,leaseEpoch:native?.epoch??0,membershipEpoch:config.membership.epoch,fencedLeaseHash:native?canonicalHash(native):null};},
   validateCore:(value,coreType)=>validateGraphOperationCore(coreType,value)!==null},progress?'verify-only':'normal',historicalAuthority);
  runtime=new ConversationGraphReplicationRuntime(options,source,local.machineId,signing,localErasure,nativeTailFloor,capacityLedger);
  runtime.memberLossOpenOnly=progress!==undefined;
  if(authority)runtime.installCustodyAuthority(authority);
  if(!runtime.trustedInstalledSet()&&!progress)throw new Error('graph-runtime-installed-membership-mismatch');
  assertRecoveryLoad();
  return runtime;
 }
 withMutation<T>(work:(token:symbol)=>Promise<T>|T):Promise<T>{return this.mutate(work,false);}
 private withLocalMutation<T>(work:(token:symbol)=>Promise<T>|T):Promise<T>{return this.mutate(work,true);}
 private mutate<T>(work:(token:symbol)=>Promise<T>|T,localOnly:boolean):Promise<T>{
  const run=this.mutations.then(async()=>{if(localOnly?!this.recordingAlive():!this.alive())throw new Error('graph-runtime-stopped');const token=Symbol('graph-mutation');this.activeMutation=token;
   try{return await work(token);}finally{this.activeMutation=null;}});this.mutations=run.catch(()=>undefined);return run;
 }
 /** Called only after the real owner adapter authenticates a current owner.
  * Native writer/custody unavailability does not prevent local sealed custody. */
 recordLocalOwnerIntent(input:GraphLocalOwnerIntentInput,authorize:()=>boolean):Promise<GraphQueuedIntentView>{return this.withLocalMutation(()=>this.intake.ownerQueue.record(input,authorize));}
 inheritLiveOwnerIntents(original:ConversationGraphQueuedIntentSpool):Promise<void>{return this.withMutation(()=>this.intake.ownerQueue.inheritLiveVisibility(original));}
 setRecordedOwnerIntentAuthority(authority:(intent:GraphLocalOwnerIntent)=>boolean|Promise<boolean>):void{if(this.recordedOwnerAuthority)throw new Error('graph-recorded-owner-authority-already-configured');this.recordedOwnerAuthority=authority;}
 async recordedOwnerIntentCurrent(intent:GraphLocalOwnerIntent):Promise<boolean|null>{
  try{
   if(intent.recordedMachineId===this.machineId){const original=await this.intake.ownerQueue.readRecordedIntent(intent.idempotencyKey);if(!original||original.recordedMachineId!==this.machineId||canonicalHash(original.admission)!==canonicalHash(intent.admission))return null;const view=await this.intake.ownerQueue.status(original.idempotencyKey,original.principalKey);if(!view?.mayServeDetails())return null;return this.recordedOwnerAuthority?await this.recordedOwnerAuthority(original):null;}
   const admissionHash=canonicalHash(intent.admission),result=await this.request(intent.recordedMachineId,'owner-current',{idempotencyKey:intent.idempotencyKey,admissionHash}) as {idempotencyKey:string;admissionHash:string;current:boolean};
   if(!exactFields(result,['idempotencyKey','admissionHash','current'])||result.idempotencyKey!==intent.idempotencyKey||result.admissionHash!==admissionHash||typeof result.current!=='boolean')throw new Error('graph-owner-current-response-invalid');return result.current;
  }catch{/* DegradationReporter internalOnly via reportUnavailable; no private owner admission/body is logged. */this.reportUnavailable('graph-owner-admission-unavailable');return null;}
 }
 setQueuedOwnerIntentPromoter(execute:(intent:GraphLocalOwnerIntent,token:symbol)=>Promise<GraphCommitOutcome|{refused:GraphQueuedRefusal}>):void{if(this.queuedOwnerPromoter)throw new Error('graph-queued-promoter-already-configured');this.queuedOwnerPromoter=execute;}
 async retryLocalOwnerIntents():Promise<void>{
  
  if(!this.queuedOwnerPromoter||!this.alive()||!this.isReady())return;
  const page=await this.intake.ownerQueue.pendingPage(this.queuedOwnerCursor);this.queuedOwnerCursor=page.nextCursor;
  
  for(const intent of page.intents){if(!this.alive()||!this.isReady())return;await this.promoteQueuedOwnerIntent(intent.idempotencyKey,intent.principalKey,this.queuedOwnerPromoter);}
 }
 localOwnerIntent(key:string,principalKey:string):Promise<GraphQueuedIntentView|null>{if(!this.recordingAlive())return Promise.reject(new Error('graph-runtime-stopped'));return this.intake.ownerQueue.status(key,principalKey);}
 localOwnerIntents(principalKey:string):Promise<GraphQueuedIntentView[]>{if(!this.recordingAlive())return Promise.reject(new Error('graph-runtime-stopped'));return this.intake.ownerQueue.list(principalKey);}
 installCustodyAuthority(authority:GraphCustodyProfileAuthority):void{
  if(!(authority instanceof GraphCustodyProfileAuthority)||authority.stateRoot!==realpathSync(this.options.stateDir)||authority.agentId!==this.config.agentId||authority.ownerPublicKey!==this.config.ownerPublicKey||canonicalHash(authority.currentMembership())!==canonicalHash(this.config.membership)||this.custodyAuthority&&this.custodyAuthority!==authority)throw new Error('graph-runtime-custody-authority-mismatch');
  this.custodyAuthority=authority;this.source.erasureAuthorities.installCustodyAuthority(authority);this.transfer.bindCustodyAuthority(authority);
 }
 installPeerFrontier(frontier:GraphCustodyPeerFrontier):void{
  if(!(frontier instanceof GraphCustodyPeerFrontier)||frontier.agentId!==this.config.agentId||frontier.ownerPublicKey!==this.config.ownerPublicKey||frontier.stateRoot!==realpathSync(this.options.stateDir)||!this.custodyAuthority||frontier.custodyAuthority!==this.custodyAuthority||this.peerFrontier&&this.peerFrontier!==frontier)throw new Error('graph-runtime-peer-frontier-scope-mismatch');
  this.peerFrontier=frontier;
 }
 assertCustodyRoleFrontier():void{if(this.config.membership.custodyProfile?.mode!=='owned-machine')return;if(!this.peerFrontier)throw new Error('graph-runtime-peer-frontier-unconfirmed');this.peerFrontier.assertRoleFrontier(this.config.membership);}
 private assertPositiveCustody():void{if(this.config.membership.custodyProfile?.mode!=='owned-machine')return;if(!this.custodyAuthority)throw new Error('graph-runtime-custody-profile-unconfirmed');if(!this.peerFrontier){this.custodyAuthority.assertPositiveWrites(this.config.membership);throw new Error('graph-runtime-peer-frontier-unconfirmed');}this.custodyAuthority.assertPositiveWrites(this.config.membership);this.peerFrontier.assertRoleFrontier(this.config.membership);this.source.assertHeldImportsSettled(this.custodyAuthority);}
 private positiveCustodyAllowed():boolean{try{this.assertPositiveCustody();return true;}catch{/* @silent-fallback-ok: missing or staged actual custody authority withholds positive admission; local intent custody remains available. */return false;}}
 private privateCustodyAllowed():boolean{if(this.config.membership.custodyProfile?.mode!=='owned-machine')return true;try{if(!this.peerFrontier||!this.custodyAuthority)return false;this.peerFrontier.assertPrivateServing(this.config.membership);this.source.assertHeldImportsSettled(this.custodyAuthority);return true;}catch{/* @silent-fallback-ok: missing verified private-serving frontier withholds private data; local sealed capture remains independent. */return false;}}
 canRecordLocalOwnerIntents():boolean{return this.recordingAlive();}
 cancelLocalOwnerIntent(key:string,principalKey:string,authorize:()=>boolean):Promise<GraphQueuedIntentView>{return this.withLocalMutation(async()=>{
  if(this.source.lookupByIdempotencyKey(key)||(await this.intake.frozenReservations()).some(record=>record.packet.idempotencyKey===key))throw new Error('graph-queued-already-admitted');
  if(!authorize())throw new Error('graph-queued-current-owner-required');return this.intake.ownerQueue.finish(key,principalKey,{state:'canceled-local'},authorize);
 });}
 /** Current owner authorization, observed-head/version and scope validation
  * happen in the trusted executor INSIDE this same existing mutation token.
  * The executor calls submitPrepared directly; it must not reacquire the lock. */
 async promoteQueuedOwnerIntent(key:string,principalKey:string,execute:(intent:GraphLocalOwnerIntent,token:symbol)=>Promise<GraphCommitOutcome|{refused:GraphQueuedRefusal}>):Promise<GraphCommitOutcome|GraphQueuedIntentView>{
  if(!this.options.leaseCoordinator.holdsLease())return this.forwardQueuedOwnerIntent(key,principalKey);
  const view=await this.intake.ownerQueue.status(key,principalKey);if(!view)throw new Error('graph-queued-owner-unavailable');if(!view.mayServeDetails())return view;
  try{await this.prepareNativeTailClosure();}catch(error){/* DegradationReporter internalOnly via reportUnavailable; no global slot is allocated while any old installed tail is unknown. */this.noteTailClosure(error);this.reportUnavailable('graph-native-tail-closure-unavailable');return view;}
  return this.withMutation(token=>this.promoteQueuedOwnerIntentCore(key,principalKey,execute,token));
 }
 private async promoteQueuedOwnerIntentCore(key:string,principalKey:string,execute:(intent:GraphLocalOwnerIntent,token:symbol)=>Promise<GraphCommitOutcome|{refused:GraphQueuedRefusal}>,token:symbol):Promise<GraphCommitOutcome|GraphQueuedIntentView>{
  const view=await this.intake.ownerQueue.status(key,principalKey),intent=await this.intake.ownerQueue.readIntent(key,principalKey);
  if(!view||!intent)throw new Error('graph-queued-owner-unavailable');
  if(view.state==='canceled-local'||view.state==='refused-local')return view;
  if(intent.recordedMachineId===this.machineId?!view.mayServeDetails():await this.recordedOwnerIntentCurrent(intent)!==true)return view;
  const alreadyAdmitted=this.source.lookupByIdempotencyKey(key)||(await this.intake.frozenReservations()).find(record=>record.packet.idempotencyKey===key);
  if(!this.options.leaseCoordinator.holdsLease()||(!alreadyAdmitted&&!await this.refreshReadinessCore()))return view;
  if(!alreadyAdmitted&&!this.isReady())return view;
  if(!await this.intake.ownerQueue.recorderIsCurrent(key))return this.intake.ownerQueue.finish(key,principalKey,{state:'refused-local',refusalCode:'profile-changed'});
  const result=await execute(intent,token);
  const actual=this.source.lookupByIdempotencyKey(key);
  if('refused'in result){if(actual||(await this.intake.frozenReservations()).some(record=>record.packet.idempotencyKey===key))throw new Error('graph-queued-refusal-already-admitted');return this.intake.ownerQueue.finish(key,principalKey,{state:'refused-local',refusalCode:result.refused});}
  if(!actual||!this.source.verifyHistoricalRecord(actual)||result.eventId!==actual.packet.eventId)throw new Error('graph-queued-promotion-not-durable');
  await this.intake.ownerQueue.finish(key,principalKey,{state:'promoted',promotion:{eventId:actual.packet.eventId,packetHash:canonicalHash(actual.packet)}});
  return result;
 }
 /** Signal only. The paired machine holding the native lease when it is not a signed member of the installed graph membership, else null. Graph writes are
  * fenced to that lease, so owner changes recorded on a member wait here until a member holds the lease again; this names the machine they wait on. */
 writerOutsideMembership():string|null{const holder=this.options.leaseCoordinator.currentHolder();return holder&&holder!==this.machineId&&!this.config.membership.members.some(member=>member.machineId===holder)?holder:null;}
 private async forwardQueuedOwnerIntent(key:string,principalKey:string):Promise<GraphCommitOutcome|GraphQueuedIntentView>{
  const view=await this.intake.ownerQueue.status(key,principalKey);if(!view)throw new Error('graph-queued-owner-unavailable');if(view.state!=='recorded-local')return view;
  const holder=this.options.leaseCoordinator.currentHolder();if(this.writerOutsideMembership()){this.reportUnavailable('graph-writer-not-member');return view;}if(!this.alive()||!holder||holder===this.machineId||!this.config.membership.members.some(member=>member.machineId===holder))return view;
  try{const transfer=await this.intake.ownerQueue.exportForForward(key,principalKey),outcome=await this.request(holder,'owner-intent',{transfer}) as GraphCommitOutcome|GraphQueuedIntentView;
   if(!outcome||typeof outcome!=='object')throw new Error('graph-queued-forward-result-invalid');
   if('eventId'in outcome){if(outcome.idempotencyKey!==key||!['checking-save','recorded-local','saved-pending','committed','refused','canceled'].includes(outcome.state))throw new Error('graph-queued-forward-result-invalid');const response=await this.request(holder,'repair',{eventId:outcome.eventId}) as {record:unknown};if(!exactFields(response,['record'])||!response.record)throw new Error('graph-queued-forward-source-unavailable');const record=await this.hydratePeerRecord(response.record,holder);if(record.packet.idempotencyKey!==key||record.packet.writerId!==holder||!this.source.verifyHistoricalRecord(record))throw new Error('graph-queued-forward-source-invalid');await this.withMutation(async()=>{if(record.erasure)await this.applyInventoryErasures([record.erasure]);if(record.materialization)await this.source.receiveHistorical(record);else await this.source.receive(record,record.packet.writerId);await this.intake.ownerQueue.finish(key,principalKey,{state:'promoted',promotion:{eventId:record.packet.eventId,packetHash:canonicalHash(record.packet)}});});return outcome;}
   if(outcome.idempotencyKey!==key)throw new Error('graph-queued-forward-result-invalid');if(outcome.state==='refused-local'&&outcome.refusalCode)return this.intake.ownerQueue.finish(key,principalKey,{state:'refused-local',refusalCode:outcome.refusalCode});
  }catch{/* DegradationReporter internalOnly via reportUnavailable; durable forward-attempt prevents an unknown remote admission being called locally canceled. */this.reportUnavailable('graph-queued-owner-forwarding-pending');}
  return (await this.intake.ownerQueue.status(key,principalKey))??view;
 }
 async submitPrepared(input:{coreType:GraphCoreType;idempotencyKey:string;requestHash:string;core:unknown;authorizationProof:GraphAuthorizationProof;plaintextSource:Uint8Array},token:symbol):Promise<GraphCommitOutcome>{
  if(token!==this.activeMutation||!this.isReady())throw new Error('graph-runtime-mutation-not-admitted');
  const priorSource=this.source.lookupByIdempotencyKey(input.idempotencyKey);
  const priorReservation=(await this.intake.frozenReservations()).some(prior=>prior.packet.idempotencyKey===input.idempotencyKey);
  const fresh=!priorSource&&!priorReservation;
  if(fresh)await this.ensureNativeTailClosed();
  const record=await this.intake.reserve(input.idempotencyKey,input.requestHash,async()=>{
   const core=validateGraphOperationCore(input.coreType,input.core);if(!core||!validateGraphApplicationSource(input.coreType,core,input.authorizationProof,input.plaintextSource))throw new Error('graph-runtime-invalid-core-or-application');
   if(canonicalHash(input.authorizationProof.membership)!==canonicalHash(this.config.membership))throw new Error('graph-runtime-membership-changed');
   const all=[...this.source.recordsForRepair(),...await this.source.controlIntents(),...await this.intake.frozenReservations()];
   const ids=new Map<string,ConversationGraphReplicationRecord>();for(const prior of all){if(!this.source.verifyHistoricalRecord(prior))throw new Error('graph-runtime-unverified-source-tail');
    const existing=ids.get(prior.packet.eventId);if(existing&&canonicalHash(existing.packet)!==canonicalHash(prior.packet))throw new Error('graph-runtime-source-fork');ids.set(prior.packet.eventId,prior);}
   const tail=[...ids.values()].sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence);let predecessorHash:string|null=null;let sequence=0;
   for(const prior of tail){if(prior.packet.sourceSequence!==sequence+1||prior.packet.predecessorHash!==predecessorHash)throw new Error('graph-runtime-source-gap');sequence=prior.packet.sourceSequence;predecessorHash=prior.packet.coreHash;}
   const eventId=graphOperationIdentity(input.coreType,core);if(!ids.has(eventId)&&ids.size>=(this.config.maxHistoryEntries??GRAPH_RECOVERY_MAX_MANIFEST_ENTRIES))throw new Error('graph-runtime-history-capacity');const plaintext=encodeGraphSourceRecoveryEnvelope({coreType:input.coreType,core,authorizationProof:input.authorizationProof,applicationSource:input.plaintextSource});let encryptedSourceBundle;try{encryptedSourceBundle=sealGraphBundle(plaintext,this.config.membership.members,{agentId:this.config.agentId,eventId});}finally{plaintext.fill(0);}
   if(this.localErasure.isDenied(deriveGraphErasureIdentity(input.coreType,core)))throw new Error('graph-source-locally-erased');
   const receipt=input.authorizationProof.receipt;const packet={coreType:input.coreType,controlHash:canonicalHash(createGraphControlCapsule(input.coreType,core,input.authorizationProof)),erasureIdentity:deriveGraphErasureIdentity(input.coreType,core),agentId:this.config.agentId,eventId,idempotencyKey:input.idempotencyKey,
    coreHash:canonicalHash(core),authorizationReceiptHash:canonicalHash(receipt),sourceSequence:sequence+1,predecessorHash,
    membershipEpoch:receipt.membershipEpoch,leaseEpoch:receipt.leaseEpoch,writerId:this.machineId,sourceBundleHash:canonicalHash(encryptedSourceBundle)};
   return {coreType:input.coreType,packet,packetSignature:signGraphRecord('graph-operation-packet-v1',packet,this.signingKey),core,authorizationProof:input.authorizationProof,encryptedSourceBundle};
  });
  if(!this.source.lookupByIdempotencyKey(record.packet.idempotencyKey)){const actuation=this.actuation();await this.source.appendReserved(record,this.intake,actuation.lease,actuation.originalLease);}
  let advancedPredecessor=false;
  const predecessors=new Map<string,ConversationGraphReplicationRecord>();for(const prior of [...this.source.recordsForRepair(),...await this.source.controlIntents(),...await this.intake.frozenReservations()])if(prior.packet.sourceSequence<record.packet.sourceSequence)predecessors.set(prior.packet.eventId,prior);
  for(const prior of [...predecessors.values()].sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence)){
   const local=this.source.lookupByIdempotencyKey(prior.packet.idempotencyKey);
   if(local?.preparationProof||local?.erasedControlProof)continue;
   if(!local){if(prior.erasure)await this.source.receive(prior,prior.packet.writerId);else if(!prior.encryptedSourceBundle)return {state:'checking-save',idempotencyKey:record.packet.idempotencyKey,eventId:record.packet.eventId,waitingMachineIds:[],phase:'local',reason:'recovery-required'};else {const current=this.actuation();await this.source.appendReserved(prior,this.intake,current.lease,current.originalLease);}}
   const checkedPrior=await this.validatedContinuation(this.source.lookupByIdempotencyKey(prior.packet.idempotencyKey)??prior);
   if(!checkedPrior)return {state:'checking-save',idempotencyKey:record.packet.idempotencyKey,eventId:record.packet.eventId,waitingMachineIds:[],phase:'local',reason:'recovery-required'};
   if(checkedPrior.erasure||checkedPrior.cancellation||checkedPrior.adoption?.disposition==='refused')await this.coordinator.cancel(checkedPrior,lease=>signGraphRecord('graph-witness-action-v1',witnessActionPayload('cancel',{idempotencyKey:checkedPrior.packet.idempotencyKey},lease),this.signingKey));
   else await this.coordinator.submit(checkedPrior);advancedPredecessor=true;
   const custody=this.source.lookupByIdempotencyKey(prior.packet.idempotencyKey);
   if(!custody?.preparationProof&&!custody?.erasedControlProof){await this.drainJournal();return {state:'checking-save',idempotencyKey:record.packet.idempotencyKey,eventId:record.packet.eventId,waitingMachineIds:[],phase:'local',reason:'witness-unavailable'};}
  }
  const known=this.source.lookupByIdempotencyKey(record.packet.idempotencyKey)??record;const checked=await this.validatedContinuation(known,fresh&&!advancedPredecessor);
  if(!checked){const context=this.source.effectiveContext(known.packet.eventId),localOnly=!hasSeparateGraphPendingCopy(known,{membership:context.membership,leaseEpoch:context.lease.leaseEpoch});return {state:known.preparationProof&&!known.erasure?(localOnly?'recorded-local':'saved-pending'):'checking-save',idempotencyKey:record.packet.idempotencyKey,eventId:record.packet.eventId,waitingMachineIds:[],phase:known.preparationProof&&!known.erasure&&!localOnly?'witnessed':'local',reason:'recovery-required'};}
  if(checked.erasure||checked.cancellation||checked.adoption?.disposition==='refused'){
   await this.coordinator.cancel(checked,lease=>signGraphRecord('graph-witness-action-v1',witnessActionPayload('cancel',{idempotencyKey:checked.packet.idempotencyKey},lease),this.signingKey));
   return {state:'refused',idempotencyKey:record.packet.idempotencyKey,eventId:record.packet.eventId,waitingMachineIds:[],phase:'witnessed',reason:'recovery-required'};
  }
  const outcome=await this.coordinator.submit(checked);await this.drainJournal();return outcome;
 }
 get droppedOriginRegistry():DroppedOriginRegistry{return this.options.droppedOrigins;}
 get installedMembership():GraphMembershipEpoch{return structuredClone(this.config.membership);}
 get agentId():string{return this.config.agentId;}
 get ownerPublicKey():string{return this.config.ownerPublicKey;}
 private async observeLocal(captured:CapturedGraphSourceOperation,token:symbol):Promise<GraphCommitOutcome>{
  if(token!==this.activeMutation||!exactFields(captured,['capture','encryptedPayload'])||!verifyGraphSourceOperationCapture(captured.capture,this.config.membership))throw new Error('graph-source-observer-invalid');
  if(captured.capture.kind==='conversation-source-observation'&&this.localErasure.isDenied({sourceKind:'conversation-metadata',sourceId:canonicalHash(captured.capture.subject)}))throw new Error('graph-source-locally-erased');
  if(captured.capture.kind==='conversation-source-observation')assertGraphSourceObservationAdmission(captured.capture,{source:this.source,reader:this.reader,dropped:this.options.droppedOrigins});
  const prepared=prepareGraphSourceOperation(captured,{agentId:this.config.agentId,identity:this.options.identity,ownerPublicKey:this.config.ownerPublicKey,
   membership:this.config.membership,admission:this.options.writeAdmission,coordinator:this.options.leaseCoordinator,localErasure:this.localErasure});
  try{return await this.submitPrepared(prepared,token);}finally{prepared.plaintextSource.fill(0);}
 }
 setRemoteDelegationIntake(intake:(source:SignedRemoteGraphDelegationSource,token:symbol)=>Promise<GraphCommitOutcome>):void{
  if(this.remoteDelegationIntake||typeof intake!=='function')throw new Error('graph-remote-intake-already-configured');this.remoteDelegationIntake=intake;
 }
 private async delegateLocal(source:SignedRemoteGraphDelegationSource,token:symbol):Promise<GraphCommitOutcome>{
  if(this.activeMutation!==token||!this.isReady()||!verifyRemoteGraphDelegationSource(source,this.config.membership)||!this.remoteDelegationIntake)throw new Error('graph-remote-delegation-unavailable');
  this.actuation();return this.remoteDelegationIntake(source,token);
 }
 async delegate(source:SignedRemoteGraphDelegationSource):Promise<GraphCommitOutcome>{
  if(!this.alive()||!this.isReady()||source.attestation.targetMachineId!==this.machineId||!verifyRemoteGraphDelegationSource(source,this.config.membership))throw new Error('graph-remote-delegation-source-invalid');
  const holder=this.options.leaseCoordinator.currentHolder();if(!holder)throw new Error('graph-remote-delegation-no-holder');
  if(holder===this.machineId)return this.withSourceMutation(token=>this.delegateLocal(source,token));
  const outcome=await this.request(holder,'delegate',{source}) as GraphCommitOutcome;
  const expected=graphOperationKey('graph-event',`delegation-${canonicalHash({agentId:source.request.agentId,sourceId:source.request.sourceId})}`),idempotencyKey=`${source.request.agentId}:${source.request.sourceId}`;
  if(!exactFields(outcome,['state','idempotencyKey','eventId','waitingMachineIds','phase',...(outcome.reason?['reason']:[])])||outcome.eventId!==expected||outcome.idempotencyKey!==idempotencyKey||!['checking-save','recorded-local','saved-pending','committed','refused'].includes(outcome.state)||!Array.isArray(outcome.waitingMachineIds)||outcome.waitingMachineIds.some(id=>!this.config.membership.members.some(member=>member.machineId===id)))throw new Error('graph-remote-delegation-outcome-invalid');
  if(outcome.state==='recorded-local'||outcome.state==='saved-pending'||outcome.state==='committed'){
   const operation=await this.config.witness.operation(idempotencyKey),wire=(await this.request(holder,'repair',{eventId:expected}) as {record:unknown}).record,repaired=wire?await this.hydratePeerRecord(wire,holder):null;
   if(!repaired||canonicalHash(repaired.packet)!==canonicalHash(operation.packet)||canonicalHash(repaired.authorizationProof.dispatchSource)!==canonicalHash(source))throw new Error('graph-remote-delegation-proof-missing');
   if(repaired.erasure)await this.applyInventoryErasures([repaired.erasure]);await this.withMutation(()=>this.source.receive(repaired,repaired.packet.writerId));
   if(outcome.state==='committed'&&this.source.status(expected).state!=='committed')throw new Error('graph-remote-delegation-commit-unproven');
  }return outcome;
 }
 async observe(captured:CapturedGraphSourceOperation):Promise<GraphCommitOutcome>{
  if(!this.alive()||!this.isReady()||!exactFields(captured,['capture','encryptedPayload'])||captured.capture.producerMachineId!==this.machineId||!verifyGraphSourceOperationCapture(captured.capture,this.config.membership))throw new Error('graph-source-observer-unavailable');
  const holder=this.options.leaseCoordinator.currentHolder();if(!holder)throw new Error('graph-source-observer-no-holder');
  if(holder===this.machineId)return this.withSourceMutation(token=>this.observeLocal(captured,token));
  const outcome=await this.request(holder,'observe',{captured}) as GraphCommitOutcome;
  const sweep=captured.capture.kind==='source-inventory-sweep';const expected=graphOperationKey('source-observation',(sweep?sourceSweepEventId:sourceObservationEventId)(captured.capture.sourceId));
  if(!exactFields(outcome,['state','idempotencyKey','eventId','waitingMachineIds','phase',...(outcome.reason?['reason']:[])])||outcome.eventId!==expected||outcome.idempotencyKey!==`${sweep?'source-inventory':'source-observation'}:${captured.capture.sourceId}`
   ||!['checking-save','recorded-local','saved-pending','committed','refused'].includes(outcome.state)||!Array.isArray(outcome.waitingMachineIds)
   ||outcome.waitingMachineIds.some(id=>!this.config.membership.members.some(member=>member.machineId===id)))throw new Error('graph-source-observer-outcome-invalid');
  if(outcome.state==='recorded-local'||outcome.state==='saved-pending'||outcome.state==='committed'){
   const operation=await this.config.witness.operation(outcome.idempotencyKey);
   const wire=(await this.request(holder,'repair',{eventId:expected}) as {record:unknown}).record;const repaired=wire?await this.hydratePeerRecord(wire,holder):null;
   if(!repaired||canonicalHash(repaired.packet)!==canonicalHash(operation.packet)||canonicalHash(repaired.authorizationProof.sourceObservation)!==canonicalHash(captured.capture))throw new Error('graph-source-observer-proof-missing');
   await this.withMutation(()=>this.source.receive(repaired,repaired.packet.writerId));
   if(outcome.state==='committed'&&this.source.status(expected).state!=='committed')throw new Error('graph-source-observer-commit-unproven');
  }return outcome;
 }
 private liveAdmission(){const native=this.options.leaseCoordinator.currentLease();return {admitted:this.alive()&&this.positiveCustodyAllowed()&&this.nativeTailAdmissionAllowed(native)&&this.options.leaseCoordinator.holdsLease()&&this.nativeTailFloor.allows(native),writerId:native?.holder??null,
  leaseEpoch:native?.epoch??0,membershipEpoch:this.config.membership.epoch,fencedLeaseHash:native?canonicalHash(native):null};}
 async reconcilePending():Promise<Array<{eventId:string;state:string}>>{if(this.options.leaseCoordinator.holdsLease()&&this.isReady()){try{await this.prepareNativeTailClosure();}catch(error){/* DegradationReporter internalOnly via reportUnavailable; missing closed tails keep recovery held without blocking local queue custody. */this.noteTailClosure(error);this.reportUnavailable('graph-native-tail-closure-unavailable');return [];}}return this.withMutation(async()=>{
  const results:Array<{eventId:string;state:string}>=[];if(!this.options.leaseCoordinator.holdsLease()||!await this.refreshReadinessCore())return results;
  const records=this.source.recordsForRepair().filter(record=>!record.certificate&&!record.cancellationCertificate).sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence);
  for(const record of records){if(!this.alive())break;
   const pending=await this.validatedContinuation(record);if(!pending){results.push({eventId:record.packet.eventId,state:'held'});continue;}
   if(pending.erasure||pending.cancellation||pending.adoption?.disposition==='refused'){
    const outcome=await this.coordinator.cancel(pending,lease=>signGraphRecord('graph-witness-action-v1',witnessActionPayload('cancel',{idempotencyKey:pending.packet.idempotencyKey},lease),this.signingKey));results.push({eventId:record.packet.eventId,state:outcome.state});
   }else{const outcome=await this.coordinator.submit(pending);results.push({eventId:record.packet.eventId,state:outcome.state});}
  }return results;
 }).then(async results=>{await this.retryLocalOwnerIntents();return results;});}
 private async erasedCustodyAuthority(packet:GraphOperationPacket,proof:GraphWitnessErasedControlProof):Promise<{custodyMembership:GraphMembershipEpoch;custodyActivations:GraphMembershipActivationCertificate[]}>{
  const epoch=proof.custodyMembershipEpoch;if(epoch<packet.membershipEpoch||epoch-packet.membershipEpoch>128)throw new Error('graph-custody-activation-range-invalid');
  const custodyMembership=await this.config.witness.membership(epoch),custodyActivations:GraphMembershipActivationCertificate[]=[];
  for(let n=packet.membershipEpoch+1;n<=epoch;n++){const activation=await this.config.witness.activation(n);if(!activation)throw new Error('graph-custody-activation-missing');custodyActivations.push(activation);}
  return {custodyMembership,custodyActivations};
 }
 private reportUnavailable(reason:string):void{this.lastReadinessFailure=reason;DegradationReporter.getInstance().report({feature:'ConversationGraphReplication',primary:'Verified graph replication',fallback:'Keep the graph operation pending and current readiness withheld',reason,impact:'Conversation graph synchronization remains incomplete',internalOnly:true});}
 private async validatedContinuation(record:ConversationGraphReplicationRecord,fresh=false):Promise<ConversationGraphReplicationRecord|null>{
  if(record.certificate||record.cancellationCertificate)return record;
  const current=this.actuation(),effective=record.adoption?.currentLease??record.authorizationProof.lease;
  const changed=effective.writerId!==this.machineId||effective.leaseEpoch!==current.lease.leaseEpoch;
  if(record.erasure&&!record.preparationProof&&!record.erasedControlProof){
   try{const operation=await this.config.witness.admitErasedControl({packet:record.packet,packetSignature:record.packetSignature,controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),...current});
    if(canonicalHash(operation.packet)!==canonicalHash(record.packet))return null;
    if(operation.prepareProof)await this.source.attachPreparation(record.packet.eventId,operation.prepareProof);
    else if(operation.erasedControlProof){const authority=await this.erasedCustodyAuthority(record.packet,operation.erasedControlProof);await this.source.attachErasedControl(record.packet.eventId,operation.erasedControlProof,authority.custodyMembership,authority.custodyActivations);}else return null;
    record=this.source.repairRecord(record.packet.eventId)!;
   }catch{/* DegradationReporter internalOnly via reportUnavailable; caught payload is never persisted. */this.reportUnavailable('graph-continuation-authority-unavailable');return null;}
  }
  if((record.cancellation||record.erasure||record.adoption?.disposition==='refused')&&!changed)return record;

  if(!record.preparationProof&&!record.erasedControlProof){
   if(fresh&&!changed)return record;
   if(!record.encryptedSourceBundle)return null;
   if(changed){
    const helper=record.coreType==='graph-event'||record.coreType==='header-op'?this.recovery:record.coreType==='source-observation'?this.observationRecovery:null;if(!helper)return null;
    try{await this.ensureNativeTailClosed(true);const checked=helper.revalidate(record.packet.eventId),originalSourceReceipt=this.source.retainedOriginalSourceReceipt(record.packet.eventId);if(checked.state!=='validated'||checked.proof.decision!=='adopt'||!checked.rewrap)return null;
     const sourceCustody=originalSourceReceipt?{originalSourceReceipt}:{takeoverSourceReceipt:await this.source.nativeTakeoverCustodyReceipt(record.packet.eventId,current.lease,current.originalLease,this.closedNativeTailProof)};
     const operation=await this.config.witness.recoverPositiveSource({packet:record.packet,packetSignature:record.packetSignature,controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),encryptedSourceBundle:record.encryptedSourceBundle,...sourceCustody,closedTails:structuredClone(this.closedNativeTailProof),revalidation:checked.proof,rewrap:checked.rewrap,...current},plan=>signGraphRecord('graph-native-source-upload-v1',plan,this.signingKey));
     if(!operation.prepareProof||!operation.adoption||canonicalHash(operation.packet)!==canonicalHash(record.packet))return null;
     await this.source.attachPreparation(record.packet.eventId,operation.prepareProof);await this.source.receive({...record,preparationProof:operation.prepareProof,adoption:operation.adoption,...(operation.rewrap?{rewrap:operation.rewrap}:{})},record.packet.writerId);return this.source.repairRecord(record.packet.eventId);
    }catch(error){/* DegradationReporter internalOnly via reportUnavailable; recovery debt retains the exact original packet without allocating another sequence. */this.reportUnavailable('graph-native-tail-positive-recovery-unavailable');return null;}
   }
   try{const proof=await this.config.witness.prepare({controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof),packet:record.packet,packetSignature:record.packetSignature,encryptedSourceBundle:record.encryptedSourceBundle,...current});await this.source.attachPreparation(record.packet.eventId,proof);record=this.source.repairRecord(record.packet.eventId)!;}catch{/* DegradationReporter internalOnly via reportUnavailable; caught payload is never persisted. */this.reportUnavailable('graph-continuation-authority-unavailable');return null;}
  }
  const helper=record.coreType==='graph-event'||record.coreType==='header-op'?this.recovery:record.coreType==='source-observation'?this.observationRecovery:null;
  if(!helper)return null;const checked=helper.revalidate(record.packet.eventId);if(checked.state!=='validated')return null;
  if(!changed&&checked.proof.decision==='adopt')return record;
  try{const adoptions=await this.config.witness.adoptPending({currentLease:current.lease,originalCurrentLease:current.originalLease,revalidations:[{proof:checked.proof,rewrap:checked.rewrap}]});
   const adoption=adoptions.find(value=>value.idempotencyKey===record.packet.idempotencyKey);if(!adoption)return null;
   const operation=await this.config.witness.operation(record.packet.idempotencyKey);
   const pending={...record,adoption,...(operation.rewrap?{rewrap:operation.rewrap}:{}),...(operation.cancellation?{cancellation:operation.cancellation}:{}),...(operation.erasure?{erasure:operation.erasure,encryptedSourceBundle:null}:{})};
   if(pending.erasure)await this.applyInventoryErasures([pending.erasure]);await this.source.receive(pending,record.packet.writerId);return pending;
  }catch(error){/* DegradationReporter internalOnly via reportUnavailable; caught payload is never persisted. */this.reportUnavailable('graph-continuation-authority-unavailable');return null;}
 }
 private trustedInstalledSet():boolean{
  if(this.memberLossOpenOnly)return false;
  try{if(!verifyMembershipEpoch(this.config.membership,this.config.ownerPublicKey)||this.config.membership.agentId!==this.config.agentId)return false;const registry=this.options.identity.loadRegistry();const installed=new Set(Object.entries(registry.machines).filter(([,entry])=>entry.status==='active'&&!entry.revokedAt).map(([id])=>id));installed.add(this.machineId);
   // Every signed member must still be installed. A machine paired later has no signed place and cannot read sealed records, so it does not stop the members.
   if(!this.config.membership.members.every(member=>installed.has(member.machineId)))return false;
   return this.config.membership.members.every(member=>{const identity=member.machineId===this.machineId?this.options.identity.loadIdentity():this.options.identities.loadIdentity(member.machineId,'remote');
    const epoch=this.options.identities.getEpoch(member.machineId);
    return !!identity&&!epoch.revokedAt&&sameKey(identity.signingPublicKey,member.signingPublicKey)&&sameKey(identity.encryptionPublicKey,member.sealingPublicKey);});
  }catch{/* DegradationReporter internalOnly via reportUnavailable; caught payload is never persisted. */this.reportUnavailable('graph-installed-membership-unavailable');return false;}
 }
 /** Local-only capture has no roster or canonical authority. It still pins
  * the actual current self identity, epoch, keys and real process lock. */
 private recordingAlive():boolean{
  try{if(this.stopped||!this.options.instanceLock.revalidate())return false;const identity=this.options.identity.loadIdentity(),epoch=this.options.identities.getEpoch(identity.machineId);if(identity.machineId!==this.machineId||epoch.revokedAt||epoch.keyEpoch>(identity.keyEpoch??0)||epoch.signingTombstones.some(row=>row.fingerprint===crypto.createHash('sha256').update(identity.signingPublicKey).digest('hex').slice(0,32)))return false;
   const signing=crypto.createPublicKey(this.signingKey).export({type:'spki',format:'pem'}).toString(),current=crypto.createPublicKey(this.options.identity.loadSigningKey()).export({type:'spki',format:'pem'}).toString();return signing===current&&sameKey(identity.signingPublicKey,signing)&&sameKey(identity.encryptionPublicKey,crypto.createPublicKey(this.options.identity.loadEncryptionKey()).export({type:'spki',format:'pem'}).toString());
  }catch{/* DegradationReporter internalOnly via reportUnavailable; invalid or unavailable enrollment cannot accept local private custody. */this.reportUnavailable('graph-local-enrollment-unavailable');return false;}
 }
 private alive():boolean{return !this.stopped&&this.options.instanceLock.revalidate()&&this.trustedInstalledSet();}
 isReady():boolean{return this.alive()&&this.positiveCustodyAllowed()&&this.options.leaseCoordinator.currentEpoch()<=GRAPH_REPLICATION_MAX_LEASE_EPOCH&&this.readyAt>0&&this.readyLeaseEpoch===this.options.leaseCoordinator.currentEpoch()&&Date.now()-this.readyAt<60000;}
 projection(){if(!this.isReady())throw new Error('graph-runtime-not-ready');return this.source.certifiedUnion(this.reader,this.options.droppedOrigins);}
 /** A cold offline view requires physical all-member ACK proof and no known
  * peer-negative debt; it never grants current readiness or allocation. */
 async confirmLocalAcknowledgedSource(){if(!this.peerFrontier)throw new Error('graph-runtime-peer-frontier-unconfirmed');return this.peerFrontier.confirmLocalAcknowledgedSource(this.source,this.reader,this.options.droppedOrigins);}
 retainedProjection(){if(!this.alive()||!this.privateCustodyAllowed())throw new Error('graph-runtime-retained-unavailable');
  const retained=this.peerFrontier?.retainedSnapshotFor(this.source,this.config.membership)??null;if(this.lastVerifiedAt===0&&!retained)throw new Error('graph-runtime-retained-unavailable');
  const union=this.source.certifiedUnion(this.reader,this.options.droppedOrigins),current=this.isReady();
  const records=!current&&retained?union.records.filter(record=>record.packet.sourceSequence<=retained.highestAcknowledgedSequence):union.records;
  return {...union,records,partial:union.partial||!current,olderRevision:!current,verifiedAt:!current&&retained?retained.acknowledgedAt:new Date(this.lastVerifiedAt).toISOString()};}
 setOwnedControlFrameCache(cache:GraphOwnedControlFrameCache):void{if(!(cache instanceof GraphOwnedControlFrameCache)||cache.stateRoot!==realpathSync(this.options.stateDir)||cache.agentId!==this.config.agentId||this.stopped)throw new Error('graph-control-frame-scope-invalid');if(this.ownedControlFrames!==cache)this.ownedControlFrames?.close();this.ownedControlFrames=cache;}
 private async denyLocalErasure(target:GraphErasureIdentity):Promise<void>{try{await this.localErasure.deny(target);}finally{this.ownedControlFrames?.purge(target);this.source.purgeMemberLossSnapshots(target);this.transfer.purgePrivateStageViews(target);}}
 /** Priority local suppression is outside the ordinary mutation queue. */
 async eraseLocal(target:GraphErasureIdentity):Promise<void>{
  await this.denyLocalErasure(target);
  purgeLocallyDeniedGraphSourceObservationCache({stateDir:this.options.stateDir,agentId:this.config.agentId,target,fence:this.localErasure});
  await Promise.all([this.source.eraseLocal(target),this.intake.eraseLocal(target),this.transfer.eraseLocal(target)]);
 }
 async localFleetPurge(target:GraphErasureIdentity,proof?:import('../core/GraphWitnessTypes.js').GraphWitnessErasure,ingress?:GraphErasureIngress):Promise<{purgeInventoryHash:string}>{
  if(proof){if(canonicalHash(proof.target)!==canonicalHash(target))throw new Error('graph-erasure-target-mismatch');await this.source.applyErasure(proof,this.source.erasureAuthorities.has(proof)?undefined:await this.config.witness.erasureAuthority(proof));}
  await this.eraseLocal(target);
  if(proof)await Promise.all([this.intake.applyErasure(proof,this.config.agentId),this.transfer.applyErasure(proof,this.config.agentId)]);
  const hashes=await Promise.all([this.source.assertLocalErasurePurged(target),this.intake.assertLocalErasurePurged(target),this.transfer.assertLocalErasurePurged(target)]);
  const cache=assertGraphSourceObservationCachePurged({stateDir:this.options.stateDir,agentId:this.config.agentId,target,fence:this.localErasure});
  let custodyRoles:string|null=null;if(this.config.membership.custodyProfile?.mode==='owned-machine'){
   if(!this.custodyAuthority)throw new Error('graph-custody-role-purge-authority-unconfirmed');const helper=new GraphCustodyRetiredRoles({stateDir:this.options.stateDir,identity:this.options.identity,authority:this.custodyAuthority});
   if(proof){let authority=this.source.erasureAuthorities.context(proof);if(!authority||canonicalHash(authority.membership)!==canonicalHash(this.custodyAuthority.verifiedNegativeRoleLineage().current)){authority=await this.config.witness.erasureAuthority(proof);await this.source.erasureAuthorities.accept(proof,authority);}custodyRoles=helper.purge(target,{proof,erasureAuthority:authority}).purgeInventoryHash;}
   else{if(!ingress)throw new Error('graph-custody-role-purge-ingress-required');custodyRoles=helper.purge(target,{ingress,fence:this.localErasure}).purgeInventoryHash;}
  }
  else{const inventory=inspectGraphCustodyRoleFiles(this.options.stateDir);if(inventory.roles.length||inventory.debt.length)throw new GraphCustodyRolePurgeDebt([...inventory.debt,...inventory.roles.map(role=>({scope:'custody-role:'+canonicalHash(role.databasePath),reason:'authority-unconfirmed'}))]);custodyRoles=inventory.inventoryHash;}
  return {purgeInventoryHash:canonicalHash({v:1,target,source:hashes[0],intake:hashes[1],transfer:hashes[2],cache,custodyRoles,ownedControlFrames:this.ownedControlFrames?.assertLocalErasurePurged(target)??null})};
 }
 /** Newest activity seen on this machine. Ordering only: it adds no conversation and no authority. */
 private readonly localActivity=new Map<string,string>();
 noteLocalActivity(ref:ConversationRef,lastActivity:string|null):void{if(lastActivity)this.localActivity.set(nodeKey(ref),lastActivity);}
 inventory(){const retained=this.retainedProjection();const inventory=materializeGraphSourceInventory({source:this.source,reader:this.reader,dropped:this.options.droppedOrigins,membership:this.config.membership});
  const conversations=inventory.conversations.map(row=>{const live=this.localActivity.get(nodeKey(row.ref));return live&&live>(row.lastActivity??'')?{...row,lastActivity:live}:row;});
  return {...inventory,conversations,partial:inventory.partial||retained.partial,olderRevision:retained.olderRevision,verifiedAt:retained.verifiedAt};}
 /** Negative-only lookup: historical certified opaque creator identity may
  * select a forget target before restored serving readiness is established. */
 erasureHeaderId(rawEffort:unknown):string|null{
  const effort=validateNodeRef(rawEffort);if(!effort||effort.kind!=='effort'||this.stopped||!this.options.instanceLock.revalidate())return null;
  const ids=new Set<string>();for(const record of this.source.certifiedUnion(this.reader,this.options.droppedOrigins).records){
   if(record.coreType!=='graph-event')continue;const core=validateGraphEvent(record.core);
   if(core?.op==='create-effort'&&canonicalHash(core.subject)===canonicalHash(effort))ids.add(core.headerId);
  }return ids.size===1?[...ids][0]:null;
 }
 readiness(){return {current:this.isReady(),retained:this.alive()&&this.privateCustodyAllowed()&&(this.lastVerifiedAt>0||!!this.peerFrontier?.retainedSnapshotFor(this.source,this.config.membership)),verifiedAt:this.lastVerifiedAt?new Date(this.lastVerifiedAt).toISOString():null};}
 /** Only the exact owner-authorized transition already held on this machine
  * may obtain native bridges while ordinary graph admission is fenced. */
 /** Enroll only roles independently verified by the actual durable ACT store.
  * This adds cryptographic verification keys, never releases positive holds. */
 installNegativeCustodyRole(activation:import('../core/GraphWitnessTypes.js').GraphMembershipActivationCertificate):void{
  if(!this.custodyAuthority)throw new Error('graph-runtime-custody-authority-unconfirmed');
  const lineage=this.custodyAuthority.verifiedNegativeRoleLineage(),row=[...lineage.activations,...lineage.memberLossActivations].find(row=>canonicalHash(row.certificate)===canonicalHash(activation));
  if(!row)throw new Error('graph-runtime-negative-role-unverified');
  const membership=row.certificate.newMembership,profile=membership.custodyProfile,keys=this.config.witnessPublicKeys;
  if(!profile||profile.witnessId!==membership.witnessId||!(keys instanceof Map))throw new Error('graph-runtime-negative-role-key-store-unavailable');
  const prior=keys.get(profile.witnessId);if(prior&&crypto.createPublicKey(prior).export({type:'spki',format:'pem'})!==crypto.createPublicKey(profile.witnessPublicKey).export({type:'spki',format:'pem'}))throw new Error('graph-runtime-negative-role-key-conflict');
  keys.set(profile.witnessId,profile.witnessPublicKey);this.source.installHistoricalImportAuthority(this.custodyAuthority);this.transfer.bindCustodyAuthority(this.custodyAuthority);
 }
 custodyTransitionActuation(intent:GraphCustodyHoldIntent){
  if(!this.custodyAuthority)throw new Error('graph-runtime-custody-authority-unconfirmed');this.custodyAuthority.assertHeldIntent(intent);
  if(canonicalHash(intent.previousMembership)!==canonicalHash(this.config.membership))throw new Error('graph-runtime-transition-profile-mismatch');
  const previous=this.nativeActuation(),raw={...unsigned(previous.lease),membershipEpoch:intent.newMembership.epoch};
  const member=intent.newMembership.members.find(row=>row.machineId===this.machineId),original=this.config.membership.members.find(row=>row.machineId===this.machineId);if(!member||!original||member.signingPublicKey!==original.signingPublicKey)throw new Error('graph-runtime-transition-writer-unregistered');
  const next={lease:{...raw,signature:signGraphRecord('graph-lease-v1',raw,this.signingKey)},originalLease:previous.originalLease};if(!verifyFencedLeaseBridge(next.lease,next.originalLease,intent.newMembership))throw new Error('graph-runtime-transition-native-proof-invalid');return {previous,next};
 }
 actuation(){this.assertPositiveCustody();return this.nativeActuation();}
 private nativeActuation(){if(!this.alive()||!this.options.leaseCoordinator.holdsLease())throw new Error('graph-runtime-write-fenced');
  const guard=this.options.writeAdmission.guardStoreWrite('conversationGraph.append');if(guard.enforce==='refuse')throw new Error('graph-runtime-write-fenced');
  const native=this.options.leaseCoordinator.currentLease();if(!native||native.holder!==this.machineId||!this.nativeTailFloor.allows(native))throw new Error('graph-runtime-no-native-lease');
  if(native.epoch>GRAPH_REPLICATION_MAX_LEASE_EPOCH)throw new Error('graph-runtime-native-epoch-capacity');
  const value={v:1 as const,agentId:this.config.agentId,membershipEpoch:this.config.membership.epoch,leaseEpoch:native.epoch,writerId:this.machineId,
   issuedAt:native.acquiredAt,expiresAt:native.expiresAt,fencedLeaseHash:canonicalHash(native)};
  const lease:GraphWitnessLease={...value,signature:signGraphRecord('graph-lease-v1',value,this.signingKey)};return {lease,originalLease:native};
 }
 /** Trusted maintenance primes the real all-member closure while peers are awake; no source sequence or receipt is allocated. */
 async prepareNativeTailClosure():Promise<void>{
  const current=this.actuation(),key=this.nativeTailKey(current.lease);if(this.closedNativeTail===key)return;
  if(!this.nativeTailPreparing)this.nativeTailPreparing=this.collectNativeTailClosure().finally(()=>{this.nativeTailPreparing=null;});await this.nativeTailPreparing;if(this.closedNativeTail!==this.nativeTailKey(this.actuation().lease))throw new Error('graph-native-tail-context-changed');
 }
 async withSourceMutation<T>(work:(token:symbol)=>Promise<T>|T):Promise<T>{await this.prepareNativeTailClosure();return this.withMutation(work);}
 private nativeTailAdmissionAllowed(native:import('../core/types.js').LeaseRecord|null):boolean{return !!native&&this.closedNativeTail===canonicalHash({membership:canonicalHash(this.config.membership),writerId:native.holder,epoch:native.epoch});}
 private nativeTailKey(lease:GraphWitnessLease):string{return canonicalHash({membership:canonicalHash(this.config.membership),writerId:lease.writerId,epoch:lease.leaseEpoch});}
 private async snapshotNativeTail(lease:GraphWitnessLease,originalLease:import('../core/types.js').LeaseRecord):Promise<GraphNativeTailClosure>{
  this.source.assertNativeTailReadable();const records=[...await this.source.nativeTailRecords(),...await this.intake.nativeTailReservations()];for(const record of records)if(!this.source.verifyHistoricalRecord(record))throw new Error('graph-native-tail-untrusted-source');
  const entries=graphNativeTailEntries(records),value={v:1 as const,agentId:this.config.agentId,membershipHash:canonicalHash(this.config.membership),writerId:lease.writerId,leaseEpoch:lease.leaseEpoch,nativeLeaseHash:canonicalHash(originalLease),machineId:this.machineId,tailHash:canonicalHash(entries),entryCount:entries.length,highestSourceSequence:entries.at(-1)?.sourceSequence??0,recordedAt:new Date().toISOString()};
  const closure={receipt:{...value,signature:signGraphRecord(GRAPH_NATIVE_TAIL_DOMAIN,value,this.signingKey)},observedLease:lease,originalObservedLease:originalLease,entries};this.tailSnapshot=closure;return closure;
 }
 private async collectNativeTailClosure():Promise<void>{
  const current=this.actuation(),key=this.nativeTailKey(current.lease);
  await this.nativeTailFloor.observe(this.config.membership,current.lease,current.originalLease);const closures:GraphNativeTailClosure[]=[];
   for(const member of this.config.membership.members){let closure:GraphNativeTailClosure;
    if(member.machineId===this.machineId)closure=await this.withMutation(()=>this.snapshotNativeTail(current.lease,current.originalLease));
    else{const first=await this.request(member.machineId,'tail-close',current) as GraphNativeTailClosure;closure={...first,entries:[...(first.entries??[])]};if(!first.receipt||!Number.isSafeInteger(first.receipt.entryCount)||first.receipt.entryCount<0||first.receipt.entryCount>20000||!Array.isArray(first.entries)||first.entries.length!==Math.min(32,first.receipt.entryCount))throw new Error('graph-native-tail-response-invalid');for(let index=1;closure.entries.length<first.receipt.entryCount;index++){const page=await this.request(member.machineId,'tail-page',{tailHash:first.receipt.tailHash,index}) as {entries:GraphNativeTailClosure['entries']};if(!exactFields(page,['entries'])||!Array.isArray(page.entries)||page.entries.length!==Math.min(32,first.receipt.entryCount-index*32))throw new Error('graph-native-tail-page-invalid');closure.entries.push(...page.entries);}}
    if(!verifyGraphNativeTailClosure(closure,this.config.membership,current.lease))throw new Error('graph-native-tail-proof-invalid');closures.push(closure);
   }
   if(!verifyGraphNativeTailBarrier(closures,this.config.membership,current.lease))throw new Error('graph-native-tail-conflict-or-gap');
   const localRecords=new Map([...this.source.recordsForRepair(),...await this.source.controlIntents(),...await this.intake.frozenReservations()].map(record=>[record.packet.eventId,record]));
   const repairs:ConversationGraphReplicationRecord[]=[];
   for(const closure of closures)for(const entry of closure.entries){const local=localRecords.get(entry.eventId);if(local&&canonicalHash(local.packet)===entry.packetHash)continue;if(closure.receipt.machineId===this.machineId)throw new Error('graph-native-tail-local-record-missing');const reply=await this.request(closure.receipt.machineId,'tail-record',{tailHash:closure.receipt.tailHash,eventId:entry.eventId}) as {record:unknown};if(!exactFields(reply,['record'])||!reply.record)throw new Error('graph-native-tail-repair-missing');const record=await this.hydratePeerRecord(reply.record,closure.receipt.machineId);if(record.erasure&&!this.source.erasureAuthorities.has(record.erasure))await this.source.erasureAuthorities.accept(record.erasure,await this.config.witness.erasureAuthority(record.erasure));if(canonicalHash(record.packet)!==entry.packetHash||graphNativeTailEntries([record])[0].sourceProofHash!==entry.sourceProofHash||!this.source.verifyHistoricalRecord(record))throw new Error('graph-native-tail-repair-invalid');repairs.push(record);localRecords.set(record.packet.eventId,record);}
   for(const record of repairs)if(record.erasure&&!this.source.erasureAuthorities.has(record.erasure))await this.source.erasureAuthorities.accept(record.erasure,await this.config.witness.erasureAuthority(record.erasure));
   await this.withMutation(async()=>{
    if(this.nativeTailKey(this.actuation().lease)!==key)throw new Error('graph-native-tail-context-changed');
    for(const record of repairs){if(record.erasure)await this.applyInventoryErasures([record.erasure]);if(record.materialization)await this.source.receiveHistorical(record);else if(!record.preparationProof&&!record.adoption&&(record.packet.writerId!==current.lease.writerId||record.packet.leaseEpoch!==current.lease.leaseEpoch))await this.source.receiveNativeTakeover(record);else await this.source.receive(record,record.packet.writerId);}
    const own=closures.findIndex(closure=>closure.receipt.machineId===this.machineId);closures[own]=await this.snapshotNativeTail(current.lease,current.originalLease);
    if(!verifyGraphNativeTailBarrier(closures,this.config.membership,current.lease))throw new Error('graph-native-tail-repaired-union-invalid');
    const union=new Map(closures.flatMap(closure=>closure.entries).map(entry=>[entry.eventId,entry]));for(const record of [...this.source.recordsForRepair(),...await this.source.controlIntents(),...await this.intake.frozenReservations()]){const known=union.get(record.packet.eventId);if(!known||canonicalHash(record.packet)!==known.packetHash)throw new Error('graph-native-tail-inventory-changed');}
    if(this.nativeTailKey(this.actuation().lease)!==key)throw new Error('graph-native-tail-context-changed');this.closedNativeTailProof=structuredClone(closures);this.closedNativeTail=key;
   });
 }
 private async ensureNativeTailClosed(forRecovery=false):Promise<void>{
  const current=this.actuation();if(this.closedNativeTail!==this.nativeTailKey(current.lease))throw new Error('graph-native-tail-closure-required');
  // A reservation is the copy taken before the witness answered. Once Source holds the row, Source's copy is the one that carries the proof.
  if(!forRecovery){const controlRows=await this.source.controlIntents(),frozen=await this.intake.frozenReservations();for(const record of [...this.source.recordsForRepair(),...controlRows,...frozen.filter(row=>!this.source.repairRecord(row.packet.eventId))])if((record.packet.leaseEpoch!==current.lease.leaseEpoch||record.packet.writerId!==this.machineId)&&!record.preparationProof&&!record.erasedControlProof&&!record.certificate&&!record.cancellationCertificate)throw new Error('graph-native-tail-recovery-required');}
 }
 private authenticate(request:PeerRequest):void{
  if(!this.alive()||!exactFields(request,['v','agentId','membershipHash','sender','target','action','requestId','issuedAt','body','signature'])
   ||request.v!==1||request.agentId!==this.config.agentId||request.membershipHash!==canonicalHash(this.config.membership)||request.target!==this.machineId
   ||!['source','certificate','proof','repair','observe','context','erase-forward','erase-purge','delegate','custody','owner-current','completion','tail-close','tail-page','tail-record','owner-intent','custody-transition'].includes(request.action)||!/^[a-f0-9]{32}$/.test(request.requestId)
   ||!Number.isFinite(Date.parse(request.issuedAt))||Math.abs(Date.now()-Date.parse(request.issuedAt))>MAX_SKEW
   ||Buffer.byteLength(canonicalJson(request))>MAX_BYTES)throw new Error('graph-peer-invalid');
  const member=this.config.membership.members.find(row=>row.machineId===request.sender);if(!member||!verifyGraphRecord(REQUEST_DOMAIN,unsigned(request),request.signature,member.signingPublicKey))throw new Error('graph-peer-signature');
  const now=Date.now();for(const [id,at]of this.replays)if(now-at>MAX_SKEW*2)this.replays.delete(id);
  const replayKey=`${request.sender}:${request.requestId}`;if(this.replays.has(replayKey)||this.replays.size>=4096)throw new Error('graph-peer-replayed');this.replays.set(replayKey,now);
 }
 private async execute(action:Action,raw:unknown,sender?:string,token?:symbol):Promise<unknown>{
  if(action==='owner-intent'){
   const body=raw as {transfer:GraphQueuedIntentTransfer};if(!exactFields(body,['transfer'])||!sender||!token||!this.queuedOwnerPromoter||!this.options.leaseCoordinator.holdsLease())throw new Error('graph-queued-owner-forwarding-unavailable');
   this.actuation();const intent=await this.intake.ownerQueue.importForwarded(body.transfer,sender);return this.promoteQueuedOwnerIntentCore(intent.idempotencyKey,intent.principalKey,this.queuedOwnerPromoter,token);
  }
  if(action==='tail-close'){
   const body=raw as {lease:GraphWitnessLease;originalLease:import('../core/types.js').LeaseRecord};if(!exactFields(body,['lease','originalLease'])||sender!==body.lease?.writerId||!verifyFencedLeaseBridge(body.lease,body.originalLease,this.config.membership))throw new Error('graph-native-tail-request-invalid');
   await this.options.leaseCoordinator.pullFromPeers();const actual=this.options.leaseCoordinator.currentLease();if(!actual||actual.epoch!==body.originalLease.epoch||actual.holder!==body.originalLease.holder)throw new Error('graph-native-tail-native-observation-missing');
   await this.nativeTailFloor.observe(this.config.membership,body.lease,body.originalLease);
   return this.withMutation(async()=>{const closure=await this.snapshotNativeTail(body.lease,body.originalLease);return {receipt:closure.receipt,observedLease:closure.observedLease,originalObservedLease:closure.originalObservedLease,entries:closure.entries.slice(0,32)};});
  }
  if(action==='tail-page'||action==='tail-record'){
   const body=raw as {tailHash:string;index?:number;eventId?:string},snapshot=this.tailSnapshot,native=this.options.leaseCoordinator.currentLease();if(!snapshot||sender!==snapshot.receipt.writerId||!native||native.epoch!==snapshot.receipt.leaseEpoch||native.holder!==sender||!this.nativeTailFloor.allows(native)||body.tailHash!==snapshot.receipt.tailHash)throw new Error('graph-native-tail-snapshot-unavailable');
   if(action==='tail-page'){if(!exactFields(body,['tailHash','index'])||!Number.isSafeInteger(body.index)||body.index!<0||body.index!*32>=snapshot.entries.length)throw new Error('graph-native-tail-page-invalid');return {entries:snapshot.entries.slice(body.index!*32,(body.index!+1)*32)};}
   if(!exactFields(body,['tailHash','eventId'])||!snapshot.entries.some(entry=>entry.eventId===body.eventId))throw new Error('graph-native-tail-record-invalid');const record=this.source.repairRecord(body.eventId!)??(await this.source.controlIntents()).find(row=>row.packet.eventId===body.eventId)??(await this.intake.frozenReservations()).find(row=>row.packet.eventId===body.eventId);return {record:record?this.source.recordForTransport(record):null};
  }
  if(action==='owner-current'){const body=raw as {idempotencyKey:string;admissionHash:string};if(!exactFields(body,['idempotencyKey','admissionHash'])||typeof body.idempotencyKey!=='string'||body.idempotencyKey.length>200||typeof body.admissionHash!=='string'||!/^[a-f0-9]{64}$/.test(body.admissionHash)||!this.recordedOwnerAuthority)throw new Error('graph-owner-current-unavailable');const intent=await this.intake.ownerQueue.readRecordedIntent(body.idempotencyKey);if(!intent||intent.recordedMachineId!==this.machineId||canonicalHash(intent.admission)!==body.admissionHash)throw new Error('graph-owner-current-snapshot-mismatch');const view=await this.intake.ownerQueue.status(intent.idempotencyKey,intent.principalKey);if(!view?.mayServeDetails())throw new Error('graph-owner-current-private-custody-quarantined');const current=await this.recordedOwnerAuthority(intent);return {idempotencyKey:body.idempotencyKey,admissionHash:body.admissionHash,current};}

  if(action==='custody-transition'){if(!sender||!this.custodyTransitionHandler||!exactFields(raw as object,['payload']))throw new Error('graph-custody-transition-unavailable');return this.custodyTransitionHandler((raw as {payload:unknown}).payload,sender);}
  if(action==='custody'){const body=raw as {method:'GET'|'POST';path:string;body?:unknown},profile=this.config.membership.custodyProfile,transport=this.config.localCustodyTransport;
   if(!body||!exactFields(body,Object.prototype.hasOwnProperty.call(body,'body')?['method','path','body']:['method','path'])||!['GET','POST'].includes(body.method)||typeof body.path!=='string'||body.path.length>2048||!profile||profile.mode!=='owned-machine'||profile.hostMachineId!==this.machineId||!transport||transport.agentId!==this.config.agentId||transport.witnessId!==profile.witnessId||transport.membershipEpoch!==this.config.membership.epoch||transport.profileHash!==canonicalHash(profile))throw new Error('graph-peer-custody-role-invalid');
   if(graphCustodyRequiresRoleFrontier(body.method,body.path))this.assertCustodyRoleFrontier();return transport.request(body.method,body.path,body.body);
  }
  if(action==='erase-forward'){const body=raw as {ingress:GraphErasureIngress;membership:GraphMembershipEpoch};if(!exactFields(body,['ingress','membership']))throw new Error('graph-erasure-body-invalid');await this.erasure.forwardIngress(body.ingress,body.membership);return {requestId:body.ingress.requestId};}
  if(action==='erase-purge'){const body=raw as {requestId:string};if(!exactFields(body,['requestId']))throw new Error('graph-erasure-body-invalid');await this.erasure.purgeRequest(body);return {requestId:body.requestId};}
  if(action==='delegate'){const body=raw as {source:SignedRemoteGraphDelegationSource};if(!exactFields(body,['source'])||!token||body.source?.attestation?.targetMachineId!==sender||!verifyRemoteGraphDelegationSource(body.source,this.config.membership))throw new Error('graph-peer-delegation-mismatch');return this.delegateLocal(body.source,token);}
  if(action==='observe'){const body=raw as {captured:CapturedGraphSourceOperation};if(!exactFields(body,['captured'])||body.captured?.capture?.producerMachineId!==sender||!token)throw new Error('graph-peer-observer-mismatch');return this.observeLocal(body.captured,token);}
  if(action==='context'){const body=raw as {contextHash:string;index:number};if(!exactFields(body,['contextHash','index'])||!this.alive())throw new Error('graph-context-request-invalid');return this.source.contextPage(body.contextHash,body.index);}
  const body=raw as {record?:ConversationGraphReplicationRecord;eventId?:string};
  if(action==='repair'){if(!exactFields(body,['eventId'])||typeof body.eventId!=='string'||!this.alive()||this.lastVerifiedAt===0)throw new Error('graph-peer-repair-unready');const record=this.source.repairRecord(body.eventId);return {record:record?this.source.recordForTransport(record):null};}
  if(!exactFields(body,['record'])||!body.record)throw new Error('graph-peer-invalid-body');
  if(this.lastVerifiedAt===0&&!await this.refreshReadinessCore())throw new Error('graph-peer-restored-source-unready');
  const record=await this.hydratePeerRecord(body.record,sender!);if(record.erasure)await this.applyInventoryErasures([record.erasure]);if(record.materialization){if(action!=='proof'&&action!=='completion')throw new Error('graph-peer-history-not-new-source');await this.source.receiveHistorical(record);return {receipt:action==='completion'?await this.source.durableDeliveryCompletionReceipt(record.packet.eventId):await this.source.durableCommitProofDeliveryReceipt(record.packet.eventId)};}const received=await this.source.receive(record,record.packet.writerId);
  if(action==='source')return {receipt:received};
  if(action==='certificate'){if(!this.isReady()&&!await this.refreshReadinessCore())throw new Error('graph-peer-certificate-unready');if(record.certificate)return {receipt:await this.source.attachCertificate(record.packet.eventId,record.certificate)};if(record.cancellationCertificate)return {receipt:await this.source.attachCancellationCertificate(record.packet.eventId,record.cancellationCertificate)};throw new Error('graph-peer-certificate-missing');}
  return {receipt:action==='completion'?await this.source.durableDeliveryCompletionReceipt(record.packet.eventId):await this.source.durableCommitProofDeliveryReceipt(record.packet.eventId)};
 }
 /** Signed registered-member transport only; the installed controller validates
  * each operation's owner/hold/transfer authority before returning actual proofs. */
 setCustodyTransitionHandler(handler:(payload:unknown,sender:string)=>Promise<unknown>):void{if(this.custodyTransitionHandler)throw new Error('graph-custody-transition-handler-already-installed');this.custodyTransitionHandler=handler;}
 requestCustodyTransition(machineId:string,payload:unknown):Promise<unknown>{return this.request(machineId,'custody-transition',{payload});}
 async custodyTransitionTail(intent:GraphCustodyHoldIntent,previous:{lease:GraphWitnessLease;originalLease:import('../core/types.js').LeaseRecord}):Promise<GraphNativeTailClosure>{
  if(!this.custodyAuthority)throw new Error('graph-runtime-custody-authority-unconfirmed');this.custodyAuthority.assertHeldIntent(intent);
  if(canonicalHash(intent.previousMembership)!==canonicalHash(this.config.membership)||!verifyFencedLeaseBridge(previous.lease,previous.originalLease,this.config.membership))throw new Error('graph-runtime-transition-native-proof-invalid');
  await this.options.leaseCoordinator.pullFromPeers();const actual=this.options.leaseCoordinator.currentLease();if(!actual||actual.epoch!==previous.originalLease.epoch||actual.holder!==previous.originalLease.holder)throw new Error('graph-native-tail-native-observation-missing');
  await this.nativeTailFloor.observe(this.config.membership,previous.lease,previous.originalLease);
  return this.withMutation(async()=>{this.custodyAuthority!.assertHeldIntent(intent);return this.snapshotNativeTail(previous.lease,previous.originalLease);});
 }
 public requestCustody(machineId:string,body:{method:'GET'|'POST';path:string;body?:unknown}):Promise<unknown>{const profile=this.config.membership.custodyProfile;if(!profile||profile.mode!=='owned-machine'||profile.hostMachineId!==machineId)return Promise.reject(new Error('graph-peer-custody-target-invalid'));return this.request(machineId,'custody',body);}
 private async request(machineId:string,action:Action,body:unknown):Promise<unknown>{
  if(!this.alive()||!this.config.membership.members.some(member=>member.machineId===machineId))throw new Error('graph-peer-not-installed');
  const registry=this.options.identity.loadRegistry();const peer=registry.machines[machineId];if(!peer)throw new Error('graph-peer-unavailable');
  const endpoints=this.options.endpointResolver.resolve(machineId,peer.endpoints,peer.lastKnownUrl);
  const wireBody=body&&typeof body==='object'&&'record'in body?{...body,record:this.source.recordForTransport((body as {record:ConversationGraphReplicationRecord}).record)}:body;
  const value={v:1 as const,agentId:this.config.agentId,membershipHash:canonicalHash(this.config.membership),sender:this.machineId,target:machineId,
   action,requestId:crypto.randomBytes(16).toString('hex'),issuedAt:new Date().toISOString(),body:wireBody};
  const request={...value,signature:signGraphRecord(REQUEST_DOMAIN,value,this.signingKey)};const member=this.config.membership.members.find(row=>row.machineId===machineId)!;
  for(const endpoint of endpoints){try{if(!isPeerUrlAllowedForCredentials({url:endpoint.url,kind:endpoint.kind}).ok)continue;const url=new URL(endpoint.url);if(url.username||url.password||url.search||url.hash)continue;
    const response=await fetch(new URL(PREFIX+'/replicate',url.origin),{method:'POST',headers:{Authorization:`Bearer ${this.config.peerBearerToken}`,'Content-Type':'application/json'},
     body:canonicalJson(request),signal:AbortSignal.timeout(5000),redirect:'error'});if(!response.ok)continue;
    const reader=response.body?.getReader();if(!reader)continue;let total=0;const chunks:Uint8Array[]=[];for(;;){const next=await reader.read();if(next.done)break;total+=next.value.byteLength;if(total>MAX_BYTES){await reader.cancel();throw new Error('graph-peer-response-too-large');}chunks.push(next.value);}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8')) as PeerResponse;
    if(!exactFields(result,['v','agentId','sender','target','requestHash','body','signature'])||result.v!==1||result.agentId!==this.config.agentId||result.sender!==machineId||result.target!==this.machineId
      ||result.requestHash!==canonicalHash(request)||!verifyGraphRecord(RESPONSE_DOMAIN,unsigned(result),result.signature,member.signingPublicKey))throw new Error('graph-peer-response-invalid');return result.body;
   }catch{/* @silent-fallback-ok: retry only installed-registry resolver candidates; no failed transport grants authority. */}}
  throw new Error('graph-peer-unavailable');
 }
 private async hydratePeerRecord(raw:unknown,sender:string):Promise<ConversationGraphReplicationRecord>{
  const record=raw as ConversationGraphReplicationRecord;const reference=record?.materialization as unknown;
  if(!reference)return record;const cached=await this.source.hydrateTransportRecordCached(raw);if(cached)return cached;if(!validateGraphMaterializationReference(reference))throw new Error('graph-context-wire-reference-required');
  let total=0,pages=0;const chunks:Buffer[]=[];
  for(let index=0;index===0||index<pages;index++){
   const page=await this.request(sender,'context',{contextHash:reference.contextHash,index});
   if(!validateGraphContextPage(page,reference,index)||index>0&&(page.pages!==pages||page.totalBytes!==total))throw new Error('graph-context-wire-page-invalid');
   if(index===0){pages=page.pages;total=page.totalBytes;}chunks.push(Buffer.from(page.data,'base64url'));
  }
  const bytes=Buffer.concat(chunks,total);return this.source.hydrateTransportRecord(raw,bytes);
 }
 member(machineId:string):GraphCommitMember|null{
  if(!this.config.membership.members.some(member=>member.machineId===machineId)||machineId===this.machineId)return null;
  const receipt = (value:unknown,record:ConversationGraphReplicationRecord,phase:'source'|'certificate'|'cancellation',hash?:string)=>{
   const raw=(value as {receipt:ReturnType<ConversationGraphReplication['effectiveContext']>['receipt']}).receipt;
   const membership=record.adoption?.newMembership??record.authorizationProof.membership;
   const context=record.adoption?{membershipEpoch:membership.epoch,leaseEpoch:record.adoption.currentLease.leaseEpoch}:undefined;
   if(raw?.machineId!==machineId||!verifyMemberReceipt(raw,record.packet,membership,phase,hash,context))throw new Error('graph-peer-receipt-invalid');return raw;
  };
  return {machineId,receiveSource:async record=>{const cancellation=record.cancellation??(!record.certificate?record.erasure:undefined);return receipt(await this.request(machineId,'source',{record}),record,cancellation?'cancellation':'source',cancellation?canonicalHash(cancellation):undefined);},
   persistCertificate:async(record,certificate)=>{const next={...record,certificate};return receipt(await this.request(machineId,'certificate',{record:next}),next,'certificate',canonicalHash(certificate));},
   persistCancellationCertificate:async(record:ConversationGraphReplicationRecord,certificate:GraphCancellationCertificate)=>{const next={...record,cancellationCertificate:certificate};return receipt(await this.request(machineId,'certificate',{record:next}),next,'certificate',canonicalHash(certificate));},
   persistCommitProof:async record=>{const receipt=(await this.request(machineId,'proof',{record})as {receipt:ReturnType<ConversationGraphReplication['commitProofDeliveryReceipt']>}).receipt;
    if(receipt.machineId!==machineId||!this.source.verifyCommitProofDeliveryReceipt(receipt,record))throw new Error('graph-peer-delivery-invalid');return receipt;},
   persistDeliveryCompletion:async record=>{const receipt=(await this.request(machineId,'completion',{record}) as {receipt:Awaited<ReturnType<ConversationGraphReplication['durableDeliveryCompletionReceipt']>>}).receipt;if(receipt.machineId!==machineId||!this.source.verifyDeliveryCompletionReceipt(receipt,record))throw new Error('graph-peer-completion-invalid');return receipt;}};
 }
 /** Fan out from EXISTING journal observers; never replace another store's hook. */
 onJournalCommit(kind:JournalKind,entries:JournalEntry[]):void{if(kind!==CONVERSATION_GRAPH_JOURNAL_KIND)return;
  for(const entry of entries){const descriptor=validateGraphReplicationDescriptor(entry.data.descriptor);if(!descriptor){this.readyAt=0;continue;}
   this.publications=this.publications.then(()=>this.source.journalCommitted(descriptor.eventId,canonicalHash(descriptor))).catch(()=>{this.readyAt=0;/* DegradationReporter internalOnly via reportUnavailable; no private error context. */this.reportUnavailable('graph-journal-publication-unavailable');});}}
 onPeerJournalCommit(origin:string,kind:JournalKind,entries:JournalEntry[]):void{if(kind!==CONVERSATION_GRAPH_JOURNAL_KIND)return;
  for(const entry of entries){const descriptor=validateGraphReplicationDescriptor(entry.data.descriptor);if(!descriptor||descriptor.origin!==origin){this.readyAt=0;continue;}
   this.queue=this.queue.then(()=>this.withMutation(()=>this.materializeDescriptor(descriptor))).catch(()=>{this.readyAt=0;/* DegradationReporter internalOnly via reportUnavailable; no private error context. */this.reportUnavailable('graph-journal-materialization-unavailable');});}}
 private async materializeDescriptor(descriptor:ConversationGraphReplicationDescriptor):Promise<void>{
  const current=this.source.repairRecord(descriptor.eventId);
  if(current){const actual=this.source.descriptorFor(current);if(canonicalHash(actual)===canonicalHash(descriptor)
    ||actual.packetHash===descriptor.packetHash&&actual.publicationVersion>descriptor.publicationVersion)return;}
  this.readyAt=0;
  for(const member of this.config.membership.members){if(member.machineId===this.machineId)continue;
   try{const result=await this.request(member.machineId,'repair',{eventId:descriptor.eventId}) as {record:ConversationGraphReplicationRecord|null};const record=result.record?await this.hydratePeerRecord(result.record,member.machineId):null;
    if(!record||!this.source.verifyHistoricalRecord(record))continue;const actual=this.source.descriptorFor(record);
    if(canonicalHash(actual)!==canonicalHash(descriptor)&&!(actual.packetHash===descriptor.packetHash&&actual.publicationVersion>descriptor.publicationVersion))continue;
    if(record.erasure)await this.applyInventoryErasures([record.erasure]);if(record.materialization)await this.source.receiveHistorical(record);else await this.source.receive(record,record.packet.writerId);return;
   }catch{/* @silent-fallback-ok: missing or stale source keeps graph partial; any installed survivor may repair it. */}
  }
  throw new Error('graph-original-source-unavailable');
 }
 async drainJournal():Promise<void>{if(!this.alive())throw new Error('graph-runtime-stopped');await this.source.drainOutbox(record=>this.options.journal.emitReplicatedRecord(CONVERSATION_GRAPH_JOURNAL_KIND,
   this.source.envelope(record,this.options.clock.tick(),this.options.peerStreams.loadWitness(CONVERSATION_GRAPH_STORE,record.packet.eventId))));this.options.journal.flush();await this.publications;}
 refreshReadiness():Promise<boolean>{
  // One pass at a time: a caller arriving mid-pass shares its result instead of queueing a second full walk behind the same lock.
  if(!this.refreshInFlight)this.refreshInFlight=this.withMutation(()=>this.refreshReadinessCore()).finally(()=>{this.refreshInFlight=null;});
  return this.refreshInFlight;
 }
 private async applyInventoryErasures(proofs:import('../core/GraphWitnessTypes.js').GraphWitnessErasure[]):Promise<void>{
  for(const proof of proofs){const id=canonicalHash(proof);if(this.appliedErasureHashes.has(id))continue;
   await this.source.applyErasure(proof,this.source.erasureAuthorities.has(proof)?undefined:await this.config.witness.erasureAuthority(proof));await this.localErasure.deny(proof.target);
   purgeLocallyDeniedGraphSourceObservationCache({stateDir:this.options.stateDir,agentId:this.config.agentId,target:proof.target,fence:this.localErasure});
   await this.intake.applyErasure(proof,this.config.agentId);await this.transfer.applyErasure(proof,this.config.agentId);this.appliedErasureHashes.add(id);
  }
 }
 private lastLoggedReadiness:string|null=null;
 private lastBackgroundFailure:string|null=null;
 private lastTailClosureFailure:string|null=null;
 private noteTailClosure(error:unknown):void{const code=error instanceof Error&&/^[a-z0-9-]{1,96}$/.test(error.message)?error.message:'unknown';if(code!==this.lastTailClosureFailure){this.lastTailClosureFailure=code;console.warn(`[conversation-graph] cannot close the previous writer's tail yet: ${code}`);}}
 private async refreshReadinessCore():Promise<boolean>{const ready=await this.refreshReadinessSteps();const step=ready?null:this.lastReadinessFailure;if(step!==this.lastLoggedReadiness){this.lastLoggedReadiness=step;console.warn(step?`[conversation-graph] not ready yet, stopped at: ${step}`:'[conversation-graph] ready');}return ready;}
 private async refreshReadinessSteps():Promise<boolean>{this.lastReadinessFailure='lifetime';this.readyAt=0;if(!this.alive())return false;try{this.assertPositiveCustody();}catch(error){this.lastReadinessFailure='custody:'+(error instanceof Error&&/^[a-z0-9-]{1,96}$/.test(error.message)?error.message:'unknown');return false;}
  try{this.lastReadinessFailure='initial-inventory';const checkpoint=await this.config.witness.inventory(crypto.randomBytes(32).toString('base64url'));
   await this.applyInventoryErasures(checkpoint.erasures);
   for(const record of this.source.recordsForRepair())if(record.erasure&&record.coreType==='source-observation'&&record.core.op==='observe-conversation-source')purgeGraphSourceObservationCache({stateDir:this.options.stateDir,agentId:this.config.agentId,record,source:this.source});
   if(checkpoint.activeMembershipHash!==canonicalHash(this.config.membership)||checkpoint.fenceEpoch>this.options.leaseCoordinator.currentEpoch()||Math.abs(Date.now()-Date.parse(checkpoint.issuedAt))>MAX_SKEW)return false;
   this.lastReadinessFailure='reservation-restore';for(const reservation of await this.intake.reservations())if(!this.source.lookupByIdempotencyKey(reservation.packet.idempotencyKey))await this.source.receive(reservation,reservation.packet.writerId);
   this.lastReadinessFailure='source-repair';for(const entry of checkpoint.manifest.entries){if(!this.alive())return false;let record=this.source.repairRecord(entry.eventId);
    if(!record){for(const member of this.config.membership.members){if(member.machineId===this.machineId)continue;if(!this.alive())return false;try{const result=await this.request(member.machineId,'repair',{eventId:entry.eventId}) as {record:ConversationGraphReplicationRecord|null};if(result.record){result.record=await this.hydratePeerRecord(result.record,member.machineId);if(result.record.erasure)await this.applyInventoryErasures([result.record.erasure]);if(result.record.materialization)await this.source.receiveHistorical(result.record);else await this.source.receive(result.record,result.record.packet.writerId);record=this.source.repairRecord(entry.eventId);if(record)break;}}catch{/* @silent-fallback-ok: a sleeping member cannot grant readiness; try other installed members. */}}}
    if(!record){
     try{const recovered=await this.config.witness.recover(entry.idempotencyKey);const operation=recovered.operation;if(operation.erasure)await this.applyInventoryErasures([operation.erasure]);
      await this.source.reconstructFromWitness({controlCapsule:operation.controlCapsule,packet:operation.packet,packetSignature:operation.packetSignature,encryptedSourceBundle:recovered.encryptedSourceBundle,
       ...(operation.prepareProof?{preparationProof:operation.prepareProof}:{}),...(operation.erasedControlProof?{erasedControlProof:operation.erasedControlProof,...await this.erasedCustodyAuthority(operation.packet,operation.erasedControlProof)}:{}),...(recovered.materialization?{materialization:recovered.materialization}:{}),...(operation.adoption?{adoption:operation.adoption}:{}),...(operation.rewrap?{rewrap:operation.rewrap}:{}),
       ...(operation.certificate?{certificate:operation.certificate}:{}),...(operation.cancellation?{cancellation:operation.cancellation}:{}),...(operation.cancellationCertificate?{cancellationCertificate:operation.cancellationCertificate}:{}),
       ...(operation.erasure?{erasure:operation.erasure}:{}),certificatePersistenceReceipts:operation.certificatePersistenceReceipts},await this.config.witness.membership(operation.packet.membershipEpoch));record=this.source.repairRecord(entry.eventId);
     }catch(error){/* DegradationReporter internalOnly via reportUnavailable; only a fixed-format code is kept, never a private message. */this.reportUnavailable(error instanceof Error&&/^[a-z0-9-]{1,96}$/.test(error.message)?error.message:'graph-witness-recovery-unavailable');return false;}
    }
    if(!record||canonicalHash(record.packet)!==entry.operationHash)return false;
    // A record every member has acknowledged cannot change without its signed manifest entry changing, so it needs no witness round trip per pass.
    this.source.assertRepairStillAllowed(record);if(this.settledRecords.get(entry.eventId)===canonicalHash({entry,descriptor:this.source.descriptorFor(record)}))continue;
    const operation=await this.config.witness.operation(record.packet.idempotencyKey),{stateProof:_freshProof,...reconciled}=operation,operationHash=canonicalHash({reconciled,descriptor:this.source.descriptorFor(record)});
    // A record already reconciled against this exact witness state needs no second write. The lock is held for the whole pass, so per-record work here blocks peer writes.
    if(this.reconciledOperations.get(entry.eventId)===operationHash)continue;
    const needsHistory=operation.materialization&&(!record.materialization||canonicalHash(graphHistoricalMaterializationRef(record.materialization))!==canonicalHash(operation.materialization));
    const hydrated=needsHistory?await this.config.witness.recover(record.packet.idempotencyKey):null;
    const repaired={...record,...(operation.prepareProof?{preparationProof:operation.prepareProof}:{}),...(operation.erasedControlProof?{erasedControlProof:operation.erasedControlProof,...await this.erasedCustodyAuthority(operation.packet,operation.erasedControlProof)}:{}),...(hydrated?.materialization?{materialization:hydrated?.materialization}:{}),...(operation.adoption?{adoption:operation.adoption}:{}),...(operation.rewrap?{rewrap:operation.rewrap}:{}),...(operation.certificate?{certificate:operation.certificate}:{}),
     ...(operation.cancellation?{cancellation:operation.cancellation}:{}),...(operation.cancellationCertificate?{cancellationCertificate:operation.cancellationCertificate}:{}),
     ...(operation.erasure?{erasure:operation.erasure,encryptedSourceBundle:null}:{}),certificatePersistenceReceipts:operation.certificatePersistenceReceipts};
    if(repaired.erasure)await this.applyInventoryErasures([repaired.erasure]);if(repaired.materialization)await this.source.receiveHistorical(repaired);else await this.source.receive(repaired,record.packet.writerId);
    {const settled=this.source.repairRecord(entry.eventId);if(settled)this.reconciledOperations.set(entry.eventId,canonicalHash({reconciled,descriptor:this.source.descriptorFor(settled)}));}
   }
   this.lastReadinessFailure='certificate-acknowledgment';
   // Waking peers acknowledge only actual local fsynced final metadata.
   const manifestEntries=new Map(checkpoint.manifest.entries.map(entry=>[entry.eventId,entry]));
   for(const record of this.source.recordsForRepair())if(!record.materialization&&(record.certificate||record.cancellationCertificate)){
    const settledEntry=manifestEntries.get(record.packet.eventId),settledKey=settledEntry?canonicalHash({entry:settledEntry,descriptor:this.source.descriptorFor(record)}):null;if(settledKey&&this.settledRecords.get(record.packet.eventId)===settledKey)continue;
    const certificateHash=canonicalHash(record.certificate??record.cancellationCertificate);let operation=await this.config.witness.operation(record.packet.idempotencyKey);
    // Skip only when the witness still holds this machine's receipt, so a witness restored from an older copy gets it again.
    if(this.acknowledgedCertificates.get(record.packet.eventId)!==certificateHash||!(operation.certificatePersistenceReceipts??[]).some(ack=>ack.machineId===this.machineId)){
     const receipt=record.certificate?await this.source.attachCertificate(record.packet.eventId,record.certificate):await this.source.attachCancellationCertificate(record.packet.eventId,record.cancellationCertificate!);
     await this.config.witness.acknowledgeCertificate(record.packet.idempotencyKey,receipt);
     operation=await this.config.witness.operation(record.packet.idempotencyKey);this.acknowledgedCertificates.set(record.packet.eventId,certificateHash);
    }
    const receipts=operation.certificatePersistenceReceipts??[],receiptsHash=canonicalHash(receipts);if(this.recordedCertificateReceipts.get(record.packet.eventId)!==receiptsHash){
     for(const ack of receipts)await this.source.recordCertificateReceipt(record.packet.eventId,ack);
     this.recordedCertificateReceipts.set(record.packet.eventId,receiptsHash);
    }
    if(settledKey&&this.config.membership.members.every(member=>receipts.some(ack=>ack.machineId===member.machineId)))this.settledRecords.set(record.packet.eventId,settledKey);
   }
   // Repair can take longer than the starting snapshot's freshness window.
   // A NEW challenge after all awaited custody work observes concurrent erase.
   this.lastReadinessFailure='final-inventory';const finalCheckpoint=await this.config.witness.inventory(crypto.randomBytes(32).toString('base64url'));
   await this.applyInventoryErasures(finalCheckpoint.erasures);
   if(finalCheckpoint.activeMembershipHash!==canonicalHash(this.config.membership)||finalCheckpoint.fenceEpoch>this.options.leaseCoordinator.currentEpoch()||Math.abs(Date.now()-Date.parse(finalCheckpoint.issuedAt))>MAX_SKEW)return false;
   this.lastReadinessFailure='final-watermark';const records=this.source.recordsForRepair();const manifest=buildGraphRecoverySourceManifest(records,this.config.membership);
   if(manifest.highestCertifiedSequence!==finalCheckpoint.manifest.highestCertifiedSequence||manifest.highestCertifiedCoreHash!==finalCheckpoint.manifest.highestCertifiedCoreHash
     ||manifest.highestAcknowledgedSequence<finalCheckpoint.manifest.highestAcknowledgedSequence)return false;
   const actualEntries=new Map(manifest.entries.map(entry=>[entry.eventId,entry]));
   for(const entry of finalCheckpoint.manifest.entries){const actual=actualEntries.get(entry.eventId);if(!actual||actual.operationHash!==entry.operationHash||actual.certificateHash!==entry.certificateHash||actual.cancellationCertificateHash!==entry.cancellationCertificateHash||actual.erasureHash!==entry.erasureHash)return false;}
   if(!this.alive()||this.options.leaseCoordinator.currentEpoch()>GRAPH_REPLICATION_MAX_LEASE_EPOCH)return false;this.readyAt=Date.parse(finalCheckpoint.issuedAt);this.lastVerifiedAt=this.readyAt;this.readyLeaseEpoch=this.options.leaseCoordinator.currentEpoch();this.lastReadinessFailure=null;return true;
  }catch(error){/* DegradationReporter internalOnly via reportUnavailable; only a fixed-format code is kept, never a private message. */this.reportUnavailable(error instanceof Error&&/^[a-z0-9-]{1,96}$/.test(error.message)?error.message:'graph-witness-recovery-unavailable');return false;}
 }
 start(options:{initialSync?:boolean}={}):void{if(this.timer||this.stopped)return;if(options.initialSync===false&&!this.isReady())throw new Error('graph-runtime-initial-sync-not-verified');const tick=()=>{if(this.background||this.stopped)return;this.background=(async()=>{await this.erasure.retry();if(this.options.leaseCoordinator.holdsLease())await this.reconcilePending();else{await this.refreshReadiness();await this.retryLocalOwnerIntents();}await this.drainJournal();})().catch(error=>{this.readyAt=0;/* DegradationReporter internalOnly via reportUnavailable; only a fixed-format code is logged, never a private message. */const code=error instanceof Error&&/^[a-z0-9-]{1,96}$/.test(error.message)?error.message:'unknown';if(code!==this.lastBackgroundFailure){this.lastBackgroundFailure=code;console.warn(`[conversation-graph] background sync stopped: ${code}`);}this.reportUnavailable('graph-background-synchronization-unavailable');}).finally(()=>{this.background=null;});};
  if(options.initialSync!==false)tick();this.timer=setInterval(tick,15000);this.timer.unref();}
 async close():Promise<void>{this.ownedControlFrames?.close();if(this.timer){clearInterval(this.timer);this.timer=null;}await this.erasure.close();this.stopped=true;this.readyAt=0;await Promise.allSettled([this.nativeTailPreparing]);await this.background;await Promise.allSettled([...this.pending]);await this.queue;await this.publications;await this.mutations;await this.intake.ownerQueue.close();/* Shared server lock is released by server teardown AFTER runtime close. */}
}
function registerConversationGraphReplicationIfMissing(registry:ReplicatedKindRegistry){if(!registry.getByStore(CONVERSATION_GRAPH_STORE))registerConversationGraphReplication(registry);}
