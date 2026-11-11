import fs from 'node:fs/promises';import path from 'node:path';
import {it,expect,vi} from 'vitest';
import {setupGraphSenderConsumerFixture} from '../helpers/graph-source-sender-consumer.js';
import {canonicalHash,verifyMembershipTransferReceipt} from '../../src/core/GraphWitnessTypes.js';
// Multi-machine graph proof: takes longer than the push lane's 10 s default on slower Linux CI runners.
vi.setConfig({testTimeout:120_000});
it('consumes an actual held sender stage into Source-backed transfer without history body arrays or duplicate parts',async()=>{
 const f=await setupGraphSenderConsumerFixture(),inventory=f.sourceReader.inventoryHash;
 try{const receipt=await f.runtime.transfer.stagePromotedHeldSource(f.metadata,f.sender,f.sourceReader,f.authorities[0]);expect(verifyMembershipTransferReceipt(receipt,f.metadata.authorization,f.newMembership)).toBe(true);expect(f.sourceReader.inventoryHash).toBe(inventory);f.sourceReader.assertFinalized();const key=canonicalHash({agentId:'echo',recoveryId:f.metadata.authorization.recoveryId}),directory=path.join(f.managers[0].baseDir,'state','conversation-graph-transfer'),names=await fs.readdir(path.join(directory,key+'.parts'));expect(names.every(name=>name.endsWith('.control.json'))).toBe(true);const index=JSON.parse(await fs.readFile(path.join(directory,key+'.stage.json'),'utf8'));expect(index.rows).toHaveLength(2);expect(index.rows.every((row:{heldSource?:unknown})=>!!row.heldSource)).toBe(true);const retained=await f.runtime.transfer.openPreparedHeldCustodyStage(f.metadata,f.sourceReader,{authority:f.authorities[0],hold:{kind:'planned',intent:f.intent,nativeFloor:f.nativeFloor,...f.native}});try{let count=0;for await(const row of retained.recordsInManifestOrder()){expect(row.record.encryptedSourceBundle).not.toBeNull();expect(row.newRewrap).not.toBeNull();retained.releasePrivateViews();count++;}expect(count).toBe(2);}finally{retained.close();}}
 finally{f.sender.close();f.prepared.close();f.sourceReader.close();}
});
