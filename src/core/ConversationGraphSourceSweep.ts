/** Signed bounded producer inventory checkpoints. No title, alias, preview or
 * row salt belongs in this payload: references point at separately certified
 * salted observations. A producer signature alone never grants read readiness.
 */
import {validateNodeRef,nodeKey,type ConversationRef} from './conversationGraph.js';
import {canonicalHash,exactFields,hash,iso,opaque,signGraphRecord,verifyGraphRecord,unsigned,type GraphMembershipEpoch,type GraphEncryptedBundle} from './GraphWitnessTypes.js';
import type crypto from 'node:crypto';
export const GRAPH_SOURCE_SWEEP_MAX_ROWS=1000,GRAPH_SOURCE_SWEEP_MAX_PAGES=32;
const DOMAIN='graph-source-inventory-sweep-v1',PAYLOAD_DOMAIN='graph-source-inventory-sweep-payload-v1';
export type GraphSourceSweepReason='capacity'|'registration-unavailable'|'registration-changed'|'source-unavailable'|'page-gap'|'capture-failed';
export interface GraphSourceSweepExpected {ref:ConversationRef;registration:'app-store'|'slack-registry'|'telegram-registry'|'prior';state:'live'|'deleted'|'forgotten'|'unavailable'}
export type GraphSourceSweepEntry=
 |{ref:ConversationRef;state:'observed';sourceId:string;payloadHash:string;page:number}
 |{ref:ConversationRef;state:'source-removed';reason:'deleted'|'forgotten'|'unavailable'};
export interface GraphSourceSweepPage {index:number;afterHash:string;nextHash:string;observationsHash:string;observedCount:number}
export interface GraphSourceSweepFrontier {registrationsHash:string;appEventWatermark:number|null;slackSequence:number|null}
export interface GraphSourceSweepPayload {
 v:1;sourceId:string;scanId:string;producerMachineId:string;startedAt:string;completedAt:string;
 status:'complete'|'partial';partialReasons:GraphSourceSweepReason[];expected:GraphSourceSweepExpected[];entries:GraphSourceSweepEntry[];
 pages:GraphSourceSweepPage[];before:GraphSourceSweepFrontier;after:GraphSourceSweepFrontier;
}
export interface SignedGraphSourceSweepCheckpoint {
 version:1;kind:'source-inventory-sweep';agentId:string;sourceId:string;scanId:string;producerMachineId:string;
 membershipEpoch:number;membershipHash:string;startedAt:string;completedAt:string;payloadHash:string;inventoryHash:string;signature:string;
}
export interface GraphSourceSweepCore {
 schemaVersion:1;op:'observe-source-inventory';eventId:string;authority:'source';principal:'server-source-observer';
 receipt:{kind:'source-observation-record';id:string};machineId:string;createdAt:string;payloadHash:string;
}
export interface CapturedGraphSourceSweepCheckpoint {capture:SignedGraphSourceSweepCheckpoint;encryptedPayload:GraphEncryptedBundle}
/** An unchanged inventory republishes only this often: each checkpoint is about ten permanent files. */
export const GRAPH_SOURCE_SWEEP_HEARTBEAT_MS=60*60*1000;
/** Must outlast missed heartbeats. Stale only marks coverage; rows stay readable. */
export const GRAPH_SOURCE_SWEEP_STALE_MS=3*GRAPH_SOURCE_SWEEP_HEARTBEAT_MS;
/** Publish only when the inventory changed or the heartbeat is due. Unchanged checkpoints are permanent files, so an idle agent must not write one per scan. */
export function sourceSweepCheckpointDue(last:{hash:string;at:number}|null,hash:string,now:number):boolean{return last?.hash!==hash||now-last.at>=GRAPH_SOURCE_SWEEP_HEARTBEAT_MS;}
export const sourceSweepEventId=(sourceId:string)=>`source-inventory-${sourceId}`;
function ref(raw:unknown):raw is ConversationRef {const value=validateNodeRef(raw);return !!value&&value.kind==='conversation'&&canonicalHash(value)===canonicalHash(raw);}
function ordered<T extends {ref:ConversationRef}>(rows:T[]):boolean {return rows.every((r,i)=>ref(r.ref)&&(i===0||nodeKey(rows[i-1].ref)<nodeKey(r.ref)));}
export function sourceSweepInventoryHash(payload:Pick<GraphSourceSweepPayload,'expected'|'entries'|'after'>):string{return canonicalHash({expected:payload.expected,entries:payload.entries,after:payload.after});}
export function sourceSweepPayloadHash(payload:GraphSourceSweepPayload):string{return canonicalHash({domain:PAYLOAD_DOMAIN,payload});}
export function sourceSweepPageHash(entries:GraphSourceSweepEntry[],index:number):string{return canonicalHash(entries.filter((e):e is Extract<GraphSourceSweepEntry,{state:'observed'}>=>e.state==='observed'&&e.page===index).map(e=>({ref:e.ref,sourceId:e.sourceId,payloadHash:e.payloadHash})));}
function frontier(f:GraphSourceSweepFrontier):boolean{return exactFields(f,['registrationsHash','appEventWatermark','slackSequence'])&&hash(f.registrationsHash)
 &&(f.appEventWatermark===null||Number.isSafeInteger(f.appEventWatermark)&&f.appEventWatermark>=0)&&(f.slackSequence===null||Number.isSafeInteger(f.slackSequence)&&f.slackSequence>=0);}
export function validateGraphSourceSweepPayload(raw:unknown):GraphSourceSweepPayload|null {
 try{const p=raw as GraphSourceSweepPayload;
  if(!exactFields(p,['v','sourceId','scanId','producerMachineId','startedAt','completedAt','status','partialReasons','expected','entries','pages','before','after'])
   ||p.v!==1||!opaque(p.sourceId)||!opaque(sourceSweepEventId(p.sourceId))||!opaque(p.scanId)||!opaque(p.producerMachineId)||!iso(p.startedAt)||!iso(p.completedAt)
   ||Date.parse(p.completedAt)<Date.parse(p.startedAt)||Date.parse(p.completedAt)-Date.parse(p.startedAt)>86400000
   ||!['complete','partial'].includes(p.status)||!Array.isArray(p.partialReasons)||p.partialReasons.length>6||new Set(p.partialReasons).size!==p.partialReasons.length
   ||p.partialReasons.some(x=>!['capacity','registration-unavailable','registration-changed','source-unavailable','page-gap','capture-failed'].includes(x))
   ||!Array.isArray(p.expected)||!Array.isArray(p.entries)||p.expected.length>GRAPH_SOURCE_SWEEP_MAX_ROWS||p.entries.length>GRAPH_SOURCE_SWEEP_MAX_ROWS
   ||!ordered(p.expected)||!ordered(p.entries)||!frontier(p.before)||!frontier(p.after)||p.after.registrationsHash!==canonicalHash(p.expected)
   ||!Array.isArray(p.pages)||p.pages.length<1||p.pages.length>GRAPH_SOURCE_SWEEP_MAX_PAGES)return null;
  for(const e of p.expected)if(!exactFields(e,['ref','registration','state'])||!['app-store','slack-registry','telegram-registry','prior'].includes(e.registration)||!['live','deleted','forgotten','unavailable'].includes(e.state))return null;
  for(const e of p.entries){
   if(e.state==='observed'){
    if(!exactFields(e,['ref','state','sourceId','payloadHash','page'])||!opaque(e.sourceId)||!hash(e.payloadHash)||!Number.isSafeInteger(e.page)||e.page<0||e.page>=p.pages.length)return null;
   }else if(e.state!=='source-removed'||!exactFields(e,['ref','state','reason'])||!['deleted','forgotten','unavailable'].includes(e.reason))return null;
   const expected=p.expected.find(x=>nodeKey(x.ref)===nodeKey(e.ref));if(!expected)return null;
   if(e.state==='observed'&&expected.state!=='live'||e.state==='source-removed'&&e.reason!=='unavailable'&&expected.state!==e.reason)return null;
  }
  for(const page of p.pages){
   if(!exactFields(page,['index','afterHash','nextHash','observationsHash','observedCount'])||page.index!==p.pages.indexOf(page)||!hash(page.afterHash)||!hash(page.nextHash)||!hash(page.observationsHash)
    ||!Number.isSafeInteger(page.observedCount)||page.observedCount<0||page.observedCount>200
    ||page.observationsHash!==sourceSweepPageHash(p.entries,page.index)||page.observedCount!==p.entries.filter(e=>e.state==='observed'&&e.page===page.index).length
    ||page.afterHash!==(page.index===0?canonicalHash(null):p.pages[page.index-1].nextHash))return null;
  }
  if(p.status==='complete'&&(p.partialReasons.length!==0||p.entries.length!==p.expected.length||p.pages.at(-1)!.nextHash!==canonicalHash(null)
    ||p.before.registrationsHash!==p.after.registrationsHash||p.before.appEventWatermark!==p.after.appEventWatermark||p.before.slackSequence!==p.after.slackSequence
    ||p.expected.some(e=>e.state==='unavailable')||p.entries.some(e=>e.state==='source-removed'&&e.reason==='unavailable')))return null;
  if(p.status==='partial'&&p.partialReasons.length===0)return null;
  return p;
 }catch{/* @silent-fallback-ok: strict source schema parser refuses malformed input with explicit null. */return null;}
}
export function verifyGraphSourceSweepCapture(raw:unknown,membership:GraphMembershipEpoch):raw is SignedGraphSourceSweepCheckpoint {
 try{const c=raw as SignedGraphSourceSweepCheckpoint,producer=membership.members.find(m=>m.machineId===c.producerMachineId);
  return exactFields(c,['version','kind','agentId','sourceId','scanId','producerMachineId','membershipEpoch','membershipHash','startedAt','completedAt','payloadHash','inventoryHash','signature'])
   &&c.version===1&&c.kind==='source-inventory-sweep'&&c.agentId===membership.agentId&&opaque(c.sourceId)&&opaque(sourceSweepEventId(c.sourceId))&&opaque(c.scanId)
   &&!!producer&&c.membershipEpoch===membership.epoch&&c.membershipHash===canonicalHash(membership)&&iso(c.startedAt)&&iso(c.completedAt)
   &&Date.parse(c.completedAt)>=Date.parse(c.startedAt)&&Date.parse(c.completedAt)-Date.parse(c.startedAt)<=86400000&&hash(c.payloadHash)&&hash(c.inventoryHash)
   &&verifyGraphRecord(DOMAIN,unsigned(c),c.signature,producer.signingPublicKey);
 }catch{/* @silent-fallback-ok: source signature/payload predicate refuses invalid evidence; no source receipt or coverage is granted. */return false;}
}
export function validateGraphSourceSweepCore(raw:unknown):GraphSourceSweepCore|null {
 try{const c=raw as GraphSourceSweepCore;return exactFields(c,['schemaVersion','op','eventId','authority','principal','receipt','machineId','createdAt','payloadHash'])
  &&c.schemaVersion===1&&c.op==='observe-source-inventory'&&opaque(c.eventId)&&c.authority==='source'&&c.principal==='server-source-observer'
  &&exactFields(c.receipt,['kind','id'])&&c.receipt.kind==='source-observation-record'&&opaque(c.receipt.id)&&c.eventId===sourceSweepEventId(c.receipt.id)
  &&opaque(c.machineId)&&iso(c.createdAt)&&hash(c.payloadHash)?c:null;}catch{/* @silent-fallback-ok: strict source schema parser refuses malformed input with explicit null. */return null;}
}
export function verifyGraphSourceSweepCoreSource(core:unknown,capture:unknown,membership:GraphMembershipEpoch,writerId:string):boolean {
 const c=validateGraphSourceSweepCore(core);return !!c&&verifyGraphSourceSweepCapture(capture,membership)&&c.machineId===writerId
  &&c.receipt.id===capture.sourceId&&c.createdAt===capture.completedAt&&c.payloadHash===capture.payloadHash;
}
export function validateGraphSourceSweepPlaintext(raw:unknown,capture:SignedGraphSourceSweepCheckpoint):boolean {
 try{const body=raw as {sourceObservation:unknown;payload:unknown};if(!exactFields(body,['sourceObservation','payload'])||canonicalHash(body.sourceObservation)!==canonicalHash(capture))return false;
  const p=validateGraphSourceSweepPayload(body.payload);return !!p&&p.sourceId===capture.sourceId&&p.scanId===capture.scanId&&p.producerMachineId===capture.producerMachineId
   &&p.startedAt===capture.startedAt&&p.completedAt===capture.completedAt&&sourceSweepPayloadHash(p)===capture.payloadHash&&sourceSweepInventoryHash(p)===capture.inventoryHash;
 }catch{/* @silent-fallback-ok: source signature/payload predicate refuses invalid evidence; no source receipt or coverage is granted. */return false;}
}
/** Internal producer helper; capture lifecycle constructs payload only from
 * actual source registration ports. This function never accepts a route row. */
export function signGraphSourceSweep(payload:GraphSourceSweepPayload,agentId:string,membership:GraphMembershipEpoch,privateKey:crypto.KeyLike):SignedGraphSourceSweepCheckpoint {
 if(!validateGraphSourceSweepPayload(payload))throw new Error('source-sweep-payload-invalid');
 const value={version:1 as const,kind:'source-inventory-sweep' as const,agentId,sourceId:payload.sourceId,scanId:payload.scanId,producerMachineId:payload.producerMachineId,
  membershipEpoch:membership.epoch,membershipHash:canonicalHash(membership),startedAt:payload.startedAt,completedAt:payload.completedAt,payloadHash:sourceSweepPayloadHash(payload),inventoryHash:sourceSweepInventoryHash(payload)};
 const result={...value,signature:signGraphRecord(DOMAIN,value,privateKey)};if(!verifyGraphSourceSweepCapture(result,membership))throw new Error('source-sweep-signing-key-invalid');return result;
}
