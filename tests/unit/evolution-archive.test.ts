// safe-fs-allow: temporary archive fixtures only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { EvolutionArchive, evolutionArchiveDigest, EVOLUTION_ARCHIVE_MAX_BYTES, type EvolutionArchiveEnvelope } from '../../src/core/EvolutionArchive.js';
import { EvolutionArchiveSync } from '../../src/core/EvolutionArchiveSync.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { ActionItem, LearningEntry } from '../../src/core/types.js';
const dirs: string[] = [];
function archive(origin='A') { const dir=fs.mkdtempSync(path.join(os.tmpdir(),'evo-archive-')); dirs.push(dir); return new EvolutionArchive(dir,origin); }
const action=(id='ACT-001'):ActionItem=>({id,title:'full work',description:'complete content',status:'completed',priority:'medium',createdAt:'2026-11-05T00:00:00Z'});
const learning=(id='LRN-001'):LearningEntry=>({id,title:'full lesson',description:'not a projected record',category:'test',source:{type:'test',name:'test'} as any,applied:true,tags:[]});
afterEach(()=>{vi.restoreAllMocks();for(const dir of dirs.splice(0))SafeFsExecutor.safeRmSync(dir,{recursive:true,force:true,operation:'evolution-archive-test-cleanup'});});
describe('EvolutionArchive memory preservation',()=>{
 it('reuses action archive and preserves unknown fields and all full-content versions',()=>{
  const a=archive();a.write({entries:[],externalMetadata:{keep:'me'}});a.preserve('actions',[action()]);a.preserve('learnings',[learning()]);a.preserve('actions',[{...action(),description:'updated version'}]);
  expect(a.read().externalMetadata).toEqual({keep:'me'});expect(a.read().entries).toHaveLength(2);expect(a.page().entries).toHaveLength(3);
  const again=new EvolutionArchive(path.resolve(path.dirname(a.filePath),'../..'),'A');expect(again.page()).toEqual(a.page());
  a.preserve('actions',[action()]);expect(a.read().entries).toHaveLength(2);
 });
 it('persists a unique fallback origin across restart without a journal identity',()=>{
  const a=archive(); // Construct a second store without the helper's explicit origin.
  const base=path.resolve(path.dirname(a.filePath),'../..');const first=new EvolutionArchive(base);first.preserve('actions',[action()]);const restarted=new EvolutionArchive(base);
  expect(restarted.page().entries[0].origin).toBe(first.origin);expect(restarted.origin).not.toBe('local');
  const other=new EvolutionArchive(path.resolve(path.dirname(archive('other').filePath),'../..'));expect(other.origin).not.toBe(first.origin);
 });
 it('exports existing legacy memory identically across new read-only instances before adoption',()=>{
  const fixture=archive();fs.mkdirSync(path.dirname(fixture.filePath),{recursive:true});
  const legacy=JSON.stringify({entries:[{action:action(),archivedAt:'2026-11-05T00:00:00Z',ageDays:2,class:'stale'}]});
  fs.writeFileSync(fixture.filePath,legacy);const dir=path.resolve(path.dirname(fixture.filePath),'../..');
  const one=new EvolutionArchive(dir).page(),two=new EvolutionArchive(dir).page();
  expect(two).toEqual(one);expect(one.entries[0].origin).toMatch(/^legacy:/);expect(fs.readFileSync(fixture.filePath,'utf8')).toBe(legacy);
  const adopted=new EvolutionArchive(dir);adopted.preserve('learnings',[learning()]);expect(new EvolutionArchive(dir).page().entries[0]).toEqual(one.entries[0]);
 });
 it('fsyncs archive and parent directory before returning and verifies readback',()=>{
  const a=archive(),sync=vi.spyOn(fs,'fsyncSync'),rename=vi.spyOn(fs,'renameSync');a.preserve('actions',[action()]);
  expect(sync).toHaveBeenCalledTimes(2);expect(sync.mock.invocationCallOrder[0]).toBeLessThan(rename.mock.invocationCallOrder[0]);expect(sync.mock.invocationCallOrder[1]).toBeGreaterThan(rename.mock.invocationCallOrder[0]);
  expect(a.localEntries('actions')).toEqual([action()]);
 });
 it('keeps corrupt archives unchanged and rejects malformed action/replica shapes',()=>{
  const a=archive();fs.mkdirSync(path.dirname(a.filePath),{recursive:true});fs.writeFileSync(a.filePath,'{broken');
  expect(()=>a.preserve('actions',[action()])).toThrow();expect(fs.readFileSync(a.filePath,'utf8')).toBe('{broken');
  fs.writeFileSync(a.filePath,JSON.stringify({entries:[{action:{id:'ACT-001'},archivedAt:'now',ageDays:0,class:'retention'}]}));expect(()=>a.read()).toThrow();
 });
 it('strictly checks the digest of a full page before importing anything',()=>{
  const a=archive('A'),b=archive('B');a.preserve('actions',[action()]);a.preserve('learnings',[learning()]);const page=a.page();page.entries[1].record.description='tampered';
  expect(()=>b.importPage(page)).toThrow('digest mismatch');expect(b.page().entries).toEqual([]);
 });
 it('keeps stable export order when a different source kind is appended after imported memory',()=>{
  const a=archive('A'),b=archive('B');a.preserve('learnings',[learning()]);b.importPage(a.page());const first=b.page({limit:1}).entries[0];b.preserve('actions',[action()]);
  expect(b.page({limit:1}).entries[0]).toEqual(first);expect(b.page({offset:1}).entries[0].kind).toBe('actions');
 });
 it('never removes exported memory on writes, even if a caller passes an incomplete document',()=>{
  const a=archive();a.preserve('actions',[action()]);const doc=a.read();doc.entries=[];expect(()=>a.write(doc)).toThrow('remove exported memory');expect(()=>a.write({entries:[]})).toThrow('remove exported memory');expect(a.localEntries('actions')).toHaveLength(1);
 });
 it('rejects oversized documents before reading and oversized records before archival',()=>{
  const a=archive();fs.mkdirSync(path.dirname(a.filePath),{recursive:true});const fd=fs.openSync(a.filePath,'w');fs.ftruncateSync(fd,EVOLUTION_ARCHIVE_MAX_BYTES+1);fs.closeSync(fd);
  const read=vi.spyOn(fs,'readFileSync');expect(()=>a.read()).toThrow('64 MiB');expect(read).not.toHaveBeenCalled();
  const b=archive();expect(()=>b.preserve('actions',[{...action(),description:'x'.repeat(1024*1024)}])).toThrow('oversized');expect(b.page().entries).toEqual([]);
 });
 it('pages full content without truncation and filters kind/id',()=>{
  const a=archive();for(let i=0;i<55;i++)a.preserve('actions',[action(`ACT-${String(i+1).padStart(3,'0')}`)]);
  expect(a.page().entries).toHaveLength(50);expect(a.page().nextOffset).toBe(50);expect(a.page({offset:50}).entries).toHaveLength(5);expect(a.page({id:'ACT-055',kind:'actions'}).entries[0].record).toEqual(action('ACT-055'));
 });
});
describe('EvolutionArchiveSync bounded custody',()=>{
 it('gossips A to B to C and retains complete memory after source disappears',async()=>{
  const a=archive('A'),b=archive('B'),c=archive('C');const full={...learning(),description:'important '.repeat(5000)};a.preserve('learnings',[full]);
  const bs=new EvolutionArchiveSync(b,{fetchPage:async(_id,_url,offset)=>a.page({offset})});await bs.onPeerRecorded('A','https://a.test');
  const cs=new EvolutionArchiveSync(c,{fetchPage:async(_id,_url,offset)=>b.page({offset})});await cs.onPeerRecorded('B','https://b.test');bs.stop();cs.stop();
  expect(c.page().entries).toEqual(a.page().entries);expect(c.page().entries[0].record.description).toBe(full.description);expect(c.localEntries('learnings')).toEqual([]);
  expect(c.page().entries[0].origin).toBe('A');
 });
 it('parks permanently failing peers durably after six requests and rearms only changed URL',async()=>{
  const a=archive();let clock=0;const fetchPage=vi.fn(async()=>{throw new Error('offline');});let sync=new EvolutionArchiveSync(a,{fetchPage,now:()=>clock});
  for(let n=0;n<6;n++){await sync.onPeerRecorded('B','https://b.test');await sync.onPeerRecorded('B','https://b.test');clock+=30*60_000;}
  expect(fetchPage).toHaveBeenCalledTimes(6);expect(a.read().syncPeers?.B.parked).toBe(true);
  sync=new EvolutionArchiveSync(a,{fetchPage,now:()=>clock});clock+=365*24*60*60_000;await sync.onPeerRecorded('B','https://b.test');expect(fetchPage).toHaveBeenCalledTimes(6);
  await sync.onPeerRecorded('B','https://new-b.test');expect(fetchPage).toHaveBeenCalledTimes(7);
 });
 it('keeps failed-page cursor and does not overwrite a simultaneous local archive write',async()=>{
  const a=archive('A'),b=archive('B');a.preserve('actions',[action()]);
  const sync=new EvolutionArchiveSync(b,{fetchPage:async()=>{b.preserve('learnings',[learning()]);return a.page();}});await sync.onPeerRecorded('A','https://a.test');
  expect(b.page().entries).toHaveLength(2);expect(b.read().syncPeers?.A.offset).toBe(0);
  const bad=a.page();bad.entries[0].digest='f'.repeat(64);const fail=new EvolutionArchiveSync(b,{fetchPage:async()=>bad});await fail.onPeerRecorded('A','https://a.test');
  expect(b.page().entries).toHaveLength(2);expect(b.read().syncPeers?.A.failures).toBe(1);
 });
 it('restarts from a new incarnation instead of accepting an old offset from rebuilt stream',async()=>{
  const a=archive('A'),b=archive('B');a.preserve('actions',[action()]);b.write({entries:[],syncPeers:{A:{url:'https://a.test',offset:99,incarnation:'old',failures:0,nextAttemptAt:0,parked:false}}});
  const offsets:number[]=[];const sync=new EvolutionArchiveSync(b,{fetchPage:async(_id,_url,offset)=>{offsets.push(offset);return a.page({offset});}});await sync.onPeerRecorded('A','https://a.test');expect(offsets).toEqual([99,0]);expect(b.page().entries).toHaveLength(1);
 });
 it('imports at most four pages per pass and resumes durable cursor after restart',async()=>{
  const source=archive('A'),sink=archive('B');source.preserve('actions',Array.from({length:205},(_,i)=>action(`ACT-${String(i+1).padStart(3,'0')}`)));
  const fetchPage=vi.fn(async(_id:string,_url:string,offset:number)=>source.page({offset}));let sync=new EvolutionArchiveSync(sink,{fetchPage});await sync.onPeerRecorded('A','https://a.test');expect(fetchPage).toHaveBeenCalledTimes(4);expect(sink.read().syncPeers?.A.offset).toBe(200);
  sync=new EvolutionArchiveSync(sink,{fetchPage});await sync.onPeerRecorded('A','https://a.test');expect(sink.page().total).toBe(205);expect(sink.read().syncPeers?.A.offset).toBe(0);
 });
 it('sends zero requests when durable attempt reservation cannot be written, including reconstruction',async()=>{
  const a=archive('A'),b=archive('B');a.preserve('actions',[action()]);b.write({entries:[]});
  const fetchPage=vi.fn(async()=>a.page());vi.spyOn(b,'write').mockImplementation(()=>{throw new Error('disk full');});
  for(let tick=0;tick<20;tick++)await new EvolutionArchiveSync(b,{fetchPage,now:()=>tick*30*60_000}).onPeerRecorded('A','https://a.test');
  expect(fetchPage).not.toHaveBeenCalled();
 });
 it('charges a failed import once before requesting and preserves the six-request bound across restart',async()=>{
  const a=archive('A'),b=archive('B');a.preserve('actions',[action()]);let clock=0;
  const fetchPage=vi.fn(async()=>a.page());vi.spyOn(b,'importPage').mockImplementation(()=>{throw new Error('archive capacity exhausted');});
  for(let tick=0;tick<20;tick++){
   await new EvolutionArchiveSync(b,{fetchPage,now:()=>clock}).onPeerRecorded('A','https://a.test');clock+=30*60_000;
  }
  expect(fetchPage).toHaveBeenCalledTimes(6);expect(b.read().syncPeers?.A).toMatchObject({failures:6,parked:true,offset:0});
 });
 it('does not send another request when import exhausts space after a durable reservation',async()=>{
  const a=archive('A'),b=archive('B');a.preserve('actions',[action()]);let full=false;
  const write=b.write.bind(b);vi.spyOn(b,'write').mockImplementation(doc=>{if(full)throw new Error('disk full');write(doc);});
  const fetchPage=vi.fn(async()=>{full=true;return a.page();});
  for(let tick=0;tick<20;tick++)await new EvolutionArchiveSync(b,{fetchPage,now:()=>tick*30*60_000}).onPeerRecorded('A','https://a.test');
  expect(fetchPage).toHaveBeenCalledTimes(1);expect(b.read().syncPeers?.A.failures).toBe(1);
 });
 it('rejects a forged advancing page before custody and leaves its cursor unadvanced',async()=>{
  const a=archive('A'),b=archive('B');a.preserve('actions',[action()]);const forged={...a.page(),total:100,nextOffset:50};
  expect(()=>b.importPage(forged)).toThrow('cursor coverage');expect(b.page().entries).toEqual([]);
  await new EvolutionArchiveSync(b,{fetchPage:async()=>forged}).onPeerRecorded('A','https://a.test');
  expect(b.page().entries).toEqual([]);expect(b.read().syncPeers?.A).toMatchObject({offset:0,failures:1});
 });
 it('validates terminal coverage and oversized metadata rather than accepting skipped memory',()=>{
  const a=archive('A'),b=archive('B');a.preserve('actions',[action()]);
  expect(()=>b.importPage({...a.page(),total:2})).toThrow('terminal archive coverage');
  const malformed={entries:[],offset:0,total:1,nextOffset:null,incarnation:'stream',oversized:[{digest:'bad',origin:'A',kind:'actions',id:'ACT-001',reason:'oversized'}]};
  expect(()=>b.importPage(malformed as any)).toThrow('oversized archive metadata');
 });
 it('corrupt durable retry state prevents requests rather than resetting a bound',async()=>{
  const a=archive();fs.mkdirSync(path.dirname(a.filePath),{recursive:true});fs.writeFileSync(a.filePath,JSON.stringify({entries:[],syncPeers:{B:{failures:'bad'}}}));
  const fetchPage=vi.fn();await new EvolutionArchiveSync(a,{fetchPage}).onPeerRecorded('B','https://b.test');expect(fetchPage).not.toHaveBeenCalled();
 });
 it('suppresses overlapping pulls and shutdown stops further import',async()=>{
  const a=archive('A'),b=archive('B');a.preserve('actions',[action()]);let finish!:(page:ReturnType<EvolutionArchive['page']>)=>void;
  const fetchPage=vi.fn(()=>new Promise<ReturnType<EvolutionArchive['page']>>(resolve=>{finish=resolve;}));const sync=new EvolutionArchiveSync(b,{fetchPage});const pending=sync.onPeerRecorded('A','https://a.test');await sync.onPeerRecorded('A','https://a.test');expect(fetchPage).toHaveBeenCalledTimes(1);sync.stop();finish(a.page());await pending;expect(b.page().entries).toEqual([]);
 });
 it('empty validated pages count as success and reset failures',async()=>{
  const a=archive('A'),b=archive('B');b.write({entries:[],syncPeers:{A:{url:'https://a.test',offset:0,failures:3,nextAttemptAt:0,parked:false}}});await new EvolutionArchiveSync(b,{fetchPage:async()=>a.page()}).onPeerRecorded('A','https://a.test');expect(b.read().syncPeers?.A.failures).toBe(0);
 });
});
