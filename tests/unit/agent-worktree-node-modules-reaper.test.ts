/**
 * The root node_modules proof wired through the reaper (spec
 * docs/specs/reaper-node-modules-regenerable.md §2, §4-§6, Testing: classify memo,
 * isCleanExceptRootNodeModules, verdict mapping, dry-run report, widened link check,
 * fresh link check, deep links, post-rename check, crash after rename, time left).
 * Real git worktrees in a temporary agent home whose path contains `/.instar/`,
 * real `npm ci --offline` installs from a LOCAL cache, real reference builds.
 * Process scans are faked (empty) where the deps allow it.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { makeAgentWorktreeReaperDeps, buildInboundLinkIndex, freshLinkInto, classifyIgnoredEntry, type ReadGit, type LinkIndexFailure } from '../../src/monitoring/agentWorktreeGit.js';
import {
  NodeModulesMemo,
  readNpmMajor,
  readReferenceInputs,
  referenceKey,
  restoreNodeModulesResidue,
  casDir,
  type NodeModulesVerdictRecord,
} from '../../src/monitoring/agentWorktreeNodeModules.js';
import { runReferenceBuild, type ReferenceBuildInput } from '../../src/monitoring/agentWorktreeReferenceBuildMain.js';
import { AgentWorktreeReferenceBuilder } from '../../src/monitoring/agentWorktreeReferenceBuilder.js';
import { runAgentWorktreeEvaluation } from '../../src/monitoring/agentWorktreeEvaluationJob.js';
import { runReclaimChild, parseRows, type ReclaimChildInput, type ReclaimChildSeams, type ReclaimRow } from '../../src/monitoring/agentWorktreeReclaimMain.js';
import { makeNpmFixture, type NpmFixture } from '../helpers/npmNodeModulesFixture.js';

const OP = 'tests/unit/agent-worktree-node-modules-reaper.test.ts';
const readGit: ReadGit = (args, cwd) => SafeGitExecutor.readSync(args, {
  cwd, encoding: 'utf-8', timeout: 30_000, operation: OP, sourceTreeReadOk: true, sourceTreeWorktreeManagerOk: true,
});
const PLENTY = () => ({ free: 10 * 1024 ** 4, total: 20 * 1024 ** 4 });

describe('root node_modules proof through the reaper', () => {
  let fxRoot: string;
  let fx: NpmFixture;
  let npmMajor: string;
  let root: string;
  let home: string;
  let worktreesDir: string;
  let stateDir: string;
  let refsDir: string;
  let configPath: string;
  let runN = 0;

  const g = (cwd: string, args: string[]) => SafeGitExecutor.run(args, { cwd, operation: OP });
  const addWorktree = (slug: string, opts: { install?: boolean; dir?: string } = {}): string => {
    const wt = path.join(opts.dir ?? worktreesDir, slug);
    g(home, ['worktree', 'add', '-q', wt, '-b', `b-${slug}`, 'HEAD']);
    if (opts.install !== false) fx.install(wt);
    return wt;
  };
  const deps = (memo?: NodeModulesMemo) => makeAgentWorktreeReaperDeps({
    instarRepo: home, worktreesDir, githubMergeCheck: false, readGit,
    cwdRoots: () => new Set<string>(), commandLines: () => [],
    ...(memo ? { nodeModulesMemo: memo } : {}),
  });
  const buildReference = async (source: string): Promise<void> => {
    const key = referenceKey(readReferenceInputs(source)!, npmMajor);
    const r = await runReferenceBuild({
      buildId: crypto.randomBytes(16).toString('hex'), key, sourceCheckout: source, refsDir, npmMajor,
      npmCacheDir: fx.cacheDir, scratchCeilingBytes: 512 * 1024 * 1024, timeoutMs: 120_000, resultPath: path.join(refsDir, 'results', 'r.json'),
    });
    expect(r.ok, r.error).toBe(true);
  };
  const input = (over: Partial<ReclaimChildInput> = {}): ReclaimChildInput => {
    const runId = (++runN).toString(16).padStart(32, 'a');
    return {
      runId, agentHome: home, projectDir: home, worktreesDir, stateDir, configPath,
      rowsPath: path.join(stateDir, 'runs', `${runId}.jsonl`), reportPath: path.join(stateDir, 'report.json'),
      deadlineAt: Date.now() + 900_000, maxReaps: 20, githubMergeCheck: false, excludedPaths: [],
      nodeModulesStateDir: refsDir, ...over,
    };
  };
  const rows = (inp: ReclaimChildInput): ReclaimRow[] => parseRows(fs.readFileSync(inp.rowsPath, 'utf8'));
  const runChild = (inp: ReclaimChildInput, seams: ReclaimChildSeams = {}) => {
    const memo = new NodeModulesMemo(refsDir);
    return runReclaimChild(inp, { deps: deps(memo), nodeModulesMemo: memo, npmMajor, volume: PLENTY, commandOf: async () => '', ...seams });
  };
  const listed = (): string => g(home, ['worktree', 'list', '--porcelain']);

  beforeAll(() => {
    fxRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-reaper-fx-')));
    fx = makeNpmFixture(fxRoot);
    npmMajor = readNpmMajor('npm', fxRoot)!;
  }, 120_000);
  afterAll(() => { SafeFsExecutor.safeRmSync(fxRoot, { recursive: true, force: true, operation: OP }); });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-reaper-')));
    home = path.join(root, '.instar', 'agents', 'echo');
    fs.mkdirSync(home, { recursive: true });
    process.env.INSTAR_AUDIT_LOG_DIR = path.join(root, 'audit');
    g(home, ['init', '-q', '-b', 'main']);
    g(home, ['config', 'user.email', 't@t.l']);
    g(home, ['config', 'user.name', 'T']);
    g(home, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(home, '.gitignore'), 'node_modules\n.worktrees/\n.instar/\n');
    fx.writeProject(home);
    g(home, ['add', '-A']);
    g(home, ['commit', '-qm', 'init']);
    worktreesDir = path.join(home, '.worktrees');
    fs.mkdirSync(worktreesDir);
    stateDir = path.join(home, '.instar', 'state', 'agent-worktree-reclaim');
    refsDir = path.join(home, '.instar', 'state', 'agent-worktree-node-modules');
    configPath = path.join(home, '.instar', 'config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ monitoring: { agentWorktreeReaper: { enabled: true, dryRun: false } } }));
  });
  afterEach(() => {
    delete process.env.INSTAR_AUDIT_LOG_DIR;
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
  });

  describe('classify memo and the eligibility predicate', () => {
    const record = (wt: string, verdict: NodeModulesVerdictRecord['verdict'], memo: NodeModulesMemo): void => {
      memo.set({ passId: 'p1', checkout: wt, verdict, reason: 'test', checkedAt: Date.now(), residue: [], residueBytes: 0, allocatedBytes: 0, rootSig: '' }, null);
    };

    it('with no memo a real node_modules is work; with one it is the memoized verdict; a changed stamp invalidates it', async () => {
      const wt = addWorktree('memo');
      expect(classifyIgnoredEntry('node_modules/', wt, readGit)).toBe('work');
      const memo = new NodeModulesMemo(null);
      memo.beginPass('p1');
      const { rootSignature } = await import('../../src/monitoring/agentWorktreeNodeModules.js');
      memo.set({ passId: 'p1', checkout: wt, verdict: 'node-modules-residue', reason: 'ok', checkedAt: 1, residue: [], residueBytes: 0, allocatedBytes: 0, rootSig: rootSignature(wt) }, {});
      expect(classifyIgnoredEntry('node_modules/', wt, readGit, memo)).toBe('node-modules-residue');
      // a deeper node_modules is never read from the memo
      expect(classifyIgnoredEntry('pkg/node_modules/', wt, readGit, memo)).toBe('work');
      fs.appendFileSync(path.join(wt, 'node_modules', '.package-lock.json'), ' ');
      expect(classifyIgnoredEntry('node_modules/', wt, readGit, memo)).toBe('work');
      // another pass's memo is never used
      memo.beginPass('p2');
      expect(classifyIgnoredEntry('node_modules/', wt, readGit, memo)).toBe('work');
    });

    it('isCleanExceptRootNodeModules skips only the real root node_modules; anything else untracked keeps the checkout', () => {
      const wt = addWorktree('pred');
      const d = deps();
      expect(d.isClean(wt)).toBe(false);
      expect(d.isCleanExceptRootNodeModules(wt)).toBe(true);
      fs.writeFileSync(path.join(wt, 'notes.txt'), 'mine');
      expect(d.isCleanExceptRootNodeModules(wt)).toBe(false);
      const wt2 = addWorktree('pred2');
      fs.mkdirSync(path.join(wt2, 'sub', 'node_modules'), { recursive: true });
      fs.writeFileSync(path.join(wt2, 'sub', 'node_modules', 'x.js'), 'x');
      expect(d.isCleanExceptRootNodeModules(wt2)).toBe(false);
    });

    it('verdict mapping: only node-modules-residue passes isClean; unchecked, reference-unavailable and residue-over-floor keep the checkout', () => {
      const wt = addWorktree('map');
      for (const v of ['unchecked', 'reference-unavailable', 'residue-over-floor', 'work'] as const) {
        const memo = new NodeModulesMemo(null); memo.beginPass('p1');
        record(wt, v, memo);
        expect(deps(memo).isClean(wt), v).toBe(false);
      }
    });
  });

  describe('the dry-run report', () => {
    const builder = () => new AgentWorktreeReferenceBuilder(
      { refsDir, agentHome: home, mainScript: '/unused.js', nodePath: process.execPath, npmCacheDir: fx.cacheDir },
      {
        spawnChild: (args, _cwd, onExit) => {
          const inp = JSON.parse(args[args.indexOf('--input-json') + 1]) as ReferenceBuildInput;
          void runReferenceBuild({ ...inp, npmCacheDir: fx.cacheDir }).then((r) => {
            fs.mkdirSync(path.dirname(inp.resultPath), { recursive: true });
            fs.writeFileSync(inp.resultPath, JSON.stringify(r));
            onExit();
          });
          return { pid: 4242 };
        },
        killGroup: () => {},
        freeBytes: async () => 10 * 1024 ** 4,
        now: () => Date.now(),
        setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; },
      },
    );
    const evaluate = (over: { maxHashesPerPass?: number } = {}) => runAgentWorktreeEvaluation({
      instarRepo: home, worktreesDir, githubMergeCheck: false, nodeModulesStateDir: refsDir, npmMajor, ...over,
    });
    const waitIdle = async (b: AgentWorktreeReferenceBuilder) => { for (let i = 0; i < 2400 && b.status().running; i++) await new Promise((r) => setTimeout(r, 50)); };

    it('first pass: unchecked and one build starts; a later pass reports the verdict and the checkout becomes eligible', async () => {
      const wt = addWorktree('first');
      const p1 = await evaluate();
      if (!p1.ok) throw new Error(p1.error);
      const w1 = p1.worktrees.find((w) => w.path === wt)!;
      expect(w1.verdict).toBe('keep');
      expect(w1.nodeModulesCheck).toMatchObject({ verdict: 'unchecked', reason: 'reference-pending' });
      expect(p1.nodeModules!.needed).toHaveLength(1);
      const b = builder();
      expect(await b.afterPass(p1.nodeModules!, { reclaimRunActive: false })).toMatchObject({ started: true });
      // at most one build per pass: a second call while it runs starts nothing
      expect(await b.afterPass(p1.nodeModules!, { reclaimRunActive: false })).toMatchObject({ started: false, reason: 'build-running' });
      await waitIdle(b);
      expect(b.status().lastOutcome).toMatchObject({ ok: true });
      const p2 = await evaluate();
      if (!p2.ok) throw new Error(p2.error);
      const w2 = p2.worktrees.find((w) => w.path === wt)!;
      expect(w2.nodeModulesCheck).toMatchObject({ verdict: 'node-modules-residue' });
      expect(w2.verdict).toBe('reap-eligible');
      expect(w2.projection?.residueBytes).toBeGreaterThan(0);
      expect(p2.nodeModules!.manifests.count).toBe(1);
      expect(p2.nodeModules!.manifests.bytes).toBeGreaterThan(0);
    }, 120_000);

    it('checkouts rotate, oldest-checked first, at most maxHashesPerPass each pass', async () => {
      const a = addWorktree('rot-a');
      const b = addWorktree('rot-b');
      await buildReference(a);
      const v = async () => { const r = await evaluate({ maxHashesPerPass: 1 }); if (!r.ok) throw new Error(r.error); return r.nodeModules!.checks; };
      const c1 = await v();
      expect([c1[a].verdict, c1[b].verdict].sort()).toEqual(['node-modules-residue', 'unchecked']);
      const first = c1[a].verdict === 'node-modules-residue' ? a : b;
      const second = first === a ? b : a;
      expect(c1[second].reason).toBe('rotation');
      const c2 = await v();
      expect(c2[second].verdict).toBe('node-modules-residue');
      expect(c2[first]).toMatchObject({ verdict: 'unchecked', reason: 'rotation' });
    }, 120_000);

    it('a reference is built only for an otherwise-eligible checkout', async () => {
      const wt = addWorktree('dirty');
      fs.writeFileSync(path.join(wt, 'notes.txt'), 'mine');
      const p = await evaluate();
      if (!p.ok) throw new Error(p.error);
      expect(p.nodeModules!.needed).toEqual([]);
      expect(p.nodeModules!.keysInUse).toHaveLength(1);
      expect(p.worktrees.find((w) => w.path === wt)).toMatchObject({ verdict: 'keep', reason: 'uncommitted-changes' });
      expect(p.worktrees.find((w) => w.path === wt)!.nodeModulesCheck).toBeUndefined();
    }, 60_000);
  });

  describe('links', () => {
    it('a checkout registered with git outside .worktrees, whose node_modules links into a candidate, makes the candidate in-use', async () => {
      const cand = addWorktree('cand');
      const outside = addWorktree('outside', { install: false, dir: path.join(home, '.instar', 'worktrees') });
      fs.symlinkSync(path.join(cand, 'node_modules'), path.join(outside, 'node_modules'));
      const d = makeAgentWorktreeReaperDeps({ instarRepo: home, worktreesDir, githubMergeCheck: false, readGit, cwdRoots: () => new Set(), commandLines: () => [] });
      await d.preparePass!();
      expect(d.isInUse(cand)).toBe(true);
      expect(d.linkIndexStatus()).toBe('ok');
      // a link from outside every root and walked folder is NOT found (accepted, stated residual)
      const cand2 = addWorktree('cand2');
      fs.symlinkSync(path.join(cand2, 'node_modules'), path.join(root, 'stray-fixture-link'));
      await d.preparePass!();
      expect(d.isInUse(cand2)).toBe(false);
    }, 60_000);

    it('an index that times out keeps everything and is reported as link-index-timeout', async () => {
      const cand = addWorktree('t', { install: false });
      let failure: LinkIndexFailure | null = null;
      expect(await buildInboundLinkIndex(home, worktreesDir, { timeoutMs: -1, onFailure: (r) => { failure = r; } })).toBeNull();
      expect(failure).toBe('link-index-timeout');
      const d = makeAgentWorktreeReaperDeps({ instarRepo: home, worktreesDir, githubMergeCheck: false, readGit, cwdRoots: () => new Set(), commandLines: () => [], inboundLinks: async () => null });
      await d.preparePass!();
      expect(d.isInUse(cand)).toBe(true);
    });

    it('fresh link check: a root node_modules link into the candidate created after the index keeps it', async () => {
      const cand = addWorktree('fresh');
      const later = addWorktree('later', { install: false, dir: path.join(home, '.instar', 'worktrees') });
      const opts = { agentHome: home, worktreesDir, worktreeRoots: [cand, later], deepLinks: [] as string[] };
      expect(await freshLinkInto(cand, opts)).toBeNull();
      fs.symlinkSync(path.join(cand, 'node_modules'), path.join(later, 'node_modules'));
      expect(await freshLinkInto(cand, opts)).toBe(path.join(later, 'node_modules'));
    }, 60_000);

    it('deep links: a link recorded under .instar/lanes whose target changed to the candidate keeps it', async () => {
      const cand = addWorktree('deep');
      const laneNm = path.join(home, '.instar', 'lanes', 'l1', 'pkg', 'node_modules');
      fs.mkdirSync(path.dirname(laneNm), { recursive: true });
      fs.symlinkSync(path.join(root, 'elsewhere'), laneNm);
      const idx = await buildInboundLinkIndex(home, worktreesDir);
      expect(idx!.deepLinks).toContain(laneNm);
      expect(idx!.linked.has(cand)).toBe(false);
      SafeFsExecutor.safeUnlinkSync(laneNm, { operation: OP });
      fs.symlinkSync(path.join(cand, 'node_modules'), laneNm);
      expect(await freshLinkInto(cand, { agentHome: home, worktreesDir, worktreeRoots: [cand], deepLinks: idx!.deepLinks })).toBe(laneNm);
    }, 60_000);
  });

  describe('live removal of a proven checkout (the reclaim child)', () => {
    it('removes it in order, with the residue in the store, a verified row before prune, and the freed bytes recorded', async () => {
      const wt = addWorktree('live');
      await buildReference(wt);
      const inp = input();
      const res = await runChild(inp);
      expect(res.errors).toEqual([]);
      expect(res.removed).toEqual([wt]);
      const ts = rows(inp).map((r) => r.t);
      expect(ts).toEqual(['lock', 'attempt', 'archived', 'renaming', 'renamed', 'verified', 'trash-done', 'removed', 'done']);
      const archived = rows(inp).find((r) => r.t === 'archived')!;
      expect(archived.nodeModulesResidueSha256).toMatch(/^[0-9a-f]{64}$/);
      const removed = rows(inp).find((r) => r.t === 'removed')!;
      expect(removed.allocatedBytes).toBeGreaterThan(0);
      expect(removed.freeDeltaIsEstimate).toBe(true);
      expect(fs.existsSync(wt)).toBe(false);
      expect(listed()).not.toContain(wt);
      // The residue restores from the store onto a fresh install.
      const fresh = path.join(root, 'fresh');
      fx.writeProject(fresh); fx.install(fresh);
      restoreNodeModulesResidue(String(archived.nodeModulesResidueManifest), path.join(home, '.instar', 'instar-dev-decisions-archive'), fresh);
      expect(fs.existsSync(path.join(fresh, 'node_modules/fixscript/build/native.o'))).toBe(true);
      const report = JSON.parse(fs.readFileSync(inp.reportPath, 'utf8'));
      expect(report.nodeModules.checks[wt].verdict).toBe('node-modules-residue');
    }, 120_000);

    it('a hand-edited file inside node_modules keeps the checkout', async () => {
      const wt = addWorktree('edited');
      await buildReference(wt);
      fs.appendFileSync(path.join(wt, 'node_modules/fixplain/lib/util.js'), '// debug\n');
      const res = await runChild(input());
      expect(res.removed).toEqual([]);
      expect(fs.existsSync(path.join(wt, 'node_modules/fixplain/lib/util.js'))).toBe(true);
    }, 120_000);

    it('a change after the pre-rename re-stat renames the folder back and keeps it, registration intact', async () => {
      const wt = addWorktree('late');
      await buildReference(wt);
      const inp = input();
      const res = await runChild(inp, { afterRow: (r) => { if (r.t === 'renaming') fs.appendFileSync(path.join(wt, 'node_modules/fixplain/index.js'), '//x\n'); } });
      expect(res.removed).toEqual([]);
      expect(res.kept).toEqual([{ path: wt, reason: 'changed-during-removal' }]);
      expect(rows(inp).map((r) => r.t)).toContain('restored');
      expect(rows(inp).map((r) => r.t)).not.toContain('verified');
      expect(fs.readFileSync(path.join(wt, 'node_modules/fixplain/index.js'), 'utf8')).toContain('//x');
      expect(listed()).toContain(wt);
      expect(fs.readdirSync(path.join(worktreesDir, '.trash'))).toEqual([]);
    }, 120_000);

    it('when the original path is taken the folder is trash-held and never deleted, also by later runs', async () => {
      const wt = addWorktree('taken');
      await buildReference(wt);
      const inp = input();
      let trash = '';
      const res = await runChild(inp, {
        afterRow: (r) => {
          if (r.t === 'renaming') trash = String(r.trash);
          if (r.t === 'renamed') { fs.appendFileSync(path.join(trash, 'node_modules/fixplain/index.js'), '//x\n'); fs.mkdirSync(wt); }
        },
      });
      expect(res.kept).toEqual([{ path: wt, reason: 'trash-held' }]);
      expect(fs.existsSync(trash)).toBe(true);
      const again = await runChild(input());
      expect(again.trash.held?.map((h) => h.name)).toEqual([path.basename(trash)]);
      expect(again.trash.deleted).toEqual([]);
      expect(fs.existsSync(path.join(trash, 'node_modules/fixplain/index.js'))).toBe(true);
    }, 120_000);

    it('crash after the rename (before and after the renamed row) with a late edit: the next run finds no verified, re-stats and renames back; nothing is deleted', async () => {
      for (const when of ['before-renamed', 'after-renamed'] as const) {
        const wt = addWorktree(`crash-${when}`);
        await buildReference(wt);
        const memo = new NodeModulesMemo(refsDir);
        const inp = input();
        await runReclaimChild(inp, {
          deps: deps(memo), nodeModulesMemo: memo, npmMajor, volume: PLENTY, commandOf: async () => '',
          afterRow: (r) => {
            if (when === 'before-renamed' && r.t === 'renaming') {
              // the rename happened; the kill comes before the `renamed` row
              fs.renameSync(wt, String(r.trash));
              fs.appendFileSync(path.join(String(r.trash), 'node_modules/fixplain/index.js'), '//late\n');
              throw new Error('simulated kill');
            }
            if (when === 'after-renamed' && r.t === 'renamed') {
              fs.appendFileSync(path.join(String(rows(inp).find((x) => x.t === 'renaming')!.trash), 'node_modules/fixplain/index.js'), '//late\n');
              throw new Error('simulated kill');
            }
          },
        });
        expect(fs.existsSync(wt), when).toBe(false);
        const next = input();
        const res = await runChild(next);
        expect(res.trash.deleted, when).toEqual([]);
        expect(rows(next).some((r) => r.t === 'restored'), when).toBe(true);
        expect(fs.readFileSync(path.join(wt, 'node_modules/fixplain/index.js'), 'utf8'), when).toContain('//late');
      }
    }, 240_000);

    it('crash right after the rename with no edit: the next run verifies, deletes the trash, and the residue still restores from the store', async () => {
      const wt = addWorktree('crash-clean');
      await buildReference(wt);
      const memo = new NodeModulesMemo(refsDir);
      const inp = input();
      await runReclaimChild(inp, {
        deps: deps(memo), nodeModulesMemo: memo, npmMajor, volume: PLENTY, commandOf: async () => '',
        afterRow: (r) => { if (r.t === 'renamed') throw new Error('simulated kill'); },
      });
      const archived = rows(inp).find((r) => r.t === 'archived')!;
      // durable before any rename: the archived row precedes the renaming row
      const order = rows(inp).map((r) => r.t);
      expect(order.indexOf('archived')).toBeLessThan(order.indexOf('renaming'));
      const next = input();
      const res = await runChild(next);
      expect(rows(next).find((r) => r.t === 'verified')).toMatchObject({ recovered: true });
      expect(res.trash.deleted).toHaveLength(1);
      const fresh = path.join(root, 'fresh');
      fx.writeProject(fresh); fx.install(fresh);
      const archive = path.join(home, '.instar', 'instar-dev-decisions-archive');
      expect(fs.readdirSync(casDir(archive)).length).toBeGreaterThan(0);
      restoreNodeModulesResidue(String(archived.nodeModulesResidueManifest), archive, fresh);
      expect(fs.existsSync(path.join(fresh, 'node_modules/fixscript/build/native.o'))).toBe(true);
    }, 120_000);

    it('time left per kind: with less than the node_modules allowance left, a node_modules checkout is not attempted while a symlinked one is', async () => {
      const nm = addWorktree('tl-nm');
      await buildReference(nm);
      const plain = addWorktree('tl-plain', { install: false }); // no node_modules: the 15 s allowance
      const inp = input({ deadlineAt: Date.now() + 40_000 });
      const res = await runChild(inp);
      expect(res.removed).toEqual([plain]);
      const report = JSON.parse(fs.readFileSync(inp.reportPath, 'utf8'));
      expect(report.worktrees.find((w: { path: string }) => w.path === nm)).toMatchObject({ outcome: 'not-attempted', outcomeReason: 'time-left' });
    }, 120_000);

    it('the restore direction of the guard allows only the recorded original path', () => {
      const trashRoot = path.join(worktreesDir, '.trash');
      fs.mkdirSync(path.join(trashRoot, 'a1'), { recursive: true });
      const original = path.join(worktreesDir, 'orig');
      const scope = { worktreesDir, trashRoot, restoreTo: original };
      expect(() => SafeFsExecutor.safeRestoreDirSync(path.join(trashRoot, 'a1'), path.join(worktreesDir, 'other'), { operation: OP, worktreeTrashScope: scope })).toThrow(/recorded original path/);
      expect(() => SafeFsExecutor.safeRestoreDirSync(path.join(trashRoot, 'a1'), path.join(home, 'orig'), { operation: OP, worktreeTrashScope: { ...scope, restoreTo: path.join(home, 'orig') } })).toThrow(/direct child of the worktrees folder/);
      fs.mkdirSync(original);
      expect(() => SafeFsExecutor.safeRestoreDirSync(path.join(trashRoot, 'a1'), original, { operation: OP, worktreeTrashScope: scope })).toThrow(/already exists/);
      SafeFsExecutor.safeRmdirSync(original, { operation: OP });
      expect(() => SafeFsExecutor.safeRestoreDirSync(path.join(trashRoot, 'a1'), original, { operation: OP, worktreeTrashScope: { worktreesDir, trashRoot } })).toThrow(/restoreTo/);
      SafeFsExecutor.safeRestoreDirSync(path.join(trashRoot, 'a1'), original, { operation: OP, worktreeTrashScope: scope });
      expect(fs.existsSync(original)).toBe(true);
    });
  });
});
