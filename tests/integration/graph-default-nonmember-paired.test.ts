/** Paired machines that are not signed graph members (CMT-1437 items 2 and 3),
 * driven through the actual registered native peers. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import type {Server} from 'node:http';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {setupGraphDefaultNativePeers} from '../helpers/graph-default-planned-transition.js';
import {ConversationGraphDefault} from '../../src/server/ConversationGraphDefault.js';
import {createConversationGraphDefaultSurface} from '../../src/server/ConversationGraphDefaultSurface.js';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {CoherenceJournal} from '../../src/core/CoherenceJournal.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
// Multi-machine graph proof: takes longer than the push lane's 10 s default on slower Linux CI runners.
vi.setConfig({testTimeout:120_000});

const PUBLICATION_MARKER='conversation_graph_owned_publication';
const managers:ConversationGraphDefault[]=[],servers:Server[]=[],journals:CoherenceJournal[]=[],dirs:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const server of servers.splice(0)){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}for(const manager of managers.splice(0))await manager.close();for(const journal of journals.splice(0))journal.close();for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'tests/integration/graph-default-nonmember-paired:cleanup'});});
const owner=(requestId:string)=>({principalKey:'owner:echo',authenticationMethod:'owner-dashboard' as const,requestId,isCurrent:()=>true});

/** Two signed members plus one more machine paired to both, never joined. */
async function fixture(chosen:()=>readonly string[]|undefined){
 const f=await setupGraphDefaultNativePeers({track:{managers,servers,journals},genesisMembers:chosen});
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-nonmember-'));dirs.push(dir);const outsider=new MachineIdentityManager(dir);await outsider.generateIdentity({role:'standby'});const identity=outsider.loadIdentity();
 for(const options of f.native.options){const manager=new MachineIdentityManager(options.stateDir);new IdentityStore({stateDir:manager.baseDir}).apply({identity,scope:'remote',actor:'pairing-trust',path:'pair'});manager.registerMachine(identity,'standby');}
 return{...f,ids:f.native.managers.map(manager=>manager.loadIdentity().machineId),outsiderId:identity.machineId};
}

describe('paired machines outside the signed membership',()=>{
 it('finishes a pin interrupted before its anchor once more machines are paired than were signed',async()=>{
  let chosen:readonly string[]|undefined;const f=await fixture(()=>chosen);chosen=[f.ids[0],f.ids[1]];
  // The crash point: the follower durably pins the genesis, then dies before it writes the publication anchor.
  const follower=f.secrets[1],realSet=follower.set.bind(follower);let crashed=false;
  vi.spyOn(follower,'set').mockImplementation((key,value)=>{if(key===PUBLICATION_MARKER&&!crashed){crashed=true;throw new Error('simulated-crash-before-anchor');}return realSet(key,value);});
  await f.defaults[0].ensureOwner(owner('genesis-before-crash')).catch(()=>undefined);
  expect(crashed).toBe(true);expect(follower.get(PUBLICATION_MARKER)).toBeUndefined();
  // The pinned genesis is on disk; only its anchor is missing.
  expect(fs.existsSync(path.join(fs.realpathSync(f.native.options[1].stateDir),'conversation-graph','bootstrap',canonicalHash('echo'),'publication.json'))).toBe(true);
  // The choice is read only before a graph exists, so a restarted machine may no longer carry it.
  chosen=undefined;

  // Next boot of the follower: a fresh process over the same state.
  const prior=f.native.options[1],{configuration:_legacy,...nativeOnly}=prior,stateDir=prior.stateDir;
  let reopened:ConversationGraphDefault;const journal=new CoherenceJournal({stateDir,machineId:prior.identity.loadIdentity().machineId,onReplicatedRecordsCommitted:(kind,entries)=>reopened?.runtime?.onJournalCommit(kind,entries)});journal.setReplicatedKindRegistry(prior.registry);journal.open();journals.push(journal);
  reopened=new ConversationGraphDefault({stateDir,agentId:'echo',instanceLock:prior.instanceLock,secrets:new SecretStore({stateDir,forceFileKey:true}),fleet:{...nativeOnly,journal}});managers.push(reopened);
  const boot=await reopened.restore().then(()=>null,(error:Error)=>error.message);
  // The genesis opens on this boot. What may remain is the host's peer bearer, which the host delivers on its next distribute.
  expect([null,'graph-peer-token-purpose-unverified']).toContain(boot);
  // The interrupted pin is finished: the anchor exists and the outsider is known as not joined.
  expect(new SecretStore({stateDir,forceFileKey:true}).get(PUBLICATION_MARKER)).toBeDefined();
  expect(reopened.unjoinedMachines()).toEqual([f.outsiderId]);
  await reopened.close();

  // The graph then comes up on both signed members on the next owner visit.
  vi.restoreAllMocks();
  const host=await f.defaults[0].ensureOwner(owner('after-crash-host'));const peer=await f.defaults[1].ensureOwner(owner('after-crash-follower'));
  expect(host.installedMembership.members.map(member=>member.machineId).sort()).toEqual([f.ids[0],f.ids[1]].sort());
  expect(peer.installedMembership).toEqual(host.installedMembership);
  expect(f.defaults[1].unjoinedMachines()).toEqual([f.outsiderId]);
 });

 it('still refuses to finish an unanchored pin when a signed member is no longer paired',async()=>{
  let chosen:readonly string[]|undefined;const f=await fixture(()=>chosen);chosen=[f.ids[0],f.ids[1]];
  const follower=f.secrets[1],realSet=follower.set.bind(follower);let crashed=false;
  vi.spyOn(follower,'set').mockImplementation((key,value)=>{if(key===PUBLICATION_MARKER&&!crashed){crashed=true;throw new Error('simulated-crash-before-anchor');}return realSet(key,value);});
  await f.defaults[0].ensureOwner(owner('genesis-before-unpair')).catch(()=>undefined);expect(crashed).toBe(true);vi.restoreAllMocks();chosen=undefined;
  // The host is unpaired from the follower's view: its signed member entry no longer matches any paired machine.
  const registry=f.native.managers[1].loadRegistry();registry.machines[f.ids[0]].status='revoked' as never;registry.machines[f.ids[0]].revokedAt=new Date().toISOString() as never;f.native.managers[1].saveRegistry(registry);
  await expect(f.defaults[1].restore()).rejects.toThrow('graph-bootstrap-publication-invalid');
  expect(follower.get(PUBLICATION_MARKER)).toBeUndefined();
 });

 it('names the paired machine outside the graph when it holds the lease, instead of leaving changes recorded-local with no reason',async()=>{
  let chosen:readonly string[]|undefined;const f=await fixture(()=>chosen);chosen=[f.ids[0],f.ids[1]];
  for(let i=0;i<2;i++){f.apps[i].use(express.json({limit:'64kb'}));f.apps[i].use(createConversationGraphDefaultSurface({manager:f.defaults[i],stateDir:f.native.options[i].stateDir,readEnabled:true,correctionsEnabled:true,scope:f.native.options[i].scopeVerifier!,telegramChatId:'-1001',pairing:null,verifyDashboardOwner:token=>token==='actual-fixture-owner',dashboardPolicy:()=>({pin:'fixture-owner-policy',generation:'11111111-1111-4111-8111-111111111111'}),forceFileKey:true}));}
  const headers={'X-Instar-Operator-Session':'actual-fixture-owner','content-type':'application/json'};
  const post=async(requestId:string)=>{const response=await fetch(f.origins[1]+'/conversation-graph/changes',{method:'POST',headers,body:JSON.stringify({requestId,change:{kind:'create-effort',projectScope:['instar']}})});return{status:response.status,body:await response.json()};};
  const status=async(requestId:string)=>{const response=await fetch(f.origins[1]+'/conversation-graph/changes/'+requestId,{headers});return{status:response.status,body:await response.json()};};
  const first=await post('while-a-member-holds');expect([200,202],JSON.stringify(first.body)).toContain(first.status);await f.defaults[0].runtime!.reconcilePending();await f.defaults[1].runtime!.reconcilePending();
  const committed=await status('while-a-member-holds');expect(committed.body.state,JSON.stringify(committed.body)).toBe('committed');expect(committed.body.blockedBy).toBeUndefined();
  // The lease moves to the paired machine that never joined.
  for(const options of f.native.options){vi.spyOn(options.leaseCoordinator,'currentHolder').mockReturnValue(f.outsiderId);vi.spyOn(options.leaseCoordinator,'holdsLease').mockReturnValue(false);}
  expect(f.defaults[1].runtime!.writerOutsideMembership()).toBe(f.outsiderId);expect(f.defaults[1].writerOutsideGraph()).toBe(f.outsiderId);
  const waiting=await post('while-the-outsider-holds');expect(waiting.status,JSON.stringify(waiting.body)).toBe(202);expect(waiting.body.state).toBe('recorded-local');
  expect(waiting.body.blockedBy).toEqual({reason:'writer-not-joined',machine:{machineId:f.outsiderId,name:expect.any(String)}});
  await f.defaults[1].runtime!.reconcilePending();
  const later=await status('while-the-outsider-holds');expect(later.status).toBe(202);expect(later.body.state).toBe('recorded-local');expect(later.body.blockedBy?.machine.machineId).toBe(f.outsiderId);
  const pending=await (await fetch(f.origins[1]+'/conversation-graph/pending',{headers})).json();expect(JSON.stringify(pending)).toContain('writer-not-joined');
  // Back on a member: the reason goes away.
  vi.restoreAllMocks();expect(f.defaults[1].runtime!.writerOutsideMembership()).toBeNull();expect(f.defaults[1].writerOutsideGraph()).toBeNull();
  const back=await status('while-the-outsider-holds');expect(back.body.blockedBy,JSON.stringify(back.body)).toBeUndefined();
 });
});
