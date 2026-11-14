/** Only opaque, signed control metadata belongs here. Private source/envelope
 * values must first become separately verified, erasable private-part refs. */
import {canonicalHash,canonicalJson,exactFields,hash} from './GraphWitnessTypes.js';
import {GRAPH_OWNED_FRAME_CHUNK_BYTES,GRAPH_OWNED_FRAME_PART_BYTES,GRAPH_OWNED_FRAME_ACTIVE_BYTES,GraphOwnedControlFrameBudget} from './GraphOwnedControlFrameCache.js';
export interface GraphOwnedMetadataDescriptor {v:1;kind:'owned-control-metadata';id:string;hash:string;bytes:number;chunks:number}
const PRIVATE=new Set(['ciphertext','envelopes','encryptedSourceBundle','ownerRecoveryEnvelope','rewrap','privateKey','plaintextSource','applicationSource','title','salt']);
export function assertGraphOwnedOpaqueMetadata(value:unknown):void{
 let nodes=0;const visit=(raw:unknown,depth:number):void=>{if(++nodes>1000000||depth>80)throw new Error('graph-control-metadata-complexity');if(raw===null||typeof raw==='boolean'||typeof raw==='number')return;if(typeof raw==='string'){if(raw.length>65536)throw new Error('graph-control-metadata-string-size');return;}if(Array.isArray(raw)){for(const child of raw)visit(child,depth+1);return;}if(!raw||typeof raw!=='object')throw new Error('graph-control-metadata-invalid');for(const [key,child]of Object.entries(raw)){if(PRIVATE.has(key)&&child!==null&&!(child&&typeof child==='object'&&exactFields(child,['ownedPrivatePart'])&&hash((child as {ownedPrivatePart:string}).ownedPrivatePart)))throw new Error('graph-control-metadata-private-field');visit(child,depth+1);}};visit(value,0);
}
export function validateGraphOwnedMetadataDescriptor(value:unknown):value is GraphOwnedMetadataDescriptor{const d=value as GraphOwnedMetadataDescriptor;return !!d&&exactFields(d,['v','kind','id','hash','bytes','chunks'])&&d.v===1&&d.kind==='owned-control-metadata'&&hash(d.hash)&&d.id===canonicalHash({kind:d.kind,hash:d.hash,bytes:d.bytes})&&Number.isSafeInteger(d.bytes)&&d.bytes>0&&d.bytes<=GRAPH_OWNED_FRAME_PART_BYTES&&d.chunks===Math.ceil(d.bytes/GRAPH_OWNED_FRAME_CHUNK_BYTES);}
export class GraphOwnedControlMetadataFrames {
 constructor(private readonly budget:GraphOwnedControlFrameBudget=new GraphOwnedControlFrameBudget()){}
 private readonly entries=new Map<string,{peer:string;descriptor:GraphOwnedMetadataDescriptor;bytes:Buffer;createdAt:number}>();private bytes=0;private closed=false;
 private sweep(){for(const[key,row]of this.entries)if(Date.now()-row.createdAt>120000)this.remove(key);}
 private remove(key:string){const row=this.entries.get(key);if(row){row.bytes.fill(0);this.budget.untrack(row.bytes);this.bytes-=row.bytes.length;this.budget.release(row.bytes.length);this.entries.delete(key);}}
 retain(value:unknown,peer:string):GraphOwnedMetadataDescriptor{
  if(this.closed)throw new Error('graph-control-metadata-closed');this.sweep();assertGraphOwnedOpaqueMetadata(value);const bytes=Buffer.from(canonicalJson(value));
  try{if(bytes.length>GRAPH_OWNED_FRAME_PART_BYTES)throw new Error('graph-control-metadata-capacity');const digest=canonicalHash(value),descriptor:GraphOwnedMetadataDescriptor={v:1,kind:'owned-control-metadata',id:canonicalHash({kind:'owned-control-metadata',hash:digest,bytes:bytes.length}),hash:digest,bytes:bytes.length,chunks:Math.ceil(bytes.length/GRAPH_OWNED_FRAME_CHUNK_BYTES)},key=peer+':'+descriptor.id;
   if(!this.entries.has(key)){if(this.entries.size>=8||this.bytes+bytes.length>GRAPH_OWNED_FRAME_ACTIVE_BYTES)throw new Error('graph-control-metadata-capacity');this.budget.reserve(bytes.length);this.entries.set(key,{peer,descriptor,bytes:Buffer.from(bytes),createdAt:Date.now()});this.budget.track(this.entries.get(key)!.bytes);this.bytes+=bytes.length;}return descriptor;
  }finally{bytes.fill(0);}
 }
 chunk(id:string,index:number,peer:string):{id:string;index:number;chunk:string;chunkHash:string}{
  this.sweep();const row=this.entries.get(peer+':'+id);if(!row||!Number.isSafeInteger(index)||index<0||index>=row.descriptor.chunks)throw new Error('graph-control-metadata-unknown');const chunk=row.bytes.subarray(index*GRAPH_OWNED_FRAME_CHUNK_BYTES,Math.min(row.bytes.length,(index+1)*GRAPH_OWNED_FRAME_CHUNK_BYTES)).toString('base64url');return{id,index,chunk,chunkHash:canonicalHash(chunk)};
 }
 /** The peer has finished with this frame. Without this, a long stream fills the active limit within the 120-second sweep. */
 release(descriptor:GraphOwnedMetadataDescriptor,peer:string):void{this.remove(peer+':'+descriptor.id);}
 has(descriptor:GraphOwnedMetadataDescriptor,peer:string):boolean{this.sweep();const row=this.entries.get(peer+':'+descriptor.id);return !!row&&canonicalHash(row.descriptor)===canonicalHash(descriptor);}
 expire(){this.sweep();}
 get activeBytes(){return this.bytes;}
 clear(){for(const key of this.entries.keys())this.remove(key);}
 close(){this.closed=true;this.clear();}
}
/** The receiving buffer joins the same budget/zeroization inventory BEFORE
 * bytes arrive, including malformed bytes which later fail the opaque schema. */
export class GraphOwnedMetadataAssembly {
 private readonly bytes:Buffer;private readonly generation:number;private next=0;private closed=false;
 constructor(private readonly descriptor:GraphOwnedMetadataDescriptor,private readonly budget:GraphOwnedControlFrameBudget){if(!validateGraphOwnedMetadataDescriptor(descriptor))throw new Error('graph-control-metadata-incomplete');budget.reserve(descriptor.bytes);this.bytes=Buffer.alloc(descriptor.bytes);budget.track(this.bytes);this.generation=budget.epoch;}
 append(index:number,raw:string):void{
  if(this.closed||this.generation!==this.budget.epoch||index!==this.next||typeof raw!=='string'||!/^[A-Za-z0-9_-]+$/.test(raw)||raw.length>Math.ceil(GRAPH_OWNED_FRAME_CHUNK_BYTES*4/3))throw new Error('graph-control-metadata-chunk-invalid');
  const piece=Buffer.from(raw,'base64url');try{if(piece.toString('base64url')!==raw||piece.length!==Math.min(GRAPH_OWNED_FRAME_CHUNK_BYTES,this.descriptor.bytes-index*GRAPH_OWNED_FRAME_CHUNK_BYTES))throw new Error('graph-control-metadata-chunk-invalid');piece.copy(this.bytes,index*GRAPH_OWNED_FRAME_CHUNK_BYTES);this.next++;}finally{piece.fill(0);}
 }
 finish():unknown{if(this.closed||this.generation!==this.budget.epoch||this.next!==this.descriptor.chunks)throw new Error('graph-control-metadata-incomplete');try{const value:unknown=JSON.parse(this.bytes.toString('utf8'));assertGraphOwnedOpaqueMetadata(value);if(canonicalHash(value)!==this.descriptor.hash)throw new Error('graph-control-metadata-hash-invalid');return value;}finally{this.close();}}
 close(){if(!this.closed){this.closed=true;this.bytes.fill(0);this.budget.untrack(this.bytes);this.budget.release(this.bytes.length);}}
}
export function decodeGraphOwnedMetadata(descriptor:GraphOwnedMetadataDescriptor,chunks:string[]):unknown{
 if(!validateGraphOwnedMetadataDescriptor(descriptor)||chunks.length!==descriptor.chunks)throw new Error('graph-control-metadata-incomplete');
 const bytes=Buffer.alloc(descriptor.bytes);try{for(let index=0;index<chunks.length;index++){const raw=chunks[index];if(typeof raw!=='string'||!/^[A-Za-z0-9_-]+$/.test(raw)||raw.length>Math.ceil(GRAPH_OWNED_FRAME_CHUNK_BYTES*4/3))throw new Error('graph-control-metadata-chunk-invalid');const piece=Buffer.from(raw,'base64url');try{if(piece.toString('base64url')!==raw||piece.length!==Math.min(GRAPH_OWNED_FRAME_CHUNK_BYTES,descriptor.bytes-index*GRAPH_OWNED_FRAME_CHUNK_BYTES))throw new Error('graph-control-metadata-chunk-invalid');piece.copy(bytes,index*GRAPH_OWNED_FRAME_CHUNK_BYTES);}finally{piece.fill(0);}}
  const value:unknown=JSON.parse(bytes.toString('utf8'));assertGraphOwnedOpaqueMetadata(value);if(canonicalHash(value)!==descriptor.hash)throw new Error('graph-control-metadata-hash-invalid');return value;
 }finally{bytes.fill(0);}
}
