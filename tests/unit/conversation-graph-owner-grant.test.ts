import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {ConversationGraphOwnerGrantStore} from '../../src/server/ConversationGraphOwnerGrant.js';
const directories:string[]=[];
afterEach(()=>{for(const dir of directories.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-owner-grant-test:teardown'});});
function fixture(){
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-owner-grant-'));directories.push(stateDir);
 const secrets=new SecretStore({stateDir,forceFileKey:true});let policy:string|null='synthetic-private-operator-policy',generation=crypto.randomUUID();
 const options={stateDir,agentId:'agent-a',secrets,dashboardPolicy:()=>policy?{pin:policy,generation}:null};
 return{stateDir,secrets,options,store:new ConversationGraphOwnerGrantStore(options),setPolicy:(next:string|null)=>{policy=next;generation=crypto.randomUUID();}};
}
describe('durable request-scoped dashboard owner admission',()=>{
 it('survives restart without persisting the PIN/session and binds the exact logical request',()=>{
  const f=fixture(),key='owner-change:opaque-request',admission=f.store.capture(key,'owner:agent-a');
  const restarted=new ConversationGraphOwnerGrantStore(f.options);
  expect(restarted.isCurrent(admission.grantId,key,'owner:agent-a')).toBe(true);
  expect(restarted.capture(key,'owner:agent-a')).toEqual(admission);
  expect(restarted.isCurrent(admission.grantId,'owner-change:another','owner:agent-a')).toBe(false);
  expect(restarted.isCurrent(admission.grantId,key,'owner:another')).toBe(false);
  const files=fs.readdirSync(path.join(f.stateDir,'conversation-graph','owner-intent-grants'));
  const persisted=files.map(file=>fs.readFileSync(path.join(f.stateDir,'conversation-graph','owner-intent-grants',file),'utf8')).join('');
  expect(persisted).not.toContain('synthetic-private-operator-policy');expect(persisted).not.toContain('sessionToken');
 });
 it('refuses the original grant after actual policy rotation or disablement instead of silently replacing it',()=>{
  const f=fixture(),key='owner-change:opaque-request',admission=f.store.capture(key,'owner:agent-a');
  f.setPolicy('rotated-private-operator-policy');expect(f.store.isCurrent(admission.grantId,key,'owner:agent-a')).toBe(false);
  expect(()=>f.store.capture(key,'owner:agent-a')).toThrow('owner-revoked');
  const next=f.store.capture('owner-change:new-request','owner:agent-a');expect(f.store.isCurrent(next.grantId,'owner-change:new-request','owner:agent-a')).toBe(true);
  f.setPolicy(null);expect(f.store.isCurrent(next.grantId,'owner-change:new-request','owner:agent-a')).toBe(false);
  expect(()=>f.store.capture('owner-change:disabled','owner:agent-a')).toThrow('owner-unavailable');
 });
 it('does not revive an old intent when a retired PIN is reused, including across process restart',()=>{
  const f=fixture(),key='owner-change:opaque-request',admission=f.store.capture(key,'owner:agent-a');
  f.setPolicy('second-private-policy');f.store.observePolicy();
  f.setPolicy('synthetic-private-operator-policy');const restarted=new ConversationGraphOwnerGrantStore(f.options);restarted.observePolicy();
  expect(restarted.isCurrent(admission.grantId,key,'owner:agent-a')).toBe(false);
  const next=restarted.capture('owner-change:new-request','owner:agent-a');expect(restarted.isCurrent(next.grantId,'owner-change:new-request','owner:agent-a')).toBe(true);
  f.setPolicy(null);restarted.observePolicy();f.setPolicy('synthetic-private-operator-policy');restarted.observePolicy();
  expect(restarted.isCurrent(next.grantId,'owner-change:new-request','owner:agent-a')).toBe(false);
 });
 it('quarantines missing policy key with existing grant records, and rejects corrupted grant metadata',()=>{
  const f=fixture(),key='owner-change:opaque-request',admission=f.store.capture(key,'owner:agent-a');
  f.secrets.delete('conversation_graph_owner_intent_policy_key');
  expect(f.store.isCurrent(admission.grantId,key,'owner:agent-a')).toBe(false);
  expect(()=>f.store.capture('owner-change:new-request','owner:agent-a')).toThrow('policy-key-missing');
  const directory=path.join(f.stateDir,'conversation-graph','owner-intent-grants'),file=fs.readdirSync(directory)[0];
  fs.writeFileSync(path.join(directory,file),'{"unexpected":"authority"}');
  expect(f.store.isCurrent(admission.grantId,key,'owner:agent-a')).toBe(false);
 });
 it('does not revive an old admission by transplanting a new policy marker',()=>{
  const f=fixture(),oldKey='owner-change:old-request',old=f.store.capture(oldKey,'owner:agent-a');
  const directory=path.join(f.stateDir,'conversation-graph','owner-intent-grants');
  const oldFile=fs.readdirSync(directory)[0],oldBody=JSON.parse(fs.readFileSync(path.join(directory,oldFile),'utf8'));
  f.setPolicy('new-private-policy');f.store.capture('owner-change:new-request','owner:agent-a');
  const newFile=fs.readdirSync(directory).find(file=>file!==oldFile)!,newBody=JSON.parse(fs.readFileSync(path.join(directory,newFile),'utf8'));
  fs.writeFileSync(path.join(directory,oldFile),JSON.stringify({...oldBody,policyMarker:newBody.policyMarker}));
  expect(f.store.isCurrent(old.grantId,oldKey,'owner:agent-a')).toBe(false);
 });
 it('rejects inherited graph-directory links before writing private grant files',()=>{
  const f=fixture(),outside=fs.mkdtempSync(path.join(os.tmpdir(),'graph-grant-outside-'));directories.push(outside);
  fs.symlinkSync(outside,path.join(f.stateDir,'conversation-graph'),'dir');
  expect(()=>f.store.capture('owner-change:linked','owner:agent-a')).toThrow('symlink');
  expect(fs.readdirSync(outside)).toEqual([]);
 });
});
