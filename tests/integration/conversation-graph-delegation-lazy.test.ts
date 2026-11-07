/** Real lazy default owner admission + isolated tmux bootstrap + solo ownership
 * CAS + signed delegation through actual source/witness custody. No model run. */
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import crypto from 'node:crypto';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
import {it,expect,vi} from 'vitest';
import {ConversationGraphDefault} from '../../src/server/ConversationGraphDefault.js';
import {ConversationGraphDelegationManager} from '../../src/server/ConversationGraphDelegationManager.js';
import {createConversationGraphDelegationFactory} from '../../src/server/ConversationGraphDelegationFactory.js';
import {StateManager} from '../../src/core/StateManager.js';import {ConversationRegistry} from '../../src/core/ConversationRegistry.js';import {createConversationBindAuth} from '../../src/core/conversationBindToken.js';import {TelegramAdapter} from '../../src/messaging/TelegramAdapter.js';import {ScopeVerifier} from '../../src/core/ScopeVerifier.js';import {SecretStore} from '../../src/core/SecretStore.js';import {SingleInstanceLock} from '../../src/core/SingleInstanceLock.js';import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const run=promisify(execFile);
it('awaits first owner publication, derives real solo CAS, retries failed directory barrier and commits original signed spawn once',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-lazy-')),tmux=path.join(dir,'tmux'),socket=`graph-lazy-${crypto.randomUUID()}`;
 fs.writeFileSync(tmux,`#!/bin/sh\nexec /opt/homebrew/bin/tmux -L '${socket}' "$@"\n`,{mode:0o700});
 const lock=new SingleInstanceLock({stateDir:dir});expect((await lock.acquire()).acquired).toBe(true);
 const state=new StateManager(dir),auth=createConversationBindAuth(dir),conversations=new ConversationRegistry({stateDir:dir,machineId:()=>manager.nativeDelegationDependencies!.identity.loadIdentity().machineId});
 const telegram=new TelegramAdapter({token:'',chatId:'-1001'},dir,{suppressLifelineAutoCreate:true});
 const scope=new ScopeVerifier({projectName:'instar',projectDir:dir,topicProjects:{'42':{projectName:'instar',projectDir:dir},'43':{projectName:'instar',projectDir:dir}}});
 const manager=new ConversationGraphDefault({stateDir:dir,agentId:'lazy-agent',instanceLock:lock,secrets:new SecretStore({stateDir:dir,forceFileKey:true}),bootstrapBearer:'isolated-test-bearer',scopeVerifier:scope,telegramChatId:'-1001'});
 const lazy=new ConversationGraphDelegationManager();const stop=manager.subscribeRuntime(runtime=>lazy.publish(runtime));
 lazy.setFactory(createConversationGraphDelegationFactory({state,bindAuth:auth,conversations,scopeVerifier:scope,telegram,telegramChatId:'-1001',tmuxPath:tmux,native:()=>manager.nativeDelegationDependencies,ownership:()=>null}));
 try{
  expect((await lazy.get()).status).toBe('held');expect(await manager.restore()).toBeNull();
  const runtime=await manager.ensureOwner({principalKey:'owner:lazy-agent',authenticationMethod:'owner-device',requestId:'lazy-first-owner',isCurrent:()=>true});
  const binding=await lazy.get();expect(binding.status).toBe('ready');if(binding.status!=='ready')throw new Error('expected actual composition');expect(binding.remote).toBeNull();
  const now=Date.now();for(const [id,name,topic] of [['parent-id','parent',42],['child-id','child',43]] as const){state.saveSession({id,name,tmuxSession:name,status:'running',startedAt:new Date(now-1000).toISOString()});telegram.registerTopicSession(topic,name);}
  const parent=auth.mint('parent',[42]),child=auth.mint('child',[43]);
  expect(await binding.local.afterSuccessfulSpawn(parent,'child-id')).toMatchObject({status:'refused'});
  await run(tmux,['new-session','-d','-s','parent','-e',`INSTAR_BIND_TOKEN=${parent}`,'-e','INSTAR_SESSION_ID=parent-id','sleep 60']);
  await run(tmux,['new-session','-d','-s','child','-e',`INSTAR_BIND_TOKEN=${child}`,'-e','INSTAR_SESSION_ID=child-id','sleep 60']);
  await run(tmux,['set-environment','-t','=parent','INSTAR_SESSION_ID','stale-parent-id']);
  expect(await binding.local.afterSuccessfulSpawn(parent,'child-id')).toMatchObject({status:'refused',reason:'parent-bootstrap-incarnation-proof-required'});
  expect(fs.existsSync(path.join(dir,'ownership','local','42.json'))).toBe(false);
  await run(tmux,['set-environment','-t','=parent','INSTAR_SESSION_ID','parent-id']);
  const real=fs.fsyncSync,ownershipDir=path.join(dir,'ownership','local');let barriers=0;
  const fault=vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.existsSync(ownershipDir)&&fs.fstatSync(fd).isDirectory()&&fs.fstatSync(fd).ino===fs.statSync(ownershipDir).ino){barriers++;throw new Error('injected-ownership-directory-barrier');}return real(fd);});
  expect(await binding.local.afterSuccessfulSpawn(parent,'child-id')).toMatchObject({status:'refused'});expect(barriers).toBeGreaterThan(0);
  expect(await binding.local.afterSuccessfulSpawn(parent,'child-id')).toMatchObject({status:'refused'});fault.mockRestore();
  const result=await binding.local.afterSuccessfulSpawn(parent,'child-id');expect(result).toMatchObject({status:'prepared-local',coordinatorNotified:true});
  const records=runtime.source.recordsForRepair().filter(r=>r.coreType==='graph-event'&&r.core.authority==='delegation');expect(records).toHaveLength(1);expect(records[0].certificate).toBeDefined();expect(runtime.source.verifyHistoricalRecord(records[0])).toBe(true);
  expect(records[0].core).toMatchObject({parent:{topicId:42},subject:{topicId:43},relation:'delegates-to'});
  lazy.publish(runtime);expect(await lazy.get()).toBe(binding);expect(await binding.local.afterSuccessfulSpawn(parent,'child-id')).toMatchObject({coordinatorNotified:true});expect(runtime.source.recordsForRepair().filter(r=>r.core.authority==='delegation')).toHaveLength(1);
 }finally{vi.restoreAllMocks();stop();await lazy.close();await manager.close();await conversations.close();lock.release();await run(tmux,['kill-server']).catch(()=>{});SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-lazy-test-owned-teardown'});}
});
