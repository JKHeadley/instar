import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FeatureRolloutReconciler, type SpecArtifact } from '../../src/core/FeatureRolloutReconciler.js';
import { scanSpecArtifacts, scanSpecArtifactsAsync, scanSpecArtifactsCanonicalAsync, scanSpecArtifactsWithCanonicalAsync } from '../../src/core/featureRolloutScan.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { rolloutFixture } from '../helpers/rolloutScanFixture.js';

const fixtures: ReturnType<typeof rolloutFixture>[] = [];
const fixture = () => { const f = rolloutFixture(); fixtures.push(f); return f; };
afterEach(() => { vi.restoreAllMocks(); for (const f of fixtures.splice(0)) f.close(); });
const artifact = (id: string): SpecArtifact => ({ id, specPath: `docs/specs/${id}.md`, title: id, approved: true,
  reviewConverged: true, shipsStaged: false, traceExists: false, merged: false, mergedRecently: false });
function tracker() {
  return { list: vi.fn(() => []), get: vi.fn(), create: vi.fn(async () => ({})), update: vi.fn(async () => ({})), setPhaseStatus: vi.fn(async () => ({})) };
}

describe('asynchronous rollout discovery', () => {
  it('preserves local projection, trace metadata and malformed-trace behavior', async () => {
    const f = fixture(); const now = () => 1700000000000;
    f.write(f.repo, '.instar/instar-dev-traces/good.json', JSON.stringify({specPath:'docs/specs/local-only.md',prNumber:123,createdAt:'2023-11-14T20:00:00Z'}));
    f.write(f.repo, '.instar/instar-dev-traces/bad.json', '{broken');
    expect(await scanSpecArtifactsAsync(f.repo, now)).toEqual(scanSpecArtifacts(f.repo, now));
  });
  it('refreshes stale tracking main despite a custom mapping and requires canonical-only success', async () => {
    const f = fixture(); f.git(f.repo, ['config', 'remote.origin.fetch', '+refs/heads/main:refs/remotes/origin/custom']);
    const got = await scanSpecArtifactsCanonicalAsync({repoPath:f.repo,canonicalRemote:'origin'});
    expect(got.canonicalHeadSha).toBe(f.second);
    expect(got.artifacts.map(x=>x.id)).toContain('canonical-new');
    expect(got.artifacts.map(x=>x.id)).not.toContain('local-only');
  });
  it('follows published main through a real rewind', async () => {
    const f = fixture();
    const actualSpawn = SafeGitExecutor.spawn.bind(SafeGitExecutor);
    const fetchDiagnostics: string[] = [];
    const fetchCommands: string[][] = [];
    const localHead = f.git(f.repo, ['rev-parse', 'HEAD']);
    const localStatus = f.git(f.repo, ['status', '--porcelain=v1']);
    vi.spyOn(SafeGitExecutor, 'spawn').mockImplementation((args, options) => {
      fetchCommands.push([...args]);
      const child = actualSpawn(args, options);
      child.stderr?.on('data', (chunk: Buffer) => fetchDiagnostics.push(chunk.toString('utf8')));
      return child;
    });
    try {
      await scanSpecArtifactsCanonicalAsync({repoPath:f.repo,canonicalRemote:'origin'});
      f.git(f.canonical, ['reset','--hard',f.first]);
      const got=await scanSpecArtifactsCanonicalAsync({repoPath:f.repo,canonicalRemote:'origin'});
      expect(got.canonicalHeadSha).toBe(f.first); expect(got.artifacts.map(x=>x.id)).not.toContain('canonical-new');
      expect(f.git(f.repo, ['rev-parse', 'HEAD'])).toBe(localHead);
      expect(f.git(f.repo, ['status', '--porcelain=v1'])).toBe(localStatus);
      expect(fetchCommands).toHaveLength(2);
      for (const args of fetchCommands) {
        expect(args).toEqual(['fetch', 'origin', '+refs/heads/main:refs/remotes/origin/main', '--no-tags', '--no-recurse-submodules']);
        expect(args).not.toContain('--force');
      }
    } catch (error) {
      // Temporary-repository stderr only; preserve the real command failure before correction.
      throw new Error(`Rewind fixture fetch diagnostics:\n${fetchDiagnostics.join('')}`, { cause: error });
    }
  });
  it('cannot substitute a competing FETCH_HEAD after its canonical fetch', async () => {
    const f = fixture(); const original = SafeGitExecutor.readStream.bind(SafeGitExecutor); let injected=false;
    vi.spyOn(SafeGitExecutor,'readStream').mockImplementation((args,opts)=>{
      if (!injected && args[0]==='rev-parse') { injected=true; f.git(f.repo,['fetch','origin',f.first,'--no-tags']); }
      return original(args,opts);
    });
    const got=await scanSpecArtifactsCanonicalAsync({repoPath:f.repo,canonicalRemote:'origin'});
    expect(injected).toBe(true); expect(got.canonicalHeadSha).toBe(f.second);
  });
  it('separately diagnoses failed fetch and delivers only complete local inventory', async () => {
    const f=fixture(); const degraded=vi.fn();
    const got=await scanSpecArtifactsWithCanonicalAsync(f.repo,{canonicalRefScanEnabled:true,canonicalRemote:'missing-fixture-remote',onDegradation:degraded});
    expect(degraded).toHaveBeenCalledOnce(); expect(got.map(x=>x.id)).toContain('local-only');
    expect(got.map(x=>x.id)).not.toContain('canonical-new');
  });
  it('discards earlier canonical blobs when a later listed blob cannot be read', async () => {
    const f=fixture(); const original=SafeGitExecutor.readStream.bind(SafeGitExecutor); let shown=0;
    vi.spyOn(SafeGitExecutor,'readStream').mockImplementation((args,opts)=>{
      if (args[0]==='show' && ++shown===2) throw new Error('fixture listed blob failed');
      return original(args,opts);
    });
    const degraded=vi.fn(); const got=await scanSpecArtifactsWithCanonicalAsync(f.repo,{canonicalRefScanEnabled:true,canonicalRemote:'origin',onDegradation:degraded});
    expect(shown).toBe(2); expect(degraded).toHaveBeenCalledOnce(); expect(got.map(x=>x.id)).toContain('local-only');
    expect(got.map(x=>x.id)).not.toContain('canonical-new');
  });
  it('rejects a listed local read failure instead of returning earlier partial observations', async () => {
    const f=fixture(); const original=fs.promises.readFile.bind(fs.promises); let reads=0;
    vi.spyOn(fs.promises,'readFile').mockImplementation(((file: unknown, options: unknown)=>{
      if (String(file).includes(path.join('docs','specs')) && ++reads===2) return Promise.reject(new Error('fixture read failed'));
      return original(file as never,options as never);
    }) as typeof fs.promises.readFile);
    await expect(scanSpecArtifactsAsync(f.repo)).rejects.toThrow('fixture read failed');
  });
  it('never starts Git or fallback after cancellation', async () => {
    const f=fixture(); const controller=new AbortController();controller.abort();
    const spy=vi.spyOn(SafeGitExecutor,'spawn'); const degraded=vi.fn();
    await expect(scanSpecArtifactsWithCanonicalAsync(f.repo,{canonicalRefScanEnabled:true,canonicalRemote:'origin',onDegradation:degraded},Date.now,controller.signal)).rejects.toMatchObject({name:'AbortError'});
    expect(spy).not.toHaveBeenCalled();expect(degraded).not.toHaveBeenCalled();
  });
});

describe('reconciler flight and shutdown',()=>{
  it('shares discovery and application and permits a new run after success',async()=>{
    const t=tracker();let release!:(value:SpecArtifact[])=>void;
    const discover=vi.fn(()=>new Promise<SpecArtifact[]>(r=>{release=r;}));
    const r=new FeatureRolloutReconciler({tracker:t as never,listSpecArtifacts:discover,observeFlag:()=>({})});
    const a=r.reconcile();expect(r.reconcile()).toBe(a);expect(t.create).not.toHaveBeenCalled();
    release([artifact('one')]);await a;expect(t.create).toHaveBeenCalledOnce();
    const b=r.reconcile();expect(b).not.toBe(a);release([]);await b;
  });
  it('releases a failed flight without tracker writes',async()=>{
    const t=tracker();const discover=vi.fn().mockRejectedValueOnce(new Error('discovery failed')).mockResolvedValueOnce([]);
    const r=new FeatureRolloutReconciler({tracker:t as never,listSpecArtifacts:discover,observeFlag:()=>({})});
    await expect(r.reconcile()).rejects.toThrow('discovery failed');await r.reconcile();expect(discover).toHaveBeenCalledTimes(2);expect(t.create).not.toHaveBeenCalled();
  });
  it('cancels discovery and makes stop idempotent without blocking dependency closure',async()=>{
    const t=tracker();let childClosed=false;
    const r=new FeatureRolloutReconciler({tracker:t as never,observeFlag:()=>({}),listSpecArtifacts:(signal)=>new Promise((_,reject)=>signal!.addEventListener('abort',()=>{childClosed=true;reject(new DOMException('cancel','AbortError'));},{once:true}))});
    const flight=r.reconcile();const rejected=expect(flight).rejects.toMatchObject({name:'AbortError'});
    await Promise.all([r.stop(),r.stop()]);await rejected;expect(childClosed).toBe(true);expect(t.create).not.toHaveBeenCalled();
    await expect(r.reconcile()).rejects.toMatchObject({name:'AbortError'});
  });
  it('awaits the active tracker write but starts no further write after stop',async()=>{
    const t=tracker();let release!:()=>void;let entered!:()=>void;const started=new Promise<void>(r=>entered=r);
    t.create.mockImplementationOnce(async()=>{entered();await new Promise<void>(r=>release=r);return{};});
    const r=new FeatureRolloutReconciler({tracker:t as never,observeFlag:()=>({}),listSpecArtifacts:()=>[artifact('one'),artifact('two')]});
    const flight=r.reconcile();const rejected=expect(flight).rejects.toMatchObject({name:'AbortError'});await started;
    let stopped=false;const stopping=r.stop().then(()=>{stopped=true;});await Promise.resolve();expect(stopped).toBe(false);
    release();await stopping;await rejected;expect(t.create).toHaveBeenCalledOnce();
  });
  it('yields a real event-loop callback between first and final immediately resolved tracker writes',async()=>{
    const t=tracker();let callbackAt=-1;let writes=0;
    t.create.mockImplementation(async()=>{if(++writes===1)setImmediate(()=>{callbackAt=writes;});return{};});
    const r=new FeatureRolloutReconciler({tracker:t as never,observeFlag:()=>({}),listSpecArtifacts:()=>Array.from({length:300},(_,i)=>artifact(`f-${i}`))});
    await r.reconcile();expect(callbackAt).toBeGreaterThanOrEqual(1);expect(callbackAt).toBeLessThan(300);
  });
});
