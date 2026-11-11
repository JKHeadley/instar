/** Certified producer checkpoint reconciliation. A signed scan is insufficient:
 * its checkpoint and every referenced row must survive all-member certification,
 * local cryptographic reconstruction and current erasure fences. */
import {canonicalHash,type GraphMembershipEpoch} from './GraphWitnessTypes.js';
import {nodeKey,type ConversationRef} from './conversationGraph.js';
import {GRAPH_SOURCE_SWEEP_STALE_MS,validateGraphSourceSweepCore,validateGraphSourceSweepPayload,validateGraphSourceSweepPlaintext,type GraphSourceSweepPayload} from './ConversationGraphSourceSweep.js';
import type {ConversationGraphReplication,ConversationGraphReplicationRecord} from './ConversationGraphReplication.js';
import type {ReplicatedStoreReader} from './ReplicatedStoreReader.js';
import type {DroppedOriginRegistry} from './RollbackUnmerge.js';
export interface GraphSourceInventoryCoverage {
 asOf:string|null;producerAsOf:Record<string,string>;staleProducerIds:string[];membershipHash:string|null;missingProducerIds:string[];partialProducerIds:string[];missingObservationIds:string[];
 checkpointEventIds:string[];unavailableConversations:ConversationRef[];
 /** Which producer's checkpoint made each ref unavailable. A global ref (app,
  * Telegram) that another producer still holds stays available (inventory). */
 unavailableBy:Array<{ref:ConversationRef;producerMachineId:string}>;
 /** Suppression comes only from a certified later producer checkpoint. */
 removed:Array<{ref:ConversationRef;producerMachineId:string;sourceSequence:number;reason:'deleted'|'forgotten'|'unavailable'}>;
}
export function reconcileGraphSourceCoverage(options:{source:ConversationGraphReplication;reader:ReplicatedStoreReader;dropped:DroppedOriginRegistry;membership?:GraphMembershipEpoch;now?:()=>number}):GraphSourceInventoryCoverage {
 const union=options.source.certifiedUnion(options.reader,options.dropped),rows=new Map<string,ConversationGraphReplicationRecord>();
 const latest=new Map<string,ConversationGraphReplicationRecord>();
 for(const r of union.records){if(r.coreType!=='source-observation')continue;const capture=r.authorizationProof.sourceObservation;
  if(capture?.kind==='conversation-source-observation')rows.set(capture.sourceId,r);
  else if(capture?.kind==='source-inventory-sweep'&&validateGraphSourceSweepCore(r.core)){
   const prior=latest.get(capture.producerMachineId);if(!prior||prior.packet.sourceSequence<r.packet.sourceSequence)latest.set(capture.producerMachineId,r);
  }
 }
 const now=options.now?.()??Date.now();
 const result:GraphSourceInventoryCoverage={asOf:null,producerAsOf:{},staleProducerIds:[],membershipHash:options.membership?canonicalHash(options.membership):null,missingProducerIds:[],partialProducerIds:[],missingObservationIds:[],checkpointEventIds:[],unavailableConversations:[],unavailableBy:[],removed:[]};
 const unavailable=new Map<string,ConversationRef>();
 for(const member of options.membership?.members??[])if(!latest.has(member.machineId))result.missingProducerIds.push(member.machineId);
 for(const [producer,r]of latest){const c=r.authorizationProof.sourceObservation;if(c?.kind!=='source-inventory-sweep')continue;
  let payload:GraphSourceSweepPayload|null=null;
  try{if(r.erasure||!options.source.verifyHistoricalRecord(r))throw new Error('checkpoint-unavailable');const bytes=options.source.openVerifiedPayload(r);
   try{const body=JSON.parse(bytes.toString('utf8'));if(validateGraphSourceSweepPlaintext(body,c))payload=validateGraphSourceSweepPayload(body.payload);}finally{bytes.fill(0);}
  }catch{/* An unreadable later checkpoint suppresses an older completeness claim. */}
  if(!payload){result.partialProducerIds.push(producer);continue;}
  result.producerAsOf[producer]=payload.completedAt;
  // Three missed hourly heartbeats. This bounds coverage freshness,
  // never retention or deletion: stale rows remain historical readable memory.
  if(options.membership?.members.some(m=>m.machineId===producer)&&(now-Date.parse(payload.completedAt)>GRAPH_SOURCE_SWEEP_STALE_MS||Date.parse(payload.completedAt)>now+5000))result.staleProducerIds.push(producer);
  result.checkpointEventIds.push(r.packet.eventId);if(payload.status!=='complete'||union.partial||union.quarantined.length)result.partialProducerIds.push(producer);
  // Current enrollment must attest its own current registration frontier. A
  // historical checkpoint remains memory, not coverage for a changed roster.
  if(options.membership?.members.some(m=>m.machineId===producer)&&c.membershipHash!==canonicalHash(options.membership))result.partialProducerIds.push(producer);
  for(const row of rows.values()){const observed=row.authorizationProof.sourceObservation;if(observed?.kind==='conversation-source-observation'&&observed.producerMachineId===producer&&row.packet.sourceSequence>r.packet.sourceSequence)result.partialProducerIds.push(producer);}
  for(const e of payload.entries){if(e.state==='source-removed'){
    result.removed.push({ref:e.ref,producerMachineId:producer,sourceSequence:r.packet.sourceSequence,reason:e.reason});
    if(e.reason==='unavailable'){unavailable.set(nodeKey(e.ref),e.ref);result.unavailableBy.push({ref:e.ref,producerMachineId:producer});}continue;
   }
   const row=rows.get(e.sourceId),capture=row?.authorizationProof.sourceObservation;
   let valid=!!row&&capture?.kind==='conversation-source-observation'&&capture.producerMachineId===producer&&capture.payloadHash===e.payloadHash&&nodeKey(capture.subject)===nodeKey(e.ref)
    &&row.packet.sourceSequence<r.packet.sourceSequence&&!row.erasure&&options.source.verifyHistoricalRecord(row);
   if(valid&&row)try{const bytes=options.source.openVerifiedPayload(row);bytes.fill(0);}catch{valid=false;}
   if(!valid){result.missingObservationIds.push(e.sourceId);result.partialProducerIds.push(producer);unavailable.set(nodeKey(e.ref),e.ref);result.unavailableBy.push({ref:e.ref,producerMachineId:producer});}
  }
 }
 result.unavailableConversations=[...unavailable.values()].sort((a,b)=>nodeKey(a)<nodeKey(b)?-1:1);
 const requiredTimes=(options.membership?.members??[]).map(m=>result.producerAsOf[m.machineId]).filter((x):x is string=>!!x);
 result.asOf=requiredTimes.length===options.membership?.members.length?requiredTimes.sort()[0]??null:null;
 for(const key of ['staleProducerIds','missingProducerIds','partialProducerIds','missingObservationIds','checkpointEventIds'] as const)result[key]=[...new Set(result[key])].sort();
 return result;
}
