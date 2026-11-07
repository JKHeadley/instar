import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import {expect,it} from 'vitest';
import {ConversationGraphDefault} from '../../src/server/ConversationGraphDefault.js';
import {createConversationGraphDefaultSurface} from '../../src/server/ConversationGraphDefaultSurface.js';
import {SingleInstanceLock} from '../../src/core/SingleInstanceLock.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {ScopeVerifier} from '../../src/core/ScopeVerifier.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';

it('does not advertise local intake after the actual default manager has closed',async()=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-local-capability-'));
 const lock=new SingleInstanceLock({stateDir});
 expect((await lock.acquire()).acquired).toBe(true);
 const manager=new ConversationGraphDefault({stateDir,agentId:'echo',instanceLock:lock,secrets:new SecretStore({stateDir,forceFileKey:true}),bootstrapBearer:'capability-fixture-token'});
 try{
  const app=express();app.use(express.json());
  app.use(createConversationGraphDefaultSurface({manager,stateDir,readEnabled:true,correctionsEnabled:true,
   scope:new ScopeVerifier({projectName:'instar',projectDir:stateDir}),telegramChatId:'-1001',pairing:null,
   verifyDashboardOwner:token=>token==='fixture-owner',dashboardPolicy:()=>({pin:'fixture-pin',generation:'11111111-1111-4111-8111-111111111111'}),forceFileKey:true}));
  await manager.close();
  const response=await request(app).get('/conversation-graph/roots').set('X-Instar-Operator-Session','fixture-owner');
  expect(response.status).toBe(503);
  expect(response.body).toMatchObject({code:'conversation-graph-pending',capabilities:{recordLocal:false,canonical:false}});
 }finally{
  await manager.close();lock.release();
  SafeFsExecutor.safeRmSync(stateDir,{recursive:true,force:true,operation:'graph-local-capability-test-cleanup'});
 }
});

it('advertises actual self-sealed intake without inventing a profile when enrolled fleet services are absent',async()=>{
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-local-enrollment-'));
 const otherDir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-local-other-'));
 const local=new MachineIdentityManager(stateDir),other=new MachineIdentityManager(otherDir);
 await local.generateIdentity();await other.generateIdentity();
 const remote=other.loadIdentity();new IdentityStore({stateDir}).apply({identity:remote,scope:'remote',actor:'pairing-trust',path:'pair'});local.registerMachine(remote,'standby');
 const lock=new SingleInstanceLock({stateDir});expect((await lock.acquire()).acquired).toBe(true);
 const manager=new ConversationGraphDefault({stateDir,agentId:'echo',instanceLock:lock,secrets:new SecretStore({stateDir,forceFileKey:true}),bootstrapBearer:'capability-fixture-token'});
 try{
  const app=express();app.use(express.json());
  app.use(createConversationGraphDefaultSurface({manager,stateDir,readEnabled:true,correctionsEnabled:true,
   scope:new ScopeVerifier({projectName:'instar',projectDir:stateDir}),telegramChatId:'-1001',pairing:null,
   verifyDashboardOwner:token=>token==='fixture-owner',dashboardPolicy:()=>({pin:'fixture-pin',generation:'11111111-1111-4111-8111-111111111111'}),forceFileKey:true}));
  const roots=await request(app).get('/conversation-graph/roots').set('X-Instar-Operator-Session','fixture-owner');
  expect(roots.status).toBe(503);expect(roots.body.capabilities).toEqual({recordLocal:true,canonical:false});
  const recorded=await request(app).post('/conversation-graph/changes').set('X-Instar-Operator-Session','fixture-owner')
   .send({requestId:'actual-enrolled-local-intent',change:{kind:'create-effort',projectScope:[]}});
  expect(recorded.status).toBe(202);expect(recorded.body.state).toBe('recorded-local');
  expect(manager.runtime).toBeNull();expect(fs.existsSync(path.join(stateDir,'conversation-graph','custody.sqlite'))).toBe(false);
 }finally{
  await manager.close();lock.release();
  for(const directory of [stateDir,otherDir])SafeFsExecutor.safeRmSync(directory,{recursive:true,force:true,operation:'graph-local-capability-test-cleanup'});
 }
});
