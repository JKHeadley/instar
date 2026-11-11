/** Real HTTP signed dispatch admission + isolated tmux bootstrap + actual
 * signed runtime peer transport/native lease/W HTTP/all-member certificate. */
import {describe,it,expect,vi} from 'vitest';
import {detectTmuxPath} from '../../src/core/Config.js';
/** The host's real tmux (Homebrew on the Mac, a built copy on CI); the wrapper only adds a private socket. */
const realTmux=():string=>{const found=detectTmuxPath();if(!found)throw new Error('tmux not found');return found;};
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import requestHttp from 'supertest';
import {createRoutes} from '../../src/server/routes.js';
import {createMockSessionManager} from '../helpers/setup.js';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {setupGraphRuntimeFixture as setup} from '../helpers/conversation-graph-runtime.js';
import {ConversationGraphDelegationRemoteRuntime} from '../../src/server/ConversationGraphDelegationRemoteRuntime.js';
import {ConversationRegistry} from '../../src/core/ConversationRegistry.js';
import {StateManager} from '../../src/core/StateManager.js';
import {createConversationBindAuth} from '../../src/core/conversationBindToken.js';
import {TelegramAdapter} from '../../src/messaging/TelegramAdapter.js';
import {ScopeVerifier} from '../../src/core/ScopeVerifier.js';
import {SessionOwnershipRegistry,InMemorySessionOwnershipStore} from '../../src/core/SessionOwnershipRegistry.js';
import {createDeliverMessageHandler} from '../../src/core/DeliverMessageHandler.js';
import {createGraphControlCapsule} from '../../src/core/GraphWitnessControl.js';
import {signEnvelope,type MeshEnvelope} from '../../src/core/MeshRpc.js';
import type {RemoteGraphDelegationRequest} from '../../src/core/ConversationGraphDelegationRemote.js';

const run=promisify(execFile);
describe('actual remote launch provenance runtime',()=>{
 it('recovers verified admission after original frame loss and forwards actual worker proof to native holder',async()=>{
  const {runtime,peer,managers,options,f,leaseStores,witness}=await setup();await runtime.refreshReadiness();await peer.refreshReadiness();
  const store=new InMemorySessionOwnershipStore(),nonces=new Set<string>();
  const ownership=new SessionOwnershipRegistry({store,seenNonce:key=>nonces.has(key),recordNonce:key=>{nonces.add(key);}});
  const parentId=runtime.machineId,workerId=peer.machineId;
  for(const action of ['place','claim'] as const)expect(ownership.cas({type:action,machineId:parentId},{sessionKey:'42',sender:parentId,nonce:crypto.randomUUID()}).ok).toBe(true);
  const registry=managers.map(manager=>new ConversationRegistry({stateDir:manager.baseDir,machineId:()=>manager.loadIdentity().machineId}));
  const states=managers.map(manager=>new StateManager(manager.baseDir)),auth=managers.map(manager=>createConversationBindAuth(manager.baseDir));
  const telegram=managers.map(manager=>new TelegramAdapter({token:'',chatId:'-1001'},manager.baseDir,{suppressLifelineAutoCreate:true}));
  const socket=`graph-remote-${crypto.randomUUID()}`,tmux=path.join(managers[1].baseDir,'owned-tmux');
  await fs.writeFile(tmux,`#!/bin/sh\nexec '${realTmux()}' -L '${socket}' "$@"\n`,{mode:0o700});
  states[0].saveSession({id:'actual-parent',name:'parent',tmuxSession:'actual-parent-tmux',status:'running',startedAt:new Date(Date.now()-1000).toISOString()});
  telegram[0].registerTopicSession(42,'actual-parent-tmux');
  const bridges=[runtime,peer].map((r,index)=>new ConversationGraphDelegationRemoteRuntime({runtime:r,agentId:'echo',identity:managers[index],admission:options[index].writeAdmission,
   coordinator:options[index].leaseCoordinator,state:states[index],bindAuth:auth[index],conversations:registry[index],ownership,
   scopeVerifier:new ScopeVerifier({projectName:'instar',projectDir:managers[index].baseDir,topicProjects:{'42':{projectName:'instar',projectDir:managers[index].baseDir},'43':{projectName:'instar',projectDir:managers[index].baseDir}}}),
   telegram:telegram[index],telegramChatId:'-1001',tmuxPath:tmux,dropped:options[index].droppedOrigins,membership:f.membership,ownerPublicKey:f.owner.publicKey.export({type:'spki',format:'pem'}).toString()}));
  let request:RemoteGraphDelegationRequest|undefined;
  const seen=new Set<string>();const handler=createDeliverMessageHandler({ownerEpochOf:key=>ownership.read(key)?.ownershipEpoch??null,
   beforeReceipt:(_command,_sender,envelope)=>bridges[1].beforeReceipt(envelope),recordReceipt:id=>{if(seen.has(id))return false;seen.add(id);return true;},
   onAccepted:command=>{request=(command.payload as {graphDelegationRequest:RemoteGraphDelegationRequest}).graphDelegationRequest;}});
  const app=express();app.use(express.json());app.post('/dispatch',(req,res)=>{const envelope=req.body as MeshEnvelope;res.json(handler(envelope.command,envelope.sender,envelope));});
  const server=app.listen(0,'127.0.0.1');await new Promise<void>(resolve=>server.once('listening',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('no-address');
  try{
   bridges[0].setPlacement({
    readOwnership:key=>ownership.read(key),cas:(key,action)=>{const result=ownership.cas(action,{sessionKey:key,sender:parentId,nonce:crypto.randomUUID()});return {ok:result.ok,epoch:ownership.read(key)?.ownershipEpoch??0};},nonce:()=>crypto.randomUUID(),
    deliver:async(target,env)=>{const envelope=signEnvelope({sender:parentId,recipient:target,epoch:env.ownershipEpoch,nonce:crypto.randomUUID(),timestamp:Date.now(),command:{type:'deliverMessage',session:env.sessionKey,messageId:env.messageId,payload:env.payload,ownershipEpoch:env.ownershipEpoch}},bytes=>crypto.sign(null,Buffer.from(bytes),managers[0].loadSigningKey()).toString('base64'));
      const response=await fetch(`http://127.0.0.1:${address.port}/dispatch`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(envelope)});expect(response.ok).toBe(true);expect((await response.json() as {accepted:string}).accepted).toBe('queued');return {kind:'accepted'};}});
   const localSpawn=createMockSessionManager();vi.spyOn(localSpawn,'spawnSession');const ownerApi=express();ownerApi.use(express.json());ownerApi.use(createRoutes({config:{authToken:'test',stateDir:managers[0].baseDir,port:0},sessionManager:localSpawn,startTime:new Date(),conversationGraphDelegationRemoteRuntime:bridges[0]} as never));
   const body={name:'worker',prompt:'private launch prompt',topicId:43,targetMachineId:workerId};
   expect((await requestHttp(ownerApi).post('/sessions/spawn').set('Authorization','Bearer test').send(body)).status).toBe(409);
   expect(ownership.read('43')).toBeNull();expect(localSpawn.spawnSession).not.toHaveBeenCalled();
   expect((await requestHttp(ownerApi).post('/sessions/spawn').set('Authorization','Bearer test').set('X-Instar-Bind-Token',auth[0].mint('actual-parent-tmux',[42])).send({...body,targetMachineId:'https://attacker.invalid'})).status).toBe(409);
   const accepted=await requestHttp(ownerApi).post('/sessions/spawn').set('Authorization','Bearer test').set('X-Instar-Bind-Token',auth[0].mint('actual-parent-tmux',[42])).send(body);
   expect(accepted.status).toBe(202);expect(accepted.body.graph.state).toBe('checking-save');expect(localSpawn.spawnSession).not.toHaveBeenCalled();expect(request).toBeDefined();expect(runtime.source.recordsForRepair()).toHaveLength(0);
   // Simulate daemon loss AFTER dispatch admission: original frame/prompt is
   // gone. Only actual later persisted worker/bootstrap can complete capture.
   states[1].saveSession({id:'actual-worker',name:'worker',tmuxSession:'actual-worker-tmux',status:'running',startedAt:new Date().toISOString()});
   telegram[1].registerTopicSession(43,'actual-worker-tmux');
   await run(tmux,['new-session','-d','-s','actual-worker-tmux','-e',`INSTAR_BIND_TOKEN=${auth[1].mint('actual-worker-tmux',[43])}`,'-e','INSTAR_SESSION_ID=actual-worker','sleep 60']);
   const takeover=f.actuation(peer.machineId,2).originalLease;for(const leaseStore of leaseStores)leaseStore.casWrite(takeover);
   expect(await peer.refreshReadiness()).toBe(true);expect(()=>runtime.actuation()).toThrow('write-fenced');
   await bridges[1].afterSuccessfulSpawn(request!,undefined,'actual-worker');
   await bridges[1].replay();
   const records=runtime.source.recordsForRepair();expect(records).toHaveLength(1);expect(records[0].authorizationProof.dispatchSource?.kind).toBe('remote-delegation-source');
   expect(runtime.source.status(records[0].packet.eventId).state).toBe('committed');expect(peer.source.status(records[0].packet.eventId).state).toBe('committed');
   expect(peer.source.allCommitProofDelivered(records[0].packet.eventId)).toBe(true);
   const historical=records[0].authorizationProof.dispatchSource;if(historical?.kind!=='remote-delegation-source')throw new Error('source-missing');
   expect(historical.request.graphLease.epoch).toBe(1);expect(records[0].authorizationProof.originalLease.epoch).toBe(2);
   const fenced=f.record('old-holder-after-takeover');
   await expect(witness.prepare({packet:fenced.packet,packetSignature:fenced.packetSignature,controlCapsule:createGraphControlCapsule(fenced.coreType,fenced.core,fenced.authorizationProof),encryptedSourceBundle:fenced.encryptedSourceBundle!,...f.actuation()})).rejects.toThrow();
   const receiptFiles=await fs.readdir(path.join(managers[1].baseDir,'state','conversation-graph-remote-delegation'));
   for(const file of receiptFiles)expect(await fs.readFile(path.join(managers[1].baseDir,'state','conversation-graph-remote-delegation',file),'utf8')).not.toContain('private launch prompt');
  }finally{for(const bridge of bridges)bridge.close();await run(tmux,['kill-server']).catch(()=>{});for(const r of registry)await r.close();await new Promise<void>(resolve=>server.close(()=>resolve()));}
 });
});
