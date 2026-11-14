import {describe,expect,it} from 'vitest';
import express from 'express';
import request from 'supertest';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';
import {MobilePairingService,deviceAuthenticator} from '../../src/server/mobilePairingRoutes.js';
import {authMiddleware} from '../../src/server/middleware.js';
import {createConversationGraphViewerResolver} from '../../src/server/conversationGraphViewer.js';
import {createConversationGraphChangeRouter} from '../../src/server/conversationGraphChangeRoutes.js';
import {ConversationGraphOwnerChanges} from '../../src/server/ConversationGraphOwnerChanges.js';
import {ConversationGraphHeaderCustody} from '../../src/server/ConversationGraphHeaderCustody.js';
import {MobileDeviceKeyLedger} from '../../src/core/MobileDeviceKeyLedger.js';
import {loadMachineSigner,identityKeyLookup} from '../../src/core/AppRecordSignatures.js';
import {canonicalString} from '../../src/core/MobileDeviceKeys.js';
import {makeDevice} from '../helpers/mobileDevice.js';

describe('signed owner correction HTTP with actual witness and two members',()=>{
 it('refuses bearer, MSP and forged signatures before reservation and certifies the signed owner request',async()=>{
  const f=await setupGraphRuntimeFixture();expect(await f.runtime.refreshReadiness()).toBe(true);expect(await f.peer.refreshReadiness()).toBe(true);
  const config={projectName:'echo',stateDir:f.managers[0].baseDir,projectDir:f.managers[0].baseDir,port:0,authToken:'test-bearer',developmentAgent:true,
   sessions:{},scheduler:{},threadline:{ownerName:'Owner'},users:[{id:'support',name:'Support',permissions:['user']}],mobilePairing:{multiRoute:{enabled:false}}};
  const pairing=new MobilePairingService({config:config as never,stateDir:config.stateDir,holdsLease:()=>true});
  pairing.nativeOn=true;pairing.keyLedger=new MobileDeviceKeyLedger({stateDir:config.stateDir,signer:loadMachineSigner(config.stateDir)!,keyLookup:identityKeyLookup(config.stateDir)});
  try{
   const resolveViewer=createConversationGraphViewerResolver({agentId:'echo',pairing,verifyDashboardOwner:()=>false});
   const custody=new ConversationGraphHeaderCustody(config.stateDir,f.runtime);
   const changes=new ConversationGraphOwnerChanges({runtime:f.runtime,identity:f.managers[0],membership:()=>f.f.membership,
    dropped:f.options[0].droppedOrigins,scope:f.options[0].scopeVerifier,telegramChatId:'-1001',resolveViewer,hasConversation:()=>false,
    headerVersion:id=>custody.get(id)});
   const app=express();app.use(express.json({limit:'16kb',verify:(req,_res,buffer)=>{(req as unknown as {rawBody:Buffer}).rawBody=Buffer.from(buffer);}}));
   app.use(authMiddleware(()=>config.authToken,'echo',undefined,deviceAuthenticator(pairing)));
   app.use(createConversationGraphChangeRouter({changes,resolveViewer}));
   const host='graph-change.example.dev',route='/mobile/conversation-graph/changes';
   const phone=(msp=false)=>{const device=makeDevice();const created=pairing.devices.createPending({deviceName:'Test phone',label:null,publicKey:device.publicKey,host,
    ...(msp?{userId:'support',role:'msp' as const}:{})});if(!created.ok)throw new Error('pairing-failed');pairing.devices.applyConfirm(created.device.id,{ok:true});return{...device,id:created.device.id};};
   const owner=phone(),msp=phone(true);let tick=0;
   const body={requestId:'signed-create-0001',change:{kind:'create-effort',projectScope:[]}};
   const signed=(device:ReturnType<typeof phone>,forged=false)=>{
    const raw=Buffer.from(JSON.stringify(body)),time=String(Date.now()+tick++);
    return request(app).post(route).set('Content-Type','application/json').set('X-Instar-Device',device.id).set('X-Instar-Device-Time',time)
     .set('X-Instar-Device-Sig',forged?'bad':device.sign(canonicalString(device.id,host,'POST',route,time,raw))).send(raw.toString());
   };
   expect((await request(app).post(route).set('Authorization','Bearer test-bearer').set('X-Instar-AgentId','echo').send(body)).status).toBe(403);
   expect((await signed(msp)).status).toBe(403);expect((await signed(owner,true)).status).toBe(401);
   expect(await f.runtime.intake.reservations()).toHaveLength(0);
   const saved=await signed(owner);expect(saved.status).toBe(200);expect(saved.body.state).toBe('committed');
   expect(f.peer.source.status(saved.body.eventId).state).toBe('committed');
  }finally{pairing.stop();}
 });
});
