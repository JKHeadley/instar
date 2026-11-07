/** A signed, short-lived description of one reversible placement. Owner
 * authentication and current observed-head checks remain mandatory at use. */
import type crypto from 'node:crypto';
import {canonicalJson,exactFields,signGraphRecord,verifyGraphRecord} from './GraphWitnessTypes.js';
import {validateNodeRef,type NodeRef} from './conversationGraph.js';

const DOMAIN='conversation-graph-undo-v1';
export interface GraphUndoClaim {
 v:1;principal:string;machineId:string;operationKey:string;subject:NodeRef;parent:NodeRef|null;expiresAt:number;
}
function valid(raw:unknown):raw is GraphUndoClaim{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return false;
 const value=raw as GraphUndoClaim;
 return exactFields(value,['v','principal','machineId','operationKey','subject','parent','expiresAt'])&&value.v===1
  &&typeof value.principal==='string'&&/^[A-Za-z0-9_.:@-]{1,120}$/.test(value.principal)
  &&typeof value.machineId==='string'&&/^[A-Za-z0-9_.:@-]{1,120}$/.test(value.machineId)
  &&typeof value.operationKey==='string'&&/^graph-event:[A-Za-z0-9_-]{8,80}$/.test(value.operationKey)
  &&!!validateNodeRef(value.subject)&&(value.parent===null||!!validateNodeRef(value.parent))
  &&Number.isSafeInteger(value.expiresAt);
}
export function issueGraphUndo(claim:GraphUndoClaim,key:crypto.KeyLike):string{
 if(!valid(claim))throw new Error('invalid-undo-claim');
 return Buffer.from(canonicalJson({claim,signature:signGraphRecord(DOMAIN,claim,key)})).toString('base64url');
}
export function readGraphUndo(token:unknown,key:crypto.KeyLike,now=Date.now()):GraphUndoClaim|null{
 if(typeof token!=='string'||token.length>4096||!/^[A-Za-z0-9_-]+$/.test(token))return null;
 try{
  const bytes=Buffer.from(token,'base64url');if(bytes.toString('base64url')!==token)return null;
  const value=JSON.parse(bytes.toString('utf8'));
  if(!exactFields(value,['claim','signature'])||!valid(value.claim)||typeof value.signature!=='string'
   ||canonicalJson(value)!==bytes.toString('utf8')||value.claim.expiresAt<=now||value.claim.expiresAt>now+600000
   ||!verifyGraphRecord(DOMAIN,value.claim,value.signature,key))return null;
  return value.claim;
 }catch{/* @silent-fallback-ok — invalid, expired or mismatched Undo token is a negative verification result; no compensating write is admitted. */return null;}
}
