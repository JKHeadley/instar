import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {assertGraphTransferPublicControl} from '../../src/core/GraphTransferPublicControl.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {ConversationGraphReplication} from '../../src/core/ConversationGraphReplication.js';
import {ConversationGraphReplicationTransfer,buildGraphRecoverySourceManifest,type GraphSourceTransferStage} from '../../src/core/ConversationGraphReplicationTransfer.js';
import {rewrapGraphBundle} from '../../src/core/GraphWitnessCrypto.js';
import {canonicalHash,graphRewrapInventoryHash,signGraphRecord,GRAPH_SIGNATURE_DOMAINS as D,verifyMembershipTransferReceipt} from '../../src/core/GraphWitnessTypes.js';
import {replicationFixture} from './conversation-graph-replication.fixtures.js';
import {ConversationGraphTransferCustody} from '../../src/core/ConversationGraphTransferCustody.js';
import {ConversationGraphMaterializationContexts} from '../../src/core/ConversationGraphMaterializationContexts.js';
import {ConversationGraphLocalErasureFence} from '../../src/core/ConversationGraphLocalErasure.js';
const dirs:string[]=[];
async function directory(){const dir=await fs.mkdtemp(path.join(os.tmpdir(),'graph-transfer-'));dirs.push(dir);return dir;}
afterEach(()=>{for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'graph-transfer-test:teardown'});});
async function fixture(){
 const f=replicationFixture();const record=f.record();const added={signing:crypto.generateKeyPairSync('ed25519'),sealing:crypto.generateKeyPairSync('x25519')};
 const raw={...f.membership,epoch:2,previousMembershipHash:canonicalHash(f.membership),writerId:'sleeper',members:[f.membership.members[1],
  {machineId:'added',signingPublicKey:added.signing.publicKey.export({type:'spki',format:'pem'}).toString(),sealingPublicKey:added.sealing.publicKey.export({type:'spki',format:'pem'}).toString()}]};
 delete (raw as Partial<typeof raw>).signature;
 const next={...raw,signature:signGraphRecord(D.membership,raw,f.owner.privateKey)};
 const native=f.actuation('sleeper',2);const {signature,...leaseRaw}=native.lease;const bridge={...leaseRaw,membershipEpoch:2};
 const lease={...bridge,signature:signGraphRecord(D.lease,bridge,f.members[1].signing.privateKey)};
 const rewrap=rewrapGraphBundle(record.encryptedSourceBundle!,'sleeper',f.members[1].sealing.privateKey,next,'sleeper',f.members[1].signing.privateKey,{agentId:'echo',eventId:record.packet.eventId},'2026-11-05T08:07:00Z');
 const {packet,packetSignature,core,authorizationProof}=record;
 const proofRaw={v:1 as const,agentId:'echo',idempotencyKey:packet.idempotencyKey,operationHash:canonicalHash(packet),coreHash:packet.coreHash,
  sourceProofHash:canonicalHash({coreType:record.coreType,packet,packetSignature,core,authorizationProof}),subjectHeadsHash:canonicalHash([]),dependenciesHash:canonicalHash([]),rewrapHash:canonicalHash(rewrap),
  newMembershipHash:canonicalHash(next),currentLeaseHash:canonicalHash(lease),writerId:'sleeper',decision:'adopt' as const,reason:'ok' as const,validatedAt:'2026-11-05T08:07:00Z'};
 const proof={...proofRaw,signature:signGraphRecord(D.revalidation,proofRaw,f.members[1].signing.privateKey)};
 const manifest=buildGraphRecoverySourceManifest([record],f.membership);
 const authRaw={v:1 as const,agentId:'echo',recoveryId:'recovery-one',previousMembershipHash:canonicalHash(f.membership),newMembershipHash:canonicalHash(next),previousWitnessId:f.membership.witnessId,newWitnessId:next.witnessId,
  fenceEpoch:2,highestCertifiedSequence:0,highestCertifiedCoreHash:null,pendingOutcomes:[{idempotencyKey:packet.idempotencyKey,operationHash:canonicalHash(packet),decision:'adopt' as const,revalidationHash:canonicalHash(proof)}],
  sourceManifestHash:canonicalHash(manifest),rewrapInventoryHash:graphRewrapInventoryHash([{eventId:packet.eventId,rewrapHash:canonicalHash(rewrap)}]),issuedAt:'2026-11-05T08:07:00Z'};
 const authorization={...authRaw,signature:signGraphRecord(D.recovery,authRaw,f.owner.privateKey)};
 const stage:GraphSourceTransferStage={authorization,previousMembership:f.membership,newMembership:next,currentLease:lease,originalCurrentLease:native.originalLease,manifest,records:[record],revalidations:[proof],rewraps:[{eventId:packet.eventId,rewrap}]};
 const verification=await ConversationGraphReplication.open(f.options(await directory()));const dir=await directory();
 const options={directory:dir,machineId:'added',memberPrivateKey:added.signing.privateKey,memberSealingPrivateKey:added.sealing.privateKey,ownerPublicKey:f.owner.publicKey,verification,witnessPublicKeys:new Map([['independent-witness',f.witness.publicKey]])};
 return {f,stage,options,dir,verification};
}
describe('preactivation graph source transfer',()=>{
 it('reads only actual Source-verified metadata-only negatives under a deny, without inventing body custody',async()=>{
  const f=await fixture(),streamRoot=await directory(),streamDirectory=path.join(streamRoot,'custody'),fence=new ConversationGraphLocalErasureFence(streamRoot),record=f.stage.records[0],raw={v:1 as const,agentId:'echo',requestId:'stream-negative-erasure',membershipEpoch:1,leaseEpoch:2,target:record.packet.erasureIdentity,bundleHashes:[record.packet.sourceBundleHash],authorizationReceiptHash:canonicalHash('actual-unit-owner-erase'),witnessId:f.f.membership.witnessId,erasedAt:'2026-11-05T08:08:00Z'},proof={...raw,signature:signGraphRecord(D.erasure,raw,f.f.witness.privateKey)};
  await f.verification.applyErasure(proof,f.f.erasureAuthority(proof));await fence.deny(raw.target);const negative={...record,encryptedSourceBundle:null,erasure:proof};expect(f.verification.verifyHistoricalRecord(negative)).toBe(true);
  const custody=new ConversationGraphTransferCustody(streamDirectory,new ConversationGraphMaterializationContexts(path.join(streamDirectory,'contexts')),32*1024*1024,{agentId:'echo',ownerPublicKey:f.f.owner.publicKey,verification:f.verification,denied:target=>fence.isDenied(target)}),{records:_records,rewraps:_rewraps,...metadata}=f.stage;async function* rows(){yield{record:negative,newRewrap:null};}
  const key=await custody.persistStream(metadata,rows()),reader=await custody.openReader(key,[]),item=await reader.records().next();expect(item.value?.record.encryptedSourceBundle).toBeNull();expect(item.value?.record.erasure).toEqual(proof);expect(item.value?.newRewrap).toBeNull();
  const indexFile=path.join(streamDirectory,key+'.stage.json'),index=JSON.parse(await fs.readFile(indexFile,'utf8')),controlFile=path.join(streamDirectory,key+'.parts',index.rows[0].controlHash+'.control.json'),control=JSON.parse(await fs.readFile(controlFile,'utf8'));control.erasure.signature='invalid';index.rows[0].controlHash=canonicalHash(control);await fs.writeFile(path.join(streamDirectory,key+'.parts',index.rows[0].controlHash+'.control.json'),JSON.stringify(control));await fs.writeFile(indexFile,JSON.stringify(index));
  await expect((await custody.openReader(key,[])).records().next()).rejects.toThrow('graph-stage-public-control-invalid');
 });
 it('streams unchanged custody parts, rechecks actual disk bytes, and refuses a locally denied body before reading it',async()=>{
  const f=await fixture(),streamRoot=await directory(),streamDirectory=path.join(streamRoot,'custody'),fence=new ConversationGraphLocalErasureFence(streamRoot),custody=new ConversationGraphTransferCustody(streamDirectory,new ConversationGraphMaterializationContexts(path.join(streamDirectory,'contexts')),32*1024*1024,{agentId:'echo',ownerPublicKey:f.f.owner.publicKey,verification:f.verification,denied:target=>fence.isDenied(target)});
  const {records,rewraps,...metadata}=f.stage;async function* rows(){yield{record:records[0],newRewrap:rewraps[0].rewrap};}
  const key=await custody.persistStream(metadata,rows()),reader=await custody.openReader(key,[]);expect(reader.count).toBe(1);expect(reader.inventory).toEqual([{eventId:records[0].packet.eventId,rewrapHash:canonicalHash(rewraps[0].rewrap)}]);
  const body=records[0].encryptedSourceBundle!,file=path.join(streamDirectory,key+'.parts',canonicalHash(body)+'.bundle.json');
  await fs.writeFile(file,JSON.stringify({...body,ciphertext:'AAAA'}));await expect(reader.records().next()).rejects.toThrow('bundle-hash-invalid');
  await fs.writeFile(file,JSON.stringify(body));const iterator=reader.records(),next=await iterator.next();expect(next.value?.record).toEqual(records[0]);expect(next.value?.newRewrap).toEqual(rewraps[0].rewrap);await iterator.return(undefined);
  const target=records[0].packet.erasureIdentity;await fence.deny(target);const opened=vi.spyOn(fs,'open');try{await expect(reader.records().next()).rejects.toThrow('graph-stage-source-denied');expect(opened.mock.calls.some(([name])=>String(name).endsWith('.bundle.json')||String(name).endsWith('.rewrap.json'))).toBe(false);}finally{opened.mockRestore();}
  await custody.purge(record=>canonicalHash(record.packet.erasureIdentity)===canonicalHash(target));expect(await custody.assertPurged(target,record=>canonicalHash(record.packet.erasureIdentity)===canonicalHash(target))).toMatch(/^[a-f0-9]{64}$/);
 });
 it('refuses a signed owner transfer that omits a locally durable later source before any transfer receipt',async()=>{
  const {f,stage,options,verification}=await fixture();
  await verification.appendLocal(stage.records[0]);
  const later=f.record('event-two',2,stage.records[0].packet.coreHash);
  await verification.appendLocal(later);
  await expect(new ConversationGraphReplicationTransfer(options).stage(stage)).rejects.toThrow('graph-transfer-local-history-omitted');
  expect(verification.repairRecord(later.packet.eventId)?.packet).toEqual(later.packet);
 });

 it('fsyncs and reloads complete original source + new envelopes before signing, without exposing canonical state',async()=>{
  const {stage,options,dir,verification}=await fixture();
  const receipt=await new ConversationGraphReplicationTransfer(options).stage(stage);
  expect(verifyMembershipTransferReceipt(receipt,stage.authorization,stage.newMembership)).toBe(true);
  expect((await fs.readdir(dir)).filter(name=>name.endsWith('.stage.json'))).toHaveLength(1);expect((await fs.readdir(dir)).some(name=>name.endsWith('.parts'))).toBe(true);
  expect(verification.originRecords()).toEqual([]);
  const again=await new ConversationGraphReplicationTransfer(options).stage(stage);expect(again.sourceManifestHash).toBe(receipt.sourceManifestHash);
 });
 it('refuses corrupt/missing inventory and a new member key that cannot decrypt the transferred source',async()=>{
  const {stage,options}=await fixture();const missing=structuredClone(stage);missing.records=[];
  await expect(new ConversationGraphReplicationTransfer(options).stage(missing)).rejects.toThrow('invalid-rewrap-inventory');
  const wrong=crypto.generateKeyPairSync('x25519');
  await expect(new ConversationGraphReplicationTransfer({...options,memberSealingPrivateKey:wrong.privateKey}).stage(stage)).rejects.toThrow();
  const extra={...stage,transcript:'refuse plaintext'};
  await expect(new ConversationGraphReplicationTransfer(options).stage(extra)).rejects.toThrow('unknown-fields');
 });
 it('refuses a changed immutable source after staged transfer rather than overwriting prior durable evidence',async()=>{
  const {stage,options,dir}=await fixture();await new ConversationGraphReplicationTransfer(options).stage(stage);
  const file=path.join(dir,(await fs.readdir(dir)).find(name=>name.endsWith('.stage.json'))!);await fs.writeFile(file,'{}');
  await expect(new ConversationGraphReplicationTransfer(options).stage(stage)).rejects.toThrow('part-conflict');
 });
 it('purges staged key envelopes and crash copies under a durable signed erasure fence',async()=>{
  const {f,stage,options,dir}=await fixture();await new ConversationGraphReplicationTransfer(options).stage(stage);
  const name=(await fs.readdir(dir)).find(name=>name.endsWith('.stage.json'))!;
  await fs.writeFile(path.join(dir,`${name}.deadbeef.tmp`),JSON.stringify(stage));
  const raw={v:1 as const,agentId:'echo',requestId:'erase-transfer',target:stage.records[0].packet.erasureIdentity,bundleHashes:[stage.records[0].packet.sourceBundleHash],membershipEpoch:1,leaseEpoch:2,authorizationReceiptHash:stage.records[0].packet.authorizationReceiptHash,witnessId:'independent-witness',erasedAt:'2026-11-05T08:09:00Z'};
  const proof={...raw,signature:signGraphRecord(D.erasure,raw,f.witness.privateKey)};
  await options.verification.applyErasure(proof,f.erasureAuthority(proof));await new ConversationGraphReplicationTransfer(options).applyErasure(proof,'echo');
  expect((await fs.readdir(dir)).filter(name=>name.endsWith('.stage.json'))).toHaveLength(1);expect((await fs.readdir(dir)).some(name=>name.endsWith('.tmp'))).toBe(false);
  await expect(new ConversationGraphReplicationTransfer(options).stage(stage)).rejects.toThrow('source-locally-erased');
  const inspect=async(folder:string):Promise<void>=>{for(const name of await fs.readdir(folder)){const file=path.join(folder,name);if((await fs.stat(file)).isDirectory())await inspect(file);else expect(await fs.readFile(file,'utf8')).not.toMatch(/"(?:envelopes|ciphertext|ephemeralPublicKey)"/);}};await inspect(dir);
 });

 it.each(['unexpected.negative-control.json','renamed-provenance.bin','unexpected.json',`${'a'.repeat(64)}.negative-control.json.backup`,`${'a'.repeat(64)}.negative-control.json.pending`,`${'a'.repeat(64)}.negative-control.json.not-a-uuid.tmp`,`${'a'.repeat(64)}.negative-control.json`,`${'a'.repeat(64)}.negative-control.json.deadbeef.tmp`,`${'a'.repeat(64)}.stage.json`,`${'a'.repeat(64)}.post-import.json`])('keeps unclassified managed copy %s as debt without reading unknown names or deleting its bytes',async name=>{
  const {stage,options,dir}=await fixture(),fence=new ConversationGraphLocalErasureFence(await directory()),target=stage.records[0].packet.erasureIdentity;await fence.deny(target);const transfer=new ConversationGraphReplicationTransfer({...options,localErasure:fence}),file=path.join(dir,name),bytes=JSON.stringify({unexpectedPrivatePayload:'managed-private-copy-canary'});await fs.writeFile(file,bytes);
  await expect(transfer.assertLocalErasurePurged(target)).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toBe(bytes);await expect(transfer.eraseLocal(target)).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toBe(bytes);
 });

 it.each(['parts','contexts','contexts-canonical'])('does not hide an unknown negative copy inside known %s directory',async family=>{
  const {stage,options,dir}=await fixture(),transfer0=new ConversationGraphReplicationTransfer(options);await transfer0.stage(stage);const folder=family==='parts'?path.join(dir,(await fs.readdir(dir)).find(name=>name.endsWith('.parts'))!):path.join(dir,'contexts');await fs.mkdir(folder,{recursive:true});const bytes=JSON.stringify({unexpectedPrivatePayload:'nested-managed-private-copy-canary'}),file=path.join(folder,family==='contexts-canonical'?canonicalHash(JSON.parse(bytes))+'.json':'unexpected.negative-control.json');await fs.writeFile(file,bytes);const fence=new ConversationGraphLocalErasureFence(await directory()),target=stage.records[0].packet.erasureIdentity;await fence.deny(target);const transfer=new ConversationGraphReplicationTransfer({...options,localErasure:fence});await expect(transfer.eraseLocal(target)).rejects.toThrow();await expect(transfer.assertLocalErasurePurged(target)).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toBe(bytes);
 });

 it('treats unexpected private fields in a renamed indexed opaque control as debt',async()=>{const {stage,options,dir}=await fixture();await new ConversationGraphReplicationTransfer(options).stage(stage);const indexName=(await fs.readdir(dir)).find(name=>name.endsWith('.stage.json'))!,indexFile=path.join(dir,indexName),index=JSON.parse(await fs.readFile(indexFile,'utf8')),parts=path.join(dir,indexName.replace('.stage.json','.parts')),control=JSON.parse(await fs.readFile(path.join(parts,index.rows[0].controlHash+'.control.json'),'utf8'));control.unexpectedPrivatePayload='opaque-control-private-canary';const controlHash=canonicalHash(control),file=path.join(parts,controlHash+'.control.json');await fs.writeFile(file,JSON.stringify(control));index.rows[0].controlHash=controlHash;await fs.writeFile(indexFile,JSON.stringify(index));const fence=new ConversationGraphLocalErasureFence(await directory()),target=stage.records[0].packet.erasureIdentity;await fence.deny(target);const transfer=new ConversationGraphReplicationTransfer({...options,localErasure:fence});await expect(transfer.eraseLocal(target)).rejects.toThrow();await expect(transfer.assertLocalErasurePurged(target)).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toContain('opaque-control-private-canary');});

 it.each(['adoption','preparationProof','erasedControlProof','custodyMembership','custodyActivations','certificate','certificatePersistenceReceipts','commitProofDeliveryReceipts','cancellation','cancellationCertificate','erasure','materialization'])('preserves malformed nested public family %s as debt',async field=>{const {stage,options,dir}=await fixture();await new ConversationGraphReplicationTransfer(options).stage(stage);const indexName=(await fs.readdir(dir)).find(name=>name.endsWith('.stage.json'))!,indexFile=path.join(dir,indexName),index=JSON.parse(await fs.readFile(indexFile,'utf8')),parts=path.join(dir,indexName.replace('.stage.json','.parts')),control=JSON.parse(await fs.readFile(path.join(parts,index.rows[0].controlHash+'.control.json'),'utf8')),payload={unexpectedPrivatePayload:'nested-public-family-private-canary'};control[field]=['custodyActivations','certificatePersistenceReceipts','commitProofDeliveryReceipts'].includes(field)?[payload]:payload;const key=canonicalHash(control),file=path.join(parts,key+'.control.json');await fs.writeFile(file,JSON.stringify(control));index.rows[0].controlHash=key;await fs.writeFile(indexFile,JSON.stringify(index));const fence=new ConversationGraphLocalErasureFence(await directory()),target=stage.records[0].packet.erasureIdentity;await fence.deny(target);const transfer=new ConversationGraphReplicationTransfer({...options,localErasure:fence});await expect(transfer.eraseLocal(target)).rejects.toThrow();await expect(transfer.assertLocalErasurePurged(target)).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toContain('nested-public-family-private-canary');});
 it('preserves an unattributed canonical bundle without blindly deleting its private bytes',async()=>{const {stage,options,dir}=await fixture();await new ConversationGraphReplicationTransfer(options).stage(stage);const parts=path.join(dir,(await fs.readdir(dir)).find(name=>name.endsWith('.parts'))!),body={unexpectedPrivatePayload:'canonical-bundle-private-canary'},bytes=JSON.stringify(body),file=path.join(parts,canonicalHash(body)+'.bundle.json');await fs.writeFile(file,bytes);const fence=new ConversationGraphLocalErasureFence(await directory()),target=stage.records[0].packet.erasureIdentity;await fence.deny(target);const transfer=new ConversationGraphReplicationTransfer({...options,localErasure:fence});await expect(transfer.eraseLocal(target)).rejects.toThrow();await expect(transfer.assertLocalErasurePurged(target)).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toBe(bytes);});

 it('accepts a genuine all-member signed certificate and rejects private fields inside it',async()=>{const {f,stage,options,verification}=await fixture(),record=stage.records[0],own=await verification.appendLocal(record),peer=await ConversationGraphReplication.open(f.options(await directory(),'sleeper')),remote=await peer.receive(record,record.packet.writerId),certificate=f.certificate(record,[own.receipt,remote]),control={...record,encryptedSourceBundle:null,certificate};expect(()=>assertGraphTransferPublicControl(control,options)).not.toThrow();expect(()=>assertGraphTransferPublicControl({...control,certificate:{...certificate,unexpectedPrivatePayload:'certificate-private-canary'}},options)).toThrow();});

 it.each(['malformed','private-extra','invalid-signature'])('preserves unverified legacy scratch %s instead of deleting it',async kind=>{const {stage,options,dir}=await fixture();await new ConversationGraphReplicationTransfer(options).stage(stage);const key=canonicalHash({agentId:stage.authorization.agentId,recoveryId:stage.authorization.recoveryId}),file=path.join(dir,key+'.stage.json.'+crypto.randomUUID()+'.tmp'),copy=structuredClone(stage);let bytes='{"privateCanary":"legacy-scratch-private-bytes"';if(kind==='private-extra')bytes=JSON.stringify({...copy,unexpectedPrivatePayload:'legacy-scratch-private-bytes'});if(kind==='invalid-signature'){copy.authorization.signature='legacy-scratch-private-bytes';bytes=JSON.stringify(copy);}await fs.writeFile(file,bytes);const fence=new ConversationGraphLocalErasureFence(await directory()),target=stage.records[0].packet.erasureIdentity;await fence.deny(target);const transfer=new ConversationGraphReplicationTransfer({...options,localErasure:fence});await expect(transfer.eraseLocal(target)).rejects.toThrow();await expect(transfer.assertLocalErasurePurged(target)).rejects.toThrow();expect(await fs.readFile(file,'utf8')).toBe(bytes);});

 it('clears actual reader rows and detached aliases synchronously across same-root custody instances before erase awaits',async()=>{const {stage,options,dir,f}=await fixture(),fence=new ConversationGraphLocalErasureFence(await directory()),transfer=new ConversationGraphReplicationTransfer({...options,localErasure:fence});await transfer.stage(stage);const custody=new ConversationGraphTransferCustody(dir,new ConversationGraphMaterializationContexts(path.join(dir,'contexts')),32*1024*1024,{...options,agentId:'echo',denied:target=>fence.isDenied(target)}),reader=await custody.openReader(custody.key(stage),[]),item=(await reader.records().next()).value!,body=item.record.encryptedSourceBundle!,envelope=body.envelopes[0],key=item.newRewrap!,target=item.record.packet.erasureIdentity;body.envelopes=[];await Promise.resolve();await fence.deny(target);const erased=new ConversationGraphReplicationTransfer({...options,localErasure:fence}).eraseLocal(target);expect(Object.keys(body)).toEqual([]);expect(Object.keys(envelope)).toEqual([]);expect(Object.keys(key)).toEqual([]);expect(item.record.encryptedSourceBundle).toBeNull();expect(item.newRewrap).toBeNull();await erased;reader.close();expect(item.record.packet).toEqual(stage.records[0].packet);});
 it('reader close clears yielded private rows without granting or changing canonical control',async()=>{const {stage,options,dir}=await fixture();await new ConversationGraphReplicationTransfer(options).stage(stage);const custody=new ConversationGraphTransferCustody(dir,new ConversationGraphMaterializationContexts(path.join(dir,'contexts')),32*1024*1024,{...options,agentId:'echo',denied:()=>false}),reader=await custody.openReader(custody.key(stage),[]),item=(await reader.records().next()).value!,body=item.record.encryptedSourceBundle!,key=item.newRewrap!;reader.close();expect(Object.keys(body)).toEqual([]);expect(Object.keys(key)).toEqual([]);expect(item.record.core).toEqual(stage.records[0].core);await expect(reader.records().next()).rejects.toThrow('graph-stage-reader-closed');});
 it('retains frozen detached private descendants as sticky debt after the mutable parent is cleared',async()=>{const {stage,options,dir}=await fixture(),fence=new ConversationGraphLocalErasureFence(await directory()),transfer=new ConversationGraphReplicationTransfer({...options,localErasure:fence});await transfer.stage(stage);const custody=new ConversationGraphTransferCustody(dir,new ConversationGraphMaterializationContexts(path.join(dir,'contexts')),32*1024*1024,{...options,agentId:'echo',denied:target=>fence.isDenied(target)}),copy=structuredClone(stage),envelope=copy.rewraps[0].rewrap.envelopes[0],original=structuredClone(envelope),held=custody.retainPrivateStageViews(copy);Object.freeze(envelope);copy.rewraps[0].rewrap.envelopes=[];const target=copy.records[0].packet.erasureIdentity;await fence.deny(target);await expect(transfer.eraseLocal(target)).rejects.toThrow('graph-transfer-private-view-debt');expect(envelope).toEqual(original);expect(copy.records[0].encryptedSourceBundle).toBeNull();await expect(transfer.assertLocalErasurePurged(target)).rejects.toThrow('graph-transfer-private-view-debt');expect(()=>held.close()).toThrow('graph-transfer-private-view-debt');});

});
