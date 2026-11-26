/** Real Source/Native/W ACT with synthetic owner-stage component consent.
 * Read-only-held only: no NativeAdmin, SourceACK or feature activation proof. */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect, vi } from 'vitest';
import { setupGraphSourceStreamRowFixture } from '../helpers/graph-source-stream-row.js';
import { ConversationGraphReplication, type ConversationGraphReplicationOptions, graphReplicationFileStem } from '../../src/core/ConversationGraphReplication.js';
import { GraphPublicMetadataPages } from '../../src/core/GraphPublicMetadataPages.js';
import { persistGraphMaterializationContextV2 } from '../../src/core/ConversationGraphMaterializationContexts.js';
import { ConversationGraphNativeTailFloor } from '../../src/core/ConversationGraphNativeTail.js';
import { registerPagedHistoryPrivacyCases } from '../helpers/graph-source-paged-history-privacy.js';

// Multi-machine graph proof: takes longer than the push lane's 10 s default on slower Linux CI runners.
vi.setConfig({testTimeout:120_000});

describe('actual Source paged historical read-only held import',()=>{
  registerPagedHistoryPrivacyCases(['frozen-detached-debt']);
 it('refuses generic export of a genuine held-only recipient row while preserving priority local erasure',async()=>{
  const realOpen=ConversationGraphReplication.open.bind(ConversationGraphReplication),observed:ConversationGraphReplicationOptions[]=[],capture=vi.spyOn(ConversationGraphReplication,'open').mockImplementation((options,mode,authority)=>{if(mode!=='verify-only')observed.push(options);return realOpen(options,mode,authority);});const f=await setupGraphSourceStreamRowFixture();capture.mockRestore();try{
   const stage={...f.metadata,records:[f.decoded.record],rewraps:f.decoded.newRewrap?[{eventId:f.original.packet.eventId,rewrap:f.decoded.newRewrap}]:[]},holds=f.authorities.map((core,index)=>core.beginStage(f.stage,f.managers[index].loadIdentity().machineId,f.managers[index].loadSigningKey(),f.recoveryReceipts[index])),transfers=[await f.runtime.transfer.stage(stage),await f.peer.transfer.stage(stage)],retirement=f.service.retireOwnedProfile('echo',{stage:f.stage,holds,stateTransferReceipts:transfers,...f.native}),activation=f.service.recoverPending('echo',{newMembership:f.newMembership,authorization:f.metadata.authorization,currentLease:f.metadata.currentLease,originalCurrentLease:f.metadata.originalCurrentLease,revalidations:f.metadata.revalidations,historicalRewraps:stage.rewraps,stateTransferReceipts:transfers,sourceManifest:f.metadata.manifest,ownedTransition:{stage:f.stage,holds,retirement}}).activation,authority=f.authorities[1];authority.stageActivation(f.stage,activation,holds,retirement);f.peer.installNegativeCustodyRole(activation);
   const recipientFloor=new ConversationGraphNativeTailFloor(f.managers[1].baseDir,'echo',authority.ownerPublicKey);await recipientFloor.open();await recipientFloor.observe(f.previousMembership,f.native.lease,f.native.originalLease);
   const root=f.managers[1].baseDir,pages=new GraphPublicMetadataPages({stateRoot:root,maxTotalBytes:8*1024*1024}),{entries,...manifestHeader}=f.metadata.manifest,context=await persistGraphMaterializationContextV2(pages,{activation,manifestHeader,entries,rewrapInventory:f.header.inventory,currentLease:f.metadata.currentLease,originalCurrentLease:f.metadata.originalCurrentLease},'echo',{ownerPublicKey:f.f.owner.publicKey,witnessPublicKeys:f.options[0].configuration!.witnessPublicKeys}),base=observed.find(row=>row.machineId===f.peer.machineId)!,options={...base,pagedHistorical:{pages,coordinator:f.options[1].leaseCoordinator,floor:recipientFloor,identity:f.managers[1],identities:f.options[1].identities,lock:f.options[1].instanceLock,maxHeldBytes:16*1024*1024}};const id=f.original.packet.eventId,directory=path.join(root,'state','conversation-graph-source'),archive=fs.mkdtempSync(path.join(root,'synthetic-prior-source-partial-restore-'));for(const name of fs.readdirSync(directory))if(name.startsWith(graphReplicationFileStem(id)+'.'))fs.renameSync(path.join(directory,name),path.join(archive,name));const source=await realOpen(options,'normal',authority);source.bindHeldNegativeContext(f.peer.reader,f.peer.droppedOriginRegistry);
   expect(source.repairRecord(id)).toBeNull();expect(fs.existsSync(path.join(directory,graphReplicationFileStem(id)+'.source.json'))).toBe(false);expect(fs.existsSync(path.join(directory,graphReplicationFileStem(id)+'.receipt.json'))).toBe(false);
   const retained=await f.peer.transfer.openRetainedCustodyStage(activation,authority);const proof=await source.importPagedHistoricalHeld(context,retained);retained.close();proof.assertFinalized();expect(source.repairRecord(id)).toBeNull();
   await expect(source.controlIntents()).rejects.toThrow('recovery-export-unavailable');await expect(source.nativeTailRecords()).rejects.toThrow('recovery-export-unavailable');expect(()=>source.assertNativeTailReadable()).toThrow('recovery-export-unavailable');
   await f.peer.localErasure.deny(f.original.packet.erasureIdentity);await source.eraseLocal(f.original.packet.erasureIdentity);expect(fs.existsSync(path.join(directory,graphReplicationFileStem(id)+'.bundle.json'))).toBe(false);expect(fs.existsSync(path.join(directory,graphReplicationFileStem(id)+'.receipt.json'))).toBe(false);expect(()=>proof.assertCurrent()).toThrow();proof.close();
  }finally{capture.mockRestore();await f.close();}
 });
});
