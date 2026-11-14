import {describe,it,expect} from 'vitest';
import fs from 'node:fs/promises';import path from 'node:path';
import {DroppedOriginRegistry} from '../../src/core/RollbackUnmerge.js';
import {ConversationGraphLocalErasureFence} from '../../src/core/ConversationGraphLocalErasure.js';
import {ConversationGraphReplication,graphReplicationFileStem} from '../../src/core/ConversationGraphReplication.js';
import {setupGraphRuntimeFixture as setup} from '../helpers/conversation-graph-runtime.js';
import {GraphCustodyBootstrapStore} from '../../src/core/GraphCustodyBootstrap.js';
import {GraphCustodyProfileAuthority} from '../../src/core/GraphCustodyProfileAuthority.js';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';

describe('physical acknowledged local read capability',()=>{
 it('checks actual acknowledged files and invalidates a retained capability on priority local denial',async()=>{
  const {f,managers,runtime,peer}=await setup({ownedCustodyHostIndex:0});
  await runtime.refreshReadiness();await peer.refreshReadiness();
  const record=f.record('local-acknowledged-read');
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:record.coreType,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash('local-acknowledged-read'),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('private retained body')},token))).state).toBe('committed');
  const publication=new GraphCustodyBootstrapStore(managers[0].baseDir,'echo').publication(f.membership.members)!;
  const authority=new GraphCustodyProfileAuthority({stateDir:managers[0].baseDir,agentId:'echo',publication});
  const proof=await runtime.source.verifyLocalAcknowledgedSnapshot(runtime.reader,runtime.droppedOriginRegistry,authority);
  expect(proof.highestAcknowledgedSequence).toBe(1);expect(proof.machineId).toBe(runtime.machineId);
  expect(()=>proof.assertCurrent(runtime.source,authority,f.membership)).not.toThrow();
  await runtime.localErasure.deny(record.packet.erasureIdentity);
  expect(()=>proof.assertCurrent(runtime.source,authority,f.membership)).toThrow('graph-local-snapshot-state-changed');
 });
 it.each(['deliveries','bundle'])('refuses cold physical memory with missing %s evidence',async suffix=>{
  const {f,managers,runtime,peer}=await setup({ownedCustodyHostIndex:0});await runtime.refreshReadiness();await peer.refreshReadiness();
  const record=f.record('local-acknowledged-missing');
  expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:record.coreType,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash('local-acknowledged-missing'),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('private retained body')},token))).state).toBe('committed');
  const publication=new GraphCustodyBootstrapStore(managers[0].baseDir,'echo').publication(f.membership.members)!;
  const authority=new GraphCustodyProfileAuthority({stateDir:managers[0].baseDir,agentId:'echo',publication});
  const file=path.join(managers[0].baseDir,'state','conversation-graph-source',graphReplicationFileStem(record.packet.eventId)+'.'+suffix+'.json');
  await fs.writeFile(file,'[]');
  await expect(runtime.source.verifyLocalAcknowledgedSnapshot(runtime.reader,runtime.droppedOriginRegistry,authority)).rejects.toThrow();
 });

 it('invalidates at final-byte check after another same-root registry durably drops the origin',async()=>{
  const {f,managers,runtime,peer}=await setup({ownedCustodyHostIndex:0});await runtime.refreshReadiness();await peer.refreshReadiness();
  const record=f.record('local-acknowledged-second-registry');expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:record.coreType,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash('local-acknowledged-second-registry'),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('private retained body')},token))).state).toBe('committed');
  const publication=new GraphCustodyBootstrapStore(managers[0].baseDir,'echo').publication(f.membership.members)!,authority=new GraphCustodyProfileAuthority({stateDir:managers[0].baseDir,agentId:'echo',publication});
  const proof=await runtime.source.verifyLocalAcknowledgedSnapshot(runtime.reader,runtime.droppedOriginRegistry,authority),other=new DroppedOriginRegistry({stateDir:managers[0].baseDir});
  other.add('conversationGraph',runtime.machineId,new Date().toISOString());
  expect(()=>proof.assertCurrent(runtime.source,authority,f.membership)).toThrow('dropped-origin-physical-state-changed');
  await expect(runtime.source.verifyLocalAcknowledgedSnapshot(runtime.reader,runtime.droppedOriginRegistry,authority)).rejects.toThrow('dropped-origin-physical-state-changed');
 });

 it.each(['fence','registry'])('refuses an actual foreign native-home %s at mint',async component=>{
  const {f,managers,runtime,peer}=await setup({ownedCustodyHostIndex:0});await runtime.refreshReadiness();await peer.refreshReadiness();
  const record=f.record('local-acknowledged-foreign');expect((await runtime.withSourceMutation(token=>runtime.submitPrepared({coreType:record.coreType,idempotencyKey:record.packet.idempotencyKey,requestHash:canonicalHash('local-acknowledged-foreign'),core:record.core,authorizationProof:record.authorizationProof,plaintextSource:Buffer.from('private retained body')},token))).state).toBe('committed');
  const publication=new GraphCustodyBootstrapStore(managers[0].baseDir,'echo').publication(f.membership.members)!,authority=new GraphCustodyProfileAuthority({stateDir:managers[0].baseDir,agentId:'echo',publication});
  const source=component==='fence'?await ConversationGraphReplication.open({...((runtime.source as unknown as {options:Parameters<typeof ConversationGraphReplication.open>[0]}).options),localErasure:new ConversationGraphLocalErasureFence(managers[1].baseDir)}):runtime.source;
  await expect(source.verifyLocalAcknowledgedSnapshot(runtime.reader,component==='registry'?peer.droppedOriginRegistry:runtime.droppedOriginRegistry,authority)).rejects.toThrow('graph-local-snapshot-component-scope-mismatch');
 });

});
