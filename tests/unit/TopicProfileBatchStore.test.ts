import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TopicProfileStore } from '../../src/core/TopicProfileStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
const dirs: string[] = [];
function fixture() { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'profile-batch-')); dirs.push(dir); return { dir, file:path.join(dir,'profiles.json') }; }
afterEach(() => { vi.restoreAllMocks(); for(const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'TopicProfileBatchStore cleanup'}); });
describe('atomic batch profile store',()=>{
 it('keeps readers at the last durable snapshot and publishes all targets together',async()=>{
  const {file}=fixture(); const store=new TopicProfileStore({stateFilePath:file});
  await store.mutate('1',{framework:'claude-code',updatedBy:'owner'});
  const original=fs.promises.rename.bind(fs.promises); let release!:()=>void; let entered!:()=>void;
  const started=new Promise<void>(r=>entered=r); const gate=new Promise<void>(r=>release=r);
  vi.spyOn(fs.promises,'rename').mockImplementation(async(...args)=>{entered(); await gate; return original(...args);});
  const pending=store.mutateBatch([{topicKey:'1',patch:{framework:'codex-cli',updatedBy:'owner'}},{topicKey:'2',patch:{framework:'codex-cli',updatedBy:'owner'}}]);
  await started; expect(store.resolve('1')?.framework).toBe('claude-code'); expect(store.resolve('2')).toBeNull();
  release(); const results=await pending; expect(results.map(r=>r.topicKey)).toEqual(['1','2']); expect(store.resolve('2')?.framework).toBe('codex-cli');
 });
 it('rejects every candidate before publishing any, and detaches reads and results',async()=>{
  const {file}=fixture(); const store=new TopicProfileStore({stateFilePath:file});
  await expect(store.mutateBatch([{topicKey:'1',patch:{framework:'codex-cli',updatedBy:'owner'}},{topicKey:'2',patch:{model:'x',modelTier:'fast',updatedBy:'owner'}}])).rejects.toThrow();
  expect(store.all()).toEqual({});
  const [r]=await store.mutateBatch([{topicKey:'1',patch:{framework:'codex-cli',updatedBy:'owner'}}]);
  r.entry.current!.framework='claude-code'; const read=store.get('1')!; read.current!.framework='claude-code'; expect(store.resolve('1')?.framework).toBe('codex-cli');
 });
 it('preserves execution epoch on reaffirmation while advancing acceptance version',async()=>{
  const {file}=fixture(); const store=new TopicProfileStore({stateFilePath:file});
  const [a]=await store.mutateBatch([{topicKey:'1',patch:{framework:'codex-cli',updatedBy:'owner'}}]);
  const [b]=await store.mutateBatch([{topicKey:'1',patch:{framework:'codex-cli',updatedBy:'owner'}}]);
  expect(b.executionEpoch).toBe(a.executionEpoch); expect(b.localAcceptanceVersion).toBeGreaterThan(a.localAcceptanceVersion);
  await store.mutate('1',{framework:'claude-code',updatedBy:'owner'}); await store.mutate('1',{framework:'codex-cli',updatedBy:'owner'});
  expect(store.getExecutionEpoch('1')).toBeGreaterThan(a.executionEpoch);
 });
});

describe('batch admission, rollback and startup',()=>{
 it('rolls back the whole batch and coalesced unrelated waiter on a refused flush',async()=>{
  const {file}=fixture(); const store=new TopicProfileStore({stateFilePath:file}); await store.mutate('1',{framework:'claude-code',updatedBy:'owner'});
  let release!:()=>void, entered!:()=>void; const gate=new Promise<void>(r=>release=r), started=new Promise<void>(r=>entered=r);
  vi.spyOn(fs.promises,'rename').mockImplementation(async()=>{entered(); await gate; throw new Error('disk refused');});
  const batch=store.mutateBatch([{topicKey:'1',patch:{framework:'codex-cli',updatedBy:'owner'}},{topicKey:'2',patch:{framework:'codex-cli',updatedBy:'owner'}}]);
  await started; const unrelated=store.mutate('3',{model:'opus',updatedBy:'owner'}); const results=Promise.allSettled([batch,unrelated]);
  await new Promise(r=>setImmediate(r)); release(); expect((await results).map(r=>r.status)).toEqual(['rejected','rejected']);
  expect(store.resolve('1')?.framework).toBe('claude-code'); expect(store.get('2')).toBeNull(); expect(store.get('3')).toBeNull();
 });
 it('orders bulk shadow clear after a pending preview batch without rewriting its own result',async()=>{
  const {file}=fixture(); const store=new TopicProfileStore({stateFilePath:file});
  const original=fs.promises.rename.bind(fs.promises); let release!:()=>void, entered!:()=>void;
  const gate=new Promise<void>(r=>release=r), started=new Promise<void>(r=>entered=r); let first=true;
  vi.spyOn(fs.promises,'rename').mockImplementation(async(...args)=>{if(first){first=false;entered();await gate;}return original(...args);});
  const batch=store.mutateBatch([{topicKey:'1',patch:{updatedBy:'owner'},options:{shadow:{framework:'codex-cli'}}}]); await started;
  const clear=store.clearAllShadows(); release(); const [own]=await batch; await clear;
  expect(own.entry.intendedProfile?.fields.framework).toBe('codex-cli'); expect(store.get('1')?.intendedProfile).toBeNull();
 });
 it('orders a preview batch after an already admitted bulk clear',async()=>{
  const {file}=fixture(); const store=new TopicProfileStore({stateFilePath:file}); await store.setShadow('1',{framework:'claude-code'},'owner');
  const original=fs.promises.rename.bind(fs.promises); let release!:()=>void,entered!:()=>void; const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);let first=true;
  vi.spyOn(fs.promises,'rename').mockImplementation(async(...args)=>{if(first){first=false;entered();await gate;}return original(...args);});
  const clear=store.clearAllShadows();await started;
  const batch=store.mutateBatch([{topicKey:'1',patch:{updatedBy:'owner'},options:{shadow:{framework:'codex-cli'}}}]);release();await clear;const [own]=await batch;
  expect(own.entry.intendedProfile?.fields.framework).toBe('codex-cli');expect(store.get('1')?.intendedProfile?.fields.framework).toBe('codex-cli');
 });
 it('orders pre-rename batch, supported restore installation, then later mutation',async()=>{
  const {file}=fixture();const store=new TopicProfileStore({stateFilePath:file});
  const original=fs.promises.rename.bind(fs.promises);let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);let first=true;
  vi.spyOn(fs.promises,'rename').mockImplementation(async(...args)=>{if(first){first=false;entered();await gate;}return original(...args);});
  const batch=store.mutateBatch([{topicKey:'1',patch:{framework:'codex-cli',updatedBy:'owner'}}]);await started;let installed=false;
  const restore=store.withRestoreBarrier(()=>{installed=true;fs.writeFileSync(file,JSON.stringify({topics:{'9':{current:{framework:'claude-code',updatedAt:'2026-01-01',updatedBy:'owner'},previous:null,intendedProfile:null,parked:null,breakerCount:0}}}));});
  const later=store.mutate('2',{framework:'codex-cli',updatedBy:'owner'});expect(installed).toBe(false);release();const [own]=await batch;await restore;await later;
  expect(own.entry.current?.framework).toBe('codex-cli');expect(store.get('1')).toBeNull();expect(store.resolve('9')?.framework).toBe('claude-code');expect(store.resolve('2')?.framework).toBe('codex-cli');
  expect(Object.keys(JSON.parse(fs.readFileSync(file,'utf8')).topics).sort()).toEqual(['2','9']);
 });
 it('does not expose a legacy seed until awaited readiness succeeds',async()=>{
  const {dir,file}=fixture();const legacy=path.join(dir,'legacy.json');fs.writeFileSync(legacy,JSON.stringify({topics:{'1':'codex-cli'}}));
  const original=fs.promises.rename.bind(fs.promises);let release!:()=>void,entered!:()=>void;const started=new Promise<void>(r=>entered=r),gate=new Promise<void>(r=>release=r);
  vi.spyOn(fs.promises,'rename').mockImplementation(async(...args)=>{entered();await gate;return original(...args);});
  const store=new TopicProfileStore({stateFilePath:file,legacyFrameworksPath:legacy});await started;expect(store.resolve('1')).toBeNull();release();await store.ready();expect(store.resolve('1')?.framework).toBe('codex-cli');
 });
 it('rejects readiness on refused legacy-seed persistence rather than exposing the seed',async()=>{
  const {dir,file}=fixture();const legacy=path.join(dir,'legacy.json');fs.writeFileSync(legacy,JSON.stringify({topics:{'1':'codex-cli'}}));
  vi.spyOn(fs.promises,'rename').mockRejectedValue(new Error('seed disk failure'));const store=new TopicProfileStore({stateFilePath:file,legacyFrameworksPath:legacy});
  await expect(store.ready()).rejects.toThrow('flush failed');expect(store.resolve('1')).toBeNull();
 });
});

it('releases earlier batch locks on later lock acquisition failure without publication',async()=>{
 const {file}=fixture();const store=new TopicProfileStore({stateFilePath:file});let release!:()=>void,entered!:()=>void;
 const gate=new Promise<void>(r=>release=r),started=new Promise<void>(r=>entered=r);const held=store.withTopicLock('2',async()=>{entered();await gate;});await started;
 await expect(store.mutateBatch([{topicKey:'1',patch:{framework:'codex-cli',updatedBy:'owner'}},{topicKey:'2',patch:{framework:'codex-cli',updatedBy:'owner'}}],{lockTimeoutMs:10})).rejects.toThrow('could not acquire');
 expect(store.all()).toEqual({});release();await held;await store.mutate('1',{framework:'claude-code',updatedBy:'owner'});expect(store.resolve('1')?.framework).toBe('claude-code');
});

it('fences old execution and reloads actual disk after a partially failed supported restore',async()=>{
 const {file}=fixture();const store=new TopicProfileStore({stateFilePath:file});await store.mutate('1',{framework:'claude-code',updatedBy:'owner'});const token=store.getExecutionEpoch('1');
 await expect(store.withRestoreBarrier(()=>{fs.writeFileSync(file,JSON.stringify({topics:{}}));throw new Error('partial install failed');})).rejects.toThrow('partial install failed');
 expect(store.getExecutionEpoch('1')).toBeGreaterThan(token);expect(store.get('1')).toBeNull();await store.mutate('2',{framework:'codex-cli',updatedBy:'owner'});expect(store.resolve('2')?.framework).toBe('codex-cli');
});
