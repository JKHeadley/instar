import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { afterEach, describe, expect, it } from 'vitest';
import { validateRendererConfig, allowsFixtureRequest, browserLaunchOptions, inspectOwnedBrowser, pngDimensions, resolvePinnedHeadlessShell } from '../design/harness/rendererIdentity.mjs';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))SafeFsExecutor.safeRmSync(root,{recursive:true,force:true,operation:'tests/design-renderer-worker:close'});});
function config(){const runDir=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'lv-tmp-renderer-')));roots.push(runDir);fs.chmodSync(runDir,0o700);return {fixtureOrigin:'http://127.0.0.1:40491',bootNonce:'a'.repeat(64),seedNow:'2026-11-01T12:00:00Z',viewport:'desktop',theme:'dark',runDir,rendererDir:runDir};}
describe('isolated renderer configuration and identity',()=>{
 it('accepts only the owned loopback fixture and standard seed/viewport/theme',()=>{const c=config();expect(validateRendererConfig(c).viewport).toEqual({width:1280,height:728});});
 it.each(['http://localhost:40491','https://127.0.0.1:40491','http://127.0.0.1','http://127.0.0.1:0','http://127.0.0.1:40491/path','http://user@127.0.0.1:40491','http://127.0.0.1:40491?token=x','http://127.1:40491'])('refuses noncanonical or unsafe fixture origin %s',fixtureOrigin=>{expect(()=>validateRendererConfig({...config(),fixtureOrigin})).toThrow();});
 it('rejects undeclared fields, host paths, synthetic-token mistakes and unsupported geometry',()=>{
  const c=config();for(const patch of [{seedState:'empty'},{parentCase:{seedState:'error'}},{authToken:'host-token'},{bootNonce:'real-token'},{viewport:{width:100,height:100}},{theme:'system'},{seedNow:'tomorrow'},{runDir:os.tmpdir()}])expect(()=>validateRendererConfig({...c,...patch})).toThrow();
  const alias=path.join(c.runDir,'lv-tmp-link');fs.symlinkSync(c.runDir,alias);expect(()=>validateRendererConfig({...c,runDir:alias})).toThrow();
 });
 it('denies other origins, WebSockets and sibling ports without prefix matching',()=>{
  const origin=config().fixtureOrigin;expect(allowsFixtureRequest(`${origin}/dashboard/console/`,origin)).toBe(true);
  for(const url of ['http://127.0.0.1:40492/','http://localhost:40491/','http://127.0.0.1:40491.evil.test/','https://example.com/','ws://127.0.0.1:40491/','file:///etc/passwd'])expect(allowsFixtureRequest(url,origin)).toBe(false);
 });
 it('constructs an explicit browser environment without inherited secrets and owns temporary files',()=>{
  const c=validateRendererConfig(config());const launch=browserLaunchOptions(c,'/pinned/browser');
  expect(launch.env).toMatchObject({HOME:c.runDir,TMPDIR:c.runDir,TZ:'UTC'});expect(launch.env).not.toHaveProperty('AUTH_TOKEN');
  expect(launch).toMatchObject({ handleSIGTERM: false, handleSIGINT: false, handleSIGHUP: false });
  expect(launch.host).toBe('127.0.0.1');expect(launch.executablePath).toBe('/pinned/browser');
 });
 it('verifies the actual launched child executable and user-data-dir instead of trusting a requested path',()=>{
  const c=config(),binary=path.join(c.runDir,'shell');fs.writeFileSync(binary,'pinned synthetic executable');
  const profile=path.join(c.runDir,'playwright_chromiumdev_profile-123');fs.mkdirSync(profile);
  expect(inspectOwnedBrowser({pid:123,spawnfile:binary,spawnargs:[binary,`--user-data-dir=${profile}`]},binary,c.runDir)).toMatchObject({pid:123,profileDir:profile});
  for(const child of [{pid:123,spawnfile:'/bin/sh',spawnargs:[binary,`--user-data-dir=${profile}`]},{pid:123,spawnfile:binary,spawnargs:[binary,'--user-data-dir=/tmp/host-profile']},{pid:0,spawnfile:binary,spawnargs:[binary,`--user-data-dir=${profile}`]}])expect(()=>inspectOwnedBrowser(child,binary,c.runDir)).toThrow();
 });
 it('reads dimensions from actual PNG bytes and rejects malformed data',()=>{
  const bytes=Buffer.alloc(24);Buffer.from([137,80,78,71,13,10,26,10]).copy(bytes);bytes.write('IHDR',12);bytes.writeUInt32BE(1280,16);bytes.writeUInt32BE(728,20);
  expect(pngDimensions(bytes)).toEqual({width:1280,height:728});expect(()=>pngDimensions(Buffer.from('not a PNG'))).toThrow();
 });
 it('resolves the pinned registry entry and rejects a mismatched revision or escaping binary',()=>{
  const c=config(),persistent=path.join(c.runDir,'1255');fs.mkdirSync(persistent);
  const binary=path.join(persistent,'synthetic-shell');fs.writeFileSync(binary,'synthetic executable bytes');
  const metadata={browsers:[{name:'chromium-headless-shell',revision:'1255',browserVersion:'test'}]};
  const registry={findExecutable:(name:string)=>name==='chromium-headless-shell'?{executablePath:()=>binary}:undefined};
  expect(resolvePinnedHeadlessShell(registry,metadata,persistent)).toMatchObject({revision:'1255',executablePath:binary});
  expect(()=>resolvePinnedHeadlessShell(registry,{browsers:[{name:'chromium-headless-shell',revision:'9999'}]},persistent)).toThrow();
  expect(()=>resolvePinnedHeadlessShell({findExecutable:()=>({executablePath:()=>'/bin/sh'})},metadata,persistent)).toThrow();
 });
 it('imports the worker without browser launch or environment mutation',async()=>{
  const before={...process.env};const worker=await import('../design/harness/rendererWorker.mjs');
  expect(typeof worker.runRenderer).toBe('function');expect({...process.env}).toEqual(before);
 });
 it('rejects secret-shaped command-line configuration and invalid stdin before loading the browser',()=>{
  const worker=path.resolve('tests/design/harness/rendererWorker.mjs');
  for(const args of [[worker,'--bootNonce=not-allowed'],[worker]]){
   const result=spawnSync(process.execPath,args,{input:'{}',encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin'}});
   expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).not.toContain('not-allowed');
   expect(result.error).toBeUndefined();
  }
 });

 it('admits the approved fixed tablet viewport',()=>{
  expect(validateRendererConfig({...config(),viewport:'tablet'}).viewport).toEqual({width:768,height:1024});
 });

});
