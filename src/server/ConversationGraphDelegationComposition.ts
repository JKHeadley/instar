/** Real post-spawn graph delegation composition. Unknown platform/project
 * bindings fail closed; nothing here promotes a prepared source to Saved. */
import type {MachineIdentityManager} from '../core/MachineIdentity.js';
import type {WriteAdmission} from '../core/WriteAdmission.js';
import type {LeaseCoordinator} from '../core/LeaseCoordinator.js';
import type {StateManager} from '../core/StateManager.js';
import type {ConversationBindAuth} from '../core/conversationBindToken.js';
import type {ConversationRegistry} from '../core/ConversationRegistry.js';
import type {SessionOwnershipRegistry} from '../core/SessionOwnershipRegistry.js';
import type {ScopeVerifier} from '../core/ScopeVerifier.js';
import type {TelegramAdapter} from '../messaging/TelegramAdapter.js';
import {ConversationGraphDelegationRuntime} from './ConversationGraphDelegationRuntime.js';
import type {ConversationGraphReplicationRuntime} from './ConversationGraphReplicationRuntime.js';
import {buildGraphDelegationAuthorizationProof,type GraphDelegationConversationRef} from '../core/ConversationGraphDelegation.js';
import {canonicalHash,canonicalJson,graphOperationKey} from '../core/GraphWitnessTypes.js';
import {reduceGraph,validateGraphEvent,nodeKey,type GraphEvent,type NodeRef} from '../core/conversationGraph.js';
import type {ConversationGraphReplicationRecord} from '../core/ConversationGraphReplication.js';

export interface ConversationGraphDelegationCompositionOptions {runtime:ConversationGraphReplicationRuntime;agentId:string;identity:MachineIdentityManager;
 admission:WriteAdmission;coordinator:LeaseCoordinator;state:StateManager;bindAuth:ConversationBindAuth;conversations:ConversationRegistry;
 ownership:SessionOwnershipRegistry;scopeVerifier:ScopeVerifier;telegram:TelegramAdapter;telegramChatId:string;tmuxPath:string;
 dropped:import('../core/RollbackUnmerge.js').DroppedOriginRegistry;establishOwnership?:(refs:readonly GraphDelegationConversationRef[])=>void;membership:import('../core/GraphWitnessTypes.js').GraphMembershipEpoch;ownerPublicKey:string}
export function createConversationGraphDelegationContext(options:ConversationGraphDelegationCompositionOptions){
 const o=options;
 const project=(ref:GraphDelegationConversationRef)=>{if(ref.platform!=='telegram'||ref.chatId!==o.telegramChatId)throw new Error('graph-project-binding-unknown');
  const binding=o.scopeVerifier.currentTopicBindings()[String(ref.topicId)];if(!binding?.projectName)throw new Error('graph-project-binding-unknown');return binding.projectName;};
 const graph=()=>{if(!o.runtime.isReady())throw new Error('graph-certified-snapshot-unready');
  const expectedSaving=new Set(o.runtime.source.recordsForRepair()
   .filter(record=>!record.certificate&&!record.cancellationCertificate&&!record.cancellation&&!record.erasure&&o.runtime.source.verifyHistoricalRecord(record)).map(record=>record.packet.eventId));
  const union=o.runtime.source.certifiedUnion(o.runtime.reader,o.dropped,expectedSaving);if(union.partial||union.quarantined.length)throw new Error('graph-certified-snapshot-incomplete');
  const graphRecords=union.records.filter(record=>record.coreType==='graph-event');const events=graphRecords.map(record=>validateGraphEvent(record.core));if(events.some(event=>!event))throw new Error('graph-certified-core-invalid');
  const verified=new Set(graphRecords.map(record=>`${record.packet.eventId}:${record.packet.coreHash}`));
  const reduced=reduceGraph(events as GraphEvent[],{verify:event=>verified.has(`${graphOperationKey('graph-event',event.eventId)}:${canonicalHash(event)}`)});
  if(reduced.partial.eventGap||reduced.partial.evidenceMissing)throw new Error('graph-certified-reducer-incomplete');return {events:events as GraphEvent[],reduced};};
 const heads=(ref:GraphDelegationConversationRef)=>{const {events,reduced}=graph();const key=nodeKey(ref);
  if(reduced.conflicts.some(conflict=>nodeKey(conflict.subject)===key))throw new Error('graph-placement-conflicted');
  const placement=events.filter(event=>event.op==='set-primary-placement'&&nodeKey(event.subject)===key);
  const replaced=new Set(placement.flatMap(event=>event.op==='set-primary-placement'?event.replacesPlacementEventIds:[]));
  const winning=reduced.placementSource.get(key)?.eventId;
  return placement.filter(event=>!replaced.has(event.eventId)||event.eventId===winning).map(event=>({eventId:event.eventId,authority:event.authority}));};
 const scope=(ref:GraphDelegationConversationRef)=>{const {reduced}=graph();let cursor:NodeRef|null=ref;const seen=new Set<string>();
  while(cursor){const key=nodeKey(cursor);if(seen.has(key))throw new Error('graph-scope-cycle');seen.add(key);
   if(cursor.kind==='effort'){const effort=reduced.efforts.get(key);if(!effort)throw new Error('graph-effort-scope-unknown');return [...effort.projectScope];}
   cursor=reduced.parentOf.get(key)??null;}return [];};
 return {project,heads,scope};
}
export function createConversationGraphDelegationComposition(options:ConversationGraphDelegationCompositionOptions):ConversationGraphDelegationRuntime{
 const o=options;const {project,heads,scope}=createConversationGraphDelegationContext(o);
 return new ConversationGraphDelegationRuntime({tmuxPath:o.tmuxPath,establishOwnership:o.establishOwnership,verifiedHeadsFor:heads,parentProjectScope:scope,
  source:{agentId:o.agentId,identity:o.identity,admission:o.admission,coordinator:o.coordinator,state:o.state,bindAuth:o.bindAuth,conversations:o.conversations,
   telegramChatId:o.telegramChatId,conversationIdsForSession:name=>{const topic=o.telegram.getTopicForSession(name)??o.telegram.resolveTopicForSessionFromDisk(name);return topic===null?[]:[topic];},projectForConversation:project,
   ownershipForConversation:ref=>ref.platform==='telegram'&&ref.chatId===o.telegramChatId?o.ownership.read(String(ref.topicId)):null},
  onPrepared:prepared=>o.runtime.withSourceMutation(async token=>{
   // Repeated successful spawn/replay must recognize the original certified
   // event before comparing its now-current head against its old base heads.
   const accepted=o.runtime.source.recordsForRepair().find(record=>record.coreType==='graph-event'&&record.packet.eventId===graphOperationKey('graph-event',prepared.core.eventId));
   if(accepted?.certificate&&o.runtime.source.verifyHistoricalRecord(accepted)&&canonicalHash(accepted.core)===canonicalHash(prepared.core)&&canonicalHash(accepted.authorizationProof.dispatchSource)===canonicalHash(prepared.source))return;
   const current=heads(prepared.source.workerRef);if(canonicalHash(current.map(head=>head.eventId).sort())!==canonicalHash([...prepared.core.replacesPlacementEventIds].sort())
    ||project(prepared.source.parentRef)!==prepared.source.parentProjectId||project(prepared.source.workerRef)!==prepared.source.workerProjectId)throw new Error('graph-prepared-observation-changed');
   const workerProject=project(prepared.source.workerRef);const parentScope=scope(prepared.source.parentRef);if(parentScope.length&&!parentScope.includes(workerProject))throw new Error('graph-prepared-scope-changed');
   const actuation=o.runtime.actuation();const authorizationProof=buildGraphDelegationAuthorizationProof(prepared,{identity:o.identity,membership:o.runtime.installedMembership,...actuation,ownerPublicKey:o.ownerPublicKey,acceptedAt:new Date().toISOString()});
   const source=Buffer.from(canonicalJson(prepared.source));try{await o.runtime.submitPrepared({coreType:'graph-event',idempotencyKey:authorizationProof.receipt.idempotencyKey,
    requestHash:canonicalHash({core:prepared.core,source:prepared.source}),core:prepared.core as unknown as Record<string,unknown>,authorizationProof,plaintextSource:source},token);}finally{source.fill(0);}
  })});
}
