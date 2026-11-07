/** Actual signed Default routers on a real socket. Prior publication/keys come
 * from the native fixture; this is not first owner boot or phone proof. */
import {it,expect,vi} from 'vitest';
import http from 'node:http';
import express from 'express';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';
import {ConversationGraphDefault,GRAPH_OWNER_CONTROL_SECRET,GRAPH_CUSTODY_ROLE_SECRET,GRAPH_PEER_BEARER_SECRET} from '../../src/server/ConversationGraphDefault.js';
import {GraphOwnerMemberLossPlanning} from '../../src/server/GraphOwnerMemberLossPlanning.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
it('holds recovery planning on an actual reachable 403, and clears only after a genuine signed current peer frontier',async()=>{
 const f=await setupGraphRuntimeFixture({ownedCustodyHostIndex:0}),publicKey=f.f.owner.publicKey.export({format:'pem',type:'spki'}).toString();
 const secrets=f.managers.map((identity,index)=>{const store=new SecretStore({stateDir:identity.baseDir,forceFileKey:true});if(index===0){store.set(GRAPH_OWNER_CONTROL_SECRET,{v:1,agentId:'echo',privateKey:f.f.owner.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKey,createdAt:new Date().toISOString()});store.set(GRAPH_CUSTODY_ROLE_SECRET,f.f.witness.privateKey.export({format:'pem',type:'pkcs8'}).toString());}store.set(GRAPH_PEER_BEARER_SECRET,'x'.repeat(43));store.set('conversation_graph_peer_bearer_scope',{v:1,agentId:'echo',ownerPublicKeyHash:canonicalHash(publicKey),purpose:'owned-default-peer-bearer'});store.syncDurably();return store;});
 const managers=f.managers.map((identity,index)=>{const {configuration:_configuration,...fleet}=f.options[index];return new ConversationGraphDefault({stateDir:identity.baseDir,agentId:'echo',secrets:secrets[index],fleet,instanceLock:fleet.instanceLock,scopeVerifier:fleet.scopeVerifier,bootstrapBearer:'synthetic-peer-bootstrap'});});
 let refuse=true,server:http.Server|undefined,resolve:ReturnType<typeof vi.spyOn>|undefined;
 try{const app=express();app.use((_req,res,next)=>{if(refuse){res.status(403).json({code:'synthetic-auth-refusal'});return;}next();});app.use(managers[1].admissionGuard(),express.json(),managers[1].router);server=http.createServer(app);await new Promise<void>(done=>server!.listen(0,'127.0.0.1',done));const address=server.address();if(!address||typeof address==='string')throw Error('test-socket-missing');const peerId=f.managers[1].loadIdentity().machineId;
  resolve=vi.spyOn(f.options[0].endpointResolver,'resolve').mockImplementation(target=>target===peerId?[{url:`http://127.0.0.1:${address.port}`,kind:'lan',priority:1}] as never:[]);
  await managers[0].ensureOwner({principalKey:'owner:echo',authenticationMethod:'owner-dashboard',requestId:'actual-peer-refusal-bootstrap',isCurrent:()=>true});const planner=new GraphOwnerMemberLossPlanning(managers[0]),id='actual-peer-refusal-plan';
  await expect(planner.context([peerId],id)).rejects.toThrow('reachable-unverified');expect(secrets[0].get('conversation_graph_member_loss_candidate_'+canonicalHash({agentId:'echo',requestId:id}))).toBeUndefined();expect(f.options[0].identities.getEpoch(peerId).revokedAt).toBeFalsy();
  refuse=false;const plan=await planner.context([peerId],id);expect(plan.newMembership.members.map(row=>row.machineId)).toEqual([f.managers[0].loadIdentity().machineId]);expect(plan.authority.currentMembership().epoch).toBe(1);expect(f.options[0].identities.getEpoch(peerId).revokedAt).toBeFalsy();
 }finally{resolve?.mockRestore();for(const manager of managers)await manager.close();if(server)await new Promise<void>(done=>server!.close(()=>done()));}
},120000);
