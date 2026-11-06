import {afterAll,beforeAll,describe,expect,it,vi} from 'vitest';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {pathToFileURL}from 'node:url';import {execFileSync}from 'node:child_process';
import {prepareRecoveryRuntimeSlot,verifyRecoveryRuntimeSlot,RECOVERY_RUNTIME_SLOT_CAPACITY,cleanupRecoveryRuntimeSlots,type RecoveryRuntimeSlot}from '../../src/recovery/RecoveryRuntimeSlot.js';
import {recoveryKeyPair}from '../../src/recovery/RecoveryProtocol.js';
import {SafeFsExecutor}from '../../src/core/SafeFsExecutor.js';

// Only the privileged OS boot read is simulated; copied Node/native storage,
// imports, filesystem ownership, capacity and cleanup all execute for real.
vi.mock('node:child_process',async(importOriginal)=>{const actual=await importOriginal<typeof import('node:child_process')>();return{...actual,execFileSync:(file:string,args:string[],options:unknown)=>file==='/usr/sbin/sysctl'&&args.join(' ')==='-n kern.bootsessionuuid'?'slot-test-boot\n':(actual.execFileSync as any)(file,args,options)};});

describe('independent copied recovery runtime with native storage',()=>{
 let root:string,source:string,stateDir:string,first:RecoveryRuntimeSlot,second:RecoveryRuntimeSlot;
 beforeAll(()=>{
  root=fs.mkdtempSync(path.join(os.tmpdir(),'recovery-native-slot-'));source=path.join(root,'mutable-main-package');stateDir=path.join(root,'private-state','admission');
  fs.mkdirSync(path.join(source,'scripts'),{recursive:true,mode:0o700});fs.mkdirSync(path.dirname(stateDir),{recursive:true,mode:0o700});
  fs.copyFileSync(path.resolve('package.json'),path.join(source,'package.json'));
  fs.cpSync(path.resolve('dist'),path.join(source,'dist'),{recursive:true,mode:fs.constants.COPYFILE_FICLONE});
  for(const name of ['recovery-entrypoint.mjs','recovery-update-entrypoint.mjs'])fs.copyFileSync(path.resolve('scripts',name),path.join(source,'scripts',name));
  // This symlink is a SOURCE dependency resolver only. The installed slot must
  // materialize its own native module/dependency files, with no external links.
  fs.symlinkSync(fs.realpathSync('node_modules'),path.join(source,'node_modules'),'dir');
  first=prepareRecoveryRuntimeSlot(path.join(source,'scripts','recovery-entrypoint.mjs'),stateDir);
 },120000);
 afterAll(()=>{if(root)SafeFsExecutor.safeRmSync(root,{recursive:true,force:true,operation:'recovery-runtime-slot.test:cleanup'});});
 function coldStorage(slot:RecoveryRuntimeSlot):unknown {
  const pub=recoveryKeyPair().publicKey,dir=path.join(root,'cold-storage-'+Math.random().toString(16).slice(2));
  const code=`const {RecoveryAdmission}=await import(process.argv[1]);const a=new RecoveryAdmission({stateDir:process.argv[2],agentId:'slot-test',machineId:'target',bootId:'slot-boot',certificationRoot:process.argv[3]});process.stdout.write(JSON.stringify(a.lease()));a.close();`;
  return JSON.parse(execFileSync(slot.node,['--input-type=module','-e',code,pathToFileURL(path.join(slot.directory,'dist','recovery','RecoveryAdmission.js')).href,dir,pub],{
   encoding:'utf8',timeout:15000,maxBuffer:8192,cwd:root,env:{HOME:root,PATH:'/usr/bin:/bin',NODE_PATH:''}}));
 }
 it('cold-loads the real fixed entrypoint and native SQLite after the entire mutable main package disappears',()=>{
  fs.renameSync(source,source+'.offline');
  try{
   expect(coldStorage(first)).toEqual({ready:false,version:0,expiresAt:0});
   try{execFileSync(first.node,[first.entrypoint,'invalid-mode','unused'],{encoding:'utf8',timeout:15000,maxBuffer:8192,cwd:root,env:{HOME:root,PATH:'/usr/bin:/bin',NODE_PATH:''}});throw new Error('mode should refuse');}
   catch(error){expect(String((error as{stderr?:string}).stderr).trim()).toBe('recovery-mode-refused');}
  }finally{fs.renameSync(source+'.offline',source);}
 });
 it('keeps the previous known runtime usable when a genuinely different package is staged',()=>{
  fs.appendFileSync(path.join(source,'dist','recovery','RecoveryEngine.js'),'\n// independently installed next recovery build\n');
  second=prepareRecoveryRuntimeSlot(path.join(source,'scripts','recovery-entrypoint.mjs'),stateDir);
  expect(second.digest).not.toBe(first.digest);expect(fs.existsSync(first.node)).toBe(true);
  fs.renameSync(source,source+'.offline');try{expect(coldStorage(first)).toMatchObject({ready:false});expect(coldStorage(second)).toMatchObject({ready:false});}finally{fs.renameSync(source+'.offline',source);}
 });
 it('fails closed at the total complete-plus-staging capacity without evicting a known runtime',()=>{
  const slots=path.dirname(first.directory),reserved:string[]=[];
  try{for(let i=fs.readdirSync(slots).length;i<RECOVERY_RUNTIME_SLOT_CAPACITY;i++){const dir=path.join(slots,'.staging-capacity-'+i);fs.mkdirSync(dir,{mode:0o700});reserved.push(dir);}
   expect(()=>prepareRecoveryRuntimeSlot(path.join(source,'scripts','recovery-entrypoint.mjs'),stateDir)).toThrow('recovery-runtime-slot-capacity');expect(fs.existsSync(first.node)).toBe(true);
  }finally{for(const dir of reserved)SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'recovery-slot.test:remove-capacity-reservations'});}
 });
 it('keeps current and transaction-referenced slots and removes only a day-old unreferenced owned slot',()=>{
  const configFile=path.join(path.dirname(stateDir),'host.json'),transaction=path.join(path.dirname(stateDir),'main-update.json');
  fs.writeFileSync(configFile,JSON.stringify({stateDir,agentId:'slot-test',machineId:'target',certificationRoot:recoveryKeyPair().publicKey,runtimeSlot:first}),{mode:0o600});
  fs.writeFileSync(transaction,JSON.stringify({previousConfig:JSON.stringify({runtimeSlot:second})}),{mode:0o600});
  const old=new Date(Date.now()-2*86400000);fs.utimesSync(first.directory,old,old);fs.utimesSync(second.directory,old,old);
  const abandoned=path.join(path.dirname(first.directory),'.staging-owner-only-crash');fs.writeFileSync(abandoned+'.owner.json',JSON.stringify({pid:2147483647,birth:1,createdAt:old.getTime()}),{mode:0o600});fs.utimesSync(abandoned+'.owner.json',old,old);
  expect(cleanupRecoveryRuntimeSlots(configFile).removed).toEqual(['.staging-owner-only-crash']);expect(fs.existsSync(abandoned+'.owner.json')).toBe(false);expect(fs.existsSync(second.node)).toBe(true);
  SafeFsExecutor.safeUnlinkSync(transaction,{operation:'recovery-slot.test:remove-finished-transaction'});
  expect(cleanupRecoveryRuntimeSlots(configFile).removed).toEqual([second.digest]);expect(fs.existsSync(first.node)).toBe(true);
  // Restage for the independent corruption regression below.
  second=prepareRecoveryRuntimeSlot(path.join(source,'scripts','recovery-entrypoint.mjs'),stateDir);
 });
 it('refuses a foreign slot path and detects modified immutable package bytes',()=>{
  expect(()=>verifyRecoveryRuntimeSlot({...first,directory:source},stateDir,true)).toThrow('recovery-runtime-slot-invalid');
  const file=path.join(second.directory,'dist','recovery','RecoveryEngine.js');fs.chmodSync(file,0o600);fs.appendFileSync(file,'\n// corrupt\n');
  expect(()=>verifyRecoveryRuntimeSlot(second,stateDir,true)).toThrow();
 });
});
