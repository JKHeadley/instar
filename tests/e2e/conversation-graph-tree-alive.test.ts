/** The phone tree is alive (work-front-doors stage 2 "Mobile hierarchy routes"; hierarchy v3 §7.4): the real
 * AgentServer composition with Conversations switched on, the standalone owned graph started by a real PIN visit,
 * a phone signed by the real verifier and ledger. The phone builds a parent and a nested group through the
 * existing change routes and reads them back nested from GET /mobile/conversation-graph/tree. */
import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import request from 'supertest';
import {AgentServer} from '../../src/server/AgentServer.js';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {SingleInstanceLock} from '../../src/core/SingleInstanceLock.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {ScopeVerifier} from '../../src/core/ScopeVerifier.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {ConversationGraphDefault} from '../../src/server/ConversationGraphDefault.js';
import {StateManager} from '../../src/core/StateManager.js';
import {InitiativeTracker} from '../../src/core/InitiativeTracker.js';
import type {InstarConfig} from '../../src/core/types.js';
import {canonicalString} from '../../src/core/MobileDeviceKeys.js';
import {encodeRouteRef} from '../../src/core/conversationGraph.js';
import {createMockSessionManager} from '../helpers/setup.js';
import {makeDevice} from '../helpers/mobileDevice.js';
vi.setConfig({testTimeout:120_000});

const HOST='graph-tree-alive.example.dev';
describe('phone tree on the production AgentServer',()=>{
 it('serves a signed owner phone the nested tree, and refuses it once the phone is revoked',async()=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-tree-alive-'));
  const identity=new MachineIdentityManager(stateDir);
  const lock=new SingleInstanceLock({stateDir});expect((await lock.acquire()).acquired).toBe(true);
  const scope=new ScopeVerifier({projectName:'instar',projectDir:stateDir});
  const manager=new ConversationGraphDefault({stateDir,agentId:'echo',instanceLock:lock,scopeVerifier:scope,telegramChatId:'-1001',
   secrets:new SecretStore({stateDir,forceFileKey:true})});
  const config={projectName:'echo',projectDir:stateDir,stateDir,port:0,authToken:'tree-alive-token',dashboardPin:'654321',developmentAgent:true,
   sessions:{claudePath:'/usr/bin/echo',maxSessions:1,defaultMaxDurationMinutes:30,protectedSessions:[],monitorIntervalMs:5000},
   scheduler:{enabled:false,jobsFile:'',maxParallelJobs:1},messaging:[],updates:{},threadline:{ownerName:'Owner'},
   secrets:{forceFileKey:true},mobilePairing:{multiRoute:{enabled:false}},tunnel:{enabled:true,type:'named',token:'x',hostname:HOST},
   multiMachine:{enabled:false,conversationGraph:{readEnabled:true,correctionsEnabled:true}},
  } as unknown as InstarConfig;
  fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify(config));
  const server=new AgentServer({config,sessionManager:createMockSessionManager(),state:new StateManager(stateDir),initiativeTracker:new InitiativeTracker(stateDir),
   coordinator:{enabled:false,managers:{identityManager:identity}} as never,coherenceGate:scope,conversationGraphDefault:manager,
   tunnel:{lifecycleState:{lastState:'active',activeProvider:'cloudflare-named'},url:`https://${HOST}`,on:()=>undefined} as never});
  try{
   const app=server.getApp();
   // A real PIN visit starts the owned graph, as on a fresh install.
   const unlocked=await request(app).post('/dashboard/unlock').send({pin:'654321'});expect(unlocked.status).toBe(200);
   const roots=await request(app).get('/conversation-graph/roots').set('Authorization','Bearer tree-alive-token')
    .set('X-Instar-AgentId','echo').set('X-Instar-Operator-Session',unlocked.body.operatorSessionToken);
   expect(roots.status,JSON.stringify(roots.body)).toBe(200);
   const phone=makeDevice(),pairing=server.mobilePairing!;
   const pending=pairing.devices.createPending({deviceName:'Tree synthetic phone',label:null,publicKey:phone.publicKey,host:HOST});
   if(!pending.ok)throw new Error('tree-phone-fixture-failed');
   pairing.keyLedger!.recordActivation(pending.device,'dashboard-pin',new Date().toISOString());expect(pairing.devices.applyConfirm(pending.device.id,{ok:true})).toBeTruthy();
   let tick=0;
   const get=(target:string)=>{const time=String(Date.now()+tick++);return request(app).get(target).set('X-Instar-Device',pending.device.id)
    .set('X-Instar-Device-Time',time).set('X-Instar-Device-Sig',phone.sign(canonicalString(pending.device.id,HOST,'GET',target,time,undefined)));};
   const post=(target:string,body:Record<string,unknown>)=>{const time=String(Date.now()+tick++);return request(app).post(target).send(body)
    .set('X-Instar-Device',pending.device.id).set('X-Instar-Device-Time',time)
    .set('X-Instar-Device-Sig',phone.sign(canonicalString(pending.device.id,HOST,'POST',target,time,Buffer.from(JSON.stringify(body)))));};
   const change=async(requestId:string,c:Record<string,unknown>)=>{const r=await post('/mobile/conversation-graph/changes',{requestId,change:c});
    expect(r.status,JSON.stringify(r.body)).toBe(200);expect(r.body.state).toBe('committed');return r.body;};
   const parent=(await change('tree-alive-parent',{kind:'create-effort',projectScope:[]})).effort;
   const child=(await change('tree-alive-child',{kind:'create-effort',projectScope:[]})).effort;
   await change('tree-alive-parent-name',{kind:'set-effort-title',effort:parent,baseVersion:0,title:'Synthetic parent group'});
   await change('tree-alive-child-name',{kind:'set-effort-title',effort:child,baseVersion:0,title:'Synthetic nested group'});
   await change('tree-alive-move',{kind:'set-primary-placement',subject:child,parent,replacesPlacementEventIds:[]});

   const tree=await get('/mobile/conversation-graph/tree');
   expect(tree.status,JSON.stringify(tree.body)).toBe(200);
   expect(tree.body.items).toHaveLength(1);
   const [top]=tree.body.items;
   expect(top).toMatchObject({ref:parent,routeRef:encodeRouteRef(parent),title:'Synthetic parent group',kind:'effort',visibleChildCount:1,childrenComplete:true});
   expect(top.children).toHaveLength(1);
   expect(top.children[0]).toMatchObject({ref:child,title:'Synthetic nested group',placedBy:'owner',children:[],childrenComplete:true});
   expect(tree.body.projects).toBe('known');
   expect(typeof tree.body.revision).toBe('string');expect(tree.body.nextCursor).toBeNull();
   const webTree=await request(app).get('/conversation-graph/tree').set('Authorization','Bearer tree-alive-token')
    .set('X-Instar-AgentId','echo').set('X-Instar-Operator-Session',unlocked.body.operatorSessionToken);
   expect(webTree.status,JSON.stringify(webTree.body)).toBe(200);
   expect(webTree.body.items).toEqual(tree.body.items);
   expect(webTree.body.projects).toBe(tree.body.projects);
   // The nested node opens with the existing node read, by the routeRef the tree gave.
   const opened=await get(`/mobile/conversation-graph/nodes/${top.children[0].routeRef}`);
   expect(opened.status).toBe(200);expect(opened.body.path.map((p:{title:string})=>p.title)).toEqual(['Synthetic parent group']);

   pairing.keyLedger!.recordRevocation(pairing.devices.get(pending.device.id)!,new Date().toISOString());pairing.devices.revoke(pending.device.id);
   expect((await get('/mobile/conversation-graph/tree')).status).toBe(401);
  }finally{
   await server.stop();await manager.close();lock.release();
   SafeFsExecutor.safeRmSync(stateDir,{recursive:true,force:true,operation:'graph-tree-alive-cleanup'});
  }
 });
});
