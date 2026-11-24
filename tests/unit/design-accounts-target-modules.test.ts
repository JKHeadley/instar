import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { createTargetBuildAuthority } from '../../src/designGate/targetBuild.js';
import { createRuntimeSnapshotOwner } from '../../src/designGate/runtimeSnapshot.js';
import { createTargetChildInitialization, createAccountsTargetChildInitializer, readTargetAccountsConsoleAsset } from '../design/harness/targetProductionModules.js';
import { startTargetAccountsHarness } from '../design/harness/accountsServer.js';
import { ACCOUNTS_CONSOLE_ASSETS } from '../design/harness/accountsConsoleAssets.js';
import { syntheticAccountsTargetFiles } from '../fixtures/design-accounts-target-modules.js';
const cleanup: Array<()=>unknown|Promise<unknown>>=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const stop of cleanup.splice(0).reverse())await stop();});
async function target(label:string,modify:(files:Record<string,string>)=>void=()=>{}) {
 const container=await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'accounts-target-'))),verifyRoot=path.join(container,'.worktrees','.verify'),root=path.join(verifyRoot,'runs','target');
 cleanup.push(()=>SafeFsExecutor.safeRmTreeSerial(container,{operation:'design-accounts-target:test-cleanup'}));
 const files:Record<string,string>={'package.json':'{"type":"module"}','package-lock.json':'{}','tsconfig.json':'{}',
  'node_modules/typescript-native/package.json':'{}','node_modules/typescript-native/bin/tsc':'launcher','node_modules/typescript-native/lib/tsc.js':'entry','node_modules/typescript-native/lib/getExePath.js':'selector',
  [`node_modules/@typescript/typescript-${process.platform}-${process.arch}/package.json`]:'{}',
  [`node_modules/@typescript/typescript-${process.platform}-${process.arch}/lib/${process.platform==='win32'?'tsc.exe':'tsc'}`]:'native',
  'src/data/fixture.json':'{}',...syntheticAccountsTargetFiles(label)};
 modify(files);for(const[file,bytes]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),bytes);}
 const authority=await createTargetBuildAuthority({root,identity:{runId:label,side:'merge',tree:'b'.repeat(40),baseSha:'a'.repeat(40)},readSourceIdentity:async()=>({tree:'b'.repeat(40),clean:true})});
 // Synthetic command ports only; not actual build/install or production module evidence.
 await authority.observeCommand({phase:'install',command:'synthetic-install',args:[]},async()=>({status:0}));
 await authority.observeCommand({phase:'build',command:'synthetic-build',args:[]},async()=>({status:0}));
 const source=await authority.seal(),owner=await createRuntimeSnapshotOwner({verifyRoot,runDir:root,runId:label,deadlineAt:Date.now()+60_000,budget:{maxEntries:1000,maxDepth:32,maxBytes:8*1024*1024}});
 cleanup.push(()=>owner.release());const snapshot=await owner.materialize(source),init=await createTargetChildInitialization(snapshot);
 const loader=createAccountsTargetChildInitializer({runId:init.runId,nonce:init.nonce,targetDigest:init.target.digest});await loader.initialize(init);
 vi.stubEnv('INSTAR_DESIGN_FIXTURE_CHILD_RUN_ID',init.runId);vi.stubEnv('INSTAR_DESIGN_FIXTURE_CHILD_NONCE',init.nonce);
 return {loader,load:()=>loader.load()};
}
it('one BASE composition uses different snapshot handlers, surrounding modules, model and assets without fallback',async()=>{
 for(const label of ['base-side','merge-side']){
  const runtime=await (await target(label)).load(); const h=await startTargetAccountsHarness(runtime);cleanup.push(h.close);
  for(const endpoint of ['/pool','/mobile/browser-devices/status','/work-board','/mobile/health-issues','/health'])expect(await fetch(h.url+endpoint,{headers:{Authorization:`Bearer ${h.bootNonce}`}}).then(r=>r.json())).toMatchObject({marker:label});
  expect(runtime.accountsModel.buildAccountsPage()).toEqual({marker:label});
  expect(await fetch(h.url+'/dashboard/console/accounts-model.js').then(r=>r.text())).toBe(syntheticAccountsTargetFiles(label)['dashboard/console/accounts-model.js']);
  expect(await fetch(h.url+'/dashboard/console/console.css').then(r=>r.text())).toBe(`synthetic ${label} dashboard/console/console.css`);
  const asset=ACCOUNTS_CONSOLE_ASSETS.find(a=>a.file.endsWith('console.css'))!,copy=readTargetAccountsConsoleAsset(runtime,asset);copy.fill(0);
  expect(readTargetAccountsConsoleAsset(runtime,asset).toString()).toContain(label);
 }
});
it('an export-shaped local/plain bag cannot enter target mode',async()=>{await expect(startTargetAccountsHarness({} as never)).rejects.toThrow('Unregistered');});
it('missing target named export fails even when that BASE production module exists',async()=>{
 const f=await target('bad-export',files=>{files['dist/server/browserStatusRead.js']='export const wrong=true;'});
 await expect(f.load()).rejects.toThrow('browserStatusRead.createBrowserStatusRead');
});
it('missing target model fails initialization rather than using BASE model',async()=>{
 await expect(target('bad-model',files=>{delete files['dashboard/console/accounts-model.js'];})).rejects.toThrow('Missing target production module');
});
it('missing closed-map target asset fails before importing candidate modules, with no BASE asset rescue',async()=>{
 const f=await target('bad-asset',files=>{delete files['dashboard/console/console.css'];files['dist/server/accountsReadRoutes.js']='throw new Error("candidate import should not run");';});
 await expect(f.load()).rejects.toThrow('Missing target console asset');
});
