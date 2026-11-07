import {startGraphSyncMethodTiming} from '../helpers/graph-sync-method-timing.js';
/** Planned M2 history must be retained before explicit permanent loss of M2's
 * old host. Real PIN admission remains separate from archive preparation. */
import {observeFixturePerformance} from '../helpers/conversation-graph-live-performance.mjs';
import {it,expect,vi} from 'vitest';
import fs from 'node:fs';import path from 'node:path';import request from 'supertest';
import {setupGraphDefaultPlannedTransition} from '../helpers/graph-default-planned-transition.js';
import {createMockSessionManager} from '../helpers/setup.js';
import {removeLostMachine} from '../../src/server/ConversationGraphMemberLossSurface.js';
import {GraphOwnerMemberLossExecution} from '../../src/server/GraphOwnerMemberLossExecution.js';
import {GraphOwnerMemberLossActionService,type GraphOwnerMemberLossIntent} from '../../src/server/GraphOwnerMemberLossAction.js';
import {GraphOwnerMemberLossPlanning} from '../../src/server/GraphOwnerMemberLossPlanning.js';
import {applyOwnerMemberLossNativeAdministration} from '../../src/server/GraphOwnerMemberLossNativeAdministration.js';
import {ConversationGraphOwnerGrantStore} from '../../src/server/ConversationGraphOwnerGrant.js';
import {GraphMemberLossHeldPreflight} from '../../src/core/GraphMemberLossHeldPreflight.js';
import {GraphNativeMemberLossStore,GraphNativeMemberLossProgress} from '../../src/core/GraphNativeMemberLossStore.js';
import {GraphWitnessClient} from '../../src/core/GraphWitnessClient.js';
import {GraphWitnessService} from '../../src/core/GraphWitnessService.js';
import {GraphWitnessBootstrapStream} from '../../src/core/GraphWitnessBootstrapStream.js';
import {GraphMemberLossPinStore} from '../../src/core/GraphMemberLossPinStore.js';
import {GraphCustodyProfileAuthority} from '../../src/core/GraphCustodyProfileAuthority.js';
import {GraphHeldSourceReader,GraphMemberLossSourceSnapshot} from '../../src/core/ConversationGraphReplication.js';
import {AgentServer} from '../../src/server/AgentServer.js';
import {StateManager} from '../../src/core/StateManager.js';import {InitiativeTracker} from '../../src/core/InitiativeTracker.js';
import {LiveConfig} from '../../src/config/LiveConfig.js';
import {initializeConversationGraphOwnerPolicy,readConversationGraphOwnerPolicy} from '../../src/core/ConversationGraphOwnerPolicy.js';
import {canonicalHash} from '../../src/core/GraphWitnessTypes.js';
import type {InstarConfig} from '../../src/core/types.js';
it('preserves original M1 certified history through actual planned M2 then fresh-owner loss to M3',async()=>{
 let metricsTimer:ReturnType<typeof setInterval>|undefined;const observer=process.env.GRAPH_LOSS_DIAGNOSTIC_PERF==='1'?observeFixturePerformance(fs.mkdtempSync(path.join(process.cwd(),'.instar/state/build/graph-loss-historical-perf-'))):null;try{
 const started=Date.now(),phase=(name:string)=>console.info('[historical-loss-phase]',JSON.stringify({phase:name,elapsedMs:Date.now()-started}));
 if(observer){metricsTimer=setInterval(()=>{const value=observer.snapshot();console.info('[historical-loss-safe-sites]',JSON.stringify({failure:value.failure,callsiteSampling:value.callsiteSampling,sampleCount:value.samples.length}));},15000);metricsTimer.unref();}
 phase('fixture-start');const f=await setupGraphDefaultPlannedTransition({onPhase:name=>phase('fixture-'+name)});phase('fixture-complete');const manager=f.defaults[1],identity=f.native.managers[1],stateDir=identity.baseDir,secrets=f.secrets[1],native=manager.nativeDelegationDependencies!,actual=manager.memberLossPlanningComponents()!,runtime=manager.runtime!,removed=f.native.managers[0].loadIdentity().machineId;
 const config={projectName:'echo',projectDir:stateDir,stateDir,port:0,authToken:'historical-loss-owner-bearer',dashboardPin:'654321',developmentAgent:true,sessions:{claudePath:'/usr/bin/echo',maxSessions:1,defaultMaxDurationMinutes:30,protectedSessions:[],monitorIntervalMs:5000},scheduler:{enabled:false,jobsFile:'',maxParallelJobs:1},messaging:[],updates:{},threadline:{ownerName:'Owner'},secrets:{forceFileKey:true},mobilePairing:{multiRoute:{enabled:false}},multiMachine:{enabled:false}} as unknown as InstarConfig;
 fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify(config));const liveConfig=new LiveConfig(stateDir),server=new AgentServer({config,liveConfig,sessionManager:createMockSessionManager(),state:new StateManager(stateDir),initiativeTracker:new InitiativeTracker(stateDir),coordinator:{enabled:false,managers:{identityManager:identity}} as never,coherenceGate:f.native.options[1].scopeVerifier});
 try{
  // This is an actual fixture socket closure, not a transport-success boolean.
  f.listeners[0].closeAllConnections();await new Promise<void>(resolve=>f.listeners[0].close(()=>resolve()));expect(f.listeners[0].listening).toBe(false);await f.defaults[0].close();
  initializeConversationGraphOwnerPolicy({stateDir,forceFileKey:true,liveConfig});const grants=new ConversationGraphOwnerGrantStore({stateDir,agentId:'echo',secrets,dashboardPolicy:()=>readConversationGraphOwnerPolicy({stateDir,forceFileKey:true})}),verify=(token:string|undefined)=>(server as unknown as {verifyDashboardOperatorSession(value:string|undefined):boolean}).verifyDashboardOperatorSession(token),service=new GraphOwnerMemberLossActionService({stateDir,agentId:'echo',identity,identities:native.identities,secrets,grants,pairing:server.mobilePairing,verifyDashboardOwner:verify,initializeDashboardPolicy:()=>{initializeConversationGraphOwnerPolicy({stateDir,forceFileKey:true,liveConfig});},signingContext:(ids,id,plan)=>new GraphOwnerMemberLossPlanning(manager).context(ids,id,plan)}),app=server.getApp();let intent:GraphOwnerMemberLossIntent|undefined;
  app.post('/conversation-graph/member-loss/prepare',async(req,res)=>{try{res.json(await service.prepare(req,'dashboard',req.body));}catch(error){res.status(403).json({error:(error as Error).message});}});app.post('/conversation-graph/member-loss/confirm',async(req,res)=>{try{intent=await service.confirm(req,'dashboard',req.body);res.json({intentHash:canonicalHash(intent.intentProof)});}catch(error){res.status(403).json({error:(error as Error).message});}});
  phase('real-owner-unlock');const unlocked=await request(app).post('/dashboard/unlock').send({pin:'654321'});expect(unlocked.status).toBe(200);const auth=(value:request.Test)=>value.set('Authorization','Bearer historical-loss-owner-bearer').set('X-Instar-AgentId','echo').set('X-Instar-Operator-Session',unlocked.body.operatorSessionToken),prepared=await auth(request(app).post('/conversation-graph/member-loss/prepare')).send({requestId:'actual-m2-history-member-loss',removedMachineIds:[removed]});expect(prepared.status,JSON.stringify(prepared.body)).toBe(200);
  phase('owner-prepare-returned');const confirmed=await auth(request(app).post('/conversation-graph/member-loss/confirm')).send({requestId:'actual-m2-history-member-loss',draftHash:prepared.body.draftHash,challenge:prepared.body.challenge,confirmedMachineIds:[removed],lossAcknowledgement:'removed-local-unshared-edits-may-be-lost',pendingDisposition:'refuse-all-uncommitted'});expect(confirmed.status,JSON.stringify(confirmed.body)).toBe(200);
  phase('owner-confirm-returned');const admitted=intent!,scope=admitted.scope,context={ownerPublicKey:actual.authority.ownerPublicKey,previousPublicationHash:scope.previousPublicationHash,previousMembership:scope.previousMembership,newMembership:scope.newMembership,nativeIdentities:scope.nativeIdentities};
  expect(context.previousMembership.epoch).toBe(2);expect(native.identities.getEpoch(removed).revokedAt).toBeUndefined();
  const restore:Array<()=>void>=[],prototype=GraphWitnessClient.prototype as unknown as Record<string,(...args:unknown[])=>Promise<unknown>>;for(const method of ['inventory','operation','recover','activation','recoveryContext','historicalMaterialization']){const original=prototype[method];if(typeof original!=='function')continue;const trace=vi.spyOn(prototype,method).mockImplementation(function(this:GraphWitnessClient,...args:unknown[]){const result=original.apply(this,args);void result.catch(error=>{const code=error instanceof Error&&/^[a-z0-9-]{1,96}$/.test(error.message)?error.message:'non-opaque-error';console.info('[historical-loss-witness]',JSON.stringify({method,code}));});return result;});restore.push(()=>trace.mockRestore());}
  const tracePort=(target:object,method:string,label:string)=>{const callable=target as Record<string,(...args:unknown[])=>unknown>,original=callable[method];if(typeof original!=='function')throw new Error('test-phase-port-missing');const trace=vi.spyOn(callable,method).mockImplementation(function(this:unknown,...args:unknown[]){phase(label+'-start');try{const result=Reflect.apply(original,this,args);if(result&&typeof (result as {then?:unknown}).then==='function')void(result as Promise<unknown>).then(()=>phase(label+'-return'),error=>phase(label+'-reject:'+(error instanceof Error&&/^[a-z0-9-]{1,96}$/.test(error.message)?error.message:'non-opaque-error')));else phase(label+'-return');return result;}catch(error){phase(label+'-throw:'+(error instanceof Error&&/^[a-z0-9-]{1,96}$/.test(error.message)?error.message:'non-opaque-error'));throw error;}});restore.push(()=>trace.mockRestore());};
  for(const method of ['verifyMemberLossHeldSourceReader','verifyDurableHistoricalImport'])tracePort(runtime.source,method,'source-'+method);
  for(const method of ['prepareHeldRewrapInventory','stageHeldSource','openRetainedCustodyStage','postActivationTransferReceiptReader'])tracePort(runtime.transfer,method,'transfer-'+method);
  tracePort(GraphHeldSourceReader.prototype,'readRecord','held-read');tracePort(GraphWitnessBootstrapStream,'prepare','w-stream-prepare');tracePort(GraphWitnessBootstrapStream.prototype,'apply','w-stream-apply');tracePort(GraphMemberLossPinStore.prototype,'pinRetained','pin-retained');
  for(const method of ['finishBootstrapTransfer','finishRecoveryUpload','bootstrap','recoverPending','settleMemberLoss'])tracePort(GraphWitnessService.prototype,method,'w-'+method);
  for(const method of ['stageMemberLossActivation','completeMemberLossActivation'])tracePort(GraphCustodyProfileAuthority.prototype,method,'core-'+method);
  const methodTiming=startGraphSyncMethodTiming([
   {label:'NativeStore',prototype:GraphNativeMemberLossStore.prototype,methods:['assertDurableReceipt']},
   {label:'NativeProgress',prototype:GraphNativeMemberLossProgress.prototype,methods:['assertCurrent','assertCurrentNativeContext']},
   {label:'SourceSnapshot',prototype:GraphMemberLossSourceSnapshot.prototype,methods:['assertCurrent']},
   {label:'HeldPreflight',prototype:GraphMemberLossHeldPreflight.prototype,methods:['assertCurrent']},
   {label:'Core',prototype:GraphCustodyProfileAuthority.prototype,methods:['currentMembership','verifiedNegativeRoleLineage','assertMemberLossHeld']},
  ]),timingInterval=setInterval(()=>console.info('[historical-loss-method-timing]',JSON.stringify(methodTiming.snapshot())),15000);timingInterval.unref();
  try{
  phase('removal');const result=await removeLostMachine({manager,stateDir,intent:admitted,resumed:null,progress:null});phase('removal-complete');expect(result.activation.newMembership.epoch).toBe(3);
  for(const original of f.records){const retained=manager.runtime!.source.repairRecord(original.packet.eventId);expect(retained?.certificate).toEqual(original.certificate);expect(retained?.packetSignature).toBe(original.packetSignature);expect(retained?.core).toEqual(original.core);}
  expect(manager.runtime!.installedMembership.epoch).toBe(3);const ready=await manager.runtime!.refreshReadiness();console.info('[historical-loss-readiness]',JSON.stringify({ready,phase:(manager.runtime as unknown as {lastReadinessFailure:string|null}).lastReadinessFailure}));expect(ready).toBe(true);
  }finally{clearInterval(timingInterval);console.info('[historical-loss-method-timing-final]',JSON.stringify(methodTiming.snapshot()));methodTiming.restore();for(const release of restore)release();}
 }finally{await server.stop();await f.cleanup();}
 }finally{if(metricsTimer)clearInterval(metricsTimer);if(observer){const value=observer.snapshot();console.info('[historical-loss-safe-sites-final]',JSON.stringify({failure:value.failure,callsiteSampling:value.callsiteSampling,sampleCount:value.samples.length}));}observer?.close();}
},120000);
