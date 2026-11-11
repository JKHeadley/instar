import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';
import {createEnrolledGraphOwnerIntentSpool,ConversationGraphQueuedIntentSpool,type GraphLocalOwnerIntentInput} from '../../src/core/ConversationGraphQueuedIntent.js';
import {ConversationGraphLocalErasureFence} from '../../src/core/ConversationGraphLocalErasure.js';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
import {newHeaderId} from '../../src/core/EffortHeaderStore.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {replicationFixture} from './conversation-graph-replication.fixtures.js';
const roots:string[]=[];
afterEach(async()=>{vi.restoreAllMocks();for(const root of roots.splice(0))await SafeFsExecutor.safeRm(root,{recursive:true,force:true,operation:'graph-queued-intent-test:cleanup'});});
async function fixture(){const root=await fs.mkdtemp(path.join(os.tmpdir(),'graph-queued-intent-'));roots.push(root);const f=replicationFixture(),fence=new ConversationGraphLocalErasureFence(root),directory=path.join(root,'queued');
 const options={directory,stateDir:root,agentId:'echo',machineId:f.members[0].machineId,signingPrivateKey:f.members[0].signing.privateKey,sealingPrivateKey:f.members[0].sealing.privateKey,ownerPublicKey:f.owner.publicKey,membership:()=>f.membership,isErased:(target:Parameters<typeof fence.isDenied>[0])=>fence.isDenied(target)};
 const input:GraphLocalOwnerIntentInput={idempotencyKey:'owner-change-opaque-retry-identity',requestId:'request-0001',principalKey:'private-owner-principal',grantVersion:'private-current-grant-stamp',surface:'mobile',admission:{kind:'owner-device',deviceId:'private-admitted-device',identity:{keyHash:'a'.repeat(64),userId:'private-owner-user',role:'owner'}},change:{kind:'create-effort',projectScope:['instar']}};
 return {f,root,fence,directory,options,input,spool:new ConversationGraphQueuedIntentSpool(options)};}
describe('sequence-free sealed owner intent custody',()=>{
 it('refuses a redirected spool ancestry before publishing sealed owner bytes',async()=>{
  const {root,options,input}=await fixture();const outside=await fs.mkdtemp(path.join(os.tmpdir(),'graph-queued-outside-'));roots.push(outside);
  const link=path.join(root,'redirected');await fs.symlink(outside,link);
  expect(()=>new ConversationGraphQueuedIntentSpool({...options,directory:path.join(link,'queued')})).toThrow();
  expect(await fs.readdir(outside)).toEqual([]);
 });

 it('records and reopens exact local Pending without a canonical sequence, source receipt or plaintext owner snapshot',async()=>{
  const {spool,options,input,directory}=await fixture(),first=await spool.record(input,()=>true);expect(first.state).toBe('recorded-local');expect(first.createdEffort?.ref.kind).toBe('effort');
  const files=await fs.readdir(directory),before=await Promise.all(files.map(async name=>[name,await fs.readFile(path.join(directory,name),'utf8')]));
  expect(files).toHaveLength(2);expect(files.some(name=>/source|receipt|journal|reservation/.test(name))).toBe(false);
  const raw=before.map(([,bytes])=>bytes).join('');expect(raw).not.toContain(input.principalKey);expect(raw).not.toContain(input.grantVersion);expect(raw).not.toContain('sourceSequence');expect(raw).not.toContain('privateKey');
  await spool.close();const restored=new ConversationGraphQueuedIntentSpool(options);expect(await restored.status(input.idempotencyKey,input.principalKey)).toEqual({...first,details:'quarantined',change:undefined});expect(await restored.record(input,()=>true)).toEqual(first);
  expect(await restored.list('another-owner')).toEqual([]);expect(await restored.status(input.idempotencyKey,'another-owner')).toBeNull();expect(await Promise.all(files.map(async name=>[name,await fs.readFile(path.join(directory,name),'utf8')]))).toEqual(before);
 });
 it('refuses an unattributable title and an oversized new forwarding binding before any private publication',async()=>{
  const {spool,input,directory}=await fixture();const title={...input,change:{kind:'set-effort-title' as const,effort:{kind:'effort' as const,id:crypto.randomUUID()},baseVersion:0,title:'No unbound private title'}};
  await expect(spool.record(title,()=>true)).rejects.toThrow('header-required');await expect(spool.record({...input,idempotencyKey:'k'.repeat(194)},()=>true)).rejects.toThrow('forward-binding-capacity');await expect(fs.readdir(directory)).rejects.toMatchObject({code:'ENOENT'});
 });
 it('keeps a private title only in erasable ciphertext and refuses changed content under the same logical request',async()=>{
  const {spool,input,directory}=await fixture();input.change={kind:'set-effort-title',effort:{kind:'effort',id:crypto.randomUUID()},baseVersion:7,title:'Unpublished family strategy'};input.headerId=newHeaderId();
  await spool.record(input,()=>true);await expect(spool.record({...input,change:{...input.change,title:'Different private name'}},()=>true)).rejects.toThrow('idempotency-conflict');
  for(const name of await fs.readdir(directory)){const bytes=await fs.readFile(path.join(directory,name),'utf8');expect(bytes).not.toContain('Unpublished family strategy');expect(bytes).not.toContain(canonicalHash(input.change));expect(bytes).not.toContain('private-current-grant-stamp');}
 });
 it('persists local cancellation and refusal across restart without inventing a witnessed terminal certificate',async()=>{
  const {spool,options,input,directory}=await fixture();await spool.record(input,()=>true);const canceled=await spool.finish(input.idempotencyKey,input.principalKey,{state:'canceled-local'});expect(canceled.state).toBe('canceled-local');
  const restored=new ConversationGraphQueuedIntentSpool(options);expect((await restored.status(input.idempotencyKey,input.principalKey))?.state).toBe('canceled-local');
  await expect(restored.finish(input.idempotencyKey,input.principalKey,{state:'promoted',promotion:{eventId:'graph-event:unaccepted',packetHash:'a'.repeat(64)}})).rejects.toThrow('terminal-conflict');
  const second={...input,idempotencyKey:'another-logical-intent'};await restored.record(second,()=>true);await restored.finish(second.idempotencyKey,second.principalKey,{state:'refused-local',refusalCode:'owner-revoked'});
  expect((await new ConversationGraphQueuedIntentSpool(options).status(second.idempotencyKey,second.principalKey))?.refusalCode).toBe('owner-revoked');
  expect((await fs.readdir(directory)).some(name=>name.includes('certificate'))).toBe(false);
 });
 it('re-establishes real durability on a readable retry after a failed directory barrier',async()=>{
  const {spool,input,directory}=await fixture();const target=spool as unknown as {sync:()=>Promise<void>},original=target.sync.bind(spool);let calls=0;const fault=vi.spyOn(target,'sync').mockImplementation(async()=>{calls++;if(calls===2||calls===3)throw new Error('actual-directory-barrier-fault');await original();});
  await expect(spool.record(input,()=>true)).rejects.toThrow('directory-barrier-fault');const files=await fs.readdir(directory);expect(files.filter(name=>name.endsWith('.control.json'))).toHaveLength(1);expect(files.filter(name=>name.endsWith('.bundle.json'))).toHaveLength(1);
  await expect(spool.record(input,()=>true)).rejects.toThrow('directory-barrier-fault');fault.mockRestore();expect((await spool.record(input,()=>true)).state).toBe('recorded-local');expect((await fs.readdir(directory)).filter(name=>name.endsWith('.control.json'))).toHaveLength(1);
 });
 it('retains an accepted local cancellation when owner permission changes during its durable publication',async()=>{
  const {spool,options,input}=await fixture();await spool.record(input,()=>true);let current=true;const original=(spool as unknown as {publish:(file:string,value:unknown,immutable?:boolean)=>Promise<void>}).publish.bind(spool);
  const publish=vi.spyOn(spool as unknown as {publish:(file:string,value:unknown,immutable?:boolean)=>Promise<void>},'publish').mockImplementation(async(file,value,immutable)=>{await original(file,value,immutable);if(file.endsWith('.outcome.json'))current=false;});
  const accepted=await spool.finish(input.idempotencyKey,input.principalKey,{state:'canceled-local'},()=>current);expect(current).toBe(false);expect(accepted.state).toBe('canceled-local');publish.mockRestore();
  expect((await new ConversationGraphQueuedIntentSpool(options).status(input.idempotencyKey,input.principalKey))?.state).toBe('canceled-local');
 });
 it('rejects a modified signed admission or foreign owner before exposing overlay content',async()=>{
  const {spool,options,input,directory}=await fixture();await spool.record(input,()=>true);const file=(await fs.readdir(directory)).find(name=>name.endsWith('.control.json'))!,raw=JSON.parse(await fs.readFile(path.join(directory,file),'utf8'));raw.recorderMachineId='unregistered-recorder';await fs.writeFile(path.join(directory,file),JSON.stringify(raw));
  await expect(new ConversationGraphQueuedIntentSpool(options).status(input.idempotencyKey,input.principalKey)).rejects.toThrow('signature-invalid');
 });
 it('purges all private copies on logical forget and keeps an attributed control tombstone across reboot',async()=>{
  const {spool,options,input,directory,fence}=await fixture();input.change={kind:'set-effort-title',effort:{kind:'effort',id:crypto.randomUUID()},baseVersion:0,title:'Forget this queued private title'};input.headerId=newHeaderId();await spool.record(input,()=>true);
  const body=(await fs.readdir(directory)).find(name=>name.endsWith('.bundle.json'))!;await fs.link(path.join(directory,body),path.join(directory,'arbitrary-hardlink-copy.json'));
  const target={sourceKind:'header' as const,sourceId:input.headerId};await fence.deny(target);await expect(spool.assertPurged(target)).rejects.toThrow('body-remains');await spool.purge(target);expect(await spool.assertPurged(target)).toMatch(/^[a-f0-9]{64}$/);
  expect(await fs.readdir(directory)).toEqual([`${canonicalHash(input.idempotencyKey)}.control.json`]);const restored=new ConversationGraphQueuedIntentSpool(options);expect(await restored.list(input.principalKey)).toEqual([]);await expect(restored.record(input,()=>true)).rejects.toThrow('intent-erased');
 });
 it('does not acknowledge a body publication racing priority local erasure',async()=>{
  const {spool,input,directory,fence}=await fixture();input.change={kind:'set-effort-title',effort:{kind:'effort',id:crypto.randomUUID()},baseVersion:0,title:'Race-private'};input.headerId=newHeaderId();
  const target={sourceKind:'header' as const,sourceId:input.headerId},link=fs.link.bind(fs);let enter!:()=>void,release!:()=>void;const reached=new Promise<void>(resolve=>enter=resolve),resume=new Promise<void>(resolve=>release=resolve);
  vi.spyOn(fs,'link').mockImplementation(async(a,b)=>{if(String(b).endsWith('.bundle.json')){enter();await resume;}return link(a,b);});
  const writing=spool.record(input,()=>true);const refusal=expect(writing).rejects.toThrow();await Promise.race([reached,writing.then(()=>{throw new Error('body publication completed before injected race');},error=>{throw error;})]);await fence.deny(target);await spool.purge(target);release();await refusal;
  expect(await spool.assertPurged(target)).toMatch(/^[a-f0-9]{64}$/);expect((await fs.readdir(directory)).some(name=>name.includes('.bundle.json'))).toBe(false);
 });
 it('accepts a fresh authorized same-body retry after a new session without rewriting its original admission',async()=>{
  const {spool,options,input}=await fixture();await spool.record(input,()=>true);const original=await spool.readIntent(input.idempotencyKey,input.principalKey);await spool.close();const restored=new ConversationGraphQueuedIntentSpool(options);
  const opaque=await restored.status(input.idempotencyKey,input.principalKey);expect(opaque?.details).toBe('quarantined');expect(opaque?.change).toBeUndefined();
  const fresh={...input,grantVersion:'a-new-current-session',surface:'dashboard' as const,admission:{kind:'owner-dashboard' as const,grantId:'fresh-opaque-dashboard-grant'}};
  expect((await restored.record(fresh,()=>true)).details).toBe('available');expect(await restored.readIntent(input.idempotencyKey,input.principalKey)).toEqual(original);
 });
 it('keeps an intent sealed and durably quarantined if current owner permission disappears during fsync',async()=>{
  const {spool,options,input}=await fixture();let current=true;const link=fs.link.bind(fs);vi.spyOn(fs,'link').mockImplementation(async(a,b)=>{const result=await link(a,b);if(String(b).endsWith('.bundle.json'))current=false;return result;});
  await expect(spool.record(input,()=>current)).rejects.toThrow('current-owner-required');const status=await spool.status(input.idempotencyKey,input.principalKey);expect(status).toMatchObject({state:'recorded-local',details:'quarantined'});expect(status?.change).toBeUndefined();
  const restored=new ConversationGraphQueuedIntentSpool({...options,canServePrivate:()=>true});expect((await restored.status(input.idempotencyKey,input.principalKey))?.details).toBe('quarantined');
  expect((await restored.finish(input.idempotencyKey,input.principalKey,{state:'canceled-local'},()=>true)).state).toBe('canceled-local');
 });
 it('uses real enrolled identity before any profile exists, self-only custody, and the same immutable spool after profile publication',async()=>{
  const {root,input}=await fixture(),identity=new MachineIdentityManager(root);await identity.generateIdentity();const identities=new IdentityStore({stateDir:root}),fence=new ConversationGraphLocalErasureFence(root);
  const peer=new MachineIdentityManager(path.join(root,'peer'));await peer.generateIdentity();identity.registerMachine(peer.loadIdentity(),'standby');identities.apply({identity:peer.loadIdentity(),scope:'remote',actor:'pairing-trust',path:'pair'});
  const options={stateDir:root,agentId:'echo',identity,identities,localErasure:fence},spool=createEnrolledGraphOwnerIntentSpool(options);const accepted=await spool.record(input,()=>true);expect(accepted.details).toBe('available');
  const directory=path.join(root,'state','conversation-graph-intake','queued-owner-intents'),file=path.join(directory,`${canonicalHash(input.idempotencyKey)}.control.json`),original=await fs.readFile(file,'utf8'),control=JSON.parse(original),bundle=JSON.parse(await fs.readFile(path.join(directory,`${canonicalHash(input.idempotencyKey)}.bundle.json`),'utf8'));
  expect(control.v).toBe(2);expect(control.context.kind).toBe('enrolled-machine');expect(control.context.recorderMachineId).toBe(identity.loadIdentity().machineId);expect(control).not.toHaveProperty('membership');expect(control).not.toHaveProperty('custodyProfileHash');expect(control).not.toHaveProperty('sourceSequence');expect(bundle.envelopes.map((row:{machineId:string})=>row.machineId)).toEqual([identity.loadIdentity().machineId]);
  await spool.close();const reopened=createEnrolledGraphOwnerIntentSpool(options);expect((await reopened.status(input.idempotencyKey,input.principalKey))?.details).toBe('quarantined');expect((await reopened.record(input,()=>true)).createdEffort).toEqual(accepted.createdEffort);expect(await fs.readFile(file,'utf8')).toBe(original);
  const material=[identity,peer].map(manager=>{const signing=crypto.createPrivateKey(manager.loadSigningKey()),sealing=crypto.createPrivateKey(manager.loadEncryptionKey());return {machineId:manager.loadIdentity().machineId,signing:{privateKey:signing,publicKey:crypto.createPublicKey(signing)},sealing:{privateKey:sealing,publicKey:crypto.createPublicKey(sealing)}};});const f=replicationFixture(material);
  const adopted=new ConversationGraphQueuedIntentSpool({directory,stateDir:root,agentId:'echo',machineId:identity.loadIdentity().machineId,signingPrivateKey:identity.loadSigningKey(),sealingPrivateKey:identity.loadEncryptionKey(),ownerPublicKey:f.owner.publicKey,membership:()=>f.membership,enrollment:{identity,identities},isErased:target=>fence.isDenied(target),canServePrivate:()=>false});
  expect((await adopted.readIntent(input.idempotencyKey,input.principalKey))?.recordedMachineId).toBe(identity.loadIdentity().machineId);expect((await adopted.status(input.idempotencyKey,input.principalKey))?.details).toBe('quarantined');expect(await fs.readFile(file,'utf8')).toBe(original);
  const cold=new ConversationGraphQueuedIntentSpool({directory,stateDir:root,agentId:'echo',machineId:identity.loadIdentity().machineId,signingPrivateKey:identity.loadSigningKey(),sealingPrivateKey:identity.loadEncryptionKey(),ownerPublicKey:f.owner.publicKey,membership:()=>f.membership,enrollment:{identity,identities},isErased:target=>fence.isDenied(target),canServePrivate:()=>false});
  await adopted.inheritLiveVisibility(cold);expect((await adopted.status(input.idempotencyKey,input.principalKey))?.details).toBe('quarantined');await adopted.inheritLiveVisibility(reopened);expect((await adopted.status(input.idempotencyKey,input.principalKey))?.details).toBe('available');
  peer.registerMachine(identity.loadIdentity(),'standby');const peerIdentities=new IdentityStore({stateDir:peer.baseDir});peerIdentities.apply({identity:identity.loadIdentity(),scope:'remote',actor:'pairing-trust',path:'pair'});const peerFence=new ConversationGraphLocalErasureFence(peer.baseDir),peerDirectory=path.join(peer.baseDir,'state','conversation-graph-intake','queued-owner-intents');
  const target=new ConversationGraphQueuedIntentSpool({directory:peerDirectory,stateDir:peer.baseDir,agentId:'echo',machineId:peer.loadIdentity().machineId,signingPrivateKey:peer.loadSigningKey(),sealingPrivateKey:peer.loadEncryptionKey(),ownerPublicKey:f.owner.publicKey,membership:()=>f.membership,enrollment:{identity:peer,identities:peerIdentities},isErased:value=>peerFence.isDenied(value)});
  const transfer=await adopted.exportForForward(input.idempotencyKey,input.principalKey);expect(transfer.bundle.envelopes.map(row=>row.machineId)).toEqual([identity.loadIdentity().machineId]);expect(transfer.rewrap.envelopes).toHaveLength(2);
  await expect(target.importForwarded(transfer,peer.loadIdentity().machineId)).rejects.toThrow('forward-authority-invalid');const imported=await target.importForwarded(transfer,identity.loadIdentity().machineId);expect(imported.createdEffort).toEqual(accepted.createdEffort);expect(await fs.readFile(path.join(peerDirectory,path.basename(file)),'utf8')).toBe(original);
  expect((await adopted.status(input.idempotencyKey,input.principalKey))?.cancelEligible).toBe(false);await expect(adopted.finish(input.idempotencyKey,input.principalKey,{state:'canceled-local'},()=>true)).rejects.toThrow('remote-admission-unknown');
  const copy=path.join(peerDirectory,'arbitrary-private-envelope-alias.json');await fs.copyFile(path.join(peerDirectory,`${canonicalHash(input.idempotencyKey)}.rewrap.json`),copy);const targetHeader={sourceKind:'header' as const,sourceId:accepted.createdEffort!.headerId};await peerFence.deny(targetHeader);await target.purge(targetHeader);await expect(fs.stat(copy)).rejects.toMatchObject({code:'ENOENT'});expect(await target.assertPurged(targetHeader)).toMatch(/^[a-f0-9]{64}$/);

 });

 it('revokes a previously built private view synchronously when erasure wins before response serialization',async()=>{
  const {spool,input,fence}=await fixture();input.change={kind:'set-effort-title',effort:{kind:'effort',id:crypto.randomUUID()},baseVersion:0,title:'Must not escape after the await'};input.headerId=newHeaderId();const view=await spool.record(input,()=>true);
  expect(view.mayServeDetails()).toBe(true);expect(Object.keys(view)).not.toContain('mayServeDetails');expect(JSON.stringify(view)).not.toContain('mayServeDetails');expect(structuredClone(view)).not.toHaveProperty('mayServeDetails');
  expect(view.visibleTo(()=>false)).toBe(false);expect(view.visibleTo(()=>true)).toBe(true);expect(Object.keys(view)).not.toContain('visibleTo');expect(structuredClone(view)).not.toHaveProperty('visibleTo');
  await fence.deny({sourceKind:'header',sourceId:input.headerId});expect(view.mayServeDetails()).toBe(false);
 });

});
