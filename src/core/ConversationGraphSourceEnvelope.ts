/** The independent witness ciphertext preserves the exact accepted semantic
 * core and original authorization along with the erasable application bytes.
 * Packet signature stays outside: the packet binds this ciphertext's hash. */
import {canonicalHash,canonicalJson,exactFields,type GraphCoreType} from './GraphWitnessTypes.js';
import type {GraphAuthorizationProof} from './ConversationGraphReplicationProof.js';
export interface GraphSourceEnvelope {v:1;coreType:GraphCoreType;core:Record<string,unknown>;authorizationProof:GraphAuthorizationProof;applicationSource:string}
export function encodeGraphSourceEnvelope(coreType:GraphCoreType,core:Record<string,unknown>,authorizationProof:GraphAuthorizationProof,applicationSource:Uint8Array):Buffer{
 return Buffer.from(canonicalJson({v:1,coreType,core,authorizationProof,applicationSource:Buffer.from(applicationSource).toString('base64url')} satisfies GraphSourceEnvelope));
}
export function decodeGraphSourceEnvelope(bytes:Buffer):{coreType:GraphCoreType;core:Record<string,unknown>;authorizationProof:GraphAuthorizationProof;applicationSource:Buffer}{
 let value:GraphSourceEnvelope;try{value=JSON.parse(bytes.toString('utf8')) as GraphSourceEnvelope;}catch{throw new Error('graph-source-envelope-invalid');}
 if(!exactFields(value,['v','coreType','core','authorizationProof','applicationSource'])||value.v!==1||!['graph-event','header-op','source-observation'].includes(value.coreType)
   ||!value.core||typeof value.core!=='object'||Array.isArray(value.core)||!value.authorizationProof||typeof value.authorizationProof!=='object'
   ||typeof value.applicationSource!=='string'||!/^[A-Za-z0-9_-]*$/.test(value.applicationSource))throw new Error('graph-source-envelope-invalid');
 const applicationSource=Buffer.from(value.applicationSource,'base64url');if(applicationSource.toString('base64url')!==value.applicationSource)throw new Error('graph-source-envelope-invalid');
 return {coreType:value.coreType,core:value.core,authorizationProof:value.authorizationProof,applicationSource};
}
export function verifyGraphSourceEnvelopeControl(value:{coreType:GraphCoreType;core:Record<string,unknown>;authorizationProof:GraphAuthorizationProof},expected:{coreType:GraphCoreType;core:Record<string,unknown>;authorizationProof:GraphAuthorizationProof}):boolean{
 return value.coreType===expected.coreType&&canonicalHash(value.core)===canonicalHash(expected.core)&&canonicalHash(value.authorizationProof)===canonicalHash(expected.authorizationProof);
}
