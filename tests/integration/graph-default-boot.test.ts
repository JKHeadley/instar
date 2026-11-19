import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import express from 'express';
import type {Server} from 'node:http';
import {createConversationGraphDefaultSurface} from '../../src/server/ConversationGraphDefaultSurface.js';
import {ScopeVerifier} from '../../src/core/ScopeVerifier.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {ConversationGraphDefault,GRAPH_OWNER_CONTROL_SECRET,GRAPH_CUSTODY_ROLE_SECRET} from '../../src/server/ConversationGraphDefault.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {SingleInstanceLock} from '../../src/core/SingleInstanceLock.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const servers:Server[]=[];
const directories:string[]=[],managers:ConversationGraphDefault[]=[],locks:SingleInstanceLock[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}for(const manager of managers.splice(0))await manager.close();for(const lock of locks.splice(0))lock.release();for(const dir of directories.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-default-boot-test:teardown'});});
async function fixture(){const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-default-'));directories.push(stateDir);const instanceLock=new SingleInstanceLock({stateDir});expect((await instanceLock.acquire()).acquired).toBe(true);locks.push(instanceLock);const secrets=new SecretStore({stateDir,forceFileKey:true}),options={stateDir,agentId:'default-agent',instanceLock,secrets,},manager=new ConversationGraphDefault(options);managers.push(manager);return{stateDir,options,secrets,manager};}
describe('zero external configuration owned-machine production default manager',()=>{
 it('creates no genesis before owner admission and uses real standalone native custody on first admitted visit, then reopens without reminting',async()=>{
  const f=await fixture();expect(await f.manager.restore()).toBeNull();expect(f.secrets.get(GRAPH_OWNER_CONTROL_SECRET)).toBeUndefined();
  await expect(f.manager.ensureOwner({principalKey:'owner:default-agent',authenticationMethod:'owner-device',requestId:'revoked-visit',isCurrent:()=>false})).rejects.toThrow('owner-admission-required');expect(f.secrets.get(GRAPH_OWNER_CONTROL_SECRET)).toBeUndefined();
  const runtime=await f.manager.ensureOwner({principalKey:'owner:default-agent',authenticationMethod:'owner-device',requestId:'actual-owner-visit',isCurrent:()=>true});expect(runtime).not.toBeNull();expect(runtime.isReady(),(runtime as unknown as {lastReadinessFailure:string}).lastReadinessFailure).toBe(true);expect(runtime.installedMembership.members).toHaveLength(1);expect(runtime.installedMembership.custodyProfile?.mode).toBe('owned-machine');const originalMembership=runtime.installedMembership,ownerControl=f.secrets.get(GRAPH_OWNER_CONTROL_SECRET),role=f.secrets.get(GRAPH_CUSTODY_ROLE_SECRET);expect(typeof role).toBe('string');
  await f.manager.close();managers.splice(managers.indexOf(f.manager),1);const reopened=new ConversationGraphDefault(f.options);managers.push(reopened);const restored=await reopened.restore();expect(restored?.isReady()).toBe(true);expect(restored?.installedMembership).toEqual(originalMembership);expect(f.secrets.get(GRAPH_OWNER_CONTROL_SECRET)).toEqual(ownerControl);expect(f.secrets.get(GRAPH_CUSTODY_ROLE_SECRET)).toBe(role);
 });
 it('quarantines missing publication plus claim and database when the separately durable owner vault still remembers establishment',async()=>{
  const f=await fixture();await f.manager.ensureOwner({principalKey:'owner:default-agent',authenticationMethod:'owner-device',requestId:'partial-restore-original-owner',isCurrent:()=>true});const root=f.secrets.get(GRAPH_OWNER_CONTROL_SECRET);await f.manager.close();managers.splice(managers.indexOf(f.manager),1);
  SafeFsExecutor.safeRmSync(path.join(f.stateDir,'conversation-graph'),{recursive:true,force:true,operation:'graph-default-test:simulate-partial-authority-restore'});
  const restored=new ConversationGraphDefault(f.options);managers.push(restored);await expect(restored.restore()).rejects.toThrow('established-publication-missing');await expect(restored.ensureOwner({principalKey:'owner:default-agent',authenticationMethod:'owner-device',requestId:'partial-restore-owner-revisit',isCurrent:()=>true})).rejects.toThrow();expect(f.secrets.get(GRAPH_OWNER_CONTROL_SECRET)).toEqual(root);expect(fs.existsSync(path.join(f.stateDir,'conversation-graph','custody.sqlite'))).toBe(false);
 });
 it('withholds publication and custody when vault durability fails, then retries the same owner root after a successful barrier',async()=>{
  const f=await fixture(),vault=path.join(f.stateDir,'secrets','config.secrets.enc'),real=fs.fsyncSync,fault=vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.existsSync(vault)&&fs.fstatSync(fd).ino===fs.statSync(vault).ino)throw new Error('injected-graph-vault-durability-failure');return real(fd);});
  await expect(f.manager.ensureOwner({principalKey:'owner:default-agent',authenticationMethod:'owner-device',requestId:'vault-fault-owner-visit',isCurrent:()=>true})).rejects.toThrow('injected-graph-vault-durability-failure');const root=f.secrets.get(GRAPH_OWNER_CONTROL_SECRET);expect(root).toBeDefined();expect(f.manager.runtime).toBeNull();expect(fs.existsSync(path.join(f.stateDir,'conversation-graph','custody.sqlite'))).toBe(false);
  fault.mockRestore();const runtime=await f.manager.ensureOwner({principalKey:'owner:default-agent',authenticationMethod:'owner-device',requestId:'vault-fault-exact-root-retry',isCurrent:()=>true});expect(runtime.isReady()).toBe(true);expect(f.secrets.get(GRAPH_OWNER_CONTROL_SECRET)).toEqual(root);
 });
 it('does not publish a custody root before the actual native decryption key has passed its durability barrier',async()=>{
  const f=await fixture(),key=new MachineIdentityManager(f.stateDir).encryptionKeyPath,real=fs.fsyncSync,fault=vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.existsSync(key)&&fs.fstatSync(fd).ino===fs.statSync(key).ino)throw new Error('injected-native-source-key-durability-failure');return real(fd);});
  await expect(f.manager.ensureOwner({principalKey:'owner:default-agent',authenticationMethod:'owner-device',requestId:'native-key-fault-visit',isCurrent:()=>true})).rejects.toThrow('injected-native-source-key-durability-failure');expect(f.manager.runtime).toBeNull();expect(fs.existsSync(path.join(f.stateDir,'conversation-graph','custody.sqlite'))).toBe(false);fault.mockRestore();
  const runtime=await f.manager.ensureOwner({principalKey:'owner:default-agent',authenticationMethod:'owner-device',requestId:'native-key-durable-retry',isCurrent:()=>true});expect(runtime.isReady()).toBe(true);
 });
 it('serves an actual owner-gated zero-external-config visit and commits create/name through native source custody before priority forget',async()=>{
  const f=await fixture(),scope=new ScopeVerifier({projectName:'instar',projectDir:f.stateDir,topicProjects:{'42':{projectName:'instar',projectDir:f.stateDir}}});
  // Same production manager: scope is supplied before first owner initialization.
  await f.manager.close();managers.splice(managers.indexOf(f.manager),1);const manager=new ConversationGraphDefault({...f.options,scopeVerifier:scope,telegramChatId:'-1001'});managers.push(manager);
  const app=express();app.use(express.json({limit:'64kb'}));app.use(createConversationGraphDefaultSurface({manager,stateDir:f.stateDir,readEnabled:true,correctionsEnabled:true,scope,telegramChatId:'-1001',pairing:null,verifyDashboardOwner:token=>token==='fixture-unlocked-owner',dashboardPolicy:()=>({pin:'fixture-current-pin-policy',generation:'11111111-1111-4111-8111-111111111111'}),forceFileKey:true}));
  const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const request=async(route:string,body?:unknown,owner=true)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...(owner?{'X-Instar-Operator-Session':'fixture-unlocked-owner'}:{Authorization:'Bearer ordinary-agent-bearer'}),...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await response.text();if(!response.headers.get('content-type')?.includes('application/json'))throw new Error(`Non-JSON ${response.status} at ${route}: ${text.slice(0,80)}`);return {status:response.status,body:JSON.parse(text)};};
  expect((await request('/conversation-graph/roots',undefined,false)).status).toBe(403);expect(f.secrets.get(GRAPH_OWNER_CONTROL_SECRET)).toBeUndefined();
  expect((await request('/conversation-graph/roots')).status).toBe(200);
  const created=await request('/conversation-graph/changes',{requestId:'create-owned-effort',change:{kind:'create-effort',projectScope:['instar']}});expect(created.status,JSON.stringify(created.body)).toBe(200);expect(created.body.state).toBe('committed');expect(created.body.effort.kind).toBe('effort');
  const named=await request('/conversation-graph/changes',{requestId:'name-owned-effort',change:{kind:'set-effort-title',effort:created.body.effort,baseVersion:0,title:'private-owned-title-canary'}});expect(named.status,JSON.stringify(named.body)).toBe(200);expect(named.body.state).toBe('committed');
  expect(JSON.stringify((await request('/conversation-graph/roots?view=all')).body)).toContain('private-owned-title-canary');
  const forgotten=await request('/conversation-graph/forget-header',{requestId:'forget-owned-effort',effort:created.body.effort});expect([200,202],JSON.stringify(forgotten.body)).toContain(forgotten.status);
  expect(JSON.stringify((await request('/conversation-graph/roots?view=all')).body)).not.toContain('private-owned-title-canary');
 });
 it('answers an owner read from the open graph while the one-at-a-time owner step is busy; a write still waits for it',async()=>{
  // Accept-all round 3: after a restart the owner step stayed busy (peer checks, a full readiness pass) and every
  // Conversations read queued behind it past the page's 20 s limit for half an hour.
  const f=await fixture(),scope=new ScopeVerifier({projectName:'instar',projectDir:f.stateDir,topicProjects:{'42':{projectName:'instar',projectDir:f.stateDir}}});
  await f.manager.close();managers.splice(managers.indexOf(f.manager),1);const manager=new ConversationGraphDefault({...f.options,scopeVerifier:scope,telegramChatId:'-1001'});managers.push(manager);
  const app=express();app.use(express.json({limit:'64kb'}));app.use(createConversationGraphDefaultSurface({manager,stateDir:f.stateDir,readEnabled:true,correctionsEnabled:true,scope,telegramChatId:'-1001',pairing:null,verifyDashboardOwner:token=>token==='fixture-unlocked-owner',dashboardPolicy:()=>({pin:'fixture-current-pin-policy',generation:'11111111-1111-4111-8111-111111111111'}),forceFileKey:true,readOwnerWaitMs:300}));
  const server=app.listen(0,'127.0.0.1');servers.push(server);await new Promise<void>(resolve=>server.once('listening',resolve));const base=`http://127.0.0.1:${(server.address() as {port:number}).port}`;
  const request=async(route:string,body?:unknown)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{'X-Instar-Operator-Session':'fixture-unlocked-owner',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:response.status,body:await response.json()};};
  // Before the graph is open, a read waits for the owner step as it always did (nothing to answer from).
  expect((await request('/conversation-graph/roots')).status).toBe(200);
  // Hold the owner step the way slow upkeep does after a restart.
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const busy=(manager as unknown as {serialized(work:()=>Promise<void>):Promise<void>;ownerStepValue:string});
  const upkeep=busy.serialized(async()=>{busy.ownerStepValue='the readiness check';await held;});
  const warn=vi.spyOn(console,'warn');
  try{
   const started=Date.now(),read=await request('/conversation-graph/roots');
   expect(read.status,JSON.stringify(read.body)).toBe(200);expect(Date.now()-started).toBeLessThan(5000);
   expect(warn.mock.calls.some(call=>String(call[0])==='[conversation-graph] answered a read without waiting: the owner step is busy with the readiness check')).toBe(true);
   // A write is not answered from the open graph: it is still waiting for the owner step.
   let wrote=false;const write=request('/conversation-graph/changes',{requestId:'write-behind-busy-owner',change:{kind:'create-effort',projectScope:['instar']}}).then(result=>{wrote=true;return result;});
   await new Promise(resolve=>setTimeout(resolve,800));expect(wrote).toBe(false);
   release();await upkeep;
   const written=await write;expect(written.status,JSON.stringify(written.body)).toBe(200);expect(written.body.state).toBe('committed');
  }finally{release();}
  // Idle again: the label resets so a later log never names finished work.
  expect(manager.ownerStep).toBe('nothing (idle)');
  // If the owner queue replaces the runtime while a read waits, the read is NOT answered from the old one: it waits.
  let releaseSwap!:()=>void;const swapHeld=new Promise<void>(resolve=>{releaseSwap=resolve;});
  const realRuntime=manager.runtime,internals=manager as unknown as {runtimeValue:unknown};
  const swapJob=busy.serialized(async()=>{await swapHeld;});
  let swappedDone=false;const swappedRead=request('/conversation-graph/roots').then(result=>{swappedDone=true;return result;});
  try{
   await new Promise(resolve=>setTimeout(resolve,100));internals.runtimeValue={replaced:true};
   await new Promise(resolve=>setTimeout(resolve,800));expect(swappedDone).toBe(false);
  }finally{internals.runtimeValue=realRuntime;releaseSwap();}
  await swapJob;expect((await swappedRead).status).toBe(200);
 });
 it('a save reuses a peer sync and readiness refresh under 10 s old instead of repeating it inline; upkeep still refreshes',async()=>{
  // Accept-all round 4: while the graph was not ready every save re-ran the peer sync and readiness check that the
  // 10 s upkeep had just run, waiting out a slow peer's timeouts again, so Accept all saves passed the page's limit.
  const f=await fixture(),owner=(id:string)=>({principalKey:'owner:default-agent',authenticationMethod:'owner-dashboard' as const,requestId:id,isCurrent:()=>true});
  const runtime=await f.manager.ensureOwner(owner('first-visit'));
  const internals=f.manager as unknown as {serialized<T>(work:()=>Promise<T>):Promise<T>;compose(publication:unknown,forSave?:boolean):Promise<void>;publication():unknown;synchronizeFrontiers(publication:unknown):Promise<void>;refreshedAt:number;custodyAuthorityValue:unknown};
  vi.spyOn(runtime,'isReady').mockReturnValue(false);const readiness=vi.spyOn(runtime,'refreshReadiness').mockResolvedValue(false as never);
  const sync=internals.custodyAuthorityValue?vi.spyOn(internals,'synchronizeFrontiers'):null;
  const counts=()=>[readiness.mock.calls.length,sync?.mock.calls.length??0];
  // Upkeep (no save) refreshes.
  await internals.serialized(()=>internals.compose(internals.publication()));const afterUpkeep=counts();expect(afterUpkeep[0]).toBe(1);
  // A save right after reuses that refresh.
  expect(await f.manager.ensureOwner(owner('save-after-upkeep'))).toBe(runtime);expect(counts()).toEqual(afterUpkeep);
  // A save after the refresh has aged past 10 s refreshes again.
  internals.refreshedAt=Date.now()-11_000;await f.manager.ensureOwner(owner('save-after-stale-refresh'));
  expect(counts()[0]).toBe(afterUpkeep[0]+1);if(sync)expect(counts()[1]).toBe(afterUpkeep[1]+1);
  // Upkeep refreshes even when the last refresh is fresh.
  await internals.serialized(()=>internals.compose(internals.publication()));expect(counts()[0]).toBe(afterUpkeep[0]+2);
 });
 it('runs the local history check outside the owner step, one at a time, so a save is not held behind it',async()=>{
  // Accept-all round 4 part 3: right after a Studio restart the first full history check took 450 s inside the
  // one-at-a-time owner step, and every Accept all save waited behind it until the page gave up.
  const f=await fixture(),owner=(id:string)=>({principalKey:'owner:default-agent',authenticationMethod:'owner-dashboard' as const,requestId:id,isCurrent:()=>true});
  const runtime=await f.manager.ensureOwner(owner('first-visit'));
  const internals=f.manager as unknown as {serialized<T>(work:()=>Promise<T>):Promise<T>;compose(publication:unknown,forSave?:boolean):Promise<void>;publication():unknown;retainedCheck:Promise<void>|null};
  await internals.retainedCheck;
  vi.spyOn(runtime,'isReady').mockReturnValue(false);vi.spyOn(runtime,'refreshReadiness').mockResolvedValue(false as never);
  let release!:()=>void;const held=new Promise<void>(resolve=>{release=resolve;});
  const check=vi.spyOn(runtime,'confirmLocalAcknowledgedSource').mockImplementation(async()=>{await held;return undefined as never;});
  try{
   const started=Date.now();
   await internals.serialized(()=>internals.compose(internals.publication()));
   expect(check).toHaveBeenCalledTimes(1);expect(internals.retainedCheck).not.toBeNull();
   // A save goes through while the history check is still running, and does not start a second one.
   expect(await f.manager.ensureOwner(owner('save-during-history-check'))).toBe(runtime);
   await internals.serialized(()=>internals.compose(internals.publication()));
   expect(Date.now()-started).toBeLessThan(5000);expect(check).toHaveBeenCalledTimes(1);
  }finally{release();}
  await internals.retainedCheck;expect(internals.retainedCheck).toBeNull();
  // Once it has finished, the next pass may start a new one.
  await internals.serialized(()=>internals.compose(internals.publication()));expect(check).toHaveBeenCalledTimes(2);
  await internals.retainedCheck;
 });
 it('names an owner step that held the one-at-a-time lane for more than 2 s, once a minute per step',async()=>{
  const f=await fixture(),step=f.manager as unknown as {ownerStepValue:string;ownerStepAt:number};const warn=vi.spyOn(console,'warn');
  const slow=(name:string)=>{step.ownerStepValue=name;step.ownerStepAt=Date.now()-3_000;step.ownerStepValue='nothing (idle)';};
  slow('the local history check');slow('the local history check');step.ownerStepValue='checking the other machines';step.ownerStepValue='nothing (idle)';
  const lines=warn.mock.calls.map(call=>String(call[0])).filter(line=>line.startsWith('[conversation-graph] the owner step spent'));
  expect(lines).toEqual(['[conversation-graph] the owner step spent 3.0 s on the local history check']);
 });
 it('refuses renamed agent roots and missing acknowledged storage instead of creating another genesis',async()=>{
  const f=await fixture();await f.manager.ensureOwner({principalKey:'owner:default-agent',authenticationMethod:'owner-dashboard',requestId:'first-visit',isCurrent:()=>true});await f.manager.close();managers.splice(managers.indexOf(f.manager),1);
  const renamed=new ConversationGraphDefault({...f.options,agentId:'renamed-agent'});managers.push(renamed);await expect(renamed.restore()).rejects.toThrow('rename-requires-migration');
  const database=path.join(f.stateDir,'conversation-graph','custody.sqlite');SafeFsExecutor.safeUnlinkSync(database,{operation:'graph-default-boot-test:lost-custody-disk'});const lost=new ConversationGraphDefault(f.options);managers.push(lost);await expect(lost.restore()).rejects.toThrow();expect(fs.existsSync(database)).toBe(false);
 });
});
