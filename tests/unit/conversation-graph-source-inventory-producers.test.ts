/** One conversation, several producers (conversation-effort-hierarchy-v3 §7.2).
 * An app conversation replicates to every machine and every machine with a
 * Telegram adapter lists the same topics, so certified inventory holds the same
 * global ref from several producers. It must read as ONE available conversation
 * whose display row every machine picks the same way. Slack ids are
 * machine-local aliases: different machines' Slack rows never merge, and the
 * same Slack ref from two machines stays withheld. The record verifier is a
 * stand-in here; the payload, core and hash checks are the production ones. */
import {describe,expect,it,vi} from 'vitest';
import type {GraphSourceInventoryCoverage} from '../../src/core/ConversationGraphSourceCoverage.js';

// Producer checkpoints are exercised for real in the integration suite; here
// one case substitutes a coverage result naming which producer lost a ref.
const coverageOverride=vi.hoisted(()=>({value:null as null|((actual:GraphSourceInventoryCoverage)=>GraphSourceInventoryCoverage)}));
vi.mock('../../src/core/ConversationGraphSourceCoverage.js',async importOriginal=>{
 const actual=await importOriginal<typeof import('../../src/core/ConversationGraphSourceCoverage.js')>();
 return {...actual,reconcileGraphSourceCoverage:(options:Parameters<typeof actual.reconcileGraphSourceCoverage>[0])=>{
  const result=actual.reconcileGraphSourceCoverage(options);return coverageOverride.value?coverageOverride.value(result):result;}};
});
import crypto from 'node:crypto';
import {materializeGraphSourceInventory,sourceObservationEventId,type GraphSourceFlatRow,type SignedGraphSourceObservation} from '../../src/core/ConversationGraphSourceInventory.js';
import {canonicalHash,canonicalJson} from '../../src/core/GraphWitnessTypes.js';
import {nodeKey,type ConversationRef} from '../../src/core/conversationGraph.js';
import type {ConversationGraphReplication,ConversationGraphReplicationRecord} from '../../src/core/ConversationGraphReplication.js';
import type {ReplicatedStoreReader} from '../../src/core/ReplicatedStoreReader.js';
import type {DroppedOriginRegistry} from '../../src/core/RollbackUnmerge.js';

const APP:ConversationRef={kind:'conversation',platform:'app',conversationKey:'7a1c8a3e-1b2c-4d5e-9f90-1234567890ab'};
const TOPIC:ConversationRef={kind:'conversation',platform:'telegram',chatId:'-100123',topicId:42};
let sequence=0;
function observed(producer:string,ref:ConversationRef,row:GraphSourceFlatRow):{record:ConversationGraphReplicationRecord;body:Buffer} {
 const sourceId=crypto.randomUUID(),producerSequence=1;
 const payload={v:1 as const,salt:crypto.randomBytes(32).toString('hex'),sourceId,subject:ref,producerMachineId:producer,producerSequence,row};
 const payloadHash=canonicalHash({domain:'graph-source-observation-payload-v1',payload});
 const capture:SignedGraphSourceObservation={version:1,kind:'conversation-source-observation',agentId:'echo',sourceId,subject:ref,producerMachineId:producer,producerSequence,
  membershipEpoch:1,membershipHash:'0'.repeat(64),capturedAt:'2026-11-09T10:00:00.000Z',payloadHash,signature:'test'};
 const core={schemaVersion:1,op:'observe-conversation-source',eventId:sourceObservationEventId(sourceId),subject:ref,authority:'source',principal:'server-source-observer',
  receipt:{kind:'source-observation-record',id:sourceId},machineId:'writer',createdAt:capture.capturedAt,payloadHash};
 const record={coreType:'source-observation',core,packet:{sourceSequence:++sequence,eventId:core.eventId},authorizationProof:{sourceObservation:capture},encryptedSourceBundle:{sealed:true}} as unknown as ConversationGraphReplicationRecord;
 return {record,body:Buffer.from(canonicalJson({sourceObservation:capture,payload}))};
}
function inventory(rows:Array<ReturnType<typeof observed>>){
 const bodies=new Map(rows.map(r=>[r.record,r.body]));
 const source={certifiedUnion:()=>({records:rows.map(r=>r.record),partial:false,quarantined:[]}),verifyHistoricalRecord:()=>true,
  openVerifiedPayload:(record:ConversationGraphReplicationRecord)=>Buffer.from(bodies.get(record)!)} as unknown as ConversationGraphReplication;
 return materializeGraphSourceInventory({source,reader:{} as ReplicatedStoreReader,dropped:{} as DroppedOriginRegistry});
}
const app=(title:string,lastActivity:string|null):GraphSourceFlatRow=>({id:'7a1c8a3e-1b2c-4d5e-9f90-1234567890ab',platform:'app',title,lastActivity});
const topic=(title:string,lastActivity:string|null):GraphSourceFlatRow=>({id:42,platform:'telegram',title,lastActivity});

describe('source inventory with several producers of one conversation',()=>{
 it('reports a replicated app conversation as one available conversation with the newest row',()=>{
  const result=inventory([observed('machine-b',APP,app('older title','2026-11-09T09:00:00.000Z')),observed('machine-a',APP,app('newer title','2026-11-09T10:00:00.000Z'))]);
  expect(result.entries).toHaveLength(2);
  expect(result.conversations).toEqual([{ref:APP,conversationId:'7a1c8a3e-1b2c-4d5e-9f90-1234567890ab',title:'newer title',lastActivity:'2026-11-09T10:00:00.000Z'}]);
  expect(result.unavailableConversations).toEqual([]);
 });
 it('reports a Telegram topic listed by two machines as one available conversation',()=>{
  const result=inventory([observed('machine-a',TOPIC,topic('topic','2026-11-09T08:00:00.000Z')),observed('machine-b',TOPIC,topic('renamed topic','2026-11-09T08:30:00.000Z'))]);
  expect(result.conversations.map(c=>[nodeKey(c.ref),c.title])).toEqual([[nodeKey(TOPIC),'renamed topic']]);
  expect(result.unavailableConversations).toEqual([]);
 });
 it('picks the same row on every machine whatever order the records arrive in, breaking a tie by producer id',()=>{
  const rows=[observed('machine-b',APP,app('from b','2026-11-09T10:00:00.000Z')),observed('machine-a',APP,app('from a','2026-11-09T10:00:00.000Z')),observed('machine-c',APP,app('from c',null))];
  const forward=inventory(rows),reverse=inventory([...rows].reverse());
  expect(forward.conversations).toHaveLength(1);expect(forward.conversations[0].title).toBe('from a');
  expect(reverse.conversations).toEqual(forward.conversations);
 });
 it('keeps a global ref available from a machine that holds it when another machine\'s checkpoint lost it, and not otherwise',()=>{
  const lostOn=(producers:string[])=>(c:GraphSourceInventoryCoverage)=>({...c,unavailableConversations:[APP],unavailableBy:producers.map(producerMachineId=>({ref:APP,producerMachineId}))});
  const rows=[observed('machine-a',APP,app('from a','2026-11-09T10:00:00.000Z')),observed('machine-b',APP,app('from b','2026-11-09T09:00:00.000Z'))];
  try{
   coverageOverride.value=lostOn(['machine-a']);
   const held=inventory(rows);
   expect(held.conversations.map(c=>c.title)).toEqual(['from b']);expect(held.unavailableConversations).toEqual([]);
   coverageOverride.value=lostOn(['machine-a','machine-b']);
   const lost=inventory(rows);
   expect(lost.conversations).toEqual([]);expect(lost.unavailableConversations).toEqual([APP]);
  }finally{coverageOverride.value=null;}
 });
 it('keeps a ref its only producer called unavailable unavailable, with no row, even if that producer has a newer observation',()=>{
  try{
   coverageOverride.value=c=>({...c,unavailableConversations:[APP],unavailableBy:[{ref:APP,producerMachineId:'machine-a'}]});
   const result=inventory([observed('machine-a',APP,app('back again','2026-11-09T11:00:00.000Z'))]);
   expect(result.conversations).toEqual([]);expect(result.unavailableConversations).toEqual([APP]);
  }finally{coverageOverride.value=null;}
 });
 it('keeps two machines\' Slack conversations separate even when their machine-local ids collide',()=>{
  const alpha:ConversationRef={kind:'conversation',platform:'slack',channelId:'CALPHA'},beta:ConversationRef={kind:'conversation',platform:'slack',channelId:'CBETA'};
  const result=inventory([observed('machine-a',alpha,{id:-7,platform:'slack',title:'alpha',lastActivity:null,machine:'machine-a'}),
   observed('machine-b',beta,{id:-7,platform:'slack',title:'beta',lastActivity:null,machine:'machine-b'})]);
  expect(result.conversations.map(c=>[c.title,c.conversationId,c.machine]).sort()).toEqual([['alpha',-7,'machine-a'],['beta',-7,'machine-b']]);
  expect(result.unavailableConversations).toEqual([]);
 });
 it('still withholds one Slack ref reported by two machines, since each names a different holder',()=>{
  const alpha:ConversationRef={kind:'conversation',platform:'slack',channelId:'CALPHA'};
  const result=inventory([observed('machine-a',alpha,{id:-7,platform:'slack',title:'alpha',lastActivity:null,machine:'machine-a'}),
   observed('machine-b',alpha,{id:-3,platform:'slack',title:'alpha',lastActivity:null,machine:'machine-b'})]);
  expect(result.conversations).toEqual([]);expect(result.unavailableConversations).toEqual([alpha]);expect(result.partial).toBe(true);
 });
});
