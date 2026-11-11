/** TEST ONLY. Actual shipped AgentServer/owned Default/device verifier. Only
 * session/model dispatch is disabled. No tunnel/host keychain; Graph sources
 * are synthetic. Unrelated AgentServer dependencies remain the real classes. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {observeFixturePerformance} from './conversation-graph-live-performance.mjs';
import {freezeGraphDist} from './conversation-graph-frozen-dist.mjs';
import {observeGraphFixtureRequest,observeGraphFixtureErasures} from './conversation-graph-live-observer.mjs';

const repository=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const critical=['server/AgentServer','server/ConversationGraphDefault','server/ConversationGraphOwnerChanges','server/ConversationGraphSurface','server/mobileOwnerDeviceAdmission','server/mobilePairingRoutes','core/MobileDeviceKeys','core/ConversationGraphReplication','core/GraphCustodyRetiredRoles','core/GraphWitnessService','core/GraphCustodyProfileAuthority','core/GraphCustodyPeerFrontier','core/GraphFleetErasureCoordinator','core/MobileDeviceKeyLedger','core/EffortHeaderStore','server/ConversationGraphHeaderCustody','core/ConversationGraphLocalErasure'];
function privateIPv4(ip){return net.isIP(ip)===4&&/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip);}
function allowedBind(bind){if(bind==='127.0.0.1')return true;return privateIPv4(bind)&&Object.values(os.networkInterfaces()).flat().some(row=>row?.family==='IPv4'&&row.address===bind);}
function listen(server,bind){return new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,bind,()=>{server.removeListener('error',reject);resolve(server.address().port);});});}
function json(res,status,body){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body));}
async function readJson(req){let length=0;const chunks=[];for await(const chunk of req){length+=chunk.length;if(length>4096)throw new Error('fixture-control-body-limit');chunks.push(chunk);}return chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};}
function opaque(value){return typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,160}$/.test(value)?value:null;}
function dispatchDisabled(){throw new Error('fixture-session-model-dispatch-disabled');}
function sessions(){return{on(){return this;},getProtectedSessions:()=>[],listRunningSessions:()=>[],getCachedRunningSessions:()=>({count:0,sessions:[]}),isSessionAlive:()=>false,stopMonitoring(){},spawnSession:dispatchDisabled,sendInput:dispatchDisabled,captureOutput:dispatchDisabled,killSession:()=>false};}

export async function startGraphLiveServer({bind='127.0.0.1',controlBind='127.0.0.1',studioIP=null,ttlMs=30*60*1000}={}){
 if(!allowedBind(bind)||!allowedBind(controlBind)||(controlBind!=='127.0.0.1'&&!privateIPv4(studioIP))||!Number.isSafeInteger(ttlMs)||ttlMs<1000||ttlMs>30*60*1000)throw new Error('fixture-bind-or-ttl-invalid');
 const startupPhase=name=>{const line=JSON.stringify({fixtureStartup:name,at:Date.now(),pid:process.pid})+'\n';process.stderr.write(line);try{fs.appendFileSync('/tmp/instar-live-fixture-phases.log',line,{mode:0o600});}catch{/* diagnostic only */}};startupPhase('snapshot-start');
 const deadline=Date.now()+ttlMs,codeSnapshot=await freezeGraphDist(repository,critical,startupPhase),modules=codeSnapshot.modules;startupPhase('snapshot-ready');
 let bindings;try{startupPhase('imports-start');bindings=await Promise.all(['server/AgentServer','server/ConversationGraphDefault','server/mobilePairingRoutes','core/MachineIdentity','core/SingleInstanceLock','core/SecretStore','core/ScopeVerifier','core/StateManager','core/InitiativeTracker','core/SafeFsExecutor','core/MobileDeviceKeys','core/AppRecordSignatures'].map(name=>import(codeSnapshot.moduleURL(name))));codeSnapshot.assertUnchanged();if(Date.now()>=deadline)throw new Error('fixture-ttl-expired-before-import');}catch(error){if(error?.code==='ERR_MODULE_NOT_FOUND'){const missing=String(error.message).match(/(?:module|package) '([^']+)'/)?.[1];if(missing)error.fixtureRelativeModule=missing.startsWith(codeSnapshot.root+path.sep)?path.relative(codeSnapshot.root,missing):(/^[a-zA-Z0-9_@./-]{1,200}$/.test(missing)?missing:null);}codeSnapshot.close();throw error;}
 startupPhase('imports-ready');
 const [{AgentServer},{ConversationGraphDefault},{deviceAdmissionIdentity,deviceAdmittedAt,deviceAdmittedHost},{MachineIdentityManager},{SingleInstanceLock},{SecretStore},{ScopeVerifier},{StateManager},{InitiativeTracker},{SafeFsExecutor},{parseDevicePublicKey},{deviceKeyHashOf}]=bindings;
 const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'conversation-graph-live-'));fs.chmodSync(stateDir,0o700);
 const performanceObserver=observeFixturePerformance(stateDir,{codeRoots:[codeSnapshot.root,repository]});
 const agentId='fixture-live-'+crypto.randomUUID(),controlToken=crypto.randomBytes(32).toString('base64url'),bearer=crypto.randomBytes(32).toString('base64url'),pin=String(crypto.randomInt(100000,1000000));
 const identity=new MachineIdentityManager(stateDir),lock=new SingleInstanceLock({stateDir});
 let server,manager,agentHttp,controlHttp,controlLanHttp,timer,closing,resolveClosed;const closed=new Promise(resolve=>{resolveClosed=resolve;});const observations=[],erasureIds=new Set();
 const close=()=>closing??(closing=(async()=>{const phase=name=>process.stderr.write(JSON.stringify({fixtureCleanup:name,at:Date.now()})+'\n');phase('listeners');performanceObserver.close();clearTimeout(timer);for(const listener of [controlLanHttp,controlHttp,agentHttp])if(listener){listener.closeAllConnections();await new Promise(resolve=>listener.close(()=>resolve()));}phase('server-stop');await server?.stop();phase('manager-close');await manager?.close();phase('private-state');lock.release();SafeFsExecutor.safeRmSync(stateDir,{recursive:true,force:true,operation:'graph-live-fixture:owned-temporary-cleanup'});phase('public-code');codeSnapshot.close();phase('done');resolveClosed();})());
 try{
  await identity.generateIdentity();if(!(await lock.acquire()).acquired)throw new Error('fixture-lock-refused');
  const scope=new ScopeVerifier({projectName:agentId,projectDir:stateDir}),config={projectName:agentId,projectDir:stateDir,stateDir,port:0,authToken:bearer,dashboardPin:pin,developmentAgent:true,
   sessions:{claudePath:'/usr/bin/false',maxSessions:1,defaultMaxDurationMinutes:30,protectedSessions:[],monitorIntervalMs:5000},scheduler:{enabled:false,jobsFile:'',maxParallelJobs:1},messaging:[],updates:{},threadline:{ownerName:'Fixture Owner'},secrets:{forceFileKey:true},
   mobilePairing:{enabled:true,native:{enabled:true},multiRoute:{enabled:false}},tunnel:{enabled:false},multiMachine:{enabled:false,conversationGraph:{readEnabled:true,correctionsEnabled:true}}};
  fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify(config),{mode:0o600});fs.writeFileSync(path.join(stateDir,'users.json'),JSON.stringify([{id:'fixture-msp',name:'Fixture MSP',channels:[],permissions:['user']}]),{mode:0o600});
  manager=new ConversationGraphDefault({stateDir,agentId,instanceLock:lock,scopeVerifier:scope,telegramChatId:'-1001',secrets:new SecretStore({stateDir,forceFileKey:true}),});
  server=new AgentServer({config,sessionManager:sessions(),state:new StateManager(stateDir),initiativeTracker:new InitiativeTracker(stateDir),coordinator:{enabled:false,managers:{identityManager:identity}},coherenceGate:scope,conversationGraphDefault:manager});
  const app=server.getApp();agentHttp=http.createServer((req,res)=>{observeGraphFixtureRequest(req,res,{bind,observations,deviceAdmittedAt,deviceAdmissionIdentity,deviceAdmittedHost,erasureIds});app(req,res);});
  const port=await listen(agentHttp,bind),agentURL=`http://${bind}:${port}`,signedHost=new URL(agentURL).hostname.toLowerCase();
  // Real dashboard PIN protocol establishes the default; no phone Graph call
  // is ever answered or authorized by this fixture control server.
  const unlocked=await fetch(agentURL+'/dashboard/unlock',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({pin}),signal:AbortSignal.timeout(15000)});const unlock=await unlocked.json();if(unlocked.status!==200||typeof unlock.operatorSessionToken!=='string')throw new Error('fixture-real-pin-unlock-refused');
  // The first owner visit composes the graph runtime lazily; under heavy test load that can answer
  // 503 (not ready yet) for a few seconds. Retry only that answer, bounded, and name the last status.
  let roots,rootsDeadline=Date.now()+30000;for(;;){roots=await fetch(agentURL+'/conversation-graph/roots',{headers:{authorization:`Bearer ${bearer}`,'X-Instar-AgentId':agentId,'X-Instar-Operator-Session':unlock.operatorSessionToken},signal:AbortSignal.timeout(15000)});if(roots.status===200&&manager.runtime)break;if(roots.status!==503||Date.now()>rootsDeadline)throw new Error('fixture-real-owner-bootstrap-refused-'+roots.status+(manager.runtime?'':'-no-runtime'));await roots.arrayBuffer();await new Promise(resolve=>setTimeout(resolve,500));}await roots.arrayBuffer();
  const pairing=server.mobilePairing;if(!pairing?.nativeOn||!pairing.keyLedger)throw new Error('fixture-real-native-verifier-unavailable');
  const controlHandler=async(req,res)=>{try{
   const remote=(req.socket.remoteAddress??'').replace(/^::ffff:/,'');if(!['127.0.0.1','::1',...(controlBind!=='127.0.0.1'?[studioIP]:[])].includes(remote))return json(res,403,{code:'fixture-control-peer-refused'});
   if(req.headers.authorization!==`Bearer ${controlToken}`)return json(res,401,{code:'fixture-control-unauthorized'});
   const route=new URL(req.url??'/','http://127.0.0.1').pathname;
   if(req.method==='POST'&&route==='/admitDevice'){
    const body=await readJson(req);if(!parseDevicePublicKey(body.publicKey)||!['owner','msp'].includes(body.role??'owner'))return json(res,400,{code:'fixture-public-key-invalid'});
    const role=body.role??'owner',pending=pairing.devices.createPending({deviceName:'Synthetic live fixture phone',label:null,publicKey:body.publicKey,host:signedHost,role,...(role==='msp'?{userId:'fixture-msp'}:{})});if(!pending.ok)return json(res,409,{code:'fixture-pending-refused'});
    const activation=pairing.keyLedger.recordActivation(pending.device,'dashboard-pin',new Date().toISOString());if(!activation||!pairing.devices.applyConfirm(pending.device.id,{ok:true,approvedVia:'dashboard-pin',approvedAt:activation.activatedAt}))throw new Error('fixture-durable-device-approval-refused');
    return json(res,200,{deviceId:pending.device.id,role,signedHost,approvedVia:'fixture',registryStatus:pairing.devices.get(pending.device.id)?.status,ledgerActivationRecorded:true,pairingUIProof:false});
   }
   if(req.method==='POST'&&route==='/revokeDevice'){
    const body=await readJson(req),device=opaque(body.deviceId)&&pairing.devices.get(body.deviceId);if(!device)return json(res,404,{code:'fixture-device-unknown'});const at=new Date().toISOString();pairing.keyLedger.recordRevocation(device,at);pairing.devices.revoke(device.id,at);
    return json(res,200,{deviceId:device.id,status:pairing.devices.get(device.id)?.status,ledgerRevoked:pairing.keyLedger.isRevoked(deviceKeyHashOf(device.publicKey),device.id)});
   }
   if(req.method==='GET'&&route==='/evidence'){
    const runtime=manager.runtime,records=runtime?.source.recordsForRepair()??[],erasureEvidence=await observeGraphFixtureErasures(runtime,agentId,erasureIds);
    return json(res,200,{schemaVersion:1,agentId,observedAt:Date.now(),observations:[...observations],nativeDispatchDisabled:true,defaultMembership:runtime?{epoch:runtime.installedMembership.epoch,memberCount:runtime.installedMembership.members.length,mode:runtime.installedMembership.custodyProfile?.mode}:null,
     sourceControls:records.map(record=>({coreType:record.coreType,operationKey:record.packet.eventId,kind:record.core.kind??record.core.op??null,subject:record.core.subject??null,headerId:record.core.headerId??null,authenticationMethod:record.authorizationProof.receipt.authenticationMethod,status:runtime.source.status(record.packet.eventId).state,historicalVerified:runtime.source.verifyHistoricalRecord(record),erasure:{localDenied:runtime.localErasure.isDenied(record.packet.erasureIdentity),sourceErased:runtime.source.isErased(record.packet.erasureIdentity),witnessProofPresent:!!record.erasure}})),performance:performanceObserver.snapshot(),...erasureEvidence,modules,codeSnapshot:codeSnapshot.identity});
   }
   if(req.method==='POST'&&route==='/shutdown'){json(res,202,{shutdown:'scheduled'});setImmediate(()=>void close());return;}
   return json(res,404,{code:'fixture-control-route-unknown'});
  }catch{return json(res,503,{code:'fixture-control-evidence-missing'});}};
  controlHttp=http.createServer(controlHandler);
  if(Date.now()>=deadline)throw new Error('fixture-ttl-expired-before-publication');
  const controlPort=await listen(controlHttp,'127.0.0.1');let controlURL=`http://127.0.0.1:${controlPort}`;if(controlBind!=='127.0.0.1'){controlLanHttp=http.createServer(controlHandler);const lanPort=await listen(controlLanHttp,controlBind);controlURL=`http://${controlBind}:${lanPort}`;}const manifest={schemaVersion:1,fixtureOnly:true,agentURL,agentId,signedHost,controlURL,control:{admit:controlURL+'/admitDevice',evidence:controlURL+'/evidence',revoke:controlURL+'/revokeDevice'},controlLoopbackURL:`http://127.0.0.1:${controlPort}`,controlAllowedPeerIP:controlBind==='127.0.0.1'?null:studioIP,controlToken,dashboardPin:pin,codeSnapshot:{...codeSnapshot.identity,root:codeSnapshot.root},publicKeyFormat:'X9.63-uncompressed-P256-base64url',signatureFormat:'DER-low-S-base64url',expiresAt:new Date(deadline).toISOString(),approvedVia:'fixture-ledger-before-confirm',pairingUIProof:false,diagnostics:{sampler:'perf-hooks-no-sampling-signals',performanceFile:performanceObserver.file},modules};
  const manifestPath=path.join(stateDir,'fixture-manifest.json'),fd=fs.openSync(manifestPath,'wx',0o600);try{fs.writeFileSync(fd,JSON.stringify(manifest,null,2));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}const directory=fs.openSync(stateDir,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}
  timer=setTimeout(()=>void close(),Math.max(1,deadline-Date.now()));return{manifestPath,manifest,close,closed};
 }catch(error){await close();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const bind=process.argv.find(a=>a.startsWith('--bind='))?.slice(7)??'127.0.0.1',controlBind=process.argv.find(a=>a.startsWith('--control-bind='))?.slice('--control-bind='.length)??'127.0.0.1',studioIP=process.argv.find(a=>a.startsWith('--studio-ip='))?.slice('--studio-ip='.length)??null,ttl=process.argv.find(a=>a.startsWith('--ttl-ms='))?.slice(9);startGraphLiveServer({bind,controlBind,studioIP,...(ttl?{ttlMs:Number(ttl)}:{})}).then(fixture=>{process.stdout.write(`CONVERSATION_GRAPH_FIXTURE_MANIFEST=${fixture.manifestPath}\n`);void fixture.closed.then(()=>process.exit(0));for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void fixture.close());}).catch(error=>{const code=String(error?.message??'');try{fs.writeFileSync('/tmp/instar-live-fixture-last-failure.log',`${new Date().toISOString()} cwd=${process.cwd()} TMPDIR=${process.env.TMPDIR??''} node=${process.version}\n${error?.stack??String(error)}\n`,{mode:0o600});}catch{/* diagnostic only: a verify run removes its lane temp folders, so keep the full failure where it survives */}process.stderr.write(`conversation-graph-live-fixture failed: ${/^fixture-[a-z0-9-]{1,100}$/.test(code)?code:String(error?.code??error?.name??'startup-refused')}${error?.fixtureRelativeModule?' module='+error.fixtureRelativeModule:''}\n`);process.exit(1);});
}
