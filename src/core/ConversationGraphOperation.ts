/** Explicit transport discriminator; immutable semantic cores retain their own
 * exact schema/hash and identifiers. Unknown or unavailable kinds fail closed. */
import {canonicalHash,graphOperationKey,type GraphCoreType,type GraphErasureIdentity} from './GraphWitnessTypes.js';
import {validateHeaderOperation,canonicalTitle,titleCommitment,MAX_EFFORT_TITLE_CHARS} from './EffortHeaderStore.js';
import {validateGraphEvent} from './conversationGraph.js';
import type {GraphAuthorizationProof} from './ConversationGraphReplicationProof.js';
import {validateGraphSourceOperationCore,validateGraphSourceOperationPlaintext} from './ConversationGraphSourceInventory.js';
export function validateGraphOperationCore(coreType:GraphCoreType,raw:unknown):Record<string,unknown>|null{
 let parsed:unknown=null;
 switch(coreType){case 'graph-event':parsed=validateGraphEvent(raw);break;
  case 'source-observation':parsed=validateGraphSourceOperationCore(raw);break;
  case 'header-op':parsed=validateHeaderOperation(raw);break;default:return null;}
 return parsed&&canonicalHash(parsed)===canonicalHash(raw)?parsed as Record<string,unknown>:null;
}
export function graphOperationIdentity(coreType:GraphCoreType,core:unknown):string{
 const parsed=validateGraphOperationCore(coreType,core);if(!parsed)throw new Error('graph-operation-core-invalid');
 return graphOperationKey(coreType,(coreType==='header-op'?parsed.opId:parsed.eventId) as string);
}

/** Application custody is independently checked before any member signs source
 * durability. An authenticated core cannot certify unrelated display bytes. */
export function validateGraphApplicationSource(coreType:GraphCoreType,core:Record<string,unknown>,proof:GraphAuthorizationProof,bytes:Uint8Array):boolean{
 if(coreType==='graph-event')return true;
 let body:Record<string,unknown>;try{body=JSON.parse(Buffer.from(bytes).toString('utf8'));}catch{return false;}
 if(!body||typeof body!=='object'||Array.isArray(body))return false;
 if(coreType==='source-observation')return !!proof.sourceObservation&&validateGraphSourceOperationPlaintext(body,proof.sourceObservation);
 if(coreType!=='header-op')return false;
 const header=validateHeaderOperation(core);if(!header)return false;
 if(Object.keys(body).some(key=>!['kind','requestId','requestHash','headerId','title','salt'].includes(key)))return false;
 if(body.headerId!==undefined&&body.headerId!==header.headerId)return false;
 for(const name of ['kind','requestId','requestHash'])if(body[name]!==undefined&&(typeof body[name]!=='string'||(body[name] as string).length>200))return false;
 if(header.kind==='forget-header')return !Object.hasOwn(body,'title')&&!Object.hasOwn(body,'salt');
 if(typeof body.title!=='string'||typeof body.salt!=='string'||!/^[a-f0-9]{64}$/.test(body.salt))return false;
 const title=canonicalTitle(body.title);return title.length>0&&title.length<=MAX_EFFORT_TITLE_CHARS&&titleCommitment(title,body.salt)===header.titleCommitment;
}

export function deriveGraphErasureIdentity(coreType:GraphCoreType,raw:unknown):GraphErasureIdentity{
 const core=validateGraphOperationCore(coreType,raw);if(!core)throw new Error('graph-erasure-core-invalid');
 if(coreType==='header-op')return {sourceKind:'header',sourceId:core.headerId as string};
 if(coreType==='source-observation'&&core.op==='observe-conversation-source')return {sourceKind:'conversation-metadata',sourceId:canonicalHash(core.subject)};
 if(coreType==='graph-event'||coreType==='source-observation'&&core.op==='observe-source-inventory')return {sourceKind:'graph-intent',sourceId:graphOperationIdentity(coreType,core)};
 throw new Error('graph-erasure-core-kind-unknown');
}
