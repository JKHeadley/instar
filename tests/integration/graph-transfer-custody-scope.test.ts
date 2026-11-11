import {expect,it} from 'vitest';
import path from 'node:path';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';
import {ConversationGraphReplicationTransfer} from '../../src/core/ConversationGraphReplicationTransfer.js';
it('binds actual Transfer and Source custody to the actual Core root even when another real Transfer copies the same keys',async()=>{
 const f=await setupGraphRuntimeFixture({ownedCustodyHostIndex:0}),identity=f.managers[0],authority=f.authorities[0],context={stateRoot:f.options[0].stateDir,agentId:'echo',machineId:f.runtime.machineId,authority};
 expect(()=>f.runtime.transfer.assertLocalCustodyContext(context)).not.toThrow();
 const foreign=new ConversationGraphReplicationTransfer({directory:path.join(f.options[1].stateDir,'state','conversation-graph-transfer'),machineId:f.runtime.machineId,memberPrivateKey:identity.loadSigningKey(),memberSealingPrivateKey:identity.loadEncryptionKey(),ownerPublicKey:authority.ownerPublicKey,localErasure:f.runtime.localErasure,verification:f.runtime.source});
 expect(()=>foreign.assertLocalCustodyContext(context)).toThrow('custody-scope-mismatch');
 const wrongSource=new ConversationGraphReplicationTransfer({directory:path.join(f.options[0].stateDir,'state','conversation-graph-transfer'),machineId:f.runtime.machineId,memberPrivateKey:identity.loadSigningKey(),memberSealingPrivateKey:identity.loadEncryptionKey(),ownerPublicKey:authority.ownerPublicKey,localErasure:f.runtime.localErasure,verification:f.peer.source});
 expect(()=>wrongSource.assertLocalCustodyContext(context)).toThrow();
 const wrongFence=new ConversationGraphReplicationTransfer({directory:path.join(f.options[0].stateDir,'state','conversation-graph-transfer'),machineId:f.runtime.machineId,memberPrivateKey:identity.loadSigningKey(),memberSealingPrivateKey:identity.loadEncryptionKey(),ownerPublicKey:authority.ownerPublicKey,localErasure:f.peer.localErasure,verification:f.runtime.source});expect(()=>wrongFence.assertLocalCustodyContext(context)).toThrow('fence-scope-mismatch');
});
