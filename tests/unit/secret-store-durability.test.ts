import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {SecretStore,MasterKeyManager,perAgentKeychainAccount} from '../../src/core/SecretStore.js';
import {SafeFsExecutor} from '../../src/core/SafeFsExecutor.js';
const directories:string[]=[];
function directory(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'graph-secret-durable-'));directories.push(dir);return dir;}
afterEach(()=>{vi.restoreAllMocks();for(const dir of directories.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'secret-store-durability-test:teardown'});});
describe('opt-in secret durability before cryptographic receipts',()=>{
 it('flushes the actual custom vault, fallback master key and directory ancestors, then reopens exact encrypted values',()=>{
  const dir=directory(),store=new SecretStore({stateDir:dir,forceFileKey:true,storeFile:'private/custody.enc'});store.set('test.role','secret-canary');const vault=path.join(dir,'private','custody.enc'),key=path.join(dir,'machine','secrets-master.key'),targets=new Set([fs.statSync(vault).ino,fs.statSync(key).ino]),flushed=new Set<number>(),real=fs.fsyncSync;
  vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{const stat=fs.fstatSync(fd);if(targets.has(stat.ino))flushed.add(stat.ino);return real(fd);});store.syncDurably();expect(flushed).toEqual(targets);expect(new SecretStore({stateDir:dir,forceFileKey:true,storeFile:'private/custody.enc'}).get('test.role')).toBe('secret-canary');expect(fs.readFileSync(vault,'utf8')).not.toContain('secret-canary');
 });
 it('propagates vault/key fsync failure instead of crediting durability, then permits an explicit successful retry',()=>{
  const dir=directory(),store=new SecretStore({stateDir:dir,forceFileKey:true});store.set('test.role','never-credit-before-sync');const vault=fs.statSync(path.join(dir,'secrets','config.secrets.enc')),real=fs.fsyncSync;
  const fault=vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.fstatSync(fd).ino===vault.ino)throw new Error('injected-vault-fsync-failure');return real(fd);});expect(()=>store.syncDurably()).toThrow('injected-vault-fsync-failure');fault.mockRestore();store.syncDurably();
  // Unchanged files already flushed by this process are not flushed again.
  const repeat=vi.spyOn(fs,'fsyncSync');store.syncDurably();expect(repeat).not.toHaveBeenCalled();repeat.mockRestore();
  const keyDir=directory(),keyStore=new SecretStore({stateDir:keyDir,forceFileKey:true});keyStore.set('test.role','never-credit-before-sync');const key=fs.statSync(path.join(keyDir,'machine','secrets-master.key'));vi.spyOn(fs,'fsyncSync').mockImplementation(fd=>{if(fs.fstatSync(fd).ino===key.ino)throw new Error('injected-key-fsync-failure');return real(fd);});expect(()=>keyStore.syncDurably()).toThrow('injected-key-fsync-failure');
 });
 it('never creates a missing key or writes a keychain entry while checking durability',()=>{
  const dir=directory();expect(()=>new MasterKeyManager(dir,true).syncDurably()).toThrow('master-key-missing');expect(fs.existsSync(path.join(dir,'machine','secrets-master.key'))).toBe(false);
  const reads:string[]=[],writes:string[]=[],key=Buffer.alloc(32,7),ops={read:(_service:string,account:string)=>{reads.push(account);return account===perAgentKeychainAccount(dir)?key:null;},write:(_service:string,account:string)=>{writes.push(account);return true;}};
  new MasterKeyManager(dir,false,ops).syncDurably();expect(reads).toContain(perAgentKeychainAccount(dir));expect(writes).toEqual([]);expect(fs.existsSync(path.join(dir,'machine','secrets-master.key'))).toBe(false);
 });
});
