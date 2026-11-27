/**
 * Chief of Staff tree import through the REAL two-member graph runtime (work-front-doors §3.1, §7 stage 2):
 * actual source inventory, owner events through the witnessed all-member commit path, the importer's signed
 * `cos-tree-import` receipt verified and persisted by BOTH machines, then idempotent re-runs, the owner's
 * correction winning, and the gate keeping everything shut until every member advertises the build.
 */
import crypto from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {ConversationRegistry} from '../../src/core/ConversationRegistry.js';
import {AppConversationService} from '../../src/core/AppConversationService.js';
import {MobileChatRequestStore} from '../../src/core/MobileChatRequests.js';
import {ConversationGraphSourceInventoryRuntime} from '../../src/server/ConversationGraphSourceInventoryRuntime.js';
import {ConversationGraphCosTreeImporter} from '../../src/server/ConversationGraphCosTreeImporter.js';
import type {ConversationGraphReplicationRuntime} from '../../src/server/ConversationGraphReplicationRuntime.js';
import {signGraphAuthorizationReceipt} from '../../src/core/ConversationGraphReplicationProof.js';
import {canonicalHash,graphOperationKey} from '../../src/core/GraphWitnessTypes.js';
import {reduceGraph,validateGraphEvent,nodeKey,type ConversationRef,type EffortRef,type GraphEvent} from '../../src/core/conversationGraph.js';
import {newHeaderId} from '../../src/core/EffortHeaderStore.js';
import {verifyGraphAuthorization} from '../../src/core/ConversationGraphReplicationProof.js';
import type {CosTreeRecordInput} from '../../src/core/ConversationGraphCosTreeImport.js';
import type {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {setupGraphRuntimeFixture as setup} from '../helpers/conversation-graph-runtime.js';
vi.setConfig({testTimeout:180_000});

const tg=(topicId:number):ConversationRef=>({kind:'conversation',platform:'telegram',chatId:'-1001',topicId});
const rec=(key:string,parent:string|null,physical=1_700_000_000_000):CosTreeRecordInput=>({conversationKey:key,parentConversationKey:parent,hlc:{physical,logical:0,node:'mac-a'},origin:'mac-a'});

function reduced(rt:ConversationGraphReplicationRuntime){
 const union=rt.projection();const events=union.records.filter(r=>r.coreType==='graph-event').map(r=>validateGraphEvent(r.core)).filter((e):e is GraphEvent=>!!e);
 const byId=new Map(union.records.map(r=>[r.packet.eventId,r]));
 return reduceGraph(events,{verify:e=>{const r=byId.get(graphOperationKey('graph-event',e.eventId));return !!r&&rt.source.verifyHistoricalRecord(r);}});
}
/** An owner event through the same signed receipt and submit path ConversationGraphOwnerChanges uses. */
async function owner(rt:ConversationGraphReplicationRuntime,identity:MachineIdentityManager,partial:Record<string,unknown>){
 const eventId='change-'+crypto.randomUUID(),createdAt=new Date().toISOString(),receiptId='owner-'+crypto.randomUUID();
 const core={schemaVersion:1,eventId,authority:'owner',principal:'owner',receipt:{kind:'owner-proof',id:receiptId},machineId:rt.machineId,createdAt,...partial};
 expect(validateGraphEvent(core)).not.toBeNull();
 const actuation=rt.actuation(),membership=rt.installedMembership,key=`owner-test:${eventId}`;
 const receipt=signGraphAuthorizationReceipt({v:1,agentId:membership.agentId,eventId:graphOperationKey('graph-event',eventId),coreHash:canonicalHash(core),actorPrincipal:'owner',
  authenticationMethod:'owner-dashboard',receiptId,membershipEpoch:membership.epoch,leaseEpoch:actuation.lease.leaseEpoch,idempotencyKey:key,writerId:rt.machineId,
  fencedLeaseHash:canonicalHash(actuation.originalLease),acceptedAt:createdAt},identity.loadSigningKey());
 const outcome=await rt.withSourceMutation(token=>rt.submitPrepared({coreType:'graph-event',idempotencyKey:key,requestHash:canonicalHash(core),core,
  authorizationProof:{receipt,membership,lease:actuation.lease,originalLease:actuation.originalLease},plaintextSource:Buffer.from(JSON.stringify({kind:'graph-owner-change',requestId:eventId}))},token));
 expect(outcome.state).toBe('committed');
 return eventId;
}

describe('Chief of Staff tree import on the real two-member graph runtime',()=>{
 it('imports once, verifies and persists on both machines, is idempotent, yields to the owner, and stays shut behind the gate',async()=>{
  const {runtime,peer,managers}=await setup();
  expect(await runtime.refreshReadiness()).toBe(true);expect(await peer.refreshReadiness()).toBe(true);
  // The conversations exist in the certified source inventory (the actual producer).
  const identity=managers[0];const registry=new ConversationRegistry({stateDir:identity.baseDir,machineId:()=>runtime.machineId});
  const service=new AppConversationService({stateDir:identity.baseDir,machineId:()=>runtime.machineId,registry,requests:new MobileChatRequestStore(identity.baseDir),holdsLease:()=>true,ownerName:()=>'Owner',dispatch:()=>null});
  const lastActivity=new Date().toISOString();
  const flatDeps={config:{stateDir:identity.baseDir} as never,pairing:null as never,service,machineId:()=>runtime.machineId,
   telegramTopics:()=>[42,43,45,46,47,48].map(topicId=>({topicId,topicName:`topic ${topicId}`,lastActivity}))};
  const worker=new ConversationGraphSourceInventoryRuntime({flatDeps,conversations:registry,runtime,identity,membership:()=>runtime.installedMembership,ownerPublicKey:runtime.ownerPublicKey,telegramChatId:'-1001'});
  try{
   const status=await worker.tick();expect(status.failed).toBe(0);
   expect(runtime.inventory().conversations.length).toBe(6);
   // The owner accepted "telegram:42" as a project: an effort with 42 as its certified front door.
   const project:EffortRef={kind:'effort',id:crypto.randomUUID()};
   await owner(runtime,identity,{op:'create-effort',subject:project,projectScope:[],headerId:newHeaderId()});
   const placed42=await owner(runtime,identity,{op:'set-primary-placement',subject:tg(42),parent:project,relation:'coordinates',replacesPlacementEventIds:[]});
   await owner(runtime,identity,{op:'set-front-door',subject:project,frontDoor:tg(42),replacesFrontDoorEventIds:[],observedPlacementEventIds:[placed42]});
   // The owner already filed 45 at the root (a removal-shaped first placement): an import must never move it.
   const owner45=await owner(runtime,identity,{op:'set-primary-placement',subject:tg(45),parent:null,relation:null,replacesPlacementEventIds:[]});
   expect(reduced(runtime).frontDoorOf.get(nodeKey(project))).toEqual(tg(42));
   // The CoS tree: 43 and 45 under the project, 46 under a project the owner never accepted, 47 was unparented (tombstoned: absent).
   const tree=[rec('telegram:43','telegram:42'),rec('telegram:45','telegram:42'),rec('telegram:46','telegram:99'),rec('telegram:48','telegram:42')];
   // An owner change to 48 saved locally (not yet committed): an import must not land first and make it stale.
   const queued=await runtime.recordLocalOwnerIntent({idempotencyKey:'owner-queued-48',requestId:'owner-queued-48',principalKey:'owner',grantVersion:'grant-1',
    admission:{kind:'owner-dashboard',grantId:'grant-1'},surface:'dashboard',change:{kind:'set-primary-placement',subject:tg(48),parent:null,replacesPlacementEventIds:[]}},()=>true);
   expect(queued.state).toBe('recorded-local');
   let advertised=false;
   const importer=new ConversationGraphCosTreeImporter({runtime:()=>runtime,identity:()=>identity,tree:()=>tree,enabled:()=>true,
    advertises:m=>m===peer.machineId?advertised:null,telegramChatId:()=>'-1001',rootConversation:()=>null});

   // Gate: the peer has not advertised the build -> nothing is written.
   const before=runtime.source.recordsForRepair().length;
   const gated=await importer.runOnce();
   expect(gated).toEqual({state:'gated',gate:{open:false,reason:'waiting-for-machines',waitingOn:[peer.machineId]}});
   const off=await new ConversationGraphCosTreeImporter({runtime:()=>runtime,identity:()=>identity,tree:()=>tree,enabled:()=>false,advertises:()=>true,telegramChatId:()=>'-1001',rootConversation:()=>null}).runOnce();
   expect(off).toEqual({state:'off'});
   expect(runtime.source.recordsForRepair().length).toBe(before);

   // Every member advertises it: exactly one import, committed through the witnessed all-member path.
   advertised=true;
   const ran=await importer.runOnce();
   expect(ran.state).toBe('ran');if(ran.state!=='ran')throw new Error('not ran');
   expect(ran.imported).toHaveLength(1);expect(ran.imported[0]).toMatchObject({conversationKey:'telegram:43',outcome:'committed'});
   expect(ran.skipped).toMatchObject({'already-placed':1,'project-not-accepted':1,'change-pending':1});
   const importId=ran.imported[0].eventId;
   for(const rt of [runtime,peer]){
    expect(rt.source.status(graphOperationKey('graph-event',importId)).state).toBe('committed');
    const g=reduced(rt);
    expect(g.parentOf.get(nodeKey(tg(43)))).toEqual(project);
    expect(g.placementSource.get(nodeKey(tg(43)))).toMatchObject({authority:'import',eventId:importId});
    expect(g.parentOf.get(nodeKey(tg(45)))).toBeNull();expect(g.placementHeads.get(nodeKey(tg(45)))).toEqual([owner45]);
    expect(g.parentOf.has(nodeKey(tg(46)))).toBe(false);
    expect(g.parentOf.has(nodeKey(tg(48)))).toBe(false);
   }
   // The stored record carries the tree record it came from and verifies with the real receive-side verifier.
   const stored=peer.source.repairRecord(graphOperationKey('graph-event',importId))!;
   expect(stored.authorizationProof.receipt.authenticationMethod).toBe('cos-tree-import');
   expect(stored.authorizationProof.importSource).toMatchObject({childKey:'telegram:43',parentKey:'telegram:42',effort:project,treeOrigin:'mac-a'});
   expect(verifyGraphAuthorization(stored.packet,stored.core,stored.authorizationProof,crypto.createPublicKey(runtime.ownerPublicKey),runtime.machineId)).toEqual({ok:true});
   // A copy whose carried source no longer matches is refused by the real store (never authoritative).
   const forged=structuredClone(stored);forged.authorizationProof.importSource={...forged.authorizationProof.importSource!,childKey:'telegram:46',child:tg(46)};
   expect(verifyGraphAuthorization(forged.packet,forged.core,forged.authorizationProof,crypto.createPublicKey(runtime.ownerPublicKey),runtime.machineId).ok).toBe(false);

   // Idempotent: a re-run writes nothing.
   const count=runtime.source.recordsForRepair().length;
   const again=await importer.runOnce();
   expect(again.state==='ran'&&again.imported).toEqual([]);
   expect(runtime.source.recordsForRepair().length).toBe(count);

   // The owner's correction wins and is never undone by a later run.
   const removed=await owner(runtime,identity,{op:'set-primary-placement',subject:tg(43),parent:null,relation:null,replacesPlacementEventIds:[importId]});
   const after=await importer.runOnce();
   expect(after.state==='ran'&&after.imported).toEqual([]);
   for(const rt of [runtime,peer]){const g=reduced(rt);expect(g.parentOf.get(nodeKey(tg(43)))).toBeNull();expect(g.placementHeads.get(nodeKey(tg(43)))).toEqual([removed]);}
  }finally{await worker.close();await registry.close();}
 });
});
