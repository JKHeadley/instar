/** Mechanical key/plan binding only. The actual PIN permission test is separate. */
import {it,expect} from 'vitest';import crypto from 'node:crypto';
import {setupGraphRuntimeFixture,stopGraphRuntimeFixturePeer} from '../helpers/conversation-graph-runtime.js';
import {ConversationGraphDefault,GRAPH_OWNER_CONTROL_SECRET,GRAPH_CUSTODY_ROLE_SECRET,GRAPH_PEER_BEARER_SECRET} from '../../src/server/ConversationGraphDefault.js';
import {GraphOwnerMemberLossPlanning} from '../../src/server/GraphOwnerMemberLossPlanning.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {graphOwnedRoleSecretName} from '../../src/core/GraphCustodyStagedRole.js';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
it.each([0,1] as const)('plans survivor %s from actual pinned Default and sealed recovery; missing role keys never regenerate',async(index)=>{
 const f=await setupGraphRuntimeFixture({ownedCustodyHostIndex:0}),stateDir=f.managers[index].baseDir,secrets=new SecretStore({stateDir,forceFileKey:true}),publicKey=f.f.owner.publicKey.export({format:'pem',type:'spki'}).toString();
 // Existing actual signed publication/pins/recovery envelope are produced by
 // the shared native fixture. This seeds its matching prior vault material;
 // it is not a fresh owner-admission or production boot proof.
 if(index===0){secrets.set(GRAPH_OWNER_CONTROL_SECRET,{v:1,agentId:'echo',privateKey:f.f.owner.privateKey.export({format:'pem',type:'pkcs8'}).toString(),publicKey,createdAt:new Date().toISOString()});secrets.set(GRAPH_CUSTODY_ROLE_SECRET,f.f.witness.privateKey.export({format:'pem',type:'pkcs8'}).toString());}secrets.set(GRAPH_PEER_BEARER_SECRET,'x'.repeat(43));secrets.set('conversation_graph_peer_bearer_scope',{v:1,agentId:'echo',ownerPublicKeyHash:canonicalHash(publicKey),purpose:'owned-default-peer-bearer'});secrets.syncDurably();
 const {configuration:_configuration,...fleet}=f.options[index],manager=new ConversationGraphDefault({stateDir,agentId:'echo',secrets,fleet,instanceLock:f.options[index].instanceLock,scopeVerifier:f.options[index].scopeVerifier!,telegramChatId:'-1001',bootstrapBearer:'planning-fixture-bootstrap'});
 try{await stopGraphRuntimeFixturePeer(f.apps[index===0?1:0]);await manager.ensureOwner({principalKey:'owner:echo',authenticationMethod:'owner-dashboard',requestId:'mechanical-planning-bootstrap',isCurrent:()=>true});const actual=manager.memberLossPlanningComponents();expect(actual?.authority.stateRoot).toBeTruthy();
  const planner=new GraphOwnerMemberLossPlanning(manager),removed=[f.managers[index===0?1:0].loadIdentity().machineId],first=await planner.context(removed,'mechanical-plan-0001'),again=await planner.context(removed,'mechanical-plan-0001');expect(canonicalHash(first.newMembership)).toBe(canonicalHash(again.newMembership));expect(first.newMembership.members.map(row=>row.machineId)).toEqual([f.managers[index].loadIdentity().machineId]);expect(crypto.createPublicKey(first.ownerPrivateKey).export({format:'pem',type:'spki'}).toString()).toBe(publicKey);expect(first.authority.currentMembership().epoch).toBe(1);
  await expect(planner.context([f.managers[index].loadIdentity().machineId],'mechanical-plan-self')).rejects.toThrow('member-loss-plan-roster-invalid');
  const roleKey=graphOwnedRoleSecretName(first.newMembership),prior=secrets.get(roleKey);secrets.delete(roleKey);await expect(planner.context(removed,'mechanical-plan-0001')).rejects.toThrow('member-loss-role-key-missing');secrets.set(roleKey,prior!);secrets.syncDurably();
 }finally{await manager.close();}
},120000);
