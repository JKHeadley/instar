/** Real normal CLI composition. No injected Graph/Default/native runtime.
 * Public npm metadata checks are allowed; all state/cache/registry is temporary.
 * No phone/tunnel/pairing UI or deployment claim. */
import {it,expect} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawn,type ChildProcess} from 'node:child_process';
import crypto from 'node:crypto';
import {MachineIdentityManager} from '../../src/core/MachineIdentity.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {testEvidenceDir} from '../helpers/test-evidence-dir.js';

const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){const server=net.createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address||typeof address==='string')throw new Error('fixture-port');const port=address.port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
/** Exact current GlobalInstallCleanup search, read-only. Fail on read error. */
function globalCleanupCandidates():string[]{
 const found:string[]=[],home=os.homedir();
 for(const versions of [path.join(home,'.asdf','installs','nodejs'),path.join(home,'.nvm','versions','node')])if(fs.existsSync(versions))for(const version of fs.readdirSync(versions)){const candidate=path.join(versions,version,'lib','node_modules','instar');if(fs.existsSync(path.join(candidate,'package.json')))found.push(candidate);}
 for(const candidate of ['/opt/homebrew/lib/node_modules/instar','/usr/local/lib/node_modules/instar'])if(fs.existsSync(path.join(candidate,'package.json')))found.push(candidate);
 const volta=path.join(home,'.volta','tools','image','packages','instar');if(fs.existsSync(volta))found.push(volta);
 return found.sort();
}
/** The server refuses to boot without the configured framework's CLI. CI has no Codex, and maxSessions is 0, so nothing ever runs it:
 * use a real codex when one is found, otherwise a stand-in that only answers --version, kept in the fixture folder so cleanup removes it. */
function codexBinary(fixtureDir:string):string{
 const found=(process.env.PATH??'').split(path.delimiter).map(dir=>path.join(dir,'codex')).find(file=>{try{fs.accessSync(file,fs.constants.X_OK);return true;}catch{return false;}});if(found)return found;
 const dir=path.join(fixtureDir,'fakebin'),file=path.join(dir,'codex');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(file,'#!/bin/sh\necho "codex-cli 0.0.0-test"\n',{mode:0o755});return file;
}
export function normalCliFixtureConfig(projectDir:string,port:number,token:string,pin:string){
 return {projectName:'conversations-cli-'+path.basename(path.dirname(projectDir)),projectDir,host:'127.0.0.1',port,authToken:token,dashboardPin:pin,secrets:{forceFileKey:true},developmentAgent:false,
  codex:{autoArmHooks:false},threadline:{relayEnabled:false,spawn:{drainEnabled:false}},scheduler:{enabled:false,jobsFile:path.join(projectDir,'.instar','jobs.json')},messaging:[],tunnel:{enabled:false},updates:{autoApply:false},feedback:{enabled:false},telemetry:{enabled:false},
  sessions:{maxSessions:0,framework:'codex-cli',frameworkBinaryPaths:{'codex-cli':codexBinary(path.dirname(projectDir))}},enabledFrameworks:['codex-cli'],multiMachine:{conversationGraph:{readEnabled:true,correctionsEnabled:true},meshTransport:{enabled:false,tailscaleEnabled:false}},
  monitoring:{systemReview:{enabled:false},quotaTracking:false,memoryMonitoring:false,watchdog:{enabled:false},telemetry:{enabled:false},sessionReaper:{enabled:false},agentWorktreeReaper:{enabled:false,githubMergeCheck:false},externalHogSentinel:{enabled:false},orphanedWorkSentinel:{enabled:false},mcpProcessReaper:{enabled:false},codexArmSessionSweeper:{enabled:false},bootHealthBeacon:{enabled:false},rateLimitSentinel:{enabled:false},socketDisconnectSentinel:{enabled:false}},
 };
}
it('boots the real CLI and preserves owner-created effort across a same-file cold restart',async()=>{
 const temporary=fs.mkdtempSync(path.join(os.tmpdir(),'graph-normal-cli-')),project=path.join(temporary,'project'),stateDir=path.join(project,'.instar'),registry=path.join(temporary,'registry'),token=crypto.randomUUID(),pin='synthetic-'+crypto.randomUUID();
 fs.mkdirSync(stateDir,{recursive:true});const port=await freePort(),config=normalCliFixtureConfig(project,port,token,pin);fs.writeFileSync(path.join(stateDir,'config.json'),JSON.stringify(config));fs.writeFileSync(path.join(stateDir,'jobs.json'),'[]');
 // Same actual crypto initializer as normal init.ts, which ALWAYS creates identity.
 const identity=new MachineIdentityManager(stateDir);await identity.generateIdentity({role:'awake'});const originalId=identity.loadIdentity().machineId;
 let child:ChildProcess|undefined,output='',generation=0;const censuses:unknown[]=[];const base=`http://127.0.0.1:${port}`;
 const request=async(route:string,body?:unknown,proof?:string,auth=true)=>{const response=await fetch(base+route,{method:body===undefined?'GET':'POST',headers:{...(auth?{Authorization:`Bearer ${token}`} : {}),...(proof?{'X-Instar-Operator-Session':proof}:{}),...(body!==undefined?{'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(10000)});return{status:response.status,data:await response.json().catch(()=>({}))};};
 const exited=(process:ChildProcess)=>process.exitCode!==null||process.signalCode!==null;
 const stop=async()=>{if(!child||exited(child))return;const owned=child;owned.kill('SIGTERM');for(let i=0;i<60&&!exited(owned);i++)await pause(100);if(!exited(owned)){owned.kill('SIGKILL');await new Promise<void>(resolve=>owned.once('exit',()=>resolve()));}child=undefined;};
 const childEnv:NodeJS.ProcessEnv={};for(const key of ['PATH','HOME','TMPDIR','LANG','LC_ALL','SHELL','USER','LOGNAME','TERM'])if(process.env[key]!==undefined)childEnv[key]=process.env[key];childEnv.INSTAR_TEST_REGISTRY_DIR=registry;childEnv.npm_config_cache=path.join(temporary,'npm-cache');
 const start=async()=>{const candidates=globalCleanupCandidates();for(const file of [path.join(os.homedir(),'Library','LaunchAgents',`ai.instar.${config.projectName}.plist`),path.join(os.homedir(),'.config','systemd','user',`instar-${config.projectName}.service`)])if(fs.existsSync(file))throw new Error('normal CLI launch refused: fixture label collides with a host service');censuses.push({at:new Date().toISOString(),readOnly:true,candidates});if(candidates.length)throw new Error('normal CLI launch refused: global cleanup candidates exist');generation++;output+=`\n--- generation ${generation} ---\n`;child=spawn(process.execPath,[path.resolve('dist/cli.js'),'server','start','--foreground','--no-telegram','--dir',project],{cwd:project,env:childEnv,stdio:['ignore','pipe','pipe']});child.stdout!.on('data',chunk=>{output+=String(chunk);});child.stderr!.on('data',chunk=>{output+=String(chunk);});for(let i=0;i<350;i++){if(exited(child))throw new Error(`CLI exited ${child.exitCode}; see preserved fixture log`);try{const result=await request('/health');if(result.status===200)return;}catch{/* bounded readiness polling of own loopback child */}await pause(100);}throw new Error('normal CLI fixture did not listen');};
 try{
  await start();expect((await request('/conversation-graph/roots',undefined,undefined,false)).status).toBeGreaterThanOrEqual(400);expect((await request('/conversation-graph/roots')).status).toBe(403);
  let unlock=await request('/dashboard/unlock',{pin});expect(unlock.status).toBe(200);let proof=unlock.data.operatorSessionToken;expect(typeof proof).toBe('string');
  // Removing a lost machine is reachable on the real server, for the owner only.
  expect((await request('/conversation-graph/member-loss/status')).status).toBe(403);const removal=await request('/conversation-graph/member-loss/status',undefined,proof);expect(removal.status,JSON.stringify(removal.data)).toBe(200);expect(removal.data.state).toBe('none');expect(removal.data.members).toHaveLength(1);expect(removal.data.members[0].self).toBe(true);
  // A removal that could not finish is refused before any hold, and as a refusal: 403 would make the dashboard forget the owner's session.
  const refusedRemoval=await request('/conversation-graph/member-loss/prepare',{requestId:'e2e-refused-removal',removedMachineIds:['m_not_a_member']},proof);expect(refusedRemoval.status,JSON.stringify(refusedRemoval.data)).toBe(409);expect((await request('/conversation-graph/member-loss/status',undefined,proof)).data).toMatchObject({state:'none',held:false});
  const roots=await request('/conversation-graph/roots?view=overview',undefined,proof);expect(roots.status).toBe(200);expect(Array.isArray(roots.data.items)).toBe(true);
  const requestId=crypto.randomUUID(),create=await request('/conversation-graph/changes',{requestId,change:{kind:'create-effort',projectScope:[]}},proof);expect([200,202]).toContain(create.status);let status=create;
  for(let i=0;i<60&&status.data.state!=='committed';i++){await pause(100);status=await request(`/conversation-graph/changes/${requestId}`,undefined,proof);}expect(status.data.state).toBe('committed');
  const agreed=await request('/conversation-graph/roots?view=overview',undefined,proof);expect(agreed.status).toBe(200);expect(agreed.data.items.length).toBeGreaterThan(0);
  await stop();expect(new MachineIdentityManager(stateDir).loadIdentity().machineId).toBe(originalId);await start();unlock=await request('/dashboard/unlock',{pin});expect(unlock.status).toBe(200);proof=unlock.data.operatorSessionToken;
  const retained=await request(`/conversation-graph/changes/${requestId}`,undefined,proof);expect(retained.data.state).toBe('committed');const reopened=await request('/conversation-graph/roots?view=overview',undefined,proof);expect(reopened.status).toBe(200);expect(reopened.data.items.map((item:any)=>item.ref)).toEqual(agreed.data.items.map((item:any)=>item.ref));expect(new MachineIdentityManager(stateDir).loadIdentity().machineId).toBe(originalId);
 }finally{const phase={generation,pid:child?.pid,localLock:fs.existsSync(path.join(stateDir,'local','server-instance.lock')),migrated:fs.existsSync(path.join(stateDir,'state','last-migrated-version.json')),stateNames:fs.existsSync(path.join(stateDir,'state'))?fs.readdirSync(path.join(stateDir,'state')):[],rootNames:fs.readdirSync(stateDir),isolatedRegistry:fs.existsSync(path.join(registry,'registry.json'))};await stop();const evidence=path.join(testEvidenceDir(),'normal-cli-owned-boot-child.log');fs.mkdirSync(path.dirname(evidence),{recursive:true});fs.writeFileSync(evidence,output);fs.writeFileSync(path.join(testEvidenceDir(),'normal-cli-owned-boot-launch-censuses.json'),JSON.stringify(censuses,null,2));fs.writeFileSync(path.join(testEvidenceDir(),'normal-cli-owned-boot-phase.json'),JSON.stringify(phase,null,2));const serverLog=path.join(project,'logs','server.log');if(fs.existsSync(serverLog))fs.copyFileSync(serverLog,path.join(testEvidenceDir(),'normal-cli-owned-boot-server.log'));SafeFsExecutor.safeRmSync(temporary,{recursive:true,force:true,operation:'graph-normal-cli-proof:owned-fixture-cleanup'});}
});
