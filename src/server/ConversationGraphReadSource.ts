/** Actual runtime read adapter. It never reads an unsigned flat row as durable
 * hierarchy inventory and never promotes a pending event into canonical state. */
import {canonicalHash} from '../core/GraphWitnessTypes.js';
import {DegradationReporter} from '../monitoring/DegradationReporter.js';
import {validateGraphEvent,type GraphEvent,type EffortRef} from '../core/conversationGraph.js';
import type {GraphReadSource} from '../core/conversationGraphRead.js';
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';
import type {ConversationGraphReplicationRecord} from '../core/ConversationGraphReplication.js';
import type {ConversationGraphHeaderCustody} from './ConversationGraphHeaderCustody.js';

export class ConversationGraphRuntimeReadSource implements GraphReadSource {
 private snapshot:ReturnType<ConversationGraphReplicationRuntime['retainedProjection']>|null=null;
 private inventorySnapshot:ReturnType<ConversationGraphReplicationRuntime['inventory']>|null=null;
 constructor(private readonly runtime:ConversationGraphReplicationRuntime,private readonly headers:ConversationGraphHeaderCustody,
  private readonly options:{correctionsEnabled?:boolean;erasureEnabled?:boolean;localIntentsEnabled?:boolean;
   cardPlacements?:()=>Array<{card:import('../core/conversationGraph.js').ConversationRef;project:import('../core/conversationGraph.js').ConversationRef}>}={}){}
 cardPlacements(){try{return this.options.cardPlacements?.()??[];}catch{
  // A failed card read must not look like "no cards": it is reported, and nothing is proposed this read.
  DegradationReporter.getInstance().report({feature:'Conversations.proposedCards',primary:'Show work cards under their project in Conversations',
   fallback:'Show the project without its proposed cards',reason:'card-placements-unreadable',impact:'A project page in Conversations may be missing the cards made for it',internalOnly:true});
  return[];}}
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
   // One verified view, shared by every read until the graph changes (runtime.readView).
   const view=this.runtime.readView();
   this.snapshot=view.retained;
   this.inventorySnapshot=view.inventory;
   this.headers.synchronize(view.retained.records);
   return{ready:true};
  }catch{return{ready:false,reason:'verified-source-unavailable'};}
 }
 /** Per view: its graph events by id, and each event's verification, worked out once. */
 private readonly perView=new WeakMap<object,{events:GraphEvent[];records:Map<string,ConversationGraphReplicationRecord>;creations:Map<string,ConversationGraphReplicationRecord>;verified:Map<string,boolean>}>();
 private viewIndex(){
  const snapshot=this.snapshot;if(!snapshot)return null;
  let index=this.perView.get(snapshot);if(index)return index;
  const records=new Map<string,ConversationGraphReplicationRecord>(),creations=new Map<string,ConversationGraphReplicationRecord>(),events:GraphEvent[]=[];
  for(const record of snapshot.records){
   if(record.coreType!=='graph-event')continue;
   const event=validateGraphEvent(record.core);if(event)events.push(event);
   const id=record.core.eventId;if(typeof id==='string'&&!records.has(id))records.set(id,record);
   const subject=record.core.subject as EffortRef|undefined;
   if(record.core.op==='create-effort'&&typeof subject?.id==='string'&&!creations.has(subject.id))creations.set(subject.id,record);
  }
  index={events,records,creations,verified:new Map()};this.perView.set(snapshot,index);return index;
 }
 certifiedEvents():GraphEvent[]{return [...(this.viewIndex()?.events??[])];}
 verify(event:GraphEvent):boolean{
  const index=this.viewIndex(),record=index?.records.get(event.eventId);
  if(!index||!record||record.packet.coreHash!==canonicalHash(event))return false;
  let ok=index.verified.get(event.eventId);
  if(ok===undefined){ok=this.runtime.source.verifyHistoricalRecord(record);index.verified.set(event.eventId,ok);}
  return ok;
 }
 conversations(){return this.inventorySnapshot?.conversations??[];}
 unavailableConversations(){return this.inventorySnapshot?.unavailableConversations??[];}
 effortTitle(effort:EffortRef):string|null{
  const record=this.viewIndex()?.creations.get(effort.id);
  return typeof record?.core.headerId==='string'?this.headers.titleOf(record.core.headerId):null;
 }
 headerMetadata(effort:EffortRef):{version:number;forgotten:boolean}|null{
  const record=this.viewIndex()?.creations.get(effort.id);
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
