/** Actual, bounded flat-inventory enumeration. The producer signs only what
 * its real AppStore/ConversationRegistry/Telegram registration ports account
 * for. No caller-supplied row array or completion flag enters this class. */
import crypto from 'node:crypto';
import {ConversationGraphSourceInventoryCapture,graphSourceObservationIsErased,validateGraphSourceObservationCore,
 type GraphSourceInventoryCaptureDeps,type CapturedGraphSourceObservation} from './ConversationGraphSourceInventory.js';
import {validateNodeRef,nodeKey,type ConversationRef} from './conversationGraph.js';
import {canonicalHash,verifyMembershipEpoch} from './GraphWitnessTypes.js';
import {sealGraphBundle} from './GraphWitnessCrypto.js';
import {GRAPH_SOURCE_SWEEP_MAX_ROWS,GRAPH_SOURCE_SWEEP_MAX_PAGES,sourceSweepPageHash,signGraphSourceSweep,sourceSweepEventId,
 type GraphSourceSweepExpected,type GraphSourceSweepEntry,type GraphSourceSweepPage,type GraphSourceSweepFrontier,type GraphSourceSweepReason,type GraphSourceSweepPayload,type CapturedGraphSourceSweepCheckpoint} from './ConversationGraphSourceSweep.js';
import type {ConversationGraphReplication} from './ConversationGraphReplication.js';
import type {ReplicatedStoreReader} from './ReplicatedStoreReader.js';
import {ConversationGraphLocalErasureFence} from './ConversationGraphLocalErasure.js';
import type {DroppedOriginRegistry} from './RollbackUnmerge.js';
export interface GraphSourceSweepCaptureOptions extends Omit<GraphSourceInventoryCaptureDeps,'acceptedInventory'> {source:ConversationGraphReplication;reader:ReplicatedStoreReader;dropped:DroppedOriginRegistry}
function compare(a:{ref:ConversationRef},b:{ref:ConversationRef}):number{const x=nodeKey(a.ref),y=nodeKey(b.ref);return x<y?-1:x>y?1:0;}
export class ConversationGraphSourceSweepCapture {
 private readonly rows:ConversationGraphSourceInventoryCapture;
 private readonly localErasure:ConversationGraphLocalErasureFence;
 constructor(private readonly options:GraphSourceSweepCaptureOptions){this.localErasure=options.localErasure??new ConversationGraphLocalErasureFence(options.identity.baseDir);this.rows=new ConversationGraphSourceInventoryCapture({...options,localErasure:this.localErasure,acceptedInventory:()=>({source:options.source,reader:options.reader,dropped:options.dropped})});}
 private registrations():{expected:GraphSourceSweepExpected[];frontier:GraphSourceSweepFrontier;reasons:Set<GraphSourceSweepReason>} {
  const o=this.options,producerMachineId=o.identity.loadIdentity().machineId,reasons=new Set<GraphSourceSweepReason>(),expected=new Map<string,GraphSourceSweepExpected>();let appEventWatermark:number|null=null,slackSequence:number|null=null;
  const put=(raw:unknown,registration:GraphSourceSweepExpected['registration'],state:GraphSourceSweepExpected['state'])=>{
   const ref=validateNodeRef(raw);if(!ref||ref.kind!=='conversation'){reasons.add('registration-unavailable');return;}
   if(expected.size>=GRAPH_SOURCE_SWEEP_MAX_ROWS&&!expected.has(nodeKey(ref))){reasons.add('capacity');return;}
   const denied=graphSourceObservationIsErased(o.identity.baseDir,o.agentId,ref,this.localErasure)||this.localErasure.isDenied({sourceKind:'conversation-metadata',sourceId:canonicalHash(ref)});
   expected.set(nodeKey(ref),{ref,registration,state:denied?'forgotten':state});
  };
  // Previously certified producer references survive a lost/deleted local row.
  // Absence is unavailable, never an inferred platform deletion.
  const union=o.source.certifiedUnion(o.reader,o.dropped);if(union.partial||union.quarantined.length)reasons.add('registration-unavailable');
  for(const record of union.records){const core=validateGraphSourceObservationCore(record.core),capture=record.authorizationProof.sourceObservation;
   if(core&&capture?.kind==='conversation-source-observation'&&capture.producerMachineId===producerMachineId&&o.source.verifyHistoricalRecord(record))put(core.subject,'prior',record.erasure?'forgotten':'unavailable');
  }
  if(!o.flat.service)reasons.add('registration-unavailable');
  else try{const app=o.flat.service.store.inventoryFrontier(GRAPH_SOURCE_SWEEP_MAX_ROWS+1);appEventWatermark=app.eventWatermark;if(app.overflow||app.keys.length>GRAPH_SOURCE_SWEEP_MAX_ROWS)reasons.add('capacity');
   for(const key of app.keys){const ref=validateNodeRef({kind:'conversation',platform:'app',conversationKey:key.conversationKey});
    // Transport mirrors in the app store are not native app identities.
    if(ref?.kind==='conversation')put(ref,'app-store',key.tombstoned?'deleted':'live');}
  }catch{/* @silent-fallback-ok: signed sweep explicitly includes registration-unavailable and remains partial; missing registration cannot prove completeness. */reasons.add('registration-unavailable');}
  try{const registry=o.registry.list({platform:'slack',limit:GRAPH_SOURCE_SWEEP_MAX_ROWS+1}).filter(row=>row.entry.origin!=='replicated');
   if(registry.length>GRAPH_SOURCE_SWEEP_MAX_ROWS)reasons.add('capacity');
   for(const {entry}of registry)put({kind:'conversation',platform:'slack',channelId:entry.channelId,...(entry.threadTs?{threadTs:entry.threadTs}:{})},'slack-registry',entry.reachability==='unreachable'?'unavailable':'live');
   const seq=(o.registry.health().seq as {counter?:unknown}|undefined)?.counter;if(Number.isSafeInteger(seq)&&Number(seq)>=0)slackSequence=Number(seq);else reasons.add('registration-unavailable');
  }catch{/* @silent-fallback-ok: signed sweep explicitly includes registration-unavailable and remains partial; missing registration cannot prove completeness. */reasons.add('registration-unavailable');}
  if(o.flat.telegramTopics)try{const topics=o.flat.telegramTopics();if(topics.length>GRAPH_SOURCE_SWEEP_MAX_ROWS)reasons.add('capacity');
   for(const topic of topics.slice(0,GRAPH_SOURCE_SWEEP_MAX_ROWS+1)){
    if(o.telegramChatId)put({kind:'conversation',platform:'telegram',chatId:o.telegramChatId,topicId:topic.topicId},'telegram-registry','live');else reasons.add('registration-unavailable');
   }
  }catch{/* @silent-fallback-ok: signed sweep explicitly includes registration-unavailable and remains partial; missing registration cannot prove completeness. */reasons.add('registration-unavailable');}
  const rows=[...expected.values()].sort(compare);
  return {expected:rows,frontier:{registrationsHash:canonicalHash(rows),appEventWatermark,slackSequence},reasons};
 }
 capture():{observations:CapturedGraphSourceObservation[];checkpoint:CapturedGraphSourceSweepCheckpoint;inventoryHash:string} {
  const o=this.options,m=o.membership(),local=o.identity.loadIdentity();
  if(!verifyMembershipEpoch(m,o.ownerPublicKey)||m.agentId!==o.agentId||!m.members.some(member=>member.machineId===local.machineId&&member.signingPublicKey===o.identity.getSigningPublicKeyPem(local.machineId)))throw new Error('source-sweep-producer-untrusted');
  const startedAt=new Date(o.now?.()??Date.now()).toISOString(),before=this.registrations(),reasons=new Set(before.reasons),observations=new Map<string,{observation:CapturedGraphSourceObservation;page:number}>();
  const pages:GraphSourceSweepPage[]=[];let cursor:string|null=null;
  for(let index=0;index<GRAPH_SOURCE_SWEEP_MAX_PAGES;index++){
   let page:ReturnType<ConversationGraphSourceInventoryCapture['capturePage']>;
   try{page=this.rows.capturePage(100,cursor);}catch{/* @silent-fallback-ok: signed sweep explicitly records capture-failed, ends scan, and cannot grant complete coverage. */reasons.add('capture-failed');break;}
   if(page.partial)reasons.add('capture-failed');
   for(const observation of page.observations){const key=nodeKey(observation.capture.subject);if(observations.has(key))continue;
    if(observations.size>=GRAPH_SOURCE_SWEEP_MAX_ROWS){reasons.add('capacity');break;}observations.set(key,{observation,page:index});}
   pages.push({index,afterHash:canonicalHash(cursor),nextHash:canonicalHash(page.nextCursor),observationsHash:'',observedCount:0});
   if(!page.nextCursor){cursor=null;break;}if(page.nextCursor===cursor){reasons.add('page-gap');break;}cursor=page.nextCursor;
   if(observations.size>=GRAPH_SOURCE_SWEEP_MAX_ROWS){reasons.add('capacity');break;}
  }
  if(cursor)reasons.add('capacity');if(pages.length===0)pages.push({index:0,afterHash:canonicalHash(null),nextHash:canonicalHash(null),observationsHash:'',observedCount:0});
  const after=this.registrations();for(const reason of after.reasons)reasons.add(reason);
  if(before.frontier.registrationsHash!==after.frontier.registrationsHash||before.frontier.appEventWatermark!==after.frontier.appEventWatermark||before.frontier.slackSequence!==after.frontier.slackSequence)reasons.add('registration-changed');
  const entries:GraphSourceSweepEntry[]=after.expected.map(expected=>{
   const observed=observations.get(nodeKey(expected.ref));
   if(expected.state==='live'&&observed)return {ref:expected.ref,state:'observed',sourceId:observed.observation.capture.sourceId,payloadHash:observed.observation.capture.payloadHash,page:observed.page};
   const reason=expected.state==='deleted'?'deleted':expected.state==='forgotten'?'forgotten':'unavailable';if(reason==='unavailable')reasons.add('source-unavailable');
   return {ref:expected.ref,state:'source-removed',reason};
  });
  for(const [key]of observations)if(!after.expected.some(expected=>nodeKey(expected.ref)===key))reasons.add('registration-changed');
  for(const page of pages){page.observationsHash=sourceSweepPageHash(entries,page.index);page.observedCount=entries.filter(e=>e.state==='observed'&&e.page===page.index).length;}
  const sourceId=crypto.randomUUID(),payload:GraphSourceSweepPayload={v:1,sourceId,scanId:crypto.randomUUID(),producerMachineId:local.machineId,startedAt,completedAt:new Date(o.now?.()??Date.now()).toISOString(),
   status:reasons.size?'partial':'complete',partialReasons:[...reasons].sort(),expected:after.expected,entries,pages,before:before.frontier,after:after.frontier};
  const capture=signGraphSourceSweep(payload,o.agentId,m,o.identity.loadSigningKey()),bytes=Buffer.from(JSON.stringify(payload));
  try{return {observations:[...observations.values()].map(row=>row.observation),checkpoint:{capture,encryptedPayload:sealGraphBundle(bytes,m.members,{agentId:o.agentId,eventId:sourceSweepEventId(sourceId)})},inventoryHash:canonicalHash({membershipHash:canonicalHash(m),status:payload.status,partialReasons:payload.partialReasons,expected:payload.expected,entries:payload.entries})};}finally{bytes.fill(0);}
 }
}
