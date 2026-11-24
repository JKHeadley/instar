import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { createInstalledDesignTargetProducer, type DesignTargetContext, type DesignTargetProducer, type InstalledDesignTargetOptions, type DesignTargetCustodyLease } from '../../../src/localVerify/designTargetProducer.js';
import { runtimeSnapshotDescription } from '../../../src/designGate/runtimeSnapshot.js';
import { realSeams } from '../../../src/localVerify/orchestratorSeams.js';
import type { ExecResult } from '../../../src/localVerify/orchestrator.js';
const disposals:Array<()=>Promise<unknown>>=[];
afterEach(async()=>{for(const dispose of disposals.splice(0).reverse())await dispose();});
const ok=(status=0):ExecResult=>({status,signal:null,stdout:'',stderr:'',deadlineKilled:false,pid:123});
const budget={maxEntries:200,maxDepth:20,maxBytes:1024*1024};
async function setup() {
 const home=await fs.mkdtemp(path.join(os.tmpdir(),'design-producer-')),verifyRoot=path.join(home,'.worktrees','.verify'),runDir=path.join(verifyRoot,'runs','candidate');
 await fs.mkdir(runDir,{recursive:true});disposals.push(()=>SafeFsExecutor.safeRmTreeSerial(home,{operation:'design-producer:test-cleanup'}));
 const write=async(file:string,body:string)=>{const filename=path.join(runDir,file);await fs.mkdir(path.dirname(filename),{recursive:true});await fs.writeFile(filename,body);};
 for(const file of ['package.json','package-lock.json','tsconfig.json'])await write(file,'{}');
 let clean=true,tree='b'.repeat(40);
 const context:DesignTargetContext={runId:'actual-unit-fixture-run',verifyRoot,runDir,baseSha:'a'.repeat(40),mergeTree:tree,headSha:'c'.repeat(40),deadlineAt:Date.now()+60_000,now:Date.now,changedPaths:['dashboard/console/accounts.js'],readBaseFile:async()=> 'BASE policy',readSourceIdentity:async()=>({tree,clean})};
 const install=vi.fn(async()=>{for(const [file,body] of Object.entries({
  'node_modules/typescript-native/package.json':'{}','node_modules/typescript-native/bin/tsc':'compiler','node_modules/typescript-native/lib/tsc.js':'entry','node_modules/typescript-native/lib/getExePath.js':'selector',
  [`node_modules/@typescript/typescript-${process.platform}-${process.arch}/package.json`]:'{}', [`node_modules/@typescript/typescript-${process.platform}-${process.arch}/lib/tsc`]:'native bytes',
  'node_modules/dependency/index.js':'actual dependency bytes',
 }))await write(file,body);return ok();});
 const build=vi.fn(async()=>{for(const file of ['dist/server/accountsReadRoutes.js','src/data/actual.json','dashboard/console/accounts.js'])await write(file,'actual candidate bytes');return ok();});
 return{home,verifyRoot,runDir,context,write,install,build,changeSource:()=>{tree='d'.repeat(40);clean=false;}};
}
/** Test custodian really retains the identical closure and writes a private unit journal; not service custody. */
function custodian(f: Awaited<ReturnType<typeof setup>>, failures: { establish?: boolean; admit?: boolean; reconcile?: number } = {}) {
 const retained = new Map<string,()=>Promise<any>>(), roots: string[] = [];
 const backend: InstalledDesignTargetOptions['custody'] = { establish: async(context,retryRelease)=>{
  if(failures.establish)throw new Error('custody unavailable before registration');
  const verifyRoot=await fs.realpath(f.verifyRoot),runDir=await fs.realpath(f.runDir),registration={id:'unit-live-registration',retryRelease};
  const journal=path.join(verifyRoot,'unit-custody.json');
  const persist=async(state:string)=>{await fs.writeFile(journal,JSON.stringify({state,runId:context.runId,roots,attemptToken:'a'.repeat(32),pid:process.pid,pgid:process.pid}));};
  await persist('owned');retained.set(registration.id,retryRelease);
  const lease:DesignTargetCustodyLease={runId:context.runId,verifyRoot,runDir,attempt:{attemptToken:'a'.repeat(32),pid:process.pid,pgid:process.pid},registration,
   assertOwned:async()=>{expect(retained.get(registration.id)).toBe(retryRelease);expect(JSON.parse(await fs.readFile(journal,'utf8')).state).toBe('owned');},
   admitRoot:async root=>{await expect(fs.stat(root)).rejects.toMatchObject({code:'ENOENT'});if(failures.admit)throw new Error('exact root journal unavailable');roots.push(root);await persist('owned');return{root,registration};},
   reconcile:async outcome=>{if(failures.reconcile){failures.reconcile--;throw new Error('cleanup reconciliation failed before registration');}if(JSON.parse(await fs.readFile(journal,'utf8')).state==='released')return;await persist(outcome.status==='released'?'released':'owned');if(outcome.status==='released')retained.delete(registration.id);}
  };return lease;
 }};
 return{backend,retained,roots};
}
describe('installed producer filesystem composition with synthetic commands, not a Local Verify attestation',()=>{
 it('keeps installation absent by default and runs no filesystem producer when BASE selection is false',async()=>{
  const f=await setup();expect(realSeams(()=>{},f.verifyRoot).designTarget).toBeUndefined();
  const select=vi.fn(async context=>{expect(Object.keys(context).sort()).toEqual(['baseSha','changedPaths','headSha','mergeTree','readBaseFile']);expect(await context.readBaseFile('docs/design/screens.json')).toBe('BASE policy');return false;});
  const port=createInstalledDesignTargetProducer({selectFromBase:select,budget,handoff:async()=>{},custody:custodian(f).backend});
  expect(await port.open(f.context)).toBeNull();await expect(fs.stat(path.join(f.verifyRoot,'design-targets'))).rejects.toMatchObject({code:'ENOENT'});expect(f.install).not.toHaveBeenCalled();
 });
 it('reports an invalid internal installation through open instead of vetoing construction of the real verify seams',async()=>{const f=await setup();const seams=realSeams(()=>{},f.verifyRoot,{designTarget:{selectFromBase:async()=>true,budget,handoff:undefined as never,custody:custodian(f).backend}});await expect(seams.designTarget!.open(f.context)).rejects.toThrow('requires installed');});
 it('uses the same observed callbacks and snapshots before later source dependency mutation',async()=>{
  const f=await setup();const handoff=vi.fn(async lease=>{const description=runtimeSnapshotDescription(lease.snapshot);expect(await fs.readFile(path.join(description.root,'node_modules/dependency/index.js'),'utf8')).toBe('actual dependency bytes');});
  const port=realSeams(()=>{},f.verifyRoot,{designTarget:{selectFromBase:async()=>true,budget,handoff,custody:custodian(f).backend}}).designTarget!,producer=(await port.open(f.context))!;disposals.push(()=>producer.release());
  await producer.observeCommand({phase:'install',command:'unit-install-callback',args:[]},f.install);await producer.observeCommand({phase:'build',command:'unit-build-callback',args:[]},f.build);
  await producer.completeBuild();await f.write('node_modules/dependency/index.js','changed by later lane');await producer.postLanes();expect(f.install).toHaveBeenCalledTimes(1);expect(f.build).toHaveBeenCalledTimes(1);expect(handoff).toHaveBeenCalledTimes(1);expect((await producer.release()).status).toBe('released');
 });
 it('requires observed nonempty success and does not mint from a missing or failed build',async()=>{
  for(const failed of [false,true]){const f=await setup(),handoff=vi.fn(async()=>{}),producer=(await createInstalledDesignTargetProducer({selectFromBase:async()=>true,budget,handoff,custody:custodian(f).backend}).open(f.context))!;disposals.push(()=>producer.release());await producer.observeCommand({phase:'install',command:'unit-install-callback',args:[]},f.install);if(failed)await producer.observeCommand({phase:'build',command:'unit-failed-build',args:[]},async()=>ok(1));await expect(producer.completeBuild()).rejects.toThrow();expect(handoff).not.toHaveBeenCalled();}
 });
 it('revalidates current source and snapshot bytes before handoff and retains unknown actual child ownership',async()=>{
  const f=await setup();let completeExit!:(receipt:{pid:number;observed:true})=>void;const recovery=custodian(f);
  const producer=(await createInstalledDesignTargetProducer({selectFromBase:async()=>true,budget,custody:recovery.backend,handoff:async lease=>{const port=lease.reserveChildLaunch(lease.snapshot);port.beforeSpawn();port.started({pid:55,exit:new Promise(resolve=>{completeExit=resolve;})});}}).open(f.context))!;disposals.push(()=>producer.release());await producer.observeCommand({phase:'install',command:'unit-install',args:[]},f.install);await producer.observeCommand({phase:'build',command:'unit-build',args:[]},f.build);await producer.completeBuild();await producer.postLanes();expect((await producer.release()).status).toBe('cleanup-unconfirmed');expect(recovery.retained.size).toBe(1);completeExit({pid:55,observed:true});await Promise.resolve();expect((await [...recovery.retained.values()][0]()).status).toBe('released');
  const g=await setup();const handoff=vi.fn(async()=>{});const other=(await createInstalledDesignTargetProducer({selectFromBase:async()=>true,budget,custody:custodian(g).backend,handoff}).open(g.context))!;disposals.push(()=>other.release());await other.observeCommand({phase:'install',command:'unit-install',args:[]},g.install);await other.observeCommand({phase:'build',command:'unit-build',args:[]},g.build);await other.completeBuild();g.changeSource();await expect(other.postLanes()).rejects.toThrow('source binding');expect(handoff).not.toHaveBeenCalled();
 });
});

it('refuses snapshot effects before durable custody/root admission and never treats a JSON claim as a live lease',async()=>{
 for(const failure of ['establish','admit','json'] as const){const f=await setup();const actual=custodian(f,{establish:failure==='establish',admit:failure==='admit'});const backend=failure==='json'?{establish:async()=>({runId:f.context.runId,verifyRoot:f.verifyRoot,runDir:f.runDir,registration:{id:'claimed'}} as never)}:actual.backend;const port=createInstalledDesignTargetProducer({selectFromBase:async()=>true,budget,handoff:async()=>{},custody:backend});if(failure!=='admit'){await expect(port.open(f.context)).rejects.toThrow();}else{const producer=(await port.open(f.context))!;disposals.push(()=>producer.release());await producer.observeCommand({phase:'install',command:'unit-install',args:[]},f.install);await producer.observeCommand({phase:'build',command:'unit-build',args:[]},f.build);await expect(producer.completeBuild()).rejects.toMatchObject({reason:'materialization-failed'});expect(await fs.readdir(path.join(f.verifyRoot,'design-targets'))).toEqual([]);}expect(actual.roots).toHaveLength(0);}
});
it('keeps the genuine upfront retry registration reachable when cleanup reconciliation throws',async()=>{
 const f=await setup(),recovery=custodian(f,{reconcile:1});let exit!:(receipt:{pid:number;observed:true})=>void;
 const producer=(await createInstalledDesignTargetProducer({selectFromBase:async()=>true,budget,custody:recovery.backend,handoff:async lease=>{const port=lease.reserveChildLaunch(lease.snapshot);port.beforeSpawn();port.started({pid:92,exit:new Promise(resolve=>{exit=resolve;})});}}).open(f.context))!;disposals.push(()=>producer.release());await producer.observeCommand({phase:'install',command:'unit-install',args:[]},f.install);await producer.observeCommand({phase:'build',command:'unit-build',args:[]},f.build);await producer.completeBuild();await producer.postLanes();expect(await producer.release()).toMatchObject({status:'cleanup-unconfirmed',ownershipRetained:true});expect(recovery.retained.size).toBe(1);exit({pid:92,observed:true});await Promise.resolve();const retry=[...recovery.retained.values()][0];expect((await retry()).status).toBe('released');expect(recovery.retained.size).toBe(0);
});

it('checks its actual frozen deadline around handoff and closes future admission without discarding recovery',async()=>{
 const f=await setup(),owned=custodian(f);let now=0;const context={...f.context,now:()=>now,deadlineAt:100};const producer=(await createInstalledDesignTargetProducer({selectFromBase:async()=>true,budget,custody:owned.backend,handoff:async()=>{now=100;}}).open(context))!;disposals.push(()=>producer.release());await producer.observeCommand({phase:'install',command:'unit-install',args:[]},f.install);await producer.observeCommand({phase:'build',command:'unit-build',args:[]},f.build);await producer.completeBuild();await expect(producer.postLanes()).rejects.toThrow('deadline');expect((await producer.release()).status).toBe('released');expect(owned.retained.size).toBe(0);
});

it('checks cancellation again at the actual reserved spawn boundary while retaining factual no-spawn closure',async()=>{
 const f=await setup(),owned=custodian(f),controller=new AbortController();const producer=(await createInstalledDesignTargetProducer({selectFromBase:async()=>true,budget,custody:owned.backend,handoff:async lease=>{const port=lease.reserveChildLaunch(lease.snapshot);controller.abort();expect(()=>port.beforeSpawn()).toThrow('admission revoked');port.notStarted();}}).open(f.context))!;disposals.push(()=>producer.release());await producer.observeCommand({phase:'install',command:'unit-install',args:[]},f.install);await producer.observeCommand({phase:'build',command:'unit-build',args:[]},f.build);await producer.completeBuild();await expect(producer.postLanes(controller.signal)).rejects.toThrow('admission revoked');expect((await producer.release()).status).toBe('released');
});
