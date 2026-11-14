/** Actual PIN/session admission; no native revocation is executed by this test. */
import {describe,it,expect,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import {AgentServer} from '../../src/server/AgentServer.js';
import {GraphMemberLossHeldPreflight} from '../../src/core/GraphMemberLossHeldPreflight.js';
import {GraphNativeMemberLossStore} from '../../src/core/GraphNativeMemberLossStore.js';
import {applyOwnerMemberLossNativeAdministration} from '../../src/server/GraphOwnerMemberLossNativeAdministration.js';
import {GraphOwnerMemberLossActionService} from '../../src/server/GraphOwnerMemberLossAction.js';
import {ConversationGraphOwnerGrantStore} from '../../src/server/ConversationGraphOwnerGrant.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {IdentityStore} from '../../src/core/IdentityStore.js';
import {GraphCustodyBootstrapStore} from '../../src/core/GraphCustodyBootstrap.js';
import {createGraphCustodyProfile} from '../../src/core/GraphCustodyProfile.js';
import {canonicalHash,signGraphRecord,unsigned} from '../../src/core/GraphWitnessTypes.js';
import {readConversationGraphOwnerPolicy,initializeConversationGraphOwnerPolicy} from '../../src/core/ConversationGraphOwnerPolicy.js';
import {LiveConfig} from '../../src/config/LiveConfig.js';
import {StateManager} from '../../src/core/StateManager.js';
import {InitiativeTracker} from '../../src/core/InitiativeTracker.js';
import type {InstarConfig} from '../../src/core/types.js';
import {createMockSessionManager} from '../helpers/setup.js';
import {setupGraphRuntimeFixture} from '../helpers/conversation-graph-runtime.js';

describe('fresh owner member-loss action admission',()=>{
 it('requires actual PIN, exact named confirmation, and current policy after an awaited plan read',async()=>{
  const f=await setupGraphRuntimeFixture({ownedCustodyHostIndex:0}),identity=f.managers[0],stateDir=identity.baseDir;
  const config={projectName:'echo',projectDir:stateDir,stateDir,port:0,authToken:'member-loss-test-bearer',dashboardPin:'654321',developmentAgent:true,
   sessions:{claudePath:'/usr/bin/echo',maxSessions:1,defaultMaxDurationMinutes:30,protectedSessions:[],monitorIntervalMs:5000},scheduler:{enabled:false,jobsFile:'',maxParallelJobs:1},messaging:[],updates:{},threadline:{ownerName:'Owner'},secrets:{forceFileKey:true},mobilePairing:{multiRoute:{enabled:false}},multiMachine:{enabled:false,conversationGraph:{...f.options[0].configuration,storage:{enabled:true},readEnabled:true,correctionsEnabled:true}}} as unknown as InstarConfig;
  fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify(config));const liveConfig=new LiveConfig(stateDir);
  const server=new AgentServer({config,liveConfig,sessionManager:createMockSessionManager(),state:new StateManager(stateDir),initiativeTracker:new InitiativeTracker(stateDir),coordinator:{enabled:false,managers:{identityManager:identity}} as never,coherenceGate:f.options[0].scopeVerifier,conversationGraphReplicationRuntime:f.runtime});
  try{
   const secrets=new SecretStore({stateDir,forceFileKey:true}),policy=()=>readConversationGraphOwnerPolicy({stateDir,forceFileKey:true});
   initializeConversationGraphOwnerPolicy({stateDir,forceFileKey:true,liveConfig});
   const grants=new ConversationGraphOwnerGrantStore({stateDir,agentId:'echo',secrets,dashboardPolicy:policy});
   const next=structuredClone(f.f.membership);next.epoch++;next.previousMembershipHash=canonicalHash(f.f.membership);next.members=next.members.filter(row=>row.machineId===identity.loadIdentity().machineId);next.createdAt=new Date().toISOString();next.custodyProfile=createGraphCustodyProfile(next,{mode:'owned-machine',witnessPublicKey:next.custodyProfile!.witnessPublicKey,hostMachineId:identity.loadIdentity().machineId},f.f.owner.privateKey);next.signature=signGraphRecord('graph-membership-v1',unsigned(next),f.f.owner.privateKey);
   let duringPlan:(()=>void)|null=null;
   const serviceOptions={stateDir,agentId:'echo',identity,identities:new IdentityStore({stateDir}),secrets,grants,pairing:server.mobilePairing,verifyDashboardOwner:token=>(server as unknown as {verifyDashboardOperatorSession(token:string|undefined):boolean}).verifyDashboardOperatorSession(token),initializeDashboardPolicy:()=>{initializeConversationGraphOwnerPolicy({stateDir,forceFileKey:true,liveConfig});},signingContext:async()=>{await Promise.resolve();duringPlan?.();return{publication:new GraphCustodyBootstrapStore(stateDir,'echo').publication(f.f.membership.members)!,authority:f.authorities[0],newMembership:next,ownerPrivateKey:f.f.owner.privateKey};}};
   const service=new GraphOwnerMemberLossActionService(serviceOptions);const foreignGrants=new ConversationGraphOwnerGrantStore({stateDir:f.managers[1].baseDir,agentId:'echo',secrets:new SecretStore({stateDir:f.managers[1].baseDir,forceFileKey:true}),dashboardPolicy:policy});expect(()=>new GraphOwnerMemberLossActionService({...serviceOptions,grants:foreignGrants})).toThrow('member-loss-component-root-mismatch');
   const app=server.getApp();let intent:Awaited<ReturnType<typeof service.confirm>>|null=null;let resumeProgress:ReturnType<GraphNativeMemberLossStore['progress']>=null;let resumedAction:Awaited<ReturnType<NonNullable<typeof intent>['finalizeConsent']>>|null=null;
   app.post('/conversation-graph/member-loss/prepare',async(req,res)=>{try{res.json(await service.prepare(req,'dashboard',req.body));}catch(error){res.status(403).json({error:(error as Error).message});}});
   app.post('/conversation-graph/member-loss/confirm',async(req,res)=>{try{if(resumeProgress){const resumed=await service.resume(req,'dashboard',req.body,resumeProgress);intent=resumed.intent;resumedAction=resumed.action;res.json({intentHash:canonicalHash(intent.intentProof),consentHash:canonicalHash(resumed.action.consent)});}else{intent=await service.confirm(req,'dashboard',req.body);res.json({intentHash:canonicalHash(intent.intentProof)});}}catch(error){res.status(403).json({error:(error as Error).message});}});
   const body={requestId:'actual-member-loss-request',removedMachineIds:[f.managers[1].loadIdentity().machineId]};
   const auth=(test:request.Test,token?:string)=>{test.set('Authorization','Bearer member-loss-test-bearer').set('X-Instar-AgentId','echo');if(token)test.set('X-Instar-Operator-Session',token);return test;};
   expect((await auth(request(app).post('/conversation-graph/member-loss/prepare')).send(body)).status).toBe(403);
   const unlocked=await request(app).post('/dashboard/unlock').send({pin:'654321'});expect(unlocked.status).toBe(200);let token=unlocked.body.operatorSessionToken;
   const prepared=await auth(request(app).post('/conversation-graph/member-loss/prepare'),token).send(body);expect(prepared.status,JSON.stringify(prepared.body)).toBe(200);expect(prepared.body.nativeChangesStarted).toBe(false);
   const confirmation={requestId:body.requestId,draftHash:prepared.body.draftHash,challenge:prepared.body.challenge,confirmedMachineIds:body.removedMachineIds,lossAcknowledgement:'removed-local-unshared-edits-may-be-lost',pendingDisposition:'refuse-all-uncommitted'};
   expect((await auth(request(app).post('/conversation-graph/member-loss/confirm'),token).send({...confirmation,confirmedMachineIds:[]})).status).toBe(403);
   duringPlan=()=>{const disk=JSON.parse(fs.readFileSync(path.join(stateDir,'config.json'),'utf8'));disk.dashboardPin='987654';fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify(disk));};
   const raced=await auth(request(app).post('/conversation-graph/member-loss/prepare'),token).send({...body,requestId:'member-loss-policy-race'});expect(raced.status,JSON.stringify(raced.body)).toBe(403);
   duringPlan=null;liveConfig.set('dashboardPin','654321');const reauthenticated=await request(app).post('/dashboard/unlock').send({pin:'654321'});expect(reauthenticated.status).toBe(200);token=reauthenticated.body.operatorSessionToken;
   const confirmed=await auth(request(app).post('/conversation-graph/member-loss/confirm'),token).send(confirmation);expect(confirmed.status,JSON.stringify(confirmed.body)).toBe(200);expect(intent).not.toBeNull();
   expect(new IdentityStore({stateDir}).getEpoch(body.removedMachineIds[0]).revokedAt).toBeFalsy();
   const auditDir=path.join(stateDir,'conversation-graph','member-loss-actions',canonicalHash('echo'));const audit=fs.readFileSync(path.join(auditDir,fs.readdirSync(auditDir).find(name=>name.endsWith('.json'))!),'utf8');expect(audit).not.toContain(prepared.body.challenge);expect(audit).not.toContain(token);
   const actualIntent=intent!,scope=actualIntent.scope,context={ownerPublicKey:f.authorities[0].ownerPublicKey,previousPublicationHash:scope.previousPublicationHash,previousMembership:scope.previousMembership,newMembership:scope.newMembership,nativeIdentities:scope.nativeIdentities};
   const hold=f.authorities[0].beginMemberLossHold(actualIntent.intentProof,context,f.runtime.machineId,identity.loadSigningKey());
   const snapshot=await f.runtime.source.verifyMemberLossInventory(f.runtime.reader,f.runtime.droppedOriginRegistry,f.runtime.intake,f.authorities[0],actualIntent.intentProof);
   const preflight=GraphMemberLossHeldPreflight.collect({authority:f.authorities[0],snapshot,context,intent:actualIntent.intentProof,holds:[hold]});
   try{
    const action=await actualIntent.finalizeConsent(preflight),identities=new IdentityStore({stateDir}),store=new GraphNativeMemberLossStore({stateDir,identity,identities,instanceLock:f.options[0].instanceLock,authority:f.authorities[0]});
    const revoke=identities.revokeDurably.bind(identities),interrupted=vi.spyOn(identities,'revokeDurably').mockImplementation((...args)=>{revoke(...args);liveConfig.set('dashboardPin','987654');});
    try{await expect(applyOwnerMemberLossNativeAdministration({action,intent:actualIntent,preflight,store,identity,identities,coordinator:f.options[0].leaseCoordinator})).rejects.toThrow('member-loss-owner-policy-');}finally{interrupted.mockRestore();}
    expect(identities.getEpoch(body.removedMachineIds[0]).revokedAt).toBeTruthy();expect(store.read(action.consent,context)).toBeNull();
    const progress=store.progress(action.consent,context,actualIntent.intentProof)!;expect(progress.revokedMachineIds).toEqual(body.removedMachineIds);
    resumeProgress=progress;const fresh=await request(app).post('/dashboard/unlock').send({pin:'987654'});expect(fresh.status).toBe(200);token=fresh.body.operatorSessionToken;
    const resumed=await auth(request(app).post('/conversation-graph/member-loss/confirm'),token).send(confirmation);expect(resumed.status,JSON.stringify(resumed.body)).toBe(200);expect(resumed.body.consentHash).toBe(canonicalHash(action.consent));
    await expect(action.assertCurrentForNative({intentHash:canonicalHash(actualIntent.intentProof),consentHash:canonicalHash(action.consent),previousPublicationHash:scope.previousPublicationHash,previousMembershipHash:canonicalHash(scope.previousMembership),newMembershipHash:canonicalHash(scope.newMembership),nativeRosterHash:canonicalHash(scope.nativeIdentities)})).rejects.toThrow('member-loss-action-stale');
    const {receipt,floor}=await applyOwnerMemberLossNativeAdministration({action:resumedAction!,intent:intent!,preflight,store,identity,identities,coordinator:f.options[0].leaseCoordinator});expect(floor.lease.epoch).toBe(f.options[0].leaseCoordinator.currentEpoch());expect(receipt.revocations.map(row=>row.machineId)).toEqual(body.removedMachineIds);
    const repeatedPreview=await auth(request(app).post('/conversation-graph/member-loss/prepare'),token).send(body);expect(repeatedPreview.status).toBe(200);expect(repeatedPreview.body.nativeChangesStarted).toBe(true);
    const repeated=await applyOwnerMemberLossNativeAdministration({action:resumedAction!,intent:intent!,preflight,store,identity,identities,coordinator:f.options[0].leaseCoordinator});expect(canonicalHash(repeated.receipt)).toBe(canonicalHash(receipt));
   }finally{preflight.close();}
  }finally{await server.stop();}
 },120000);
});
