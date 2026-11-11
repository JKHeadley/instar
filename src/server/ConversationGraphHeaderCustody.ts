/** Materializes ONLY opaque header metadata. The source runtime owns every
 * encrypted payload, key envelope, repair copy and erasure fence.
 * Spec: conversation-effort-hierarchy-v3 §7.6.
 */
import {EffortHeaderStore,validateHeaderOperation,titleCommitment,canonicalTitle,deriveCertifiedHeaderMetadata,type HeaderOperation} from '../core/EffortHeaderStore.js';
import type {ConversationGraphReplicationRecord} from '../core/ConversationGraphReplication.js';
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';

export class ConversationGraphHeaderCustody {
 readonly headers:EffortHeaderStore;
 private incomplete=false;
 constructor(stateDir:string,private readonly runtime:ConversationGraphReplicationRuntime){
  this.headers=new EffortHeaderStore(stateDir,(headerId,bundleRef)=>{
   if(this.runtime.source.isErased({sourceKind:'header',sourceId:headerId}))return null;
   const records=this.runtime.retainedProjection().records.filter(record=>record.coreType==='header-op'&&record.core.kind==='set-effort-title'
    &&record.core.headerId===headerId&&(record.core.bundleRef as {id?:string}|undefined)?.id===bundleRef.id);
   // A duplicate bundle reference cannot choose a different source by arrival
   // order. Only the unique immutable operation can resolve this header text.
   if(records.length!==1)return null;
   const op=validateHeaderOperation(records[0].core);return op?this.content(records[0],op):null;
  });
 }
 private content(record:ConversationGraphReplicationRecord,op:HeaderOperation):{title:string;salt:string}|null{
  if(op.kind!=='set-effort-title')return null;
  if(this.runtime.source.isErased({sourceKind:'header',sourceId:op.headerId}))return null;
  try{
   const bytes=this.runtime.source.openVerifiedPayload(record);
   let body:Record<string,unknown>;try{body=JSON.parse(bytes.toString('utf8'));}finally{bytes.fill(0);}
   if(body.headerId!==op.headerId||typeof body.title!=='string'||typeof body.salt!=='string'
    ||!canonicalTitle(body.title)||canonicalTitle(body.title).length>200||titleCommitment(body.title,body.salt)!==op.titleCommitment)return null;
   return{title:body.title,salt:body.salt};
  }catch{/* @silent-fallback-ok — unavailable verified header text is omitted; synchronize marks coverage partial instead of inventing content. */return null;}
 }
 /** Called before an owner read or correction snapshot. No unverified event,
  * pending proposal or bare witness acceptance reaches applyCertified. */
 synchronize():void{
  this.incomplete=false;
  const records=this.runtime.retainedProjection().records.filter(record=>record.coreType==='header-op')
   .sort((a,b)=>a.packet.sourceSequence-b.packet.sourceSequence);
  const entries:Array<{operation:HeaderOperation;content:{title:string;salt:string}|null}>=[];
  for(const record of records){
   if(!this.runtime.source.verifyHistoricalRecord(record)){this.incomplete=true;continue;}
   const op=validateHeaderOperation(record.core);if(!op){this.incomplete=true;continue;}
   const content=op.kind==='forget-header'?null:this.content(record,op);
   if(op.kind==='set-effort-title'&&!content){this.incomplete=true;continue;}
   entries.push({operation:op,content});
  }
  // Metadata is a rebuildable projection of this exact verified union. A
  // dropped origin must not leave an obsolete version blocking new changes.
  this.headers.reconcileCertified(entries);
 }
 titleOf(headerId:string):string|null{return this.headers.titleOf(headerId);}
 get(headerId:string):{version:number;forgotten:boolean}|null{
  if(this.runtime.source.isErased({sourceKind:'header',sourceId:headerId}))return{version:0,forgotten:true};
  const operations=this.runtime.retainedProjection().records.filter(record=>record.coreType==='header-op'&&record.core.headerId===headerId)
   .map(record=>{
    if(!this.runtime.source.verifyHistoricalRecord(record))throw new Error('header-metadata-source-unverified');
    const op=validateHeaderOperation(record.core);if(!op)throw new Error('header-metadata-core-invalid');return op;
   });
  const metadata=deriveCertifiedHeaderMetadata(operations);
  return metadata?{version:metadata.version,forgotten:metadata.forgotten}:null;
 }
 partial():boolean{return this.incomplete;}
}
