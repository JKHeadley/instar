/** Actual runtime read adapter. It never reads an unsigned flat row as durable
 * hierarchy inventory and never promotes a pending event into canonical state. */
import {canonicalHash} from '../core/GraphWitnessTypes.js';
import {validateGraphEvent,type GraphEvent,type EffortRef} from '../core/conversationGraph.js';
import type {GraphReadSource} from '../core/conversationGraphRead.js';
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';
import type {ConversationGraphHeaderCustody} from './ConversationGraphHeaderCustody.js';

export class ConversationGraphRuntimeReadSource implements GraphReadSource {
 private snapshot:ReturnType<ConversationGraphReplicationRuntime['retainedProjection']>|null=null;
 private inventorySnapshot:ReturnType<ConversationGraphReplicationRuntime['inventory']>|null=null;
 constructor(private readonly runtime:ConversationGraphReplicationRuntime,private readonly headers:ConversationGraphHeaderCustody,
  private readonly options:{correctionsEnabled?:boolean;erasureEnabled?:boolean;localIntentsEnabled?:boolean}={}){}
 localRecordingReady():boolean{return this.options.correctionsEnabled===true&&this.options.localIntentsEnabled===true
  &&this.runtime.installedMembership.custodyProfile?.mode==='owned-machine'&&this.runtime.canRecordLocalOwnerIntents();}
 erasureReady():boolean{return this.options.erasureEnabled===true;}
 correctionsReady():boolean{
  if(this.options.correctionsEnabled!==true)return false;
  if(this.options.localIntentsEnabled===true)return this.runtime.canRecordLocalOwnerIntents();
  if(!this.runtime.isReady())return false;
  try{this.runtime.actuation();return true;}catch{/* @silent-fallback-ok — absent current write authority disables the correction capability; read readiness remains separately verified. */return false;}
 }
 readiness():{ready:true}|{ready:false;reason:string}{
  this.snapshot=null;this.inventorySnapshot=null;
  try{
   this.snapshot=this.runtime.retainedProjection();
   this.inventorySnapshot=this.runtime.inventory();
   this.headers.synchronize();
   return{ready:true};
  }catch{return{ready:false,reason:'verified-source-unavailable'};}
 }
 certifiedEvents():GraphEvent[]{
  return (this.snapshot?.records??[]).filter(record=>record.coreType==='graph-event')
   .map(record=>validateGraphEvent(record.core)).filter((event):event is GraphEvent=>event!==null);
 }
 verify(event:GraphEvent):boolean{
  const record=this.snapshot?.records.find(record=>record.coreType==='graph-event'&&record.core.eventId===event.eventId);
  return !!record&&record.packet.coreHash===canonicalHash(event)&&this.runtime.source.verifyHistoricalRecord(record);
 }
 conversations(){return this.inventorySnapshot?.conversations??[];}
 unavailableConversations(){return this.inventorySnapshot?.unavailableConversations??[];}
 effortTitle(effort:EffortRef):string|null{
  const record=this.snapshot?.records.find(record=>record.coreType==='graph-event'&&record.core.op==='create-effort'
   &&(record.core.subject as EffortRef).id===effort.id);
  return typeof record?.core.headerId==='string'?this.headers.titleOf(record.core.headerId):null;
 }
 headerMetadata(effort:EffortRef):{version:number;forgotten:boolean}|null{
  const record=this.snapshot?.records.find(record=>record.coreType==='graph-event'&&record.core.op==='create-effort'
   &&(record.core.subject as EffortRef).id===effort.id);
  if(typeof record?.core.headerId!=='string')return null;
  return this.headers.get(record.core.headerId)??{version:0,forgotten:false};
 }
 replication(){
  const coverage=this.inventorySnapshot?.coverage;
  return{replicaLag:!!this.snapshot?.olderRevision||!!this.snapshot?.pendingEventIds.length,
   eventGap:!!this.snapshot?.missingEventIds.length,
   evidenceMissing:!coverage?.membershipHash||!coverage.asOf||!!(coverage.missingProducerIds.length
    ||coverage.partialProducerIds.length||coverage.staleProducerIds.length||coverage.missingObservationIds.length)
    ||!!this.inventorySnapshot?.missingEventIds.length||this.headers.partial()};
 }
 now():Date{return this.snapshot?.olderRevision?new Date(this.snapshot.verifiedAt):new Date();}
}
