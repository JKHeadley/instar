import type {GraphTransferCustodyReader} from '../core/ConversationGraphTransferCustody.js';
import {GRAPH_MEMBER_LOSS_PLAN_ORIGIN_DOMAIN,GRAPH_MEMBER_LOSS_PLAN_REVISION_DOMAIN,graphMemberLossRevisionRecoveryId,type GraphMemberLossPlanRevision} from '../core/GraphMemberLossPlanRevision.js';
/** Mechanical continuation of a freshly owner-admitted permanent-member loss.
 * Human admission and native revocation remain separate actual capabilities.
 * This first execution path collects exactly one surviving installed member. */
import {ConversationGraphDefault} from './ConversationGraphDefault.js';
import {GraphOwnerMemberLossIntent,GraphOwnerMemberLossAction} from './GraphOwnerMemberLossAction.js';
import {GraphOwnerMemberLossPlanning} from './GraphOwnerMemberLossPlanning.js';
import {GraphMemberLossHeldPreflight} from '../core/GraphMemberLossHeldPreflight.js';
import {GraphHeldSourceReader,GraphHeldSenderReadSession,GraphMemberLossSourceSnapshot} from '../core/ConversationGraphReplication.js';
import {GraphNativeMemberLossStore} from '../core/GraphNativeMemberLossStore.js';
import {NativeDecommissionLeasePermit} from '../core/NativeDecommissionLeasePermit.js';
import {createGraphOwnerRecoveryEnvelope} from '../core/GraphOwnerRecovery.js';
import {GraphOwnerRecoveryStore} from '../core/GraphOwnerRecoveryStore.js';
import {GraphMemberLossPinStore} from '../core/GraphMemberLossPinStore.js';
import {openGraphMemberLossOwnedRole,prepareGraphMemberLossOwnedRole,persistGraphMemberLossPlanOrigin,retainedGraphMemberLossPlanOrigin,type GraphMemberLossOwnedRole} from '../core/GraphMemberLossOwnedRole.js';
import {buildGraphRecoverySourceManifest,buildGraphTransferRewrapInventory,type GraphSourceTransferStage} from '../core/ConversationGraphReplicationTransfer.js';
import {GraphRecoverySourceManifestAccumulator} from '../core/ConversationGraphRecoveryManifest.js';
import {GraphPreparedTransferEnvelopes} from '../core/GraphPreparedTransferEnvelopes.js';
import {GraphWitnessBootstrapStream} from '../core/GraphWitnessBootstrapStream.js';
import {verifyGraphHistoricalMaterializationContext} from '../core/ConversationGraphHistoricalMaterialization.js';
import {createGraphControlCapsule} from '../core/GraphWitnessControl.js';
import {type GraphWitnessRecoveryRequest,type GraphWitnessBootstrapRequest,type GraphWitnessArchive} from '../core/GraphWitnessService.js';
import {canonicalHash,canonicalJson,graphRewrapInventoryHash,signGraphRecord,verifyFencedLeaseBridge,verifyWitnessLease,type GraphWitnessLease,type GraphPendingRevalidation,type GraphBundleRewrap,type GraphMembershipActivationCertificate} from '../core/GraphWitnessTypes.js';
import type {GraphMemberLossActivationAuthority} from '../core/GraphMemberLossActivation.js';
import type {GraphNativeMemberLossReceipt,GraphNativeMemberLossFloor} from '../core/GraphMemberLossNativeProof.js';

export interface GraphOwnerMemberLossExecutionInput {
 intent:GraphOwnerMemberLossIntent;action:GraphOwnerMemberLossAction;
 preflight:GraphMemberLossHeldPreflight;snapshot:GraphMemberLossSourceSnapshot;
 nativeStore:GraphNativeMemberLossStore;
 native:{receipt:GraphNativeMemberLossReceipt;floor:GraphNativeMemberLossFloor};
}
export class GraphOwnerMemberLossExecution {
 private running:Promise<unknown>|null=null;
 private readonly preparedArchives=new WeakMap<GraphMemberLossHeldPreflight,{lineageHash:string;memberships:GraphWitnessBootstrapRequest['memberships'];archive:GraphWitnessArchive}>();
 constructor(private readonly manager:ConversationGraphDefault){if(!(manager instanceof ConversationGraphDefault))throw new Error('member-loss-actual-default-required');}
 /** Read and authenticate original historical ACT/context custody BEFORE any
  * Native revocation. This is bounded metadata, never a new source authority. */
 async prepareHistoricalArchive(preflight:GraphMemberLossHeldPreflight):Promise<void>{
  const actual=this.manager.memberLossPlanningComponents(),runtime=this.manager.runtime;if(!(preflight instanceof GraphMemberLossHeldPreflight)||!actual||!runtime||preflight.stateRoot!==actual.authority.stateRoot||preflight.previousPublicationHash!==actual.authority.publicationHash)throw new Error('member-loss-execution-preflight-scope-invalid');preflight.assertCurrent();
  const lineage=actual.authority.verifiedNegativeRoleLineage(),activations=[...lineage.activations,...lineage.memberLossActivations].map(row=>row.certificate).filter(row=>row.newMembership.epoch<=preflight.previousMembership.epoch).sort((a,b)=>a.newMembership.epoch-b.newMembership.epoch),memberships=[lineage.genesis,...activations.map(row=>row.newMembership)],contexts:GraphWitnessArchive['contexts']=[],witnessPublicKeys=new Map(memberships.map(row=>{if(!row.custodyProfile)throw new Error('member-loss-historical-role-profile-missing');return[row.witnessId,row.custodyProfile.witnessPublicKey] as const;}));
  if(activations.length!==preflight.previousMembership.epoch-1||canonicalHash(memberships.at(-1))!==canonicalHash(preflight.previousMembership))throw new Error('member-loss-historical-lineage-incomplete');
  for(const activation of activations){const reader=await runtime.transfer.openRetainedCustodyStage(activation,actual.authority);try{const metadata=reader.metadata,context={activation,manifest:metadata.manifest,rewrapInventory:reader.inventory,currentLease:metadata.currentLease,originalCurrentLease:metadata.originalCurrentLease};if(!verifyGraphHistoricalMaterializationContext({...context,rewrapHash:canonicalHash(null)},actual.authority.agentId,{ownerPublicKey:actual.authority.ownerPublicKey,witnessPublicKeys}))throw new Error('member-loss-historical-context-invalid');contexts.push(context);if(Buffer.byteLength(canonicalJson({memberships,activations,contexts}))>32*1024*1024)throw new Error('member-loss-historical-archive-resource-capacity');preflight.assertCurrent();}finally{reader.close();}}
  const retained=actual.authority.verifiedNegativeRoleLineage(),current=[...retained.activations,...retained.memberLossActivations].map(row=>row.certificate).filter(row=>row.newMembership.epoch<=preflight.previousMembership.epoch).sort((a,b)=>a.newMembership.epoch-b.newMembership.epoch);if(canonicalHash(current)!==canonicalHash(activations))throw new Error('member-loss-historical-lineage-changed');
  const copy=JSON.parse(canonicalJson({lineageHash:canonicalHash(activations),memberships,archive:{activations,contexts}}));const freeze=(value:unknown):void=>{if(value&&typeof value==='object'){for(const child of Object.values(value))freeze(child);Object.freeze(value);}};freeze(copy);this.preparedArchives.set(preflight,copy);
 }
 private historicalArchive(preflight:GraphMemberLossHeldPreflight){const actual=this.manager.memberLossPlanningComponents()!,prepared=this.preparedArchives.get(preflight);if(!prepared)throw new Error('member-loss-execution-historical-archive-required');const lineage=actual.authority.verifiedNegativeRoleLineage(),activations=[...lineage.activations,...lineage.memberLossActivations].map(row=>row.certificate).filter(row=>row.newMembership.epoch<=preflight.previousMembership.epoch).sort((a,b)=>a.newMembership.epoch-b.newMembership.epoch);if(canonicalHash(activations)!==prepared.lineageHash)throw new Error('member-loss-historical-lineage-changed');return prepared;}
 /** Call before NativeAdministration: unsupported continuation must not revoke. */
 assertSupportedPreflight(preflight:GraphMemberLossHeldPreflight):void{
  const actual=this.manager.memberLossPlanningComponents();if(!(preflight instanceof GraphMemberLossHeldPreflight)||!actual||preflight.stateRoot!==actual.authority.stateRoot||preflight.previousPublicationHash!==actual.authority.publicationHash)throw new Error('member-loss-execution-preflight-scope-invalid');
  preflight.assertCurrent();const runtime=this.manager.runtime;if(!runtime)throw new Error('member-loss-execution-runtime-unavailable');
  for(const operation of preflight.currentOperations){if(operation.outcome==='pending'||preflight.operations.find(original=>original.eventId===operation.eventId)?.outcome==='pending')continue;const record=runtime.source.repairRecord(operation.eventId);if(!record)throw new Error('member-loss-terminal-source-evidence-missing');try{if(!record.encryptedSourceBundle&&!record.erasure)throw new Error('member-loss-terminal-local-denial-needs-witness-erasure');}finally{record.encryptedSourceBundle=null;delete record.rewrap;}}
  if(preflight.previousMembership.epoch!==1)this.historicalArchive(preflight);if(preflight.newMembership.members.length!==1)throw new Error('member-loss-multi-survivor-collection-required');
 }
 execute(input:GraphOwnerMemberLossExecutionInput){
  if(this.running)throw new Error('member-loss-execution-in-progress');
  const work=this.run(input);this.running=work;return work.finally(()=>{this.preparedArchives.delete(input.preflight);if(this.running===work)this.running=null;});
 }
 private async run(input:GraphOwnerMemberLossExecutionInput){
  const {intent,action,preflight,snapshot,nativeStore}=input;
  if(!(intent instanceof GraphOwnerMemberLossIntent)||!(action instanceof GraphOwnerMemberLossAction)||!(preflight instanceof GraphMemberLossHeldPreflight)||!(snapshot instanceof GraphMemberLossSourceSnapshot)||!(nativeStore instanceof GraphNativeMemberLossStore))throw new Error('member-loss-actual-execution-capabilities-required');
  const components=this.manager.memberLossPlanningComponents(),native=this.manager.nativeDelegationDependencies,runtime=this.manager.runtime;
  if(!components||!native||!runtime)throw new Error('member-loss-execution-runtime-unavailable');
  const {authority,secrets}=components,scope=action.scope,consent=action.consent,proof=intent.intentProof;
  const context={ownerPublicKey:authority.ownerPublicKey,previousPublicationHash:authority.publicationHash,previousMembership:scope.previousMembership,newMembership:scope.newMembership,nativeIdentities:scope.nativeIdentities};
  const check={intentHash:canonicalHash(proof),consentHash:canonicalHash(consent),previousPublicationHash:context.previousPublicationHash,previousMembershipHash:canonicalHash(context.previousMembership),newMembershipHash:canonicalHash(context.newMembership),nativeRosterHash:canonicalHash(context.nativeIdentities)};
  // These awaits can resolve without touching the loop. Yield for real, so a long removal cannot starve the lease renewal timer or the rest of the agent.
  const fresh=async()=>{await new Promise(resolve=>setImmediate(resolve));await intent.assertCurrentForNative(check);await action.assertCurrentForNative(check);};
  await fresh();this.assertSupportedPreflight(preflight);snapshot.assertCurrent();
  if(nativeStore.custodyAuthority!==authority||nativeStore.stateRoot!==authority.stateRoot||nativeStore.machineId!==native.identity.loadIdentity().machineId||preflight.stateRoot!==authority.stateRoot||preflight.intentHash!==check.intentHash||preflight.inventoryHash!==snapshot.inventoryHash||preflight.erasureInventoryHash!==snapshot.erasureInventoryHash||canonicalHash(preflight.newMembership)!==check.newMembershipHash||canonicalHash(preflight.operations)!==canonicalHash(consent.payload.operations)||context.newMembership.members.length!==1)throw new Error('member-loss-execution-scope-mismatch');
  const historical=context.previousMembership.epoch===1?null:this.historicalArchive(preflight);
  const planning=await new GraphOwnerMemberLossPlanning(this.manager).context(scope.removed.map(row=>row.machineId),scope.requestId,context);
  await fresh();preflight.assertCurrent();
  const progress=nativeStore.progress(consent,context,proof);if(!progress)throw new Error('member-loss-native-progress-missing');
  if(canonicalHash(progress.originalFloor)!==canonicalHash(input.native.floor))throw new Error('member-loss-execution-original-floor-mismatch');
  nativeStore.assertDurableReceipt(consent,context,proof,input.native.receipt);
  const retained=authority.verifiedNegativeRoleLineage().memberLossActivations.find(row=>canonicalHash(row.certificate.memberLoss!.consent)===canonicalHash(consent)&&canonicalHash(row.certificate.memberLoss!.intent)===canonicalHash(proof))?.certificate;
  if(retained){try{return await this.resumeActivated(input,retained,progress,fresh);}finally{snapshot.close();preflight.close();}}
  let role:GraphMemberLossOwnedRole|undefined,completed=false,sourceReader:GraphHeldSourceReader|undefined,prepared:GraphPreparedTransferEnvelopes|undefined,bootstrapStream:GraphWitnessBootstrapStream|undefined,readSession:GraphHeldSenderReadSession|undefined,retainedRead:GraphTransferCustodyReader|undefined;
  try{
   const permit=NativeDecommissionLeasePermit.fromCommittedRevocations({store:nativeStore,coordinator:native.leaseCoordinator,consent,context,intent:proof,receipts:[input.native.receipt],floors:[input.native.floor]});
   await fresh();if(!await native.leaseCoordinator.acquireOnOwnerDecommission(permit))throw new Error('member-loss-native-acquisition-unavailable');await fresh();
   const originalLease=native.leaseCoordinator.currentLease();if(!originalLease)throw new Error('member-loss-native-lease-missing');
   const next=context.newMembership,self=native.identity.loadIdentity().machineId,key=native.identity.loadSigningKey(),leaseBody={v:1 as const,agentId:authority.agentId,membershipEpoch:next.epoch,leaseEpoch:originalLease.epoch,writerId:originalLease.holder,issuedAt:originalLease.acquiredAt,expiresAt:originalLease.expiresAt,fencedLeaseHash:canonicalHash(originalLease)},currentLease:GraphWitnessLease={...leaseBody,signature:signGraphRecord('graph-lease-v1',leaseBody,key)};
   if(!verifyFencedLeaseBridge(currentLease,originalLease,next)||currentLease.writerId!==self)throw new Error('member-loss-current-native-bridge-invalid');
   const previousBody={...leaseBody,membershipEpoch:context.previousMembership.epoch},previousLease={...previousBody,signature:signGraphRecord('graph-lease-v1',previousBody,key)},held=await runtime.source.verifyMemberLossHeldSourceReader(runtime.reader,runtime.droppedOriginRegistry,runtime.intake,authority,{intent:proof,preflight,progress,coordinator:native.leaseCoordinator,lease:previousLease,originalLease});sourceReader=held.reader;
   const remaining=preflight.currentOperations.filter(row=>row.outcome==='pending'),remainingIds=new Set(remaining.map(row=>row.eventId)),revalidations:Array<{proof:GraphPendingRevalidation;rewrap:null}>=[],lossControls:NonNullable<GraphWitnessRecoveryRequest['lossControls']>=[],accumulator=new GraphRecoverySourceManifestAccumulator(context.previousMembership);let needsNegativeControls=false;
   for(const descriptor of sourceReader.descriptors()){
    const record=await sourceReader.readRecord(descriptor.eventId);try{accumulator.append(record);
     if(remainingIds.has(record.packet.eventId)){
      const body={v:1 as const,agentId:authority.agentId,idempotencyKey:record.packet.idempotencyKey,operationHash:canonicalHash(record.packet),coreHash:record.packet.coreHash,sourceProofHash:canonicalHash({coreType:record.coreType,packet:record.packet,packetSignature:record.packetSignature,core:record.core,authorizationProof:record.authorizationProof}),subjectHeadsHash:canonicalHash([]),dependenciesHash:canonicalHash([]),rewrapHash:canonicalHash(null),newMembershipHash:canonicalHash(next),currentLeaseHash:canonicalHash(currentLease),writerId:self,decision:'refuse' as const,reason:'operator-refused' as const,validatedAt:new Date().toISOString()};revalidations.push({proof:{...body,signature:signGraphRecord('graph-pending-revalidation-v1',body,key)},rewrap:null});
      if(!record.encryptedSourceBundle&&runtime.localErasure.isDenied(record.packet.erasureIdentity))needsNegativeControls=true;
     }
     if(!record.preparationProof&&!record.erasedControlProof&&!record.certificate&&!record.cancellationCertificate)lossControls.push({packet:record.packet,packetSignature:record.packetSignature,controlCapsule:createGraphControlCapsule(record.coreType,record.core,record.authorizationProof)});
    }finally{sourceReader.releasePrivateViews();}
   }
   sourceReader.finalize();const manifest=accumulator.finish();if(canonicalHash(manifest)!==preflight.sourceManifestHash||revalidations.length!==remaining.length)throw new Error('member-loss-execution-source-manifest-changed');
   const retainedOrigin=retainedGraphMemberLossPlanOrigin({authority,progress,consent,intent:proof,context}),previousRevision=authority.memberLossPlanRevision(next.epoch),revisionFields=retainedOrigin?{consentHash:canonicalHash(consent),originalCreationHash:retainedOrigin.creationHash,generation:(previousRevision?.generation??0)+1,inventoryHash:preflight.inventoryHash,erasureInventoryHash:preflight.erasureInventoryHash}:null;
   const recoveryId=revisionFields?graphMemberLossRevisionRecoveryId({...revisionFields,leaseHash:canonicalHash(currentLease)}):'loss-'+canonicalHash(consent);prepared=await runtime.transfer.prepareHeldRewrapInventory({recoveryId,source:sourceReader,context:{authority,hold:held.hold},newMembership:next,coordinator:native.leaseCoordinator,...(retainedOrigin?{reuseFrom:{recoveryId:retainedOrigin.origin.originalPlan.authorization.recoveryId,originalPlan:retainedOrigin.origin.originalPlan,consent,progress}}:{})});
   const authorizationBody={v:1 as const,agentId:authority.agentId,recoveryId,previousMembershipHash:check.previousMembershipHash,newMembershipHash:check.newMembershipHash,previousWitnessId:context.previousMembership.witnessId,newWitnessId:next.witnessId,fenceEpoch:currentLease.leaseEpoch,highestCertifiedSequence:manifest.highestCertifiedSequence,highestCertifiedCoreHash:manifest.highestCertifiedCoreHash,pendingOutcomes:revalidations.map(({proof:row})=>({idempotencyKey:row.idempotencyKey,operationHash:row.operationHash,decision:row.decision,revalidationHash:canonicalHash(row)})),sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:graphRewrapInventoryHash(prepared.inventory()),issuedAt:new Date().toISOString()},authorization={...authorizationBody,signature:signGraphRecord('graph-recovery-authorization-v1',authorizationBody,planning.ownerPrivateKey)};
   const stage={authorization,previousMembership:context.previousMembership,newMembership:next,currentLease,originalCurrentLease:originalLease,manifest,revalidations:revalidations.map(row=>row.proof)};
   const recoveryStore=new GraphOwnerRecoveryStore({stateDir:authority.stateRoot,agentId:authority.agentId,identity:native.identity,identities:native.identities}),envelope=retainedOrigin?recoveryStore.envelope(retainedOrigin.origin.ownerRecoveryHash,next,authority.ownerPublicKey):createGraphOwnerRecoveryEnvelope(planning.ownerPrivateKey,next),ownerRecovery=recoveryStore.put(envelope,next,authority.ownerPublicKey);
   const originBody={v:1 as const,kind:'owned-member-loss-plan-origin' as const,agentId:authority.agentId,consentHash:canonicalHash(consent),intentHash:canonicalHash(proof),originalPlan:stage,ownerRecoveryHash:canonicalHash(envelope),createdAt:new Date().toISOString()},planOrigin=retainedOrigin?.origin??{...originBody,signature:signGraphRecord(GRAPH_MEMBER_LOSS_PLAN_ORIGIN_DOMAIN,originBody,planning.ownerPrivateKey)};
   const negative=sourceReader.negativeInventory(),revisionBody=revisionFields?{v:1 as const,kind:'owned-member-loss-plan-revision' as const,agentId:authority.agentId,intentHash:canonicalHash(proof),...revisionFields,supersedesHash:previousRevision?canonicalHash(previousRevision):null,originalPlan:retainedOrigin!.origin.originalPlan,plan:stage,ownerRecoveryHash:canonicalHash(envelope),negativeFacts:{erasureHashes:negative.erasures.map(value=>canonicalHash(value)).sort(),localTargets:[...negative.localErasureTargets].sort((a,b)=>canonicalHash(a)<canonicalHash(b)?-1:canonicalHash(a)>canonicalHash(b)?1:0)},issuedAt:new Date().toISOString()}:null,planRevision:GraphMemberLossPlanRevision|undefined=revisionBody?{...revisionBody,signature:signGraphRecord(GRAPH_MEMBER_LOSS_PLAN_REVISION_DOMAIN,revisionBody,planning.ownerPrivateKey)}:undefined;
   persistGraphMemberLossPlanOrigin({authority,progress,consent,intent:proof,context,origin:planOrigin});
   await fresh();preflight.assertCurrent();const transfer=await runtime.transfer.stageHeldSource(stage,sourceReader,{authority,hold:held.hold},prepared.envelopes(),needsNegativeControls?{snapshot,preflight,progress,nativeStore,authority,consent,intent:proof,coordinator:native.leaseCoordinator}:undefined);await fresh();preflight.assertCurrent();
   const hold=authority.beginMemberLossHold(proof,context,self,key);
   const negativeAdvancements:GraphMemberLossActivationAuthority['negativeAdvancements']=preflight.currentOperations.filter(row=>row.outcome!=='pending'&&preflight.operations.find(original=>original.eventId===row.eventId)?.outcome==='pending').map(row=>{
    if(row.outcome!=='canceled'&&row.outcome!=='erased'||!row.terminalHash)throw new Error('member-loss-positive-advancement-forbidden');return{eventId:row.eventId,operationHash:row.operationHash,terminalHash:row.terminalHash,outcome:row.outcome};
   });
   const memberLoss:GraphMemberLossActivationAuthority={v:planRevision?2:1,...(planRevision?{planRevision}:{}),kind:'owned-member-loss',intent:proof,consent,nativeIdentities:context.nativeIdentities,nativeReceipts:[input.native.receipt],nativeFloors:[input.native.floor],survivorHolds:[hold],negativeAdvancements,sourceInventories:[{machineId:self,inventoryHash:preflight.inventoryHash,erasureInventoryHash:preflight.erasureInventoryHash}],ownerRecoveryHash:canonicalHash(envelope),ownerRecoveryReceipts:[ownerRecovery],currentLease,originalLease};
   const recovery={newMembership:next,authorization,currentLease,originalCurrentLease:originalLease,revalidations,stateTransferReceipts:[transfer],sourceManifest:manifest,memberLoss,lossControls};
   if(sourceReader.descriptors().length){retainedRead=await runtime.transfer.openPreparedHeldCustodyStage(stage,sourceReader,{authority,hold:held.hold});readSession=runtime.source.verifyMemberLossReadSession({reader:sourceReader,prepared,retained:retainedRead,metadata:stage,context:{authority,hold:held.hold},evidence:{snapshot,preflight,progress,authority,consent,intent:proof,coordinator:native.leaseCoordinator}});}
   bootstrapStream=await GraphWitnessBootstrapStream.prepare(sourceReader,preflight,prepared,{recovery,memberships:historical?.memberships??[context.previousMembership],...(historical?{archive:historical.archive}:{}),erasures:sourceReader.negativeInventory().erasures,previousFenceEpoch:input.native.floor.epoch},planning.ownerPrivateKey,readSession);
   await fresh();preflight.assertCurrent();const preparedRole=await prepareGraphMemberLossOwnedRole({stateDir:authority.stateRoot,identity:native.identity,identities:native.identities,secrets,authority,nativeStore,progress,preflight,coordinator:native.leaseCoordinator,bootstrapStream,planOrigin,ownerRecoveryEnvelope:envelope});
   try{await fresh();role=preparedRole.finish();}finally{preparedRole.close();}
   // The original held Source is finalized before any local post-ACT imports.
   await fresh();bootstrapStream.close();
   const activation=role.activation;authority.stageMemberLossActivation(activation);runtime.installNegativeCustodyRole(activation);
   const negativeActuation=()=>{const original=native.leaseCoordinator.currentLease();if(!original||!native.instanceLock.revalidate()||!native.leaseCoordinator.holdsLease()||original.holder!==self||original.epoch!==currentLease.leaseEpoch)throw new Error('member-loss-native-epoch-continuation-required');const body={v:1 as const,agentId:authority.agentId,membershipEpoch:next.epoch,leaseEpoch:original.epoch,writerId:self,issuedAt:original.acquiredAt,expiresAt:original.expiresAt,fencedLeaseHash:canonicalHash(original)},lease={...body,signature:signGraphRecord('graph-lease-v1',body,key)};if(!verifyFencedLeaseBridge(lease,original,next)||!verifyWitnessLease(lease,next,Date.now()))throw new Error('member-loss-current-negative-lease-invalid');return{lease,originalLease:original};};
   const pinReader=await runtime.transfer.openRetainedCustodyStage(activation,authority),pin=await new GraphMemberLossPinStore({stateDir:authority.stateRoot,identity:native.identity,identities:native.identities,authority,transfer:runtime.transfer}).pinRetained(activation,pinReader);
   for(const operation of remaining){
    await fresh();const entry=manifest.entries.find(row=>row.eventId===operation.eventId);if(!entry)throw new Error('member-loss-original-manifest-entry-missing');const witnessed=await role.negativeWitness.operation(entry.idempotencyKey);
    if(!witnessed?.adoption||!witnessed.cancellation||witnessed.certificate)throw new Error('member-loss-negative-decision-missing');
    const receipt=await runtime.source.reconstructFromWitness({packet:witnessed.packet,packetSignature:witnessed.packetSignature,controlCapsule:witnessed.controlCapsule,encryptedSourceBundle:null,...(witnessed.prepareProof?{preparationProof:witnessed.prepareProof}:{}),...(witnessed.erasedControlProof?{erasedControlProof:witnessed.erasedControlProof}:{}),adoption:witnessed.adoption,cancellation:witnessed.cancellation,...(witnessed.erasure?{erasure:witnessed.erasure}:{})},witnessed.controlCapsule.authorizationProof.membership);
    if(!receipt||receipt.phase!=='cancellation')throw new Error('member-loss-cancellation-only-receipt-required');
    const certificate=await role.negativeWitness.certifyCancellation({packet:witnessed.packet,...negativeActuation()},witnessed.controlCapsule.authorizationProof.membership,[receipt]);
    const persisted=await runtime.source.attachCancellationCertificate(witnessed.packet.eventId,certificate);await role.negativeWitness.acknowledgeCertificate(witnessed.packet.idempotencyKey,persisted);
   }
   await fresh();const pins=[pin],actuation=negativeActuation(),settlement=await role.negativeWitness.settleMemberLoss(activation,pins,actuation.lease,actuation.originalLease);
   await fresh();authority.completeMemberLossActivation(activation,pins,settlement);const custody=role.promote();completed=true;
   return{state:'completed' as const,activation,settlement,pins,custody};
  }finally{try{bootstrapStream?.close();readSession?.close();retainedRead?.close();sourceReader?.close();prepared?.close();}finally{snapshot.close();preflight.close();if(!completed)role?.close();}}
 }
 /** Resume only the exact physically retained ACT plan; current Source never
  * supplies replacement timestamps, authorizations or historical custody. */
 private async resumeActivated(input:GraphOwnerMemberLossExecutionInput,activation:GraphMembershipActivationCertificate,progress:NonNullable<ReturnType<GraphNativeMemberLossStore['progress']>>,fresh:()=>Promise<void>){
  const components=this.manager.memberLossPlanningComponents()!,native=this.manager.nativeDelegationDependencies!,runtime=this.manager.runtime!,{authority,secrets}=components,next=activation.newMembership,self=native.identity.loadIdentity().machineId,key=native.identity.loadSigningKey();
  const reader=await runtime.transfer.openRetainedCustodyStage(activation,authority),metadata=reader.metadata;let role:GraphMemberLossOwnedRole|undefined,completed=false;
  try{
   await fresh();input.preflight.assertCurrent();
   const envelope=new GraphOwnerRecoveryStore({stateDir:authority.stateRoot,agentId:authority.agentId,identity:native.identity,identities:native.identities}).envelope(activation.memberLoss!.ownerRecoveryHash,next,authority.ownerPublicKey);
   role=await openGraphMemberLossOwnedRole({stateDir:authority.stateRoot,identity:native.identity,identities:native.identities,secrets,authority,nativeStore:input.nativeStore,progress,preflight:input.preflight,coordinator:native.leaseCoordinator,completedActivation:activation,ownerRecoveryEnvelope:envelope});
   await fresh();runtime.installNegativeCustodyRole(activation);
   const actuation=()=>{const original=native.leaseCoordinator.currentLease();if(!original||!native.instanceLock.revalidate()||!native.leaseCoordinator.holdsLease()||original.holder!==self||original.epoch!==activation.memberLoss!.currentLease.leaseEpoch)throw new Error('member-loss-native-epoch-continuation-required');const body={v:1 as const,agentId:authority.agentId,membershipEpoch:next.epoch,leaseEpoch:original.epoch,writerId:self,issuedAt:original.acquiredAt,expiresAt:original.expiresAt,fencedLeaseHash:canonicalHash(original)},lease={...body,signature:signGraphRecord('graph-lease-v1',body,key)};if(!verifyFencedLeaseBridge(lease,original,next)||!verifyWitnessLease(lease,next,Date.now()))throw new Error('member-loss-current-negative-lease-invalid');return{lease,originalLease:original};};
   const pin=await new GraphMemberLossPinStore({stateDir:authority.stateRoot,identity:native.identity,identities:native.identities,authority,transfer:runtime.transfer}).pinRetained(activation,reader);
   for(const outcome of activation.ownerAuthorization!.pendingOutcomes){
    await fresh();const entry=metadata.manifest.entries.find(row=>row.idempotencyKey===outcome.idempotencyKey);if(!entry)throw new Error('member-loss-original-manifest-entry-missing');const operation=await role.negativeWitness.operation(entry.idempotencyKey);
    if(!operation?.adoption||!operation.cancellation||operation.certificate)throw new Error('member-loss-negative-decision-missing');
    if(operation.cancellationCertificate){const persisted=await runtime.source.attachCancellationCertificate(operation.packet.eventId,operation.cancellationCertificate);await role.negativeWitness.acknowledgeCertificate(operation.packet.idempotencyKey,persisted);continue;}
    const receipt=await runtime.source.reconstructFromWitness({packet:operation.packet,packetSignature:operation.packetSignature,controlCapsule:operation.controlCapsule,encryptedSourceBundle:null,...(operation.prepareProof?{preparationProof:operation.prepareProof}:{}),...(operation.erasedControlProof?{erasedControlProof:operation.erasedControlProof}:{}),adoption:operation.adoption,cancellation:operation.cancellation,...(operation.erasure?{erasure:operation.erasure}:{})},operation.controlCapsule.authorizationProof.membership);
    if(!receipt||receipt.phase!=='cancellation')throw new Error('member-loss-cancellation-only-receipt-required');const certificate=await role.negativeWitness.certifyCancellation({packet:operation.packet,...actuation()},operation.controlCapsule.authorizationProof.membership,[receipt]),persisted=await runtime.source.attachCancellationCertificate(operation.packet.eventId,certificate);await role.negativeWitness.acknowledgeCertificate(operation.packet.idempotencyKey,persisted);
   }
   await fresh();const pins=[pin],current=actuation(),settlement=await role.negativeWitness.settleMemberLoss(activation,pins,current.lease,current.originalLease);await fresh();authority.completeMemberLossActivation(activation,pins,settlement);const custody=role.promote();completed=true;return{state:'completed' as const,activation,settlement,pins,custody};
  }finally{try{reader.close();}finally{if(!completed)role?.close();}}
 }

}
