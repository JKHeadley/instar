import {SecretStore} from '../../src/core/SecretStore.js';
import {LiveConfig} from '../../src/config/LiveConfig.js';
import {initializeConversationGraphOwnerPolicy} from '../../src/core/ConversationGraphOwnerPolicy.js';
import {DASHBOARD_PIN_GENERATION_HEAD} from '../../src/core/DashboardPinGeneration.js';
import {afterEach,describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {openConversationGraphStandalone,type ConversationGraphStandalone} from '../../src/server/ConversationGraphStandalone.js';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';
import {FencedLease} from '../../src/core/FencedLease.js';
import {LeaseCoordinator} from '../../src/core/LeaseCoordinator.js';
import {SingleInstanceLock} from '../../src/core/SingleInstanceLock.js';
import {verifyMembershipEpoch,signGraphRecord,GRAPH_SIGNATURE_DOMAINS,type GraphMembershipEpoch} from '../../src/core/GraphWitnessTypes.js';
import type {MachineIdentity} from '../../src/core/types.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const dirs:string[]=[],opened:ConversationGraphStandalone[]=[],locks:SingleInstanceLock[]=[];
function directory(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-standalone-'));dirs.push(dir);return dir;}
const pem=(encoded:string)=>crypto.createPublicKey({key:Buffer.from(encoded,'base64'),format:'der',type:'spki'}).export({format:'pem',type:'spki'}).toString();
function enrollmentFactory(){const owner=crypto.generateKeyPairSync('ed25519');return {owner,create:(identity:MachineIdentity)=>{
 const raw={v:1 as const,agentId:'standalone-agent',epoch:1,previousMembershipHash:null,members:[{machineId:identity.machineId,signingPublicKey:pem(identity.signingPublicKey),sealingPublicKey:pem(identity.encryptionPublicKey)}],writerId:identity.machineId,witnessId:'owned-custody-role',failureDomain:'owned-machine',createdAt:new Date().toISOString()};
 return {ownerPublicKey:owner.publicKey,membership:{...raw,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.membership,raw,owner.privateKey)} satisfies GraphMembershipEpoch};
 }};}
async function open(stateDir:string,factory= enrollmentFactory(),instanceLock?:SingleInstanceLock){const result=await openConversationGraphStandalone({stateDir,instanceLock,enrollment:async identity=>factory.create(identity)});opened.push(result);return result;}
afterEach(async()=>{vi.restoreAllMocks();vi.unstubAllEnvs();for(const helper of opened.splice(0))await helper.close();for(const lock of locks.splice(0))lock.release();for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-standalone-test:teardown'});});
describe('real one-member Conversations native composition',()=>{
 it.each(['identity-epoch','unacknowledged','transaction','phone-ledger'] as const)('does not mint a replacement identity over retained native evidence: %s',async kind=>{
  const stateDir=directory(),secrets=new SecretStore({stateDir,forceFileKey:true});secrets.set('ordinary-fixture-setting','fixture-value');secrets.syncDurably();
  const identities=new IdentityStore({stateDir}),file=kind==='identity-epoch'?identities.epochPath:kind==='unacknowledged'?identities.unacknowledgedPath:kind==='transaction'?identities.transactionPath:path.join(stateDir,'mobile-device-key-ledger.jsonl');fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'retained prior native evidence');
  await expect(open(stateDir)).rejects.toThrow(kind==='transaction'?'journal is unreadable':'identity-recovery-required');expect(new MachineIdentityManager(stateDir).hasIdentity()).toBe(false);expect(fs.readFileSync(file,'utf8')).toBe('retained prior native evidence');
 });

 it('retains the actual non-native SecretStore master while creating its first native identity',async()=>{
  const stateDir=directory(),secrets=new SecretStore({stateDir,forceFileKey:true});secrets.set('ordinary-fixture-setting','fixture-value');secrets.syncDurably();
  const file=path.join(stateDir,'machine','secrets-master.key'),bytes=fs.readFileSync(file),inode=fs.statSync(file).ino;
  expect(new MachineIdentityManager(stateDir).hasIdentity()).toBe(false);const helper=await open(stateDir);expect(helper.leaseCoordinator.holdsLease()).toBe(true);expect(fs.readFileSync(file)).toEqual(bytes);expect(fs.statSync(file).ino).toBe(inode);expect(secrets.get('ordinary-fixture-setting')).toBe('fixture-value');
 });
 it.each(['bad-size','public-mode','hardlink','linked-directory'] as const)('never ignores malformed or linked non-native backing state: %s',async kind=>{
  const stateDir=directory(),machine=path.join(stateDir,'machine');fs.mkdirSync(machine);const file=path.join(machine,'secrets-master.key');fs.writeFileSync(file,'a'.repeat(64),{mode:0o600});
  if(kind==='bad-size')fs.writeFileSync(file,'invalid');else if(kind==='public-mode')fs.chmodSync(file,0o644);else if(kind==='hardlink')fs.linkSync(file,path.join(stateDir,'master-copy'));else{SafeFsExecutor.safeUnlinkSync(file,{operation:'standalone-fixture:replace-machine-dir'});SafeFsExecutor.safeRmSync(machine,{recursive:true,force:true,operation:'standalone-fixture:replace-machine-dir'});fs.symlinkSync(directory(),machine);}
  await expect(open(stateDir)).rejects.toThrow('identity-recovery-required');expect(new MachineIdentityManager(stateDir).hasIdentity()).toBe(false);
 });

 it('opens a genuinely blank native home after the actual managed PIN writer publishes its policy HEAD',async()=>{
  const stateDir=directory();fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify({dashboardPin:'synthetic-owner-pin',secrets:{forceFileKey:true}}));
  const policy=initializeConversationGraphOwnerPolicy({stateDir,liveConfig:new LiveConfig(stateDir),forceFileKey:true});expect(policy).not.toBeNull();expect(new MachineIdentityManager(stateDir).hasIdentity()).toBe(false);
  const helper=await open(stateDir);expect(helper.identity.hasIdentity()).toBe(true);expect(helper.leaseCoordinator.holdsLease()).toBe(true);
 });
 it.each(['private-extra','duplicate-field','wrong-generation','prior-custody','linked-head'] as const)('never treats invalid policy or custody evidence as a blank home: %s',async kind=>{
  const stateDir=directory();fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify({dashboardPin:'synthetic-owner-pin',secrets:{forceFileKey:true}}));initializeConversationGraphOwnerPolicy({stateDir,liveConfig:new LiveConfig(stateDir),forceFileKey:true});
  const file=path.join(stateDir,DASHBOARD_PIN_GENERATION_HEAD),head=JSON.parse(fs.readFileSync(file,'utf8'));
  if(kind==='private-extra')fs.writeFileSync(file,JSON.stringify({...head,privateBody:'must-not-be-classified-as-public'}));
  else if(kind==='duplicate-field')fs.writeFileSync(file,'{\"version\":1,\"generation\":\"private-hidden-value\",\"generation\":'+JSON.stringify(head.generation)+'}\n');
  else if(kind==='wrong-generation'){const config=JSON.parse(fs.readFileSync(path.join(stateDir,'config.json'),'utf8'));config.dashboardPinGeneration=crypto.randomUUID();fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify(config));}
  else if(kind==='prior-custody')fs.mkdirSync(path.join(stateDir,'conversation-graph','bootstrap'),{recursive:true});
  else fs.linkSync(file,file+'.unowned-copy');
  await expect(open(stateDir)).rejects.toThrow('identity-recovery-required');expect(new MachineIdentityManager(stateDir).hasIdentity()).toBe(false);
 });

 it('uses real signed native acquisition, cluster admission and durable identity through clean restart',async()=>{
  const stateDir=directory(),factory=enrollmentFactory(),first=await open(stateDir,factory);
  const identity=first.identity.loadIdentity(),lease=first.leaseCoordinator.currentLease()!;
  expect(first.nativeLease).toBeInstanceOf(FencedLease);expect(first.leaseCoordinator).toBeInstanceOf(LeaseCoordinator);expect(first.identities).toBeInstanceOf(IdentityStore);
  expect(first.instanceLock.revalidate()).toBe(true);expect(first.leaseCoordinator.holdsLease()).toBe(true);expect(first.nativeLease.verifyLease(lease)).toBe(true);
  expect(first.writeAdmission.guardStoreWrite('conversationGraph.append').enforce).not.toBe('refuse');
  expect(first.writeDomainRegistry.domainForOp('conversationGraph.append').domain).toBe('cluster-shared');
  expect(verifyMembershipEpoch(first.enrollment.membership,factory.owner.publicKey)).toBe(true);
  expect(JSON.parse(fs.readFileSync(path.join(stateDir,'local','conversation-graph-native-lease.json'),'utf8')).lease).toEqual(lease);
  first.start();await first.close();expect(()=>first.leaseCoordinator.holdsLease()).toThrow('lease-fenced');
  const second=await open(stateDir,factory);expect(second.identity.loadIdentity()).toEqual(identity);expect(second.leaseCoordinator.holdsLease()).toBe(true);
  expect(second.leaseCoordinator.currentEpoch()).toBeGreaterThanOrEqual(lease.epoch);expect(second.leaseCoordinator.currentLease()!.nonce).toBeGreaterThan(lease.nonce);
 });
 it('reuses but never releases the caller lifetime lock',async()=>{
  const stateDir=directory(),lock=new SingleInstanceLock({stateDir});locks.push(lock);expect((await lock.acquire()).acquired).toBe(true);
  const helper=await open(stateDir,enrollmentFactory(),lock);await helper.close();expect(lock.revalidate()).toBe(true);
  const wrongStateDir=directory();await expect(open(wrongStateDir,enrollmentFactory(),lock)).rejects.toThrow('instance-lock-required');expect(fs.existsSync(path.join(wrongStateDir,'machine','identity.json'))).toBe(false);
 });
 it('refuses missing/forged or multi-member owner enrollment without granting a local lease',async()=>{
  for(const kind of ['forged','multiple'] as const){const stateDir=directory(),factory=enrollmentFactory();
   await expect(openConversationGraphStandalone({stateDir,enrollment:async identity=>{const result=factory.create(identity);
    if(kind==='forged')result.membership.signature='A'.repeat(86);
    else{const member={...result.membership.members[0],machineId:'other-installed'};const {signature:_signature,...raw}=result.membership;const multiple={...raw,members:[...raw.members,member]};result.membership={...multiple,signature:signGraphRecord(GRAPH_SIGNATURE_DOMAINS.membership,multiple,factory.owner.privateKey)};}
    return result;}})).rejects.toThrow('single-member-enrollment-required');
   expect(fs.existsSync(path.join(stateDir,'local','conversation-graph-native-lease.json'))).toBe(false);
  }
 });
 it('refuses any other registry obligation, including a revoked former peer',async()=>{
  const stateDir=directory(),local=new MachineIdentityManager(stateDir);await local.generateIdentity();
  const remote=new MachineIdentityManager(directory());await remote.generateIdentity();const peer=remote.loadIdentity();
  new IdentityStore({stateDir}).apply({identity:peer,scope:'remote',actor:'pairing-trust',path:'pair'});local.registerMachine(peer,'standby');
  const registry=local.loadRegistry();registry.machines[peer.machineId].status='revoked';registry.machines[peer.machineId].revokedAt=new Date().toISOString();local.saveRegistry(registry);
  await expect(open(stateDir)).rejects.toThrow('existing-roster-obligations');expect(fs.existsSync(path.join(stateDir,'local','conversation-graph-native-lease.json'))).toBe(false);
 });
 it('never replaces an orphaned identity key or silently resets a corrupt lease',async()=>{
  const orphan=directory();fs.mkdirSync(path.join(orphan,'machine'));fs.writeFileSync(path.join(orphan,'machine','signing-key.pem'),'existing private material');
  await expect(open(orphan)).rejects.toThrow('identity-recovery-required');expect(fs.readFileSync(path.join(orphan,'machine','signing-key.pem'),'utf8')).toBe('existing private material');
  const oldGraph=directory();fs.mkdirSync(path.join(oldGraph,'state'));fs.writeFileSync(path.join(oldGraph,'state','conversation-graph-custody.sqlite'),'existing custody');
  await expect(open(oldGraph)).rejects.toThrow('identity-recovery-required');expect(fs.existsSync(path.join(oldGraph,'machine','identity.json'))).toBe(false);
  const oldBootstrap=directory();fs.mkdirSync(path.join(oldBootstrap,'conversation-graph','bootstrap'),{recursive:true});fs.writeFileSync(path.join(oldBootstrap,'conversation-graph','bootstrap','publication.json'),'existing profile');
  await expect(open(oldBootstrap)).rejects.toThrow('identity-recovery-required');expect(fs.existsSync(path.join(oldBootstrap,'machine','identity.json'))).toBe(false);
  const stateDir=directory(),factory=enrollmentFactory(),helper=await open(stateDir,factory);await helper.close();
  const file=path.join(stateDir,'local','conversation-graph-native-lease.json');fs.writeFileSync(file,'{"lease":{"epoch":999,"holder":"other"}}');
  await expect(open(stateDir,factory)).rejects.toThrow('lease-invalid');expect(fs.readFileSync(file,'utf8')).toContain('999');
 });
 it('fences a swallowed native persistence error rather than confirming an in-memory renewal',async()=>{
  const stateDir=directory(),helper=await open(stateDir),old=helper.leaseCoordinator.currentLease()!;
  const next=helper.nativeLease.signLease(old.epoch,old.acquiredAt,new Date(Date.now()+60000).toISOString(),old.nonce+1);
  const realRename=fs.renameSync;vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(String(to).endsWith('conversation-graph-native-lease.json'))throw new Error('independent disk failure');return realRename(from,to);});
  expect(helper.leaseStore.refresh(next)).toBe(false);expect(()=>helper.leaseStore.read()).toThrow('lease-fenced');
 });
 it('relinquishes with a signed persisted native tombstone when another member obligation appears',async()=>{
  const helper=await open(directory()),remote=new MachineIdentityManager(directory());await remote.generateIdentity();const peer=remote.loadIdentity();
  new IdentityStore({stateDir:helper.identity.baseDir}).apply({identity:peer,scope:'remote',actor:'pairing-trust',path:'pair'});helper.identity.registerMachine(peer,'standby');
  expect(await helper.leaseCoordinator.acquireIfEligible()).toBe(false);expect(helper.leaseCoordinator.holdsLease()).toBe(false);
  const released=helper.leaseStore.read().lease!;expect(released.released).toBe(true);expect(helper.nativeLease.verifyLease(released)).toBe(true);
 });
 it.each(['lock-loss','new-peer'] as const)('refuses synchronous cluster admission immediately after %s, before a lease tick',async change=>{
  const helper=await open(directory());expect(helper.writeAdmission.evaluate('cluster-shared').admit).toBe(true);
  if(change==='lock-loss')helper.instanceLock.release();
  else{const remote=new MachineIdentityManager(directory());await remote.generateIdentity();const peer=remote.loadIdentity();new IdentityStore({stateDir:helper.identity.baseDir}).apply({identity:peer,scope:'remote',actor:'pairing-trust',path:'pair'});helper.identity.registerMachine(peer,'standby');}
  // No acquire/renew/timer tick has intervened; native lease alone is still live.
  expect(helper.leaseCoordinator.holdsLease()).toBe(true);expect(helper.writeAdmission.evaluate('cluster-shared').admit).toBe(false);
  // The compiled inventory gate remains authoritative, rather than being forced live.
  expect(helper.writeAdmission.guardStoreWrite('conversationGraph.append').enforce).toBe('legacy');
 });
 it('refuses override admission before acquiring a lock and allows an ordinary retry',async()=>{
  const stateDir=directory();vi.stubEnv('INSTAR_ALLOW_SECOND_INSTANCE','1');
  const acquire=vi.spyOn(SingleInstanceLock.prototype,'acquire');
  await expect(open(stateDir)).rejects.toThrow('instance-lock-required');expect(fs.existsSync(path.join(stateDir,'local','server-instance.lock'))).toBe(false);
  expect(acquire).not.toHaveBeenCalled();expect(fs.existsSync(path.join(stateDir,'machine','identity.json'))).toBe(false);vi.unstubAllEnvs();acquire.mockRestore();
  const helper=await open(stateDir);expect(helper.instanceLock.revalidate()).toBe(true);
 });
 it('does not overwrite or remove an existing caller lock when override mode is set',async()=>{
  const stateDir=directory(),lock=new SingleInstanceLock({stateDir});locks.push(lock);expect((await lock.acquire()).acquired).toBe(true);
  const before=fs.readFileSync(lock.lockPath(),'utf8');vi.stubEnv('INSTAR_ALLOW_SECOND_INSTANCE','1');
  await expect(open(stateDir)).rejects.toThrow('instance-lock-required');expect(fs.readFileSync(lock.lockPath(),'utf8')).toBe(before);expect(lock.revalidate()).toBe(true);
 });
 it('cleans up an owned lock when acquisition throws after actual publication',async()=>{
  const stateDir=directory(),realAcquire=SingleInstanceLock.prototype.acquire;
  const acquire=vi.spyOn(SingleInstanceLock.prototype,'acquire').mockImplementationOnce(async function(this:SingleInstanceLock){const result=await realAcquire.call(this);expect(result.acquired).toBe(true);throw new Error('failure after actual lock publication');});
  await expect(open(stateDir)).rejects.toThrow('failure after actual lock publication');expect(fs.existsSync(path.join(stateDir,'local','server-instance.lock'))).toBe(false);acquire.mockRestore();
  const helper=await open(stateDir);expect(helper.instanceLock.revalidate()).toBe(true);
 });
});
