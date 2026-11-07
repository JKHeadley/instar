import {afterEach,describe,it,expect,vi} from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {execFileSync} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {LiveConfig} from '../../src/config/LiveConfig.js';
import {SecretStore} from '../../src/core/SecretStore.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
import {readConversationGraphOwnerPolicy,readConversationGraphOwnerCredential,initializeConversationGraphOwnerPolicy} from '../../src/core/ConversationGraphOwnerPolicy.js';
import {ConversationGraphOwnerGrantStore} from '../../src/server/ConversationGraphOwnerGrant.js';
import {loadConfig} from '../../src/core/Config.js';
import {DASHBOARD_PIN_GENERATION_HEAD,readDashboardPinGenerationHead,publishDashboardPinGenerationHead} from '../../src/core/DashboardPinGeneration.js';
import {persistDashboardPin} from '../../src/core/dashboardPin.js';
const directories:string[]=[];
function fixture(config:Record<string,unknown>={dashboardPin:'private-A',updates:{autoApply:false}}){const stateDir=fs.mkdtempSync(path.join(os.tmpdir(),'owner-policy-'));directories.push(stateDir);const file=path.join(stateDir,'config.json');fs.writeFileSync(file,JSON.stringify(config));return{stateDir,file,liveConfig:new LiveConfig(stateDir)};}
function freshGrantCurrent(stateDir:string,grantId:string,key:string):boolean{
 const url=(file:string)=>pathToFileURL(path.resolve('dist',file)).href;
 const script=`import {SecretStore} from ${JSON.stringify(url('core/SecretStore.js'))};import {ConversationGraphOwnerGrantStore} from ${JSON.stringify(url('server/ConversationGraphOwnerGrant.js'))};import {readConversationGraphOwnerPolicy} from ${JSON.stringify(url('core/ConversationGraphOwnerPolicy.js'))};const stateDir=${JSON.stringify(stateDir)};const secrets=new SecretStore({stateDir,forceFileKey:true});const store=new ConversationGraphOwnerGrantStore({stateDir,agentId:'agent-a',secrets,dashboardPolicy:()=>readConversationGraphOwnerPolicy({stateDir,secrets})});console.log(JSON.stringify(store.isCurrent(${JSON.stringify(grantId)},${JSON.stringify(key)},'owner:agent-a')));`;
 return JSON.parse(execFileSync(process.execPath,['--input-type=module','-e',script],{encoding:'utf8',timeout:10000}).trim());
}
afterEach(()=>{vi.restoreAllMocks();for(const directory of directories.splice(0))SafeFsExecutor.safeRmSync(directory,{recursive:true,force:true,operation:'owner-policy-test:teardown'});});
describe('durable config-coupled dashboard policy generation',()=>{
 it('loads the managed generation through the actual Instar config loader',()=>{
  const project=fixture(),stateDir=path.join(project.stateDir,'.instar');fs.mkdirSync(stateDir);const liveConfig=new LiveConfig(stateDir);liveConfig.set('dashboardPin','private-A');
  const generation=readConversationGraphOwnerPolicy({stateDir})!.generation,config=loadConfig(project.stateDir);expect(config.dashboardPinGeneration).toBe(generation);expect(config.dashboardPin).toBe('private-A');
 });
 it('migrates a legacy PIN only at explicit owner first use, then reads the current disk pair',()=>{
  const f=fixture(),before=fs.readFileSync(f.file,'utf8');
  expect(readConversationGraphOwnerCredential(f)).toBe('private-A');expect(readConversationGraphOwnerPolicy(f)).toBeNull();expect(fs.readFileSync(f.file,'utf8')).toBe(before);
  const initial=initializeConversationGraphOwnerPolicy(f)!;expect(initial).toMatchObject({pin:'private-A'});expect(initial.generation).toMatch(/^[a-f0-9-]{36}$/);
  expect(initializeConversationGraphOwnerPolicy(f)).toEqual(initial);
  const other=new LiveConfig(f.stateDir);other.set('dashboardPin','private-B');const actual=readConversationGraphOwnerPolicy(f)!;
  expect(actual.pin).toBe('private-B');expect(actual.generation).not.toBe(initial.generation);expect(JSON.parse(fs.readFileSync(f.file,'utf8')).updates).toEqual({autoApply:false});
 });
 it('requires the actual writer for the same state directory and refuses malformed managed generations',()=>{
  const f=fixture(),other=fixture();expect(()=>initializeConversationGraphOwnerPolicy({...f,liveConfig:other.liveConfig})).toThrow('writer-mismatch');
  fs.writeFileSync(f.file,JSON.stringify({dashboardPin:'private-A',dashboardPinGeneration:'untrusted-generation'}));
  expect(()=>readConversationGraphOwnerPolicy(f)).toThrow('generation-invalid');expect(()=>initializeConversationGraphOwnerPolicy(f)).toThrow('generation-invalid');
  expect(()=>f.liveConfig.set('dashboardPinGeneration','chosen-by-caller')).toThrow('generation-is-managed');
  expect(()=>f.liveConfig.set('dashboardPinGeneration.nested','chosen')).toThrow('generation-is-managed');expect(()=>f.liveConfig.set('dashboardPin.secret',true)).toThrow('requires-atomic-update');
 });
 it('does not overwrite a newer actual PIN installed between first-use snapshot and its atomic writer',()=>{
  const f=fixture(),other=new LiveConfig(f.stateDir),write=f.liveConfig.set.bind(f.liveConfig);
  vi.spyOn(f.liveConfig,'set').mockImplementationOnce((key,value,options)=>{other.set('dashboardPin','private-B');return write(key,value,options);});
  const current=initializeConversationGraphOwnerPolicy(f)!;expect(current.pin).toBe('private-B');expect(JSON.parse(fs.readFileSync(f.file,'utf8')).dashboardPin).toBe('private-B');
 });
 it('does not acknowledge a failed PIN write or install its attempted cache value; unrelated writes retain legacy behavior',()=>{
  const f=fixture();f.liveConfig.set('dashboardPin','private-A');const before=fs.readFileSync(f.file,'utf8'),policy=readConversationGraphOwnerPolicy(f)!;
  const rename=fs.renameSync;vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(String(to)===f.file)throw new Error('config rename failure');return rename(from,to);});
  expect(()=>f.liveConfig.set('dashboardPin','private-B')).toThrow('config rename failure');expect(fs.readFileSync(f.file,'utf8')).toBe(before);
  expect(f.liveConfig.get('dashboardPin','')).toBe('private-A');expect(f.liveConfig.get('dashboardPinGeneration','')).toBe(policy.generation);
  const error=vi.spyOn(console,'error').mockImplementation(()=>undefined);expect(()=>f.liveConfig.set('updates.autoApply',true)).not.toThrow();expect(error).toHaveBeenCalled();
 });
 it('throws on a post-rename directory sync failure rather than acknowledging an uncertain PIN write',()=>{
  const f=fixture();f.liveConfig.set('dashboardPin','private-A');const old=readConversationGraphOwnerPolicy(f)!;
  const sync=fs.fsyncSync;const fault=vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.fstatSync(fd).isDirectory())throw new Error('directory sync failure');return sync(fd);});
  expect(()=>f.liveConfig.set('dashboardPin','private-B')).toThrow('directory sync failure');fault.mockRestore();
  // HEAD publishes first: failure at its directory barrier revokes the old
  // pair but cannot acknowledge or publish the new credential.
  expect(JSON.parse(fs.readFileSync(f.file,'utf8')).dashboardPin).toBe('private-A');
  expect(readDashboardPinGenerationHead(f.stateDir)).not.toBe(old.generation);
  expect(()=>readConversationGraphOwnerPolicy(f)).toThrow('quarantined');
 });
 it('preserves an encrypted PIN reference and changes generation for every identical placeholder write',()=>{
  const f=fixture({dashboardPin:{secret:true}}),secrets=new SecretStore({stateDir:f.stateDir,forceFileKey:true});secrets.set('dashboardPin','vault-A');
  const first=initializeConversationGraphOwnerPolicy({...f,secrets})!;expect(first.pin).toBe('vault-A');expect(JSON.parse(fs.readFileSync(f.file,'utf8')).dashboardPin).toEqual({secret:true});
  secrets.set('dashboardPin','vault-B');f.liveConfig.set('dashboardPin',{secret:true});const second=readConversationGraphOwnerPolicy({...f,secrets})!;expect(second.pin).toBe('vault-B');expect(second.generation).not.toBe(first.generation);
  secrets.set('dashboardPin','vault-A');f.liveConfig.set('dashboardPin',{secret:true});const third=readConversationGraphOwnerPolicy({...f,secrets})!;expect(third.pin).toBe('vault-A');expect(new Set([first.generation,second.generation,third.generation]).size).toBe(3);
 });
 it.each(['plaintext','vault'] as const)('keeps an old grant revoked across REAL process restart after failed policy-ledger writes and A-B-A %s rotation',kind=>{
  const f=fixture({dashboardPin:kind==='vault'?{secret:true}:'private-A'}),secrets=new SecretStore({stateDir:f.stateDir,forceFileKey:true});
  if(kind==='vault')secrets.set('dashboardPin','private-A');initializeConversationGraphOwnerPolicy({...f,secrets});
  const store=new ConversationGraphOwnerGrantStore({stateDir:f.stateDir,agentId:'agent-a',secrets,dashboardPolicy:()=>readConversationGraphOwnerPolicy({...f,secrets})});
  const key='pending-before-rotation',old=store.capture(key,'owner:agent-a'),initial=readConversationGraphOwnerPolicy({...f,secrets})!;
  const rename=fs.renameSync,fault=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(String(to).endsWith('owner-intent-policy.json'))throw new Error('policy ledger unavailable');return rename(from,to);});
  const install=(pin:string)=>{if(kind==='vault')persistDashboardPin(f.stateDir,pin,value=>f.liveConfig.set('dashboardPin',value),()=>secrets);else f.liveConfig.set('dashboardPin',pin);};
  install('private-B');expect(()=>store.observePolicy()).toThrow('policy ledger unavailable');install('private-A');expect(()=>store.observePolicy()).toThrow('policy ledger unavailable');fault.mockRestore();
  expect(readConversationGraphOwnerPolicy({...f,secrets})!.generation).not.toBe(initial.generation);
  expect(freshGrantCurrent(f.stateDir,old.grantId,key)).toBe(false);
 });
 it('keeps an old grant revoked in a fresh process across mixed policy-ledger and vault-reservation failures',()=>{
  const f=fixture({dashboardPin:{secret:true}}),secrets=new SecretStore({stateDir:f.stateDir,forceFileKey:true});secrets.set('dashboardPin','private-A');initializeConversationGraphOwnerPolicy({...f,secrets});
  const grants=new ConversationGraphOwnerGrantStore({stateDir:f.stateDir,agentId:'agent-a',secrets,dashboardPolicy:()=>readConversationGraphOwnerPolicy({...f,secrets})});
  const key='pending-before-mixed-failure',old=grants.capture(key,'owner:agent-a'),rename=fs.renameSync;let refuseConfig=false;
  const fault=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(String(to).endsWith('owner-intent-policy.json')||refuseConfig&&String(to)===f.file)throw new Error('selected durability unavailable');return rename(from,to);});
  persistDashboardPin(f.stateDir,'private-B',value=>f.liveConfig.set('dashboardPin',value),()=>secrets);expect(()=>grants.observePolicy()).toThrow('selected durability unavailable');
  refuseConfig=true;expect(()=>persistDashboardPin(f.stateDir,'private-A',value=>f.liveConfig.set('dashboardPin',value),()=>secrets)).toThrow('selected durability unavailable');
  expect(secrets.get('dashboardPin')).toBe('private-B');fault.mockRestore();expect(freshGrantCurrent(f.stateDir,old.grantId,key)).toBe(false);
 });
 it.each(['stat','read','parse'] as const)('never republishes retired authority through a stale unrelated writer after %s failure',kind=>{
  const f=fixture();initializeConversationGraphOwnerPolicy(f);const stale=new LiveConfig(f.stateDir),secrets=new SecretStore({stateDir:f.stateDir,forceFileKey:true});
  const options={stateDir:f.stateDir,agentId:'agent-a',secrets,dashboardPolicy:()=>readConversationGraphOwnerPolicy(f)};
  const old=new ConversationGraphOwnerGrantStore(options).capture('stale-writer','owner:agent-a');
  f.liveConfig.set('dashboardPin','private-B');const current=fs.readFileSync(f.file,'utf8');
  vi.spyOn(console,'error').mockImplementation(()=>undefined);
  let fault:{mockRestore():void};
  if(kind==='stat')fault=vi.spyOn(fs,'statSync').mockImplementationOnce(()=>{throw new Error('metadata unavailable');});
  else if(kind==='read')fault=vi.spyOn(fs,'readFileSync').mockImplementationOnce(()=>{throw new Error('read unavailable');});
  else fault=vi.spyOn(fs,'readFileSync').mockReturnValueOnce('{bad json');
  stale.set('unrelatedSetting',true);fault.mockRestore();expect(fs.readFileSync(f.file,'utf8')).toBe(current);
  expect(freshGrantCurrent(f.stateDir,old.grantId,'stale-writer')).toBe(false);
  stale.set('unrelatedSetting',true);const actual=JSON.parse(fs.readFileSync(f.file,'utf8'));expect(actual.dashboardPin).toBe('private-B');expect(actual.dashboardPinGeneration).toBe(JSON.parse(current).dashboardPinGeneration);expect(actual.unrelatedSetting).toBe(true);
 });
 it('reads every merge even with unchanged mtime and refuses missing previously observed configuration',()=>{
  const f=fixture();initializeConversationGraphOwnerPolicy(f);const stale=new LiveConfig(f.stateDir),before=fs.statSync(f.file);
  f.liveConfig.set('dashboardPin','private-B');fs.utimesSync(f.file,before.atime,before.mtime);
  stale.set('updates.autoApply',true);expect(readConversationGraphOwnerPolicy(f)!.pin).toBe('private-B');
  SafeFsExecutor.safeUnlinkSync(f.file,{operation:'owner-policy-test:missing-config'});vi.spyOn(console,'error').mockImplementation(()=>undefined);
  stale.set('unrelatedSetting',true);expect(fs.existsSync(f.file)).toBe(false);expect(()=>stale.set('dashboardPin','private-A')).toThrow();expect(fs.existsSync(f.file)).toBe(false);
 });
 it('refuses retired whole-config replay from another process, including the correct retired credential',()=>{
  const f=fixture();initializeConversationGraphOwnerPolicy(f);const secrets=new SecretStore({stateDir:f.stateDir,forceFileKey:true});
  const store=new ConversationGraphOwnerGrantStore({stateDir:f.stateDir,agentId:'agent-a',secrets,dashboardPolicy:()=>readConversationGraphOwnerPolicy(f)}),old=store.capture('raw-replay','owner:agent-a');
  const retired=fs.readFileSync(f.file,'utf8');f.liveConfig.set('dashboardPin','private-B');const head=readDashboardPinGenerationHead(f.stateDir);
  execFileSync(process.execPath,['--input-type=module','-e',`import crypto from 'node:crypto';
import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(f.file)},${JSON.stringify(retired)});`],{timeout:10000});
  expect(readDashboardPinGenerationHead(f.stateDir)).toBe(head);expect(()=>readConversationGraphOwnerCredential(f)).toThrow('quarantined');expect(()=>initializeConversationGraphOwnerPolicy(f)).toThrow('quarantined');expect(freshGrantCurrent(f.stateDir,old.grantId,'raw-replay')).toBe(false);
  const url=pathToFileURL(path.resolve('dist/core/ConversationGraphOwnerPolicy.js')).href;
  const output=execFileSync(process.execPath,['--input-type=module','-e',`import {readConversationGraphOwnerCredential} from ${JSON.stringify(url)};try{readConversationGraphOwnerCredential({stateDir:${JSON.stringify(f.stateDir)}});console.log('accepted');}catch{console.log('quarantined');}`],{encoding:'utf8',timeout:10000});expect(output.trim()).toBe('quarantined');
  // An actual privileged managed reset, not the replayed credential, can recover.
  f.liveConfig.set('dashboardPin','private-C');expect(readConversationGraphOwnerPolicy(f)!.pin).toBe('private-C');expect(readDashboardPinGenerationHead(f.stateDir)).not.toBe(head);
 });
 it('quarantines managed configuration with missing HEAD and missing generation with an existing HEAD',()=>{
  const f=fixture();initializeConversationGraphOwnerPolicy(f);const head=path.join(f.stateDir,DASHBOARD_PIN_GENERATION_HEAD),bytes=fs.readFileSync(head);
  SafeFsExecutor.safeUnlinkSync(head,{operation:'owner-policy-test:missing-head'});expect(()=>readConversationGraphOwnerCredential(f)).toThrow('quarantined');expect(()=>initializeConversationGraphOwnerPolicy(f)).toThrow('quarantined');
  fs.writeFileSync(head,bytes);fs.writeFileSync(f.file,JSON.stringify({dashboardPin:'private-A'}));expect(()=>readConversationGraphOwnerPolicy(f)).toThrow('quarantined');expect(()=>initializeConversationGraphOwnerPolicy(f)).toThrow('quarantined');
 });
 it('publishes and confirms HEAD before config and never publishes config when the HEAD barrier fails',()=>{
  const f=fixture();initializeConversationGraphOwnerPolicy(f);const original=fs.readFileSync(f.file,'utf8'),head=path.join(fs.realpathSync(f.stateDir),DASHBOARD_PIN_GENERATION_HEAD),rename=fs.renameSync,events:string[]=[];
  const fault=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(String(to)===head){events.push('head');throw new Error('head unavailable');}if(String(to)===f.file)events.push('config');return rename(from,to);});
  expect(()=>f.liveConfig.set('dashboardPin','private-B')).toThrow('head unavailable');expect(events).toEqual(['head']);expect(fs.readFileSync(f.file,'utf8')).toBe(original);fault.mockRestore();
  vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(String(to)===f.file){expect(readDashboardPinGenerationHead(f.stateDir)).not.toBe(JSON.parse(original).dashboardPinGeneration);throw new Error('config unavailable after HEAD');}return rename(from,to);});
  expect(()=>f.liveConfig.set('dashboardPin','private-B')).toThrow('config unavailable after HEAD');expect(()=>readConversationGraphOwnerCredential(f)).toThrow('quarantined');
 });
 it('does not repair a HEAD published between the legacy reader and initializer writer',()=>{
  const f=fixture(),write=f.liveConfig.set.bind(f.liveConfig),head=crypto.randomUUID();
  vi.spyOn(f.liveConfig,'set').mockImplementationOnce((key,value,options)=>{publishDashboardPinGenerationHead(f.stateDir,head);return write(key,value,options);});
  expect(()=>initializeConversationGraphOwnerPolicy(f)).toThrow('quarantined');expect(readDashboardPinGenerationHead(f.stateDir)).toBe(head);expect(JSON.parse(fs.readFileSync(f.file,'utf8')).dashboardPinGeneration).toBeUndefined();
 });
 it('does not log watched PIN changes as plaintext',()=>{
  const f=fixture();f.liveConfig.get('dashboardPin','');const log=vi.spyOn(console,'log').mockImplementation(()=>undefined);
  fs.writeFileSync(f.file,JSON.stringify({dashboardPin:'private-B'}));f.liveConfig.forceRefresh();
  expect(log.mock.calls.flat().join(' ')).not.toContain('private-A');expect(log.mock.calls.flat().join(' ')).not.toContain('private-B');
 });
});
