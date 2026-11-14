import {afterEach,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {captureRecoveryMainBindings,restoreRecoveryMainBindings,validateRecoveryMainBindings} from '../../src/recovery/RecoveryMainBindings.js';
import crypto from 'node:crypto';
import {LaunchdRecoveryControl,type RecoveryHostConfig} from '../../src/recovery/RecoveryEngine.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const launchctl=vi.hoisted(()=>({calls:[] as string[][]}));
vi.mock('node:child_process',async original=>{
 const actual=await original<typeof import('node:child_process')>();
 const mocked=()=>{throw new Error('unmocked callback exec');};Object.defineProperty(mocked,Symbol.for('nodejs.util.promisify.custom'),{value:async(file:string,args:string[])=>{if(file!=='/bin/launchctl')throw new Error('unexpected OS command');launchctl.calls.push(args);return {stdout:'state = waiting',stderr:''};}});
 return {...actual,execFile:mocked};
});
const dirs:string[]=[];
afterEach(()=>{vi.restoreAllMocks();launchctl.calls=[];for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-main-bindings.test:cleanup'});});
function fixture(){
 const mainStateDir=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-main-bindings-'));dirs.push(mainStateDir);
 const directory=path.join(mainStateDir,'recovery','runtime-slots','a'.repeat(64)),node=path.join(directory,'bin','node');
 fs.mkdirSync(path.dirname(node),{recursive:true,mode:0o700});fs.writeFileSync(node,'independent interpreter',{mode:0o500});
 fs.mkdirSync(path.join(mainStateDir,'bin'),{mode:0o700});const original=path.join(mainStateDir,'old-main-package-node');fs.writeFileSync(original,'original',{mode:0o500});
 fs.symlinkSync(original,path.join(mainStateDir,'bin','node'));fs.writeFileSync(path.join(mainStateDir,'instar-boot.cjs'),'// fixed installer wrapper',{mode:0o600});
 const c={mainStateDir,stateDir:path.join(mainStateDir,'recovery','admission'),runtimeSlot:{directory,node},mainBindings:undefined as ReturnType<typeof captureRecoveryMainBindings>|undefined};
 c.mainBindings=captureRecoveryMainBindings(c);return {c,original};
}
describe('independently retained owned main bootstrap',()=>{
 it('restores the owned bindings through actual fixed LaunchdRecoveryControl.start before kickstart',async()=>{
  const {c,original}=fixture();vi.spyOn(process,'platform','get').mockReturnValue('darwin');
  const plist=path.join(c.mainStateDir,'main.plist'),content='<string>ai.instar.agent</string><string>server</string><string>start</string>';fs.writeFileSync(plist,content,{mode:0o600});
  SafeFsExecutor.safeUnlinkSync(original,{operation:'recovery-main-bindings.test:remove-original-package-interpreter'});SafeFsExecutor.safeUnlinkSync(c.mainBindings!.wrapper,{operation:'recovery-main-bindings.test:remove-original-wrapper'});
  const control=new LaunchdRecoveryControl({...c,serviceLabel:'ai.instar.agent',agentId:'agent',mainService:{plist,ownershipDigest:crypto.createHash('sha256').update(content).digest('hex')}} as RecoveryHostConfig);
  await control.start();expect(launchctl.calls.some(args=>args[0]==='kickstart')).toBe(true);expect(fs.readlinkSync(c.mainBindings!.nodeAlias)).toBe(c.runtimeSlot.node);expect(fs.readFileSync(c.mainBindings!.wrapper,'utf8')).toBe('// fixed installer wrapper');
 });
 it('restores deleted wrapper and dangling own interpreter from the previous exact installer snapshot',()=>{
  const {c,original}=fixture();SafeFsExecutor.safeUnlinkSync(original,{operation:'recovery-main-bindings.test:remove-main-interpreter'});SafeFsExecutor.safeUnlinkSync(c.mainBindings!.wrapper,{operation:'recovery-main-bindings.test:remove-main-wrapper'});
  expect(()=>validateRecoveryMainBindings(c)).not.toThrow();restoreRecoveryMainBindings(c);
  expect(fs.readFileSync(c.mainBindings!.wrapper,'utf8')).toBe('// fixed installer wrapper');expect(fs.readlinkSync(c.mainBindings!.nodeAlias)).toBe(c.runtimeSlot.node);
 });
 it('refuses present changed wrapper or another interpreter symlink without changing either',()=>{
  const {c}=fixture();fs.writeFileSync(c.mainBindings!.wrapper,'// changed');expect(()=>restoreRecoveryMainBindings(c)).toThrow('binding-changed');expect(fs.readFileSync(c.mainBindings!.wrapper,'utf8')).toBe('// changed');
  fs.writeFileSync(c.mainBindings!.wrapper,'// fixed installer wrapper');SafeFsExecutor.safeUnlinkSync(c.mainBindings!.nodeAlias,{operation:'recovery-main-bindings.test:replace-alias'});fs.symlinkSync('/unexpected/node',c.mainBindings!.nodeAlias);
  expect(()=>restoreRecoveryMainBindings(c)).toThrow('binding-changed');expect(fs.readlinkSync(c.mainBindings!.nodeAlias)).toBe('/unexpected/node');
 });
 it('refuses changed interpreter bytes at the same previously pinned alias target',()=>{
  const {c,original}=fixture();fs.chmodSync(original,0o700);fs.writeFileSync(original,'different interpreter');expect(()=>restoreRecoveryMainBindings(c)).toThrow('binding-changed');expect(fs.readlinkSync(c.mainBindings!.nodeAlias)).toBe(original);
 });
 it('refuses corruption of retained backup instead of treating it as installer-produced bytes',()=>{
  const {c}=fixture();fs.writeFileSync(c.mainBindings!.wrapperBackup,'// corrupted');expect(()=>restoreRecoveryMainBindings(c)).toThrow('binding-untrusted');
 });
});
