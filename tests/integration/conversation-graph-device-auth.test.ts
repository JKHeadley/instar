/** Production device-auth middleware + hierarchy resolver/router. Inventory is
 * sample data; this verifies request authority, not increment-A certification. */
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
import {canonicalString} from '../../src/core/MobileDeviceKeys.js';
import {makeDevice} from '../helpers/mobileDevice.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const cleanup:Array<()=>void>=[];
afterEach(()=>{for(const f of cleanup.splice(0).reverse())f();});
const HOST='graph-auth.example.dev',ROUTE='/mobile/conversation-graph/roots?view=all';
async function boot(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'graph-device-auth-'));
 cleanup.push(()=>SafeFsExecutor.safeRmSync(directory,{recursive:true,force:true,operation:'graph-device-auth-test:cleanup'}));
 const config={projectName:'echo',stateDir:directory,projectDir:directory,port:0,authToken:'test-bearer',developmentAgent:true,
  sessions:{},scheduler:{},threadline:{ownerName:'Owner'},users:[{id:'support',name:'Support',permissions:['user']}],mobilePairing:{multiRoute:{enabled:false}}};
 await new MachineIdentityManager(directory).generateIdentity({name:'graph owner device fixture'});
 const pairing=new MobilePairingService({config:config as never,stateDir:directory,holdsLease:()=>true});cleanup.push(()=>pairing.stop());
 pairing.nativeOn=true;pairing.keyLedger=new MobileDeviceKeyLedger({stateDir:directory,signer:loadMachineSigner(directory)!,keyLookup:identityKeyLookup(directory)});
 let ready=true,reads=0;
 const model=new ConversationGraphReadModel({readiness:()=>ready?{ready:true}:{ready:false,reason:'a-proof-missing'},certifiedEvents:()=>[],verify:()=>false,
  conversations:()=>{reads++;return[{ref:{kind:'conversation',platform:'telegram',chatId:'-100123',topicId:42},conversationId:42,title:'Owner private title',lastActivity:null}];},
  effortTitle:()=>null,replication:()=>({replicaLag:false,eventGap:false,evidenceMissing:false}),now:()=>new Date()});
 const app=express();app.use(express.json());app.use(authMiddleware(()=>config.authToken,'echo',undefined,deviceAuthenticator(pairing)));
 app.use(createConversationGraphRouter({model,resolveViewer:createConversationGraphViewerResolver({agentId:'echo',pairing,
  verifyDashboardOwner:proof=>proof==='test-owner-proof'})}));
 const phone=(msp=false)=>{const dev=makeDevice();const c=pairing.devices.createPending({deviceName:'Test phone',label:null,publicKey:dev.publicKey,host:HOST,
  ...(msp?{userId:'support',role:'msp' as const}:{})});if(!c.ok)throw new Error('test-pairing-failed');pairing.devices.applyConfirm(c.device.id,{ok:true});return{...dev,id:c.device.id};};
 let tick=0;
 const signed=(dev:ReturnType<typeof phone>,route=ROUTE,bad=false)=>{const time=String(Date.now()+tick++);const signature=dev.sign(canonicalString(dev.id,HOST,'GET',route,time,undefined));
  return request(app).get(route).set('X-Instar-Device',dev.id).set('X-Instar-Device-Time',time).set('X-Instar-Device-Sig',bad?'bad':signature);};
 return{app,pairing,phone,signed,reads:()=>reads,ready:(value:boolean)=>{ready=value;}};
}
describe('Conversations real device request authority',()=>{
 it('admits a signed owner, refuses bearer/MSP/forged requests before reading inventory',async()=>{
  const e=await boot();const owner=e.phone(),msp=e.phone(true);
  expect((await request(e.app).get(ROUTE).set('Authorization','Bearer test-bearer').set('X-Instar-AgentId','echo')).status).toBe(403);
  const denied=await e.signed(msp);expect(denied.status).toBe(403);expect(denied.body.code).toBe('hierarchy-owner-only');
  expect((await e.signed(owner,ROUTE,true)).status).toBe(401);expect(e.reads()).toBe(0);
  const accepted=await e.signed(owner);expect(accepted.status).toBe(200);expect(accepted.body.items[0].source.conversationId).toBe(42);
 });
 it('keeps a valid owner at 503 while storage proof is absent',async()=>{
  const e=await boot();e.ready(false);const response=await e.signed(e.phone());
  expect(response.status).toBe(503);expect(response.body.code).toBe('conversation-graph-off');expect(e.reads()).toBe(0);
 });
 it('refuses a revoked phone and requires the existing dashboard owner proof',async()=>{
  const e=await boot();const owner=e.phone();e.pairing.devices.revoke(owner.id);
  expect((await e.signed(owner)).status).toBe(401);
  const route='/conversation-graph/roots?view=all';
  expect((await request(e.app).get(route).set('Authorization','Bearer test-bearer').set('X-Instar-AgentId','echo')).status).toBe(403);
  expect((await request(e.app).get(route).set('Authorization','Bearer test-bearer').set('X-Instar-AgentId','echo').set('X-Instar-Operator-Session','test-owner-proof')).status).toBe(200);
 });
});
