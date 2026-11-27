/** The phone tree (work-front-doors stage 2 "Mobile hierarchy routes"; hierarchy v3 §7.4) through the production
 * device-auth middleware, the owner viewer resolver and the graph router: owner phone only, a member phone, the
 * bearer token and a forged or revoked signature are refused before the inventory is read. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import {afterEach,describe,it,expect} from 'vitest';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {MobileDeviceKeyLedger} from '../../src/core/MobileDeviceKeyLedger.js';
import {loadMachineSigner,identityKeyLookup} from '../../src/core/AppRecordSignatures.js';
import {MobilePairingService,deviceAuthenticator} from '../../src/server/mobilePairingRoutes.js';
import {authMiddleware} from '../../src/server/middleware.js';
import {createConversationGraphViewerResolver} from '../../src/server/conversationGraphViewer.js';
import {createConversationGraphRouter} from '../../src/server/conversationGraphRoutes.js';
import {ConversationGraphReadModel} from '../../src/core/conversationGraphRead.js';
import type {GraphEvent} from '../../src/core/conversationGraph.js';
import {canonicalString} from '../../src/core/MobileDeviceKeys.js';
import {makeDevice} from '../helpers/mobileDevice.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
const HOST='graph-auth.example.dev',ROUTE='/mobile/conversation-graph/tree';
const EFFORT={kind:'effort' as const,id:'012fdaec-70de-4324-9ef3-22b616fc83ce'};
const FRONT={kind:'conversation' as const,platform:'telegram' as const,chatId:'-100123',topicId:42};
const WORKER={kind:'conversation' as const,platform:'telegram' as const,chatId:'-100123',topicId:43};
const ev=(n:number,extra:Record<string,unknown>):GraphEvent=>({schemaVersion:1,eventId:`evt-tree-${n}`,authority:'owner',principal:'owner',
 receipt:{kind:'owner-proof',id:`r${n}`},machineId:'m1',createdAt:`2026-11-05T10:0${n}:00.000Z`,...extra} as GraphEvent);
const placeFront=ev(2,{subject:FRONT,op:'set-primary-placement',parent:EFFORT,relation:'coordinates',replacesPlacementEventIds:[]});
const EVENTS=[ev(1,{subject:EFFORT,op:'create-effort',projectScope:[],headerId:'hdr-012fdaec70de43249ef322b616fc83ce'}),placeFront,
 ev(3,{subject:EFFORT,op:'set-front-door',frontDoor:FRONT,replacesFrontDoorEventIds:[],observedPlacementEventIds:[placeFront.eventId]}),
 ev(4,{subject:WORKER,op:'set-primary-placement',parent:EFFORT,relation:'coordinates',replacesPlacementEventIds:[]})];
async function boot(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'graph-tree-auth-'));
 cleanup.push(()=>SafeFsExecutor.safeRmSync(directory,{recursive:true,force:true,operation:'graph-tree-auth-test:cleanup'}));
 const config={projectName:'echo',stateDir:directory,projectDir:directory,port:0,authToken:'test-bearer',developmentAgent:true,
  sessions:{},scheduler:{},threadline:{ownerName:'Owner'},users:[{id:'support',name:'Support',permissions:['user']}],mobilePairing:{multiRoute:{enabled:false}}};
 await new MachineIdentityManager(directory).generateIdentity({name:'graph owner device fixture'});
 const pairing=new MobilePairingService({config:config as never,stateDir:directory,holdsLease:()=>true});cleanup.push(()=>pairing.stop());
 pairing.nativeOn=true;pairing.keyLedger=new MobileDeviceKeyLedger({stateDir:directory,signer:loadMachineSigner(directory)!,keyLookup:identityKeyLookup(directory)});
 let ready=true,reads=0;
 const model=new ConversationGraphReadModel({readiness:()=>ready?{ready:true}:{ready:false,reason:'a-proof-missing'},certifiedEvents:()=>EVENTS,verify:()=>true,
  conversations:()=>{reads++;return[{ref:FRONT,conversationId:42,title:'Owner private title',lastActivity:'2026-11-05T09:00:00.000Z'},{ref:WORKER,conversationId:43,title:'Worker chat',lastActivity:'2026-11-05T09:01:00.000Z'}];},
  effortTitle:()=>'Shop launch group',replication:()=>({replicaLag:false,eventGap:false,evidenceMissing:false}),now:()=>new Date()});
 const app=express();app.use(express.json());app.use(authMiddleware(()=>config.authToken,'echo',undefined,deviceAuthenticator(pairing)));
 app.use(createConversationGraphRouter({model,resolveViewer:createConversationGraphViewerResolver({agentId:'echo',pairing,
  verifyDashboardOwner:proof=>proof==='test-owner-proof'}),projects:()=>[{ref:FRONT,title:'Shop launch',conversationKey:'telegram:42'}]}));
 const phone=(msp=false)=>{const dev=makeDevice();const c=pairing.devices.createPending({deviceName:'Test phone',label:null,publicKey:dev.publicKey,host:HOST,
  ...(msp?{userId:'support',role:'msp' as const}:{})});if(!c.ok)throw new Error('test-pairing-failed');pairing.devices.applyConfirm(c.device.id,{ok:true});return{...dev,id:c.device.id};};
 let tick=0;
 const signed=(dev:ReturnType<typeof phone>,route=ROUTE,bad=false)=>{const time=String(Date.now()+tick++);const signature=dev.sign(canonicalString(dev.id,HOST,'GET',route,time,undefined));
  return request(app).get(route).set('X-Instar-Device',dev.id).set('X-Instar-Device-Time',time).set('X-Instar-Device-Sig',bad?'bad':signature);};
 return{app,pairing,phone,signed,reads:()=>reads,ready:(value:boolean)=>{ready=value;}};
}
describe('the phone tree through real device request authority',()=>{
 it('serves the signed owner phone the nested tree with its front door and Project label',async()=>{
  const e=await boot();const response=await e.signed(e.phone());
  expect(response.status).toBe(200);expect(response.headers['cache-control']).toBe('no-store');
  expect(response.body.projects).toBe('known');
  const [launch]=response.body.items;
  expect(launch).toMatchObject({ref:EFFORT,title:'Shop launch group',kind:'effort',frontDoor:FRONT,visibleChildCount:2,childrenComplete:true,
   project:{title:'Shop launch',conversationKey:'telegram:42'}});
  expect(launch.children.map((c:{role:string;source:{conversationId:number}})=>[c.role,c.source.conversationId])).toEqual([['worker',43],['front-door',42]]);
 });
 it('refuses bearer, member and forged requests before reading the inventory',async()=>{
  const e=await boot();const owner=e.phone(),member=e.phone(true);
  expect((await request(e.app).get(ROUTE).set('Authorization','Bearer test-bearer').set('X-Instar-AgentId','echo')).status).toBe(403);
  const denied=await e.signed(member);expect(denied.status).toBe(403);expect(denied.body).toEqual({code:'hierarchy-owner-only'});
  expect(JSON.stringify(denied.body)).not.toContain('Shop launch');
  expect((await e.signed(owner,ROUTE,true)).status).toBe(401);
  expect(e.reads()).toBe(0);
 });
 it('refuses a revoked phone and answers 503 until the graph is ready',async()=>{
  const e=await boot();const owner=e.phone();e.ready(false);
  const off=await e.signed(owner);expect(off.status).toBe(503);expect(off.body.code).toBe('conversation-graph-off');expect(e.reads()).toBe(0);
  e.pairing.devices.revoke(owner.id);expect((await e.signed(owner)).status).toBe(401);
 });
 it('serves the same tree to an authenticated dashboard owner and refuses bearer only',async()=>{
  const e=await boot();
  const r=await request(e.app).get('/conversation-graph/tree').set('Authorization','Bearer test-bearer').set('X-Instar-AgentId','echo').set('X-Instar-Operator-Session','test-owner-proof');
  expect(r.status).toBe(200);
  expect(r.headers['cache-control']).toBe('no-store');
  const mobile = await e.signed(e.phone());
  expect(r.body.items).toEqual(mobile.body.items);
  expect(r.body.projects).toBe(mobile.body.projects);
  const denied = await request(e.app).get('/conversation-graph/tree')
    .set('Authorization','Bearer test-bearer').set('X-Instar-AgentId','echo');
  expect(denied.status).toBe(403);
 });
});
