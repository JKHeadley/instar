/** Bounded transport framing only. Completion must call the full source-recovery
 * verifier; neither chunk hashes nor a staged header grant admission. */
import {canonicalHash,canonicalJson,exactFields,hash,type GraphOperationPacket,type GraphWitnessLease} from './GraphWitnessTypes.js';
import type {LeaseRecord} from './types.js';
import type {GraphControlCapsule} from './GraphWitnessControl.js';
import type {GraphWitnessRecoveredSourceRequest} from './GraphWitnessService.js';
export const GRAPH_NATIVE_UPLOAD_DOMAIN='graph-native-source-upload-v1';
export const GRAPH_NATIVE_UPLOAD_MAX_BYTES=32*1024*1024;
export const GRAPH_NATIVE_UPLOAD_CHUNK_BYTES=192*1024;
export interface GraphNativeSourceUpload {kind:'native-source';v:1;transferId:string;requestHash:string;packet:GraphOperationPacket;packetSignature:string;controlCapsule:GraphControlCapsule;lease:GraphWitnessLease;originalLease:LeaseRecord;bytes:number;chunkHashes:string[];signature:string}
export type GraphNativeSourceUploadSigner=(plan:Omit<GraphNativeSourceUpload,'signature'>)=>string;
export function createGraphNativeSourceUpload(request:GraphWitnessRecoveredSourceRequest,sign:GraphNativeSourceUploadSigner):{plan:GraphNativeSourceUpload;chunks:string[]}{
 const bytes=Buffer.from(canonicalJson(request));if(bytes.length>GRAPH_NATIVE_UPLOAD_MAX_BYTES)throw new Error('native-source-upload-capacity');
 const chunks:string[]=[];for(let offset=0;offset<bytes.length;offset+=GRAPH_NATIVE_UPLOAD_CHUNK_BYTES)chunks.push(bytes.subarray(offset,offset+GRAPH_NATIVE_UPLOAD_CHUNK_BYTES).toString('base64url'));
 const requestHash=canonicalHash(request);const unsigned={kind:'native-source',v:1,transferId:canonicalHash({kind:'native-source',requestHash}),requestHash,packet:request.packet,packetSignature:request.packetSignature,controlCapsule:request.controlCapsule,lease:request.lease,originalLease:request.originalLease,bytes:bytes.length,chunkHashes:chunks.map(canonicalHash)} as const;return {plan:{...unsigned,signature:sign(unsigned)},chunks};
}
export function validateGraphNativeSourceUpload(raw:unknown):raw is GraphNativeSourceUpload{
 const p=raw as GraphNativeSourceUpload;return !!p&&exactFields(p,['kind','v','transferId','requestHash','packet','packetSignature','controlCapsule','lease','originalLease','bytes','chunkHashes','signature'])&&p.kind==='native-source'&&p.v===1&&hash(p.requestHash)&&p.transferId===canonicalHash({kind:'native-source',requestHash:p.requestHash})&&Number.isSafeInteger(p.bytes)&&p.bytes>0&&p.bytes<=GRAPH_NATIVE_UPLOAD_MAX_BYTES&&Array.isArray(p.chunkHashes)&&p.chunkHashes.length===Math.ceil(p.bytes/GRAPH_NATIVE_UPLOAD_CHUNK_BYTES)&&p.chunkHashes.every(hash)&&typeof p.signature==='string'&&p.signature.length<=256;
}
export function decodeGraphNativeSourceUpload(plan:GraphNativeSourceUpload,chunks:string[]):GraphWitnessRecoveredSourceRequest{
 if(!validateGraphNativeSourceUpload(plan)||chunks.length!==plan.chunkHashes.length)throw new Error('native-source-upload-incomplete');
 const buffers=chunks.map((chunk,index)=>{if(typeof chunk!=='string'||!/^[A-Za-z0-9_-]+$/.test(chunk)||canonicalHash(chunk)!==plan.chunkHashes[index])throw new Error('native-source-upload-chunk-invalid');const bytes=Buffer.from(chunk,'base64url');if(bytes.toString('base64url')!==chunk||bytes.length!==Math.min(GRAPH_NATIVE_UPLOAD_CHUNK_BYTES,plan.bytes-index*GRAPH_NATIVE_UPLOAD_CHUNK_BYTES))throw new Error('native-source-upload-chunk-invalid');return bytes;});
 const bytes=Buffer.concat(buffers);if(bytes.length!==plan.bytes)throw new Error('native-source-upload-byte-count-invalid');const request=JSON.parse(bytes.toString('utf8')) as GraphWitnessRecoveredSourceRequest;
 if(canonicalHash(request)!==plan.requestHash||canonicalHash(request.packet)!==canonicalHash(plan.packet)||request.packetSignature!==plan.packetSignature||canonicalHash(request.controlCapsule)!==canonicalHash(plan.controlCapsule)||canonicalHash(request.lease)!==canonicalHash(plan.lease)||canonicalHash(request.originalLease)!==canonicalHash(plan.originalLease))throw new Error('native-source-upload-request-mismatch');return request;
}
