import {verifyGraphMemberLossNegativeCustody} from './GraphMemberLossNegativeCustody.js';
/** Conversations v3 §7.2 witness-only source recovery. Reconstructs ORIGINAL
 * accepted control from the sealed source, never a new owner/producer receipt.
 * The common wire encoding is owned by ConversationGraphSourceEnvelope.ts.
 */
import type crypto from 'node:crypto';
import {verifyGraphCustodyAuthority} from './ConversationGraphCustodyAuthority.js';
import {createGraphControlCapsule,verifyGraphControlCapsule,verifyGraphWitnessCustody,type GraphControlCapsule} from './GraphWitnessControl.js';
import {encodeGraphSourceEnvelope,decodeGraphSourceEnvelope} from './ConversationGraphSourceEnvelope.js';
import {validateGraphOperationCore,graphOperationIdentity,validateGraphApplicationSource} from './ConversationGraphOperation.js';
import {verifyGraphAuthorization,type GraphAuthorizationProof} from './ConversationGraphReplicationProof.js';
import {openGraphBundle,openRewrappedGraphBundle} from './GraphWitnessCrypto.js';
import {canonicalHash,canonicalJson,exactFields,iso,validatePacket,verifyMembershipEpoch,verifyEncryptedBundle,verifyGraphRecord,unsigned,GRAPH_SIGNATURE_DOMAINS as D,
 verifyAdoptionCertificate,verifyBundleRewrap,verifyWitnessErasure,verifyMemberReceipt,
 verifyCommitCertificate,verifyCancellationCertificate,verifyWitnessCancellation,erasureCoversPacket,
 type GraphCoreType,type GraphOperationPacket,type GraphMembershipEpoch,type GraphEncryptedBundle,type GraphWitnessPrepareProof,
 type GraphBundleRewrap,type GraphWitnessErasure,type GraphWitnessErasedControlProof,type GraphMembershipActivationCertificate} from './GraphWitnessTypes.js';
import {verifyGraphHistoricalMaterialization,type GraphHistoricalMaterialization} from './ConversationGraphHistoricalMaterialization.js';
import type {ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';

export const GRAPH_SOURCE_RECOVERY_MAX_ENVELOPE_BYTES=1536000;
export const GRAPH_SOURCE_RECOVERY_MAX_APPLICATION_BYTES=1048576;
export interface GraphSourceRecoveryControl {coreType:GraphCoreType;core:Record<string,unknown>;authorizationProof:GraphAuthorizationProof;applicationSource:Buffer}
export function encodeGraphSourceRecoveryEnvelope(input:{coreType:GraphCoreType;core:Record<string,unknown>;authorizationProof:GraphAuthorizationProof;applicationSource:Uint8Array}):Buffer {
 if(input.applicationSource.byteLength>GRAPH_SOURCE_RECOVERY_MAX_APPLICATION_BYTES||!validateGraphOperationCore(input.coreType,input.core)
  ||input.authorizationProof.receipt.eventId!==graphOperationIdentity(input.coreType,input.core)
  ||input.authorizationProof.receipt.coreHash!==canonicalHash(input.core)
  ||!validateGraphApplicationSource(input.coreType,input.core,input.authorizationProof,input.applicationSource))throw new Error('graph-source-recovery-control-invalid');
 const bytes=encodeGraphSourceEnvelope(input.coreType,input.core,input.authorizationProof,input.applicationSource);
 if(bytes.length>GRAPH_SOURCE_RECOVERY_MAX_ENVELOPE_BYTES){bytes.fill(0);throw new Error('graph-source-recovery-envelope-too-large');}return bytes;
}
/** Validate the actual original packet/auth signatures after decryption. Caller
 * owns and must zero the envelope and the returned application buffer. */
export function decodeGraphSourceRecoveryEnvelope(input:{packet:GraphOperationPacket;packetSignature:string;plaintextEnvelope:Buffer;ownerPublicKey:crypto.KeyLike}):GraphSourceRecoveryControl {
 if(input.plaintextEnvelope.length>GRAPH_SOURCE_RECOVERY_MAX_ENVELOPE_BYTES)throw new Error('graph-source-recovery-envelope-too-large');
 const value=decodeGraphSourceEnvelope(input.plaintextEnvelope);
 try{
  const {packet}=input;const core=validateGraphOperationCore(value.coreType,value.core);
  if(!validatePacket(packet)||!core||value.coreType!==packet.coreType||packet.eventId!==graphOperationIdentity(value.coreType,core)
   ||canonicalHash(core)!==packet.coreHash||canonicalHash(createGraphControlCapsule(value.coreType,core,value.authorizationProof))!==packet.controlHash||value.applicationSource.length>GRAPH_SOURCE_RECOVERY_MAX_APPLICATION_BYTES
   ||!verifyGraphAuthorization(packet,core,value.authorizationProof,input.ownerPublicKey,packet.writerId).ok)throw new Error('graph-source-recovery-control-invalid');
  const member=value.authorizationProof.membership.members.find(m=>m.machineId===packet.writerId);
  if(!member||!verifyGraphRecord(D.packet,packet,input.packetSignature,member.signingPublicKey))throw new Error('graph-source-recovery-packet-signature-invalid');
  // Reject duplicate/noncanonical JSON control without changing the ONE wire
  // format. Application bytes remain opaque and preserve their original bytes.
  if(input.plaintextEnvelope.toString('utf8')!==canonicalJson({v:1,coreType:value.coreType,core:value.core,authorizationProof:value.authorizationProof,applicationSource:value.applicationSource.toString('base64url')}))throw new Error('graph-source-recovery-envelope-noncanonical');
  if(!validateGraphApplicationSource(value.coreType,core,value.authorizationProof,value.applicationSource))throw new Error('graph-source-recovery-application-invalid');
  return value;
 }catch(error){value.applicationSource.fill(0);throw error;}
}
export type GraphSourceRecoveryMaterializationContext=GraphHistoricalMaterialization;
export type GraphWitnessSourceRecoveryInput=Omit<ConversationGraphReplicationRecord,'coreType'|'core'|'authorizationProof'|'preparationProof'|'erasedControlProof'> & {
 originalMembership:GraphMembershipEpoch;controlCapsule:GraphControlCapsule;preparationProof?:GraphWitnessPrepareProof;erasedControlProof?:GraphWitnessErasedControlProof;materialization?:GraphSourceRecoveryMaterializationContext;
};
export interface GraphSourceRecoveryOptions {
 machineId:string;sealingPrivateKey:crypto.KeyLike;ownerPublicKey:crypto.KeyLike;witnessPublicKeys:ReadonlyMap<string,crypto.KeyLike>;
 /** Actual verified witness/local tombstone inventory. A matching tombstone
  * dominates every retained ciphertext copy, including old recovery snapshots. */
 knownErasures?:readonly GraphWitnessErasure[];installedMembership?:GraphMembershipEpoch;custodyMembership?:GraphMembershipEpoch;custodyActivations?:GraphMembershipActivationCertificate[];
}
function witnessKey(id:string,options:GraphSourceRecoveryOptions):crypto.KeyLike {
 const key=options.witnessPublicKeys.get(id);if(!key)throw new Error('graph-source-recovery-witness-unpinned');return key;
}
function verifyMaterialization(context:GraphSourceRecoveryMaterializationContext,input:GraphWitnessSourceRecoveryInput,bundle:GraphEncryptedBundle,rewrap:GraphBundleRewrap,options:GraphSourceRecoveryOptions):GraphMembershipEpoch {
 if(!verifyGraphHistoricalMaterialization(context,input,{ownerPublicKey:options.ownerPublicKey,witnessPublicKeys:options.witnessPublicKeys,machineId:options.machineId})
  ||context.rewrapHash!==canonicalHash(rewrap)||context.currentLease.writerId!==rewrap.writerId
  ||!verifyBundleRewrap(rewrap,bundle,context.activation.newMembership))throw new Error('graph-source-recovery-materialization-invalid');
 return context.activation.newMembership;
}

/** Pure cold reconstruction. originalMembership and packetSignature come from
 * pinned witness transport/archive, never a new signature by the recovering
 * machine. Receiving storage still applies its real write/erasure gates. */
export function reconstructGraphSourceRecord(input:GraphWitnessSourceRecoveryInput,options:GraphSourceRecoveryOptions):{record:ConversationGraphReplicationRecord;applicationSource:Buffer} {
 const {packet,packetSignature,originalMembership:m,encryptedSourceBundle:bundle,preparationProof:prepared}=input;
 if(!validatePacket(packet)||!verifyMembershipEpoch(m,options.ownerPublicKey)||m.agentId!==packet.agentId||m.epoch!==packet.membershipEpoch)
  throw new Error('graph-source-recovery-membership-invalid');
 const member=m.members.find(x=>x.machineId===packet.writerId);
 if(!member||!verifyGraphRecord(D.packet,packet,packetSignature,member.signingPublicKey))throw new Error('graph-source-recovery-packet-signature-invalid');
 if(!verifyGraphControlCapsule(input.controlCapsule,packet,options.ownerPublicKey)||canonicalHash(input.controlCapsule.authorizationProof.membership)!==canonicalHash(m))throw new Error('graph-source-recovery-capsule-invalid');
 let erasure:GraphWitnessErasure|undefined;
 for(const candidate of [...(options.knownErasures??[]),...(input.erasure?[input.erasure]:[])]){
  if(candidate.agentId!==packet.agentId||!verifyWitnessErasure(candidate,witnessKey(candidate.witnessId,options)))throw new Error('graph-source-recovery-erasure-invalid');
  if(erasureCoversPacket(candidate,packet))erasure=candidate;
 }
 const lossNegative=!!input.adoption?.activation?.memberLoss&&verifyGraphMemberLossNegativeCustody({packet,packetSignature,controlCapsule:input.controlCapsule,prepareProof:prepared??null,erasedControlProof:input.erasedControlProof??null,certificate:input.certificate??null,adoption:input.adoption??null,cancellation:input.cancellation??null},m,options.ownerPublicKey,witnessKey(input.adoption.witnessId,options));
 const custody=input.erasedControlProof??prepared;if(!custody&&!lossNegative)throw new Error('graph-source-recovery-custody-missing');
 if(input.adoption&&(input.adoption.revalidation.sourceProofHash!==canonicalHash({coreType:packet.coreType,packet,packetSignature,core:input.controlCapsule.core,authorizationProof:input.controlCapsule.authorizationProof})||!verifyAdoptionCertificate(input.adoption,packet,m,options.ownerPublicKey,witnessKey(input.adoption.witnessId,options))))throw new Error('graph-source-recovery-adoption-invalid');
 if(input.materialization&&!verifyGraphHistoricalMaterialization(input.materialization,input,{ownerPublicKey:options.ownerPublicKey,witnessPublicKeys:options.witnessPublicKeys,machineId:options.machineId}))throw new Error('graph-source-recovery-materialization-invalid');
 if(options.installedMembership&&(!verifyMembershipEpoch(options.installedMembership,options.ownerPublicKey)||options.installedMembership.agentId!==packet.agentId))throw new Error('graph-source-recovery-current-membership-invalid');
 const matches=(membership:GraphMembershipEpoch|undefined)=>!!membership&&membership.epoch===input.erasedControlProof?.custodyMembershipEpoch&&membership.witnessId===custody?.witnessId;
 const custodyMembership=options.custodyMembership??input.custodyMembership??[m,input.adoption?.newMembership,input.materialization?.activation.newMembership,options.installedMembership].find(matches);
 const custodyActivations=options.custodyActivations??input.custodyActivations??(custodyMembership&&canonicalHash(custodyMembership)!==canonicalHash(m)?input.materialization?[input.materialization.activation]:input.adoption?.activation?[input.adoption.activation]:[]:[]);
 if(options.custodyMembership&&input.custodyMembership&&canonicalHash(options.custodyMembership)!==canonicalHash(input.custodyMembership))throw new Error('graph-source-recovery-custody-membership-conflict');
 const issuerAllowed=input.erasedControlProof?!!custodyMembership&&verifyGraphCustodyAuthority(input.erasedControlProof,m,custodyMembership,custodyActivations,{ownerPublicKey:options.ownerPublicKey,witnessPublicKeys:options.witnessPublicKeys}):custody?.witnessId===m.witnessId;
 if(custody&&(!issuerAllowed||!verifyGraphWitnessCustody(prepared??null,input.erasedControlProof??null,packet,custody.witnessId,witnessKey(custody.witnessId,options),erasure??null)))throw new Error('graph-source-recovery-witness-custody-invalid');
 if(input.erasedControlProof&&input.certificate)throw new Error('graph-source-recovery-never-saved-cannot-commit');
 if((input.custodyMembership||input.custodyActivations)&&!input.erasedControlProof)throw new Error('graph-source-recovery-custody-sidecar-unexpected');
 if(input.adoption?.erasedControlHash!==undefined&&(!input.erasedControlProof||!erasure||prepared||input.certificate||input.adoption.erasedControlHash!==canonicalHash(input.erasedControlProof)))throw new Error('graph-source-recovery-erased-adoption-unbound');
 let control:GraphSourceRecoveryControl;
 if(erasure||lossNegative){
  // Permanent capsule is independently authenticated; erased application bytes
  // are neither opened nor reconstructed, even if a stale ciphertext survived.
  control={coreType:input.controlCapsule.coreType,core:input.controlCapsule.core,authorizationProof:input.controlCapsule.authorizationProof,applicationSource:Buffer.alloc(0)};
 }else{
 if(!bundle||!verifyEncryptedBundle(bundle,m)||canonicalHash(bundle)!==packet.sourceBundleHash)throw new Error('graph-source-recovery-ciphertext-invalid');
 if(input.adoption&&(input.adoption.revalidation.sourceProofHash!==canonicalHash({coreType:packet.coreType,packet,packetSignature,core:input.controlCapsule.core,authorizationProof:input.controlCapsule.authorizationProof})||!verifyAdoptionCertificate(input.adoption,packet,m,options.ownerPublicKey,witnessKey(input.adoption.witnessId,options))))throw new Error('graph-source-recovery-adoption-invalid');
 let sealingMembership=m;
 if(input.rewrap){
  if(input.materialization)sealingMembership=verifyMaterialization(input.materialization,input,bundle,input.rewrap,options);
  else if(input.adoption&&input.adoption.rewrapHash===canonicalHash(input.rewrap)
   &&verifyBundleRewrap(input.rewrap,bundle,input.adoption.newMembership))sealingMembership=input.adoption.newMembership;
  else throw new Error('graph-source-recovery-rewrap-unapproved');
 }else if(input.materialization)throw new Error('graph-source-recovery-rewrap-missing');
 if(!sealingMembership.members.some(x=>x.machineId===options.machineId))throw new Error('graph-source-recovery-member-unavailable');
 const binding={agentId:packet.agentId,eventId:packet.eventId};
 const sealed=input.rewrap?openRewrappedGraphBundle(bundle,input.rewrap,options.machineId,options.sealingPrivateKey,sealingMembership,binding)
  :openGraphBundle(bundle,options.machineId,options.sealingPrivateKey,binding);
 try{control=decodeGraphSourceRecoveryEnvelope({packet,packetSignature,plaintextEnvelope:sealed,ownerPublicKey:options.ownerPublicKey});}finally{sealed.fill(0);}
 if(canonicalHash(createGraphControlCapsule(control.coreType,control.core,control.authorizationProof))!==canonicalHash(input.controlCapsule)){control.applicationSource.fill(0);throw new Error('graph-source-recovery-capsule-mismatch');}
 }
 try{
  if(canonicalHash(control.authorizationProof.membership)!==canonicalHash(m))throw new Error('graph-source-recovery-original-membership-mismatch');
  if(input.certificate&&!verifyCommitCertificate(input.certificate,packet,m,witnessKey(input.certificate.witnessId,options),options.ownerPublicKey))throw new Error('graph-source-recovery-certificate-invalid');
  if(input.cancellationCertificate&&!verifyCancellationCertificate(input.cancellationCertificate,packet,m,witnessKey(input.cancellationCertificate.witnessId,options),options.ownerPublicKey))throw new Error('graph-source-recovery-cancellation-certificate-invalid');
  if(input.cancellation&&!verifyWitnessCancellation(input.cancellation,packet,witnessKey(input.cancellation.witnessId,options),input.adoption?{membershipEpoch:input.adoption.newMembership.epoch,leaseEpoch:input.adoption.currentLease.leaseEpoch}:undefined))throw new Error('graph-source-recovery-cancellation-invalid');
  const terminal=input.certificate??input.cancellationCertificate;
  if(input.certificatePersistenceReceipts){
   if(!Array.isArray(input.certificatePersistenceReceipts)||(input.certificatePersistenceReceipts.length>0&&!terminal))throw new Error('graph-source-recovery-persistence-invalid');
   const effective=terminal?.adoption?.newMembership??m,context=terminal?.adoption?{membershipEpoch:effective.epoch,leaseEpoch:terminal.adoption.currentLease.leaseEpoch}:undefined;
   const seen=new Set<string>();for(const receipt of input.certificatePersistenceReceipts){
    if(seen.has(receipt.machineId)||!verifyMemberReceipt(receipt,packet,effective,'certificate',canonicalHash(terminal),context))throw new Error('graph-source-recovery-persistence-invalid');seen.add(receipt.machineId);
   }
  }
  const {originalMembership:_original,controlCapsule:_capsule,...rest}=input;
  const record:ConversationGraphReplicationRecord={...rest,coreType:control.coreType,core:control.core,authorizationProof:control.authorizationProof,...(erasure?{erasure,encryptedSourceBundle:null}:{}),...(lossNegative?{encryptedSourceBundle:null}:{}),...(input.erasedControlProof?{custodyMembership,custodyActivations}:{})};
  if(erasure||lossNegative)delete record.rewrap;
  return {record,applicationSource:control.applicationSource};
 }catch(error){control.applicationSource.fill(0);throw error;}
}
