import {readConversationGraphOwnerPolicy} from '../../src/core/ConversationGraphOwnerPolicy.js';
/** Actual AgentServer composition with two durable graph members and witness
 * HTTP. The phone uses the real verifier/ledger. Session dispatch is stubbed;
 * no physical device, public witness deployment or production enablement proof. */
import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import request from 'supertest';
import {AgentServer} from '../../src/server/AgentServer.js';
import {LiveConfig} from '../../src/config/LiveConfig.js';
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
import {setupGraphRuntimeFixture,witnesses} from '../helpers/conversation-graph-runtime.js';

const HOST='graph-alive.example.dev';
describe('Conversations production AgentServer composition',()=>{
 it('boots the actual standalone default from a real PIN visit and accepts a signed phone without an injected graph runtime',async()=>{
  const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-default-agent-alive-'));
  const identity=new MachineIdentityManager(stateDir);expect(identity.hasIdentity()).toBe(false);
  const lock=new SingleInstanceLock({stateDir});expect((await lock.acquire()).acquired).toBe(true);
  const scope=new ScopeVerifier({projectName:'instar',projectDir:stateDir});
  const manager=new ConversationGraphDefault({stateDir,agentId:'echo',instanceLock:lock,scopeVerifier:scope,telegramChatId:'-1001',
   secrets:new SecretStore({stateDir,forceFileKey:true}),});
  let ensureFailure:unknown;const actualEnsure=manager.ensureOwner.bind(manager),ensureTrace=vi.spyOn(manager,'ensureOwner').mockImplementation(async input=>{try{return await actualEnsure(input);}catch(error){const message=(error as Error).message;const graphPaths=[stateDir,path.join(stateDir,'state'),path.join(stateDir,'local')].flatMap(dir=>fs.existsSync(dir)?fs.readdirSync(dir).filter(name=>name.startsWith('conversation-graph')).map(name=>path.relative(stateDir,path.join(dir,name))):[]);let policyValid=false;try{policyValid=readConversationGraphOwnerPolicy({stateDir,forceFileKey:true})!==null;}catch{/* diagnostic only */}ensureFailure={code:/^[a-z0-9-]{1,160}$/.test(message)?message:(error as Error).name,graphPaths,policyValid,registryCount:Object.keys(identity.loadRegistry().machines).length,machineDirs:['machine','machines'].map(name=>({name,entries:fs.existsSync(path.join(stateDir,name))?fs.readdirSync(path.join(stateDir,name)):[]}))};throw error;}});
  const config={projectName:'echo',projectDir:stateDir,stateDir,port:0,authToken:'standalone-server-fixture-token',dashboardPin:'654321',developmentAgent:true,
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
   const app=server.getApp();expect(manager.runtime).toBeNull();
   const unlocked=await request(app).post('/dashboard/unlock').send({pin:'654321'});expect(unlocked.status).toBe(200);
   const roots=await request(app).get('/conversation-graph/roots').set('Authorization','Bearer standalone-server-fixture-token')
    .set('X-Instar-AgentId','echo').set('X-Instar-Operator-Session',unlocked.body.operatorSessionToken);
   expect(roots.status,JSON.stringify({body:roots.body,ensureFailure})).toBe(200);
   expect(manager.runtime?.installedMembership.members).toHaveLength(1);expect(manager.runtime?.installedMembership.custodyProfile?.mode).toBe('owned-machine');
   expect(server.appConversations?.deps.machineId()).toBe(identity.loadIdentity().machineId);
   expect(server.mobilePairing?.keyLedger).toBeTruthy();
   const phone=makeDevice(),pairing=server.mobilePairing!;
   const pending=pairing.devices.createPending({deviceName:'Standalone synthetic phone',label:null,publicKey:phone.publicKey,host:HOST});
   if(!pending.ok)throw new Error('standalone-phone-fixture-failed');
   pairing.keyLedger!.recordActivation(pending.device,'dashboard-pin',new Date().toISOString());expect(pairing.devices.applyConfirm(pending.device.id,{ok:true})).toBeTruthy();
   const route='/mobile/conversation-graph/changes',body={requestId:'standalone-phone-create',change:{kind:'create-effort',projectScope:[]}},time=String(Date.now());
   const created=await request(app).post(route).send(body).set('X-Instar-Device',pending.device.id).set('X-Instar-Device-Time',time)
    .set('X-Instar-Device-Sig',phone.sign(canonicalString(pending.device.id,HOST,'POST',route,time,Buffer.from(JSON.stringify(body)))));
   expect(created.status,JSON.stringify(created.body)).toBe(200);expect(created.body.state).toBe('committed');
   expect(manager.runtime!.source.status(created.body.eventId).state).toBe('committed');
   let tick=0;const signedRead=()=>{const target='/mobile/conversation-graph/roots?view=all',time=String(Date.now()+tick++);return request(app).get(target).set('X-Instar-Device',pending.device.id).set('X-Instar-Device-Time',time).set('X-Instar-Device-Sig',phone.sign(canonicalString(pending.device.id,HOST,'GET',target,time,undefined)));};
   const read=await signedRead();expect(read.status).toBe(200);expect(read.body.items.some((item:{ref:unknown})=>JSON.stringify(item.ref)===JSON.stringify(created.body.effort))).toBe(true);
   pairing.keyLedger!.recordRevocation(pairing.devices.get(pending.device.id)!,new Date().toISOString());pairing.devices.revoke(pending.device.id);
   expect((await signedRead()).status).toBe(401);
  }finally{
   ensureTrace.mockRestore();await server.stop();await manager.close();lock.release();
   SafeFsExecutor.safeRmSync(stateDir,{recursive:true,force:true,operation:'graph-default-agent-alive-cleanup'});
  }
 });
 it('uses actual PIN owner proof and device signature for a certified read and change',async()=>{
  const actual=await setupGraphRuntimeFixture({ownedCustodyHostIndex:0});
  const stateDir=actual.managers[0].baseDir;
  for(const dir of ['state/sessions','state/jobs','logs'])fs.mkdirSync(path.join(stateDir,dir),{recursive:true});
  const config={projectName:'echo',projectDir:stateDir,stateDir,port:0,authToken:'graph-alive-token',dashboardPin:'654321',developmentAgent:true,
   sessions:{claudePath:'/usr/bin/echo',maxSessions:1,defaultMaxDurationMinutes:30,protectedSessions:[],monitorIntervalMs:5000},
   scheduler:{enabled:false,jobsFile:'',maxParallelJobs:1},messaging:[],updates:{},threadline:{ownerName:'Owner'},
   mobilePairing:{multiRoute:{enabled:false}},tunnel:{enabled:true,type:'named',token:'x',hostname:HOST},
   multiMachine:{enabled:false,conversationGraph:{...actual.options[0].configuration,storage:{enabled:true},readEnabled:true,correctionsEnabled:true}},
  } as unknown as InstarConfig;
  fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify(config));
  const liveConfig=new LiveConfig(stateDir);
  const sessionManager=createMockSessionManager();
  const server=new AgentServer({config,sessionManager,state:new StateManager(stateDir),initiativeTracker:new InitiativeTracker(stateDir),
   coordinator:{enabled:false,managers:{identityManager:actual.managers[0]}} as never,
   coherenceGate:actual.options[0].scopeVerifier,conversationGraphReplicationRuntime:actual.runtime,
   tunnel:{lifecycleState:{lastState:'active',activeProvider:'cloudflare-named'},url:`https://${HOST}`,on:()=>undefined} as never});
  try{
   const app=server.getApp();
   const auth=(test:request.Test)=>test.set('Authorization','Bearer graph-alive-token').set('X-Instar-AgentId','echo');
   const unlocked=await request(app).post('/dashboard/unlock').send({pin:'654321'});
   expect(unlocked.status).toBe(200);
   const proof=unlocked.body.operatorSessionToken;expect(proof).toBeTypeOf('string');
   expect((await auth(request(app).get('/conversation-graph/roots'))).status).toBe(403);
   expect(await actual.runtime.refreshReadiness()).toBe(true);
   const created=await auth(request(app).post('/conversation-graph/changes')).set('X-Instar-Operator-Session',proof)
    .send({requestId:'alive-effort-0001',change:{kind:'create-effort',projectScope:[]}});
   expect(created.body).toMatchObject({state:'committed'});expect(created.status).toBe(200);
   expect(server.mobilePairing?.nativeOn).toBe(true);expect(server.mobilePairing?.keyLedger).toBeTruthy();
   const phone=makeDevice();const pending=server.mobilePairing!.devices.createPending({deviceName:'Graph proof phone',label:null,publicKey:phone.publicKey,host:HOST});
   if(!pending.ok)throw new Error('phone-pairing-failed');
   // Seed the same durable ledger-before-registry approval ordering used by
   // the pairing route. The pairing UI itself is not exercised by this test.
   server.mobilePairing!.keyLedger!.recordActivation(pending.device,'dashboard-pin',new Date().toISOString());
   expect(server.mobilePairing!.devices.applyConfirm(pending.device.id,{ok:true})).toBeTruthy();
   const route='/mobile/conversation-graph/roots?view=all';let tick=0;
   const signed=(path=route)=>{const time=String(Date.now()+tick++);return request(app).get(path).set('X-Instar-Device',pending.device.id)
    .set('X-Instar-Device-Time',time).set('X-Instar-Device-Sig',phone.sign(canonicalString(pending.device.id,HOST,'GET',path,time,undefined)));};
   const read=await signed();expect(read.status).toBe(200);expect(read.body.items.some((row:{ref:{kind:string}})=>row.ref.kind==='effort')).toBe(true);
   const detail=await signed(`/mobile/conversation-graph/nodes/${encodeRouteRef(created.body.effort)}`);
   expect(detail.status).toBe(200);expect(detail.body.node.ref).toEqual(created.body.effort);
   expect(detail.body.correction.replacesPlacementEventIds).toEqual([]);
   const status=await signed('/mobile/conversation-graph/changes/alive-effort-0001');
   expect(status.status).toBe(200);expect(status.body.state).toBe('committed');
   const postPath='/mobile/conversation-graph/changes';
   const post=async(body:Record<string,unknown>,target=postPath)=>{const time=String(Date.now()+tick++);return request(app).post(target).send(body)
    .set('X-Instar-Device',pending.device.id).set('X-Instar-Device-Time',time)
    .set('X-Instar-Device-Sig',phone.sign(canonicalString(pending.device.id,HOST,'POST',target,time,Buffer.from(JSON.stringify(body)))));};
   const phoneCommitted=await post({requestId:'alive-phone-0001',change:{kind:'create-effort',projectScope:[]}});
   expect(phoneCommitted.body).toMatchObject({requestId:'alive-phone-0001',state:'committed'});expect(phoneCommitted.status).toBe(200);
   const phoneEffort=phoneCommitted.body.effort;
   const named=await post({requestId:'alive-phone-name-0001',change:{kind:'set-effort-title',effort:phoneEffort,baseVersion:0,title:'Signed phone synthetic name'}});
   expect(named.status).toBe(200);expect(named.body.state).toBe('committed');
   const namedRead=await signed(`/mobile/conversation-graph/nodes/${encodeRouteRef(phoneEffort)}`);
   expect(namedRead.status).toBe(200);expect(namedRead.body.node.title).toBe('Signed phone synthetic name');
   const move={kind:'set-primary-placement',subject:phoneEffort,parent:created.body.effort,replacesPlacementEventIds:[]};
   const preview=await post(move,'/mobile/conversation-graph/preview');
   expect(preview.status).toBe(200);expect(preview.body.eligible).toBe(true);
   const moved=await post({requestId:'alive-phone-move-0001',change:move});
   expect(moved.status).toBe(200);expect(moved.body.state).toBe('committed');expect(moved.body.undoToken).toBeTypeOf('string');
   const undone=await post({requestId:'alive-phone-undo-0001',undoToken:moved.body.undoToken},'/mobile/conversation-graph/undo');
   expect(undone.status).toBe(200);expect(undone.body.state).toBe('committed');
   const forgotten=await post({requestId:'alive-phone-forget-0001',effort:phoneEffort},'/mobile/conversation-graph/forget-header');
   expect(forgotten.status).toBe(202);expect(forgotten.body.localHidden).toBe(true);expect(forgotten.body.fleetComplete).toBe(false);
   const hiddenName=await signed(`/mobile/conversation-graph/nodes/${encodeRouteRef(phoneEffort)}`);
   expect(hiddenName.status).toBe(200);expect(hiddenName.text).not.toContain('Signed phone synthetic name');
   // Stop the actual custody store while leaving the real phone verifier and
   // peer HTTP servers in place. Accept only a sealed local intent, not a
   // substitute Source receipt or a fabricated canonical tree.
   actual.service.close();witnesses.splice(witnesses.indexOf(actual.service),1);
   const body={requestId:'alive-offline-0001',change:{kind:'create-effort',projectScope:[]}};
   const before=actual.runtime.source.recordsForRepair().length;
   const offline=await post(body);
   expect(offline.status).toBe(202);expect(offline.body.state).toBe('recorded-local');
   expect(offline.body.custody.kind).toBe('recorded-here');
   expect(actual.runtime.source.recordsForRepair()).toHaveLength(before);
   const local=await signed('/mobile/conversation-graph/changes/alive-offline-0001');
   expect(local.status).toBe(202);expect(local.body.operationKey).toBe(offline.body.operationKey);
   const pendingPage=await signed('/mobile/conversation-graph/pending?offset=0');
   expect(pendingPage.status).toBe(200);
   expect(pendingPage.body.items.some((item:{operationKey:string})=>item.operationKey===offline.body.operationKey)).toBe(true);
   expect(pendingPage.body.nextOffset).toBeNull();
   server.mobilePairing!.devices.revoke(pending.device.id);
   expect((await signed()).status).toBe(401);
   expect((await signed('/mobile/conversation-graph/changes/alive-offline-0001')).status).toBe(401);
   liveConfig.set('dashboardPin','111222');
   expect((await auth(request(app).get('/conversation-graph/roots')).set('X-Instar-Operator-Session',proof)).status).toBe(403);
   // Returning to the same PIN must not revive proof from its retired policy.
   liveConfig.set('dashboardPin','654321');
   expect((await auth(request(app).get('/conversation-graph/roots')).set('X-Instar-Operator-Session',proof)).status).toBe(403);
   const sources=['src/server/ConversationGraphOwnerChanges.ts','src/server/ConversationGraphSurface.ts',
    'src/server/ConversationGraphOwnerAdmission.ts','src/server/ConversationGraphReplicationRuntime.ts'];
   const sourceHashes=Object.fromEntries(sources.map(file=>[file,crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
   const out=path.resolve('.instar/state/build');fs.mkdirSync(out,{recursive:true});
   fs.writeFileSync(path.join(out,'native-owned-local-wire-capture-with-phone-corrections.json'),JSON.stringify({
    kind:'actual-agent-server-synthetic-signed-phone-capture',uncommittedSources:true,
    runtime:'injected-two-member-owned-runtime; fixture-seeded-device-approval; not-default-bootstrap-or-pairing-UI-or-physical-device-proof',sourceHashesAtCapture:sourceHashes,capturedAt:new Date().toISOString(),
    roots:read.body,node:detail.body,committed:created.body,phoneCommitted:phoneCommitted.body,named:named.body,preview:preview.body,moved:moved.body,undone:undone.body,forgotten:forgotten.body,recordedLocal:offline.body,localStatus:local.body,pending:pendingPage.body,
   },null,2));
  }finally{await server.stop();}
 });
});
