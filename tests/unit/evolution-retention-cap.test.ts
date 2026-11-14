// safe-fs-allow: temporary test directories only.
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EvolutionManager } from '../../src/core/EvolutionManager.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'evo022-test-cleanup' }); });
function directory() { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'evo022-')); dirs.push(d); fs.mkdirSync(path.join(d, 'state/evolution'), {recursive:true}); return d; }
const stores = [
  { kind:'proposals', file:'evolution-queue', key:'proposals', prefix:'EVO', save:'saveEvolution', list:'listProposals', stats:'getEvolutionStats', active:{status:'approved',type:'infrastructure'}, terminal:{status:'implemented',type:'infrastructure'} },
  { kind:'learnings', file:'learning-registry', key:'learnings', prefix:'LRN', save:'saveLearnings', list:'listLearnings', stats:'getLearningStats', active:{applied:false,category:'test',source:{type:'test',name:'test'}}, terminal:{applied:true,category:'test',source:{type:'test',name:'test'}} },
  { kind:'gaps', file:'capability-gaps', key:'gaps', prefix:'GAP', save:'saveGaps', list:'listGaps', stats:'getGapStats', active:{status:'identified',severity:'medium',category:'test'}, terminal:{status:'addressed',severity:'medium',category:'test'} },
  { kind:'actions', file:'action-queue', key:'actions', prefix:'ACT', save:'saveActions', list:'listActions', stats:'getActionStats', active:{status:'pending',priority:'medium',createdAt:'2026-01-01T00:00:00Z'}, terminal:{status:'completed',priority:'medium',createdAt:'2026-01-01T00:00:00Z'} },
] as const;
function record(s: typeof stores[number], n: number, active: boolean) { return {id:`${s.prefix}-${String(n).padStart(3,'0')}`,title:`record ${n}`,description:`full content ${n}`, ...(active?s.active:s.terminal)}; }
function seed(d:string,s:typeof stores[number],rows:unknown[]) { fs.writeFileSync(path.join(d,'state/evolution',s.file+'.json'),JSON.stringify({[s.key]:rows,stats:{total:999}})); }
// Private save funnels are exercised against real files, including the exact saturation boundary.
function save(m:EvolutionManager,s:typeof stores[number],rows:unknown[]) { (m as any)[s.save]({[s.key]:rows,stats:{}}); }
describe.each(stores)('EVO-022 $kind', s => {
  it.each([1,2,3])('preserves %i active rows and archives only terminal surplus at target 2', active => {
    const d=directory(), m=new EvolutionManager({stateDir:d,retentionTargets:{[s.kind]:2}});
    const rows=[record(s,1,false),record(s,2,false), ...Array.from({length:active},(_,i)=>record(s,i+3,true))];
    save(m,s,rows);
    const hot=JSON.parse(fs.readFileSync(path.join(d,'state/evolution',s.file+'.json'),'utf8'))[s.key];
    expect(hot.filter((r:any)=>r.id.endsWith('001'))).toEqual([]);
    expect(hot).toHaveLength(Math.max(2,active));
    for(const r of rows.slice(2)) expect(hot).toContainEqual(r);
    const archive=m.getArchivePage({kind:s.kind,limit:50});
    const archived=archive.entries.map(e=>e.record);
    expect(archived).toContainEqual(rows[0]);
    if(active>=2) expect(archived).toContainEqual(rows[1]);
    expect((m as any)[s.stats]()).toMatchObject({total:hot.length,active,terminalRetained:Math.max(0,2-active),target:2,terminalAllowance:Math.max(0,2-active),overflow:Math.max(0,active-2)});
  });
  it('honors zero and new-key precedence over legacy aliases',()=>{
    const d=directory(),m=new EvolutionManager({stateDir:d,maxProposals:20,maxLearnings:20,maxGaps:20,maxActions:20,retentionTargets:{[s.kind]:0}});
    save(m,s,[record(s,1,false)]); expect((m as any)[s.list]()).toEqual([]);
    expect(m.getArchivePage({kind:s.kind}).entries[0].record).toEqual(record(s,1,false));
  });
  it.each([-1,NaN,Infinity,1.5])('invalid target %s retains all records',target=>{
    const d=directory(),m=new EvolutionManager({stateDir:d,retentionTargets:{[s.kind]:target}});save(m,s,[record(s,1,false)]);
    expect((m as any)[s.list]()).toHaveLength(1);expect((m as any)[s.stats]().target).toBeNull();
  });
  it('archive damage holds eviction and reports unknown rather than replacing content',()=>{
    const d=directory(),m=new EvolutionManager({stateDir:d,retentionTargets:{[s.kind]:0}});
    const file=path.join(d,'state/evolution/action-archive.json'); fs.writeFileSync(file,'{broken');
    save(m,s,[record(s,1,false)]); expect((m as any)[s.list]()).toHaveLength(1);expect(fs.readFileSync(file,'utf8')).toBe('{broken');
  });
  it('recomputes stale read stats and refuses mutation reads of corrupted data',()=>{
    const d=directory(),m=new EvolutionManager({stateDir:d});seed(d,s,[record(s,1,true)]);expect((m as any)[s.stats]()).toMatchObject({total:1,active:1});
    fs.writeFileSync(path.join(d,'state/evolution',s.file+'.json'),'{broken');
    expect(()=> (m as any)[s.list]()).toThrow();expect(m.getRetentionReport()[s.kind]).toMatchObject({status:'unknown'});
  });
});
it('reserves archived IDs across restart and restores a terminal action held in the hot list',()=>{
 const d=directory(); let m=new EvolutionManager({stateDir:d,retentionTargets:{actions:0}});
 save(m,stores[3],[record(stores[3],1,false)]);m=new EvolutionManager({stateDir:d,retentionTargets:{actions:0}});
 const a=m.addAction({title:'new work',description:'new'});expect(a.id).toBe('ACT-002');
 expect(m.restoreArchivedAction('ACT-001')).toMatchObject({status:'completed',autoExpiryHold:{reason:expect.any(String)}});
 expect(m.listActions()).toHaveLength(2);
});
it('eviction sends no delete, retains full learning content, and makes it available to repair',()=>{
 const d=directory(),m=new EvolutionManager({stateDir:d,retentionTargets:{learnings:0}}),emitDelete=vi.fn(),emitPut=vi.fn();
 m.setLearningReplicationEmitter({emitDelete,emitPut});save(m,stores[1],[record(stores[1],1,false)]);
 expect(emitDelete).not.toHaveBeenCalled();expect(m.listLearningsForReplication()).toContainEqual(record(stores[1],1,false));
});
it('a failed hot-list save after archival is safe to retry without duplicate history',()=>{
 const d=directory(),m=new EvolutionManager({stateDir:d,retentionTargets:{actions:0}}),rows=[record(stores[3],1,false)];
 const rename=fs.renameSync;vi.spyOn(fs,'renameSync').mockImplementation((a,b)=>{if(String(b).endsWith('action-queue.json'))throw new Error('crash');rename(a,b);});
 expect(()=>save(m,stores[3],rows)).toThrow('crash');vi.restoreAllMocks();save(m,stores[3],rows);
 expect(m.getArchivePage({kind:'actions'}).entries).toHaveLength(1);
});

it('restore merges its marker with history created by retention during the save',()=>{
 const d=directory(),m=new EvolutionManager({stateDir:d,retentionTargets:{actions:1}});
 m.archive.preserve('actions',[record(stores[3],1,false) as any]);
 seed(d,stores[3],[record(stores[3],2,false)]);
 expect(m.restoreArchivedAction('ACT-001')).toMatchObject({id:'ACT-001',autoExpiryHold:expect.any(Object)});
 expect(m.listActions().map(a=>a.id)).toEqual(['ACT-001']);
 expect(m.listArchivedActions().find(e=>e.action.id==='ACT-001')?.restoredAt).toEqual(expect.any(String));
 expect(m.listArchivedActions().find(e=>e.action.id==='ACT-002')?.action).toEqual(record(stores[3],2,false));
});

it('can restore again after a restored terminal action is released and re-archived',()=>{
 const d=directory(),m=new EvolutionManager({stateDir:d,retentionTargets:{actions:0}});
 const a=m.addAction({title:'result',description:'full'});m.updateAction(a.id,{status:'completed'});
 expect(m.restoreArchivedAction(a.id)).toMatchObject({id:a.id});
 expect(m.updateAction(a.id,{autoExpiryHold:null})).toBe(true);expect(m.listActions()).toEqual([]);
 expect(m.restoreArchivedAction(a.id)).toMatchObject({id:a.id,autoExpiryHold:expect.any(Object)});
 expect(m.getArchivePage({kind:'actions',id:a.id}).entries).toHaveLength(1);
});

it.each(stores)('keeps legacy opaque $kind IDs readable, archived and reserved across reload',s=>{
 const d=directory(),legacy={...record(s,1,false),id:`${s.prefix}-LEGACY`};seed(d,s,[legacy]);
 const m=new EvolutionManager({stateDir:d,retentionTargets:{[s.kind]:0}});
 expect((m as any)[s.list]()).toEqual([legacy]);save(m,s,[legacy]);
 const reloaded=new EvolutionManager({stateDir:d});
 expect(reloaded.getArchivePage({kind:s.kind,id:legacy.id}).entries[0].record).toEqual(legacy);
 const next=(reloaded as any).nextRetainedId(s.kind,s.prefix,[]);expect(next).toBe(`${s.prefix}-001`);expect(next).not.toBe(legacy.id);
});

it.each(stores)('never treats opaque exponent-like $kind suffixes as numeric allocations',s=>{
 const d=directory(),m=new EvolutionManager({stateDir:d});
 const legacy={...record(s,1,false),id:`${s.prefix}-1e3`};m.archive.preserve(s.kind,[legacy as any]);
 expect((m as any).nextRetainedId(s.kind,s.prefix,[record(s,2,true)])).toBe(`${s.prefix}-003`);
});
