/** Exact controller command externalization. This does not authorize a command:
 * the unchanged controller must verify the reconstructed original afterwards. */
import {GraphOwnedControlFrameCache,type GraphOwnedPrivatePartPlan} from './GraphOwnedControlFrameCache.js';
import {createGraphControlCapsule,type GraphControlCapsule} from './GraphWitnessControl.js';
import {verifyGraphOwnerRecoveryEnvelope,type GraphOwnerRecoveryEnvelope} from './GraphOwnerRecovery.js';
import {canonicalHash,canonicalJson,exactFields,hash,verifyMembershipEpoch,type GraphOperationPacket,type GraphEncryptedBundle,type GraphBundleRewrap,type GraphMembershipEpoch,type GraphWitnessLease} from './GraphWitnessTypes.js';
import type {LeaseRecord} from './types.js';
interface Context {packet:GraphOperationPacket;packetSignature:string;controlCapsule:GraphControlCapsule;bundle:GraphEncryptedBundle}
interface PrivateRef {ownedPrivatePart:string}
export function isGraphOwnedPrivateRef(value:unknown):value is PrivateRef{return !!value&&typeof value==='object'&&exactFields(value,['ownedPrivatePart'])&&hash((value as PrivateRef).ownedPrivatePart);}
export function externalizeGraphOwnedCommand(payload:unknown,options:{cache:GraphOwnedControlFrameCache;target:string;ownerPublicKey:string;lease:GraphWitnessLease;originalLease:LeaseRecord}):{metadata:unknown;parts:GraphOwnedPrivatePartPlan[];keys:string[];inlineRecovery:GraphOwnerRecoveryEnvelope|null;commandHash:string}{
 const commandHash=canonicalHash(payload),command=structuredClone(payload) as Record<string,unknown>;
 if(!command||!['stage','recover','pin','bootstrap'].includes(command.kind as string))throw new Error('graph-control-framing-kind-unsupported');
 const contexts=new Map<string,Context>(),memberships=new Map<string,GraphMembershipEpoch>();
 const inspect=(value:unknown):void=>{if(!value||typeof value!=='object')return;if(isGraphOwnedPrivateRef(value))throw new Error('graph-control-framing-reserved-ref');if(Array.isArray(value)){value.forEach(inspect);return;}const row=value as Record<string,any>;
  if(row.v===1&&row.agentId&&row.members&&verifyMembershipEpoch(row as GraphMembershipEpoch,options.ownerPublicKey))memberships.set(canonicalHash(row),row as GraphMembershipEpoch);
  if(row.encryptedSourceBundle){const source=row.operation??row;if(source.packet){const controlCapsule=source.controlCapsule??createGraphControlCapsule(source.coreType,source.core,source.authorizationProof);contexts.set(source.packet.eventId,{packet:source.packet,packetSignature:source.packetSignature,controlCapsule,bundle:row.encryptedSourceBundle});}}
  Object.values(row).forEach(inspect);
 };inspect(command);
 const parts:GraphOwnedPrivatePartPlan[]=[],keys:string[]=[];let inlineRecovery:GraphOwnerRecoveryEnvelope|null=null;
 if(command.ownerRecoveryEnvelope){const envelope=command.ownerRecoveryEnvelope as GraphOwnerRecoveryEnvelope;const stage=(command.stage??(command.transition as any)?.stage) as any;
  if(!stage||!verifyGraphOwnerRecoveryEnvelope(envelope,stage.newMembership,options.ownerPublicKey)||canonicalHash(envelope)!==stage.ownerRecoveryHash||Buffer.byteLength(canonicalJson(envelope))>65536)throw new Error('graph-control-framing-recovery-invalid');inlineRecovery=envelope;delete command.ownerRecoveryEnvelope;
 }
 try{
  const transform=(value:unknown):unknown=>{if(!value||typeof value!=='object')return value;if(Array.isArray(value))return value.map(transform);const row=value as Record<string,any>,out:Record<string,unknown>={};
   for(const [name,body]of Object.entries(row)){
    if(name==='encryptedSourceBundle'&&body){const source=row.operation??row,context=contexts.get(source.packet?.eventId);if(!context)throw new Error('graph-control-framing-source-missing');const part=options.cache.createSourcePart({...context,target:options.target,commandHash,lease:options.lease,originalLease:options.originalLease});parts.push(part.plan);keys.push(part.key);out[name]={ownedPrivatePart:part.key};}
    else if(name==='rewrap'&&body){const rewrap=body as GraphBundleRewrap,context=contexts.get(rewrap.eventId),newMembership=memberships.get(rewrap.newMembershipHash);if(!context||!newMembership)throw new Error('graph-control-framing-rewrap-source-missing');const part=options.cache.createRewrapPart({...context,rewrap,newMembership,target:options.target,commandHash,lease:options.lease,originalLease:options.originalLease});parts.push(part.plan);keys.push(part.key);out[name]={ownedPrivatePart:part.key};}
    else out[name]=transform(body);
   }return out;
  };return{metadata:transform(command),parts,keys,inlineRecovery,commandHash};
 }catch(error){for(const key of keys)options.cache.release(key);throw error;}
}
export function reconstructGraphOwnedCommand(metadata:unknown,inlineRecovery:GraphOwnerRecoveryEnvelope|null,commandHash:string,cache:GraphOwnedControlFrameCache,sender:string):unknown{
 const references=new Set<string>();const inspect=(value:unknown):void=>{if(isGraphOwnedPrivateRef(value)){references.add(value.ownedPrivatePart);return;}if(value&&typeof value==='object')Object.values(value).forEach(inspect);};inspect(metadata);
 const resolved=new Map<string,GraphEncryptedBundle|GraphBundleRewrap>(),bundles=new Map<string,GraphEncryptedBundle>();
 try{const plans=[...references].map(key=>({key,plan:cache.partPlan(key,sender)}));for(const {key,plan}of plans.filter(row=>row.plan.kind==='source-bundle')){const value=cache.take(key,sender,commandHash) as GraphEncryptedBundle;resolved.set(key,value);bundles.set(canonicalHash(value),value);}for(const {key,plan}of plans.filter(row=>row.plan.kind==='source-rewrap'))resolved.set(key,cache.take(key,sender,commandHash,bundles.get(plan.packet.sourceBundleHash)));
  const restore=(value:unknown):unknown=>{if(isGraphOwnedPrivateRef(value)){const part=resolved.get(value.ownedPrivatePart);if(!part)throw new Error('graph-control-frame-part-missing');return part;}if(Array.isArray(value))return value.map(restore);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,child])=>[key,restore(child)]));return value;};const result=restore(metadata) as Record<string,unknown>;if(inlineRecovery)result.ownerRecoveryEnvelope=inlineRecovery;if(canonicalHash(result)!==commandHash)throw new Error('graph-control-frame-command-mismatch');return result;
 }finally{for(const key of references)cache.release(key);}
}
