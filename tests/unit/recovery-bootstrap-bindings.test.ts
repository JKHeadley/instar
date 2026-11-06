import {afterEach,describe,expect,it,vi} from 'vitest';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import crypto from 'node:crypto';import vm from 'node:vm';
import {ensureStableNodeSymlink,installBootWrapper} from '../../src/commands/setup.js';
import {assertRecoveryBootstrapWrite} from '../../src/recovery/RecoveryBootstrapBindings.js';
import {captureRecoveryMainBindings} from '../../src/recovery/RecoveryMainBindings.js';import {RecoveryAdmission} from '../../src/recovery/RecoveryAdmission.js';import {recoveryKeyPair} from '../../src/recovery/RecoveryProtocol.js';import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
vi.mock('../../src/core/processIdentity.js',()=>({processStartMs:()=>1000}));
vi.mock('node:child_process',async original=>{const actual=await original<typeof import('node:child_process')>();return{...actual,execFileSync:vi.fn((cmd:string,args:string[],options:unknown)=>cmd==='/usr/sbin/sysctl'?'bootstrap-test-boot':actual.execFileSync(cmd,args,options as never))};});
const dirs:string[]=[];afterEach(()=>{vi.restoreAllMocks();for(const d of dirs.splice(0))SafeFsExecutor.safeRmSync(d,{recursive:true,force:true,operation:'recovery-bootstrap-bindings.test:cleanup'});});
function fixture(){
 const project=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-bootstrap-'));dirs.push(project);const state=path.join(project,'.instar'),recovery=path.join(state,'recovery'),directory=path.join(recovery,'runtime-slots','a'.repeat(64)),node=path.join(directory,'bin','node');
 fs.mkdirSync(path.dirname(node),{recursive:true,mode:0o700});fs.writeFileSync(node,'retained Node',{mode:0o500});fs.mkdirSync(path.join(state,'bin'),{mode:0o700});const target=path.join(project,'original-node');fs.writeFileSync(target,'original Node',{mode:0o500});fs.symlinkSync(target,path.join(state,'bin','node'));fs.writeFileSync(path.join(state,'instar-boot.cjs'),'// retained trusted wrapper',{mode:0o600});fs.writeFileSync(path.join(state,'instar-boot.sh'),'# retained shell wrapper',{mode:0o600});
 const plist=path.join(project,'main.plist'),text='<string>ai.instar.agent</string><string>server</string><string>start</string>';fs.writeFileSync(plist,text,{mode:0o600});const keys=recoveryKeyPair();
 const c={version:1,agentId:'agent',machineId:'machine',stateDir:path.join(recovery,'admission'),mainStateDir:state,certificationRoot:keys.publicKey,sshPrivateKey:keys.privateKey,relayPrivateKey:keys.privateKey,relayUrl:'https://relay.example',serviceLabel:'ai.instar.agent',healthPort:4040,mainService:{plist,ownershipDigest:crypto.createHash('sha256').update(text).digest('hex')},runtimeSlot:{version:1,directory,node,entrypoint:path.join(directory,'scripts','recovery-entrypoint.mjs'),updateEntrypoint:path.join(directory,'scripts','recovery-update-entrypoint.mjs'),digest:'a'.repeat(64)}};
 const config={...c,mainBindings:captureRecoveryMainBindings(c)},file=path.join(recovery,'host.json');fs.writeFileSync(file,JSON.stringify(config),{mode:0o600});return{project,state,recovery,config,file};
}
describe('ordinary main bootstrap writers under recovery enrollment',()=>{
 it('preserves pinned current bytes through the actual setup writers without a trusted transaction',()=>{
  const f=fixture();expect(ensureStableNodeSymlink(f.project)).toBe(f.config.mainBindings.nodeAlias);expect(installBootWrapper(f.project).js).toBe(f.config.mainBindings.wrapper);expect(fs.readFileSync(f.config.mainBindings.wrapper,'utf8')).toBe('// retained trusted wrapper');
 });
 it('restores missing owned startup bindings from the retained snapshot without repinning',()=>{
  vi.spyOn(process,'platform','get').mockReturnValue('darwin');const f=fixture(),before=fs.readFileSync(f.file,'utf8');SafeFsExecutor.safeUnlinkSync(f.config.mainBindings.wrapper,{operation:'recovery-bootstrap-bindings.test:delete-wrapper'});SafeFsExecutor.safeUnlinkSync(f.config.mainBindings.nodeAlias,{operation:'recovery-bootstrap-bindings.test:delete-alias'});
  expect(ensureStableNodeSymlink(f.project)).toBe(f.config.mainBindings.nodeAlias);expect(fs.readlinkSync(f.config.mainBindings.nodeAlias)).toBe(f.config.runtimeSlot.node);expect(fs.readFileSync(f.config.mainBindings.wrapper,'utf8')).toBe('// retained trusted wrapper');expect(fs.readFileSync(f.file,'utf8')).toBe(before);
 });
 it('refuses changed present bootstrap files instead of silently accepting or regenerating them',()=>{
  const f=fixture();fs.writeFileSync(f.config.mainBindings.wrapper,'// unexpected bytes');expect(()=>installBootWrapper(f.project)).toThrow('binding-changed');expect(()=>ensureStableNodeSymlink(f.project)).toThrow('binding-changed');expect(fs.readFileSync(f.config.mainBindings.wrapper,'utf8')).toBe('// unexpected bytes');
 });
 it('the actual generated boot wrapper never runs ABI alias rewriting after recovery enrollment',()=>{
  const project=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-generated-boot-'));dirs.push(project);const wrappers=installBootWrapper(project),state=path.join(project,'.instar');
  fs.mkdirSync(path.join(state,'recovery'),{mode:0o700});fs.writeFileSync(path.join(state,'recovery','host.json'),'{}',{mode:0o600});fs.mkdirSync(path.join(state,'bin'),{mode:0o700});fs.symlinkSync('/approved/retained-node',path.join(state,'bin','node'));
  const code=fs.readFileSync(wrappers.js,'utf8').replace(/^#![^\n]*\n/,'').split('if (!fs.existsSync(SHADOW_DIR)')[0]+'\nselfHealNodeSymlink();';const subprocess=vi.fn(()=>{throw new Error('unexpected ABI candidate search');});
  vm.runInNewContext(code,{require:(name:string)=>name==='fs'?fs:name==='path'?path:name==='os'?os:{execFileSync:subprocess,spawn:subprocess},process:{execPath:'/unexpected/current-node',stderr:{write:vi.fn()}}});
  expect(subprocess).not.toHaveBeenCalled();expect(fs.readlinkSync(path.join(state,'bin','node'))).toBe('/approved/retained-node');expect(fs.existsSync(path.join(state,'bin','node-candidates.json'))).toBe(false);
 });
 it('requires the exact live installer latch as well as the private transaction for callback writes',()=>{
  const f=fixture(),key='b'.repeat(64),before=fs.readFileSync(f.file,'utf8');fs.writeFileSync(path.join(f.recovery,'main-update.json'),JSON.stringify({projectDir:f.project,configFile:f.file,phase:'prepared',ownerPid:process.pid,ownerBirth:1000,previousConfig:before,latchKey:key}),{mode:0o600});
  expect(()=>assertRecoveryBootstrapWrite(f.project)).toThrow('transaction-invalid');const a=new RecoveryAdmission({stateDir:f.config.stateDir,agentId:'agent',machineId:'machine',certificationRoot:f.config.certificationRoot,bootId:'bootstrap-test-boot'});
  try{a.beginOwnedUpdate(key,{pid:process.pid,birth:1000,bootId:'bootstrap-test-boot'});expect(()=>assertRecoveryBootstrapWrite(f.project)).not.toThrow();}finally{a.finishOwnedUpdate(key);a.close();}
 });
});
