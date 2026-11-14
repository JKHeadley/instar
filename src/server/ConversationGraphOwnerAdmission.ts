/** Fresh HTTP owner admission and later current-policy validation are distinct.
 * Later validation is usable ONLY for an already verified machine-signed sealed
 * intent; none of these snapshots authenticates a new HTTP request.
 */
import type {Request} from 'express';
import {ledgerViewKey} from '../core/AppRecordSignatures.js';
import fs from 'node:fs';
import {validateNodeRef} from '../core/conversationGraph.js';
import type {GraphViewer} from '../core/conversationGraphRead.js';
import type {GraphLocalOwnerIntent} from '../core/ConversationGraphQueuedIntent.js';
import {type MobilePairingService} from './mobilePairingRoutes.js';
import {mobileOwnerDeviceAdmission,revalidateQueuedOwnerAdmissionSnapshot} from './mobileOwnerDeviceAdmission.js';
import type {ConversationGraphOwnerGrantStore} from './ConversationGraphOwnerGrant.js';
export type GraphQueuedOwnerAdmission=GraphLocalOwnerIntent['admission'];

/** A failed read is unavailable, never a durable revocation verdict. */
export function recordedGraphOwnerDevicePolicy(pairing:MobilePairingService,
 snapshot:Extract<GraphQueuedOwnerAdmission,{kind:'owner-device'}>):'current'|'revoked'|'unavailable'{
 try{
  // DeviceRegistry's compatibility reader turns read failures into an empty
  // registry. Establish readable authority before interpreting device-missing.
  const raw=JSON.parse(fs.readFileSync(pairing.devices.file,'utf8'));
  if(!raw||!Array.isArray(raw.devices)||!pairing.keyLedger)return'unavailable';
  const ledger=pairing.keyLedger.view();if(ledger===null)return'unavailable';
  const key=ledger.get(ledgerViewKey(snapshot.identity.keyHash,snapshot.deviceId));
  if(key?.revokedAt||pairing.keyLedger.isRevoked(snapshot.identity.keyHash,snapshot.deviceId))return'revoked';
  // Missing retained activation evidence is uncertainty, not a new owner grant.
  // An absent ledger cannot authorize an old sealed intent merely because a
  // device registry still calls that phone active. This does not certify the
  // freshness of a subsequently reconstructed ledger or solve authority rollback.
  if(!key)return'unavailable';
  const verdict=revalidateQueuedOwnerAdmissionSnapshot(pairing,snapshot);
  return verdict.ok?'current':['unreadable','key-ledger-missing','pairing-off','native-off'].includes(verdict.reason)?'unavailable':'revoked';
 }catch{return'unavailable';} // @silent-fallback-ok: uncertain current authority holds the intent; it never revokes or promotes it
}
export function recordedGraphOwnerDeviceIsCurrent(pairing:MobilePairingService,
 snapshot:Extract<GraphQueuedOwnerAdmission,{kind:'owner-device'}>):boolean{return recordedGraphOwnerDevicePolicy(pairing,snapshot)==='current';}

export type GraphQueuedOwnerResolution={state:'authorized';viewer:GraphViewer}|{state:'refused'}|{state:'unavailable'};
export function createConversationGraphOwnerAdmission(options:{agentId:string;machineId:string;pairing:MobilePairingService|null;
 grants:ConversationGraphOwnerGrantStore;resolveViewer(req:Request,surface:'dashboard'|'mobile'):GraphViewer|null;
 initializeDashboardPolicy?():void;
 /** Signed peer RPC to the ORIGINAL recorder, not the current writer's guessed registry. */
 remoteCurrent?(intent:GraphLocalOwnerIntent):Promise<GraphQueuedOwnerResolution>;
}){
 const localPolicy=(intent:GraphLocalOwnerIntent):'current'|'revoked'|'unavailable'=>{
  if(intent.principalKey!==`owner:${options.agentId}`)return'revoked';
  return intent.admission.kind==='owner-device'
   ?options.pairing?recordedGraphOwnerDevicePolicy(options.pairing,intent.admission):'unavailable'
   :options.grants.verdict(intent.admission.grantId,intent.idempotencyKey,intent.principalKey);
 };
 return{
  capture(req:Request,surface:'dashboard'|'mobile',key:string):GraphQueuedOwnerAdmission|null{
   const before=options.resolveViewer(req,surface);if(!before)return null;
   let admission:GraphQueuedOwnerAdmission;
   if(surface==='mobile'){
    const actual=options.pairing?mobileOwnerDeviceAdmission(options.pairing,req):null;if(!actual)return null;
    admission={kind:'owner-device',deviceId:actual.deviceId,identity:{...actual.identity,role:'owner'}};
   }else {options.initializeDashboardPolicy?.();admission=options.grants.capture(key,before.principalKey);}
   const after=options.resolveViewer(req,surface);
   return after&&after.principalKey===before.principalKey&&after.grantVersion===before.grantVersion?admission:null;
  },
  async resolve(intent:GraphLocalOwnerIntent):Promise<GraphQueuedOwnerResolution>{
   if(intent.recordedMachineId!==options.machineId){
    if(!options.remoteCurrent)return{state:'unavailable'};
    return options.remoteCurrent(intent);
   }
   const state=localPolicy(intent);if(state==='unavailable')return{state:'unavailable'};if(state==='revoked')return{state:'refused'};
   return{state:'authorized',viewer:{principalKey:intent.principalKey,grantVersion:intent.grantVersion,
    mayView:ref=>validateNodeRef(ref)!==null}};
  },
  /** RPC server calls this only after verifying the original sealed intent and
   * registered recorder binding. A random grant ID/owner boolean is insufficient.
   */
  currentRecordedIntent(intent:GraphLocalOwnerIntent):boolean{
   if(intent.recordedMachineId!==options.machineId)return false;
   const state=localPolicy(intent);if(state==='unavailable')throw new Error('graph-queued-owner-authority-unavailable');return state==='current';
  },
 };
}
