/**
 * The root node_modules proof, end to end (docs/specs/reaper-node-modules-regenerable.md,
 * Testing → Integration): a throwaway agent home with real git worktrees, each
 * installed by `npm ci` (install scripts run) from a LOCAL npm cache of tiny
 * fixture packages; the dry-run evaluation; the COMPILED reference builder child
 * started by the real supervisor (`nice`, detached group); then the COMPILED
 * reclaim child started by the real runner with removal live in the throwaway's
 * own config only.
 *
 * Checks that the clean worktree is reclaimed, that its script residue is in the
 * content-addressed store and verifies by hash, that the bytes freed are recorded,
 * and that a hand-edited file inside node_modules keeps its worktree.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { AgentWorktreeReclaimRunner } from '../../src/monitoring/agentWorktreeReclaimRunner.js';
import { AgentWorktreeReferenceBuilder } from '../../src/monitoring/agentWorktreeReferenceBuilder.js';
import { runAgentWorktreeEvaluation } from '../../src/monitoring/agentWorktreeEvaluationJob.js';
import { parseRows, type ReclaimRow } from '../../src/monitoring/agentWorktreeReclaimMain.js';
import { casDir, listManifests, readNpmMajor } from '../../src/monitoring/agentWorktreeNodeModules.js';
import { makeNpmFixture, type NpmFixture } from '../helpers/npmNodeModulesFixture.js';

const OP = 'tests/integration/agent-worktree-node-modules-live.test.ts';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const RECLAIM_CHILD = path.join(ROOT, 'dist', 'monitoring', 'agentWorktreeReclaimMain.js');
const BUILD_CHILD = path.join(ROOT, 'dist', 'monitoring', 'agentWorktreeReferenceBuildMain.js');

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('root node_modules proof, live, through the compiled children', () => {
  let root: string;
  let fx: NpmFixture;
  let home: string;
  let worktreesDir: string;
  let stateDir: string;
  let refsDir: string;
  let configPath: string;
  const savedEnv: Record<string, string | undefined> = {};
  const g = (cwd: string, args: string[]) => SafeGitExecutor.run(args, { cwd, operation: OP });

  beforeAll(() => {
    for (const k of ['INSTAR_AUDIT_LOG_DIR', 'INSTAR_AUDIT_LOG_DISABLED']) savedEnv[k] = process.env[k];
    delete process.env.INSTAR_AUDIT_LOG_DIR;
    delete process.env.INSTAR_AUDIT_LOG_DISABLED;
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-live-')));
    fx = makeNpmFixture(path.join(root, 'fixture'));
    home = path.join(root, '.instar', 'agents', 'throwaway');
    fs.mkdirSync(path.join(home, '.instar'), { recursive: true });
    g(home, ['init', '-q', '-b', 'main']);
    g(home, ['config', 'user.email', 't@t.l']);
    g(home, ['config', 'user.name', 'T']);
    g(home, ['config', 'commit.gpgsign', 'false']);
    fs.writeFileSync(path.join(home, '.gitignore'), 'node_modules\n.worktrees/\n.instar/audit/\n.instar/state/\n.instar/config.json\n.instar/instar-dev-decisions-archive/\n');
    fs.writeFileSync(path.join(home, '.instar', 'README.md'), 'state\n');
    fx.writeProject(home);
    g(home, ['add', '-A']);
    g(home, ['commit', '-qm', 'init']);
    worktreesDir = path.join(home, '.worktrees');
    fs.mkdirSync(worktreesDir);
    stateDir = path.join(home, '.instar', 'state', 'agent-worktree-reclaim');
    refsDir = path.join(home, '.instar', 'state', 'agent-worktree-node-modules');
    configPath = path.join(home, '.instar', 'config.json');
    fs.writeFileSync(configPath, JSON.stringify({ monitoring: { agentWorktreeReaper: { enabled: true, dryRun: true } } }));
  }, 120_000);
  afterAll(() => {
    for (const [k, v] of Object.entries(savedEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
  });

  it('the compiled children exist (built by the lane globalSetup)', () => {
    expect(fs.existsSync(RECLAIM_CHILD)).toBe(true);
    expect(fs.existsSync(BUILD_CHILD)).toBe(true);
  });

  it('reclaims a proven worktree with its residue archived and verified, records the bytes freed, and keeps a hand-edited one', async () => {
    const clean = path.join(worktreesDir, 'clean');
    const edited = path.join(worktreesDir, 'edited');
    for (const wt of [clean, edited]) {
      g(home, ['worktree', 'add', '-q', wt, '-b', `b-${path.basename(wt)}`, 'HEAD']);
      fx.install(wt);
    }
    const npmMajor = readNpmMajor('npm', root);
    expect(npmMajor).toMatch(/^\d+$/);

    // 1. A dry-run pass: both read `unchecked`, one reference is needed.
    const p1 = await runAgentWorktreeEvaluation({ instarRepo: home, worktreesDir, githubMergeCheck: false, nodeModulesStateDir: refsDir });
    if (!p1.ok) throw new Error(p1.error);
    expect(p1.nodeModules!.checks[clean]).toMatchObject({ verdict: 'unchecked' });
    expect(p1.nodeModules!.needed).toHaveLength(1);

    // 2. The real supervisor starts the compiled builder child (niced, own group).
    const builder = new AgentWorktreeReferenceBuilder({ refsDir, agentHome: home, mainScript: BUILD_CHILD, nodePath: process.execPath, npmCacheDir: fx.cacheDir });
    expect(await builder.afterPass(p1.nodeModules!, { reclaimRunActive: false })).toMatchObject({ started: true });
    for (let i = 0; i < 1200 && builder.status().running; i++) await sleep(100);
    await sleep(200);
    expect(builder.status().lastOutcome, JSON.stringify(builder.status())).toMatchObject({ ok: true });
    expect(listManifests(refsDir)).toHaveLength(1);
    expect(fs.existsSync(path.join(refsDir, 'scratch'))).toBe(false);

    // 3. A hand edit inside one worktree's node_modules, then live removal on the throwaway only.
    fs.appendFileSync(path.join(edited, 'node_modules', 'fixplain', 'lib', 'util.js'), '// hand edit\n');
    fs.writeFileSync(configPath, JSON.stringify({ monitoring: { agentWorktreeReaper: { enabled: true, dryRun: false } } }));
    const runner = new AgentWorktreeReclaimRunner({
      stateDir, processName: 'agentWorktreeReclaimMain', mainScript: RECLAIM_CHILD, nodePath: process.execPath,
      agentHome: home, projectDir: home, worktreesDir, configPath, nodeModulesStateDir: refsDir,
      githubMergeCheck: () => false, maxReaps: () => 20, pollMs: 100, killGraceMs: 1_000,
    });
    const started = await runner.startRun({ excludedPaths: [] });
    if (!started.started) throw new Error(`run not started: ${started.reason}`);
    await Promise.race([started.done, sleep(300_000)]);
    const rows: ReclaimRow[] = parseRows(fs.readFileSync(path.join(stateDir, 'runs', `${started.runId}.jsonl`), 'utf8'));

    // The proven worktree is reclaimed, in order, with a verified row before prune.
    expect(fs.existsSync(clean), JSON.stringify(rows.filter((r) => r.t === 'error' || r.t === 'kept'))).toBe(false);
    const ts = rows.map((r) => r.t);
    expect(ts.indexOf('archived')).toBeLessThan(ts.indexOf('renaming'));
    expect(ts.indexOf('renamed')).toBeLessThan(ts.indexOf('verified'));
    expect(ts.indexOf('verified')).toBeLessThan(ts.indexOf('removed'));
    expect(g(home, ['worktree', 'list', '--porcelain'])).not.toContain(`worktree ${clean}`);

    // Its script residue is in the store and verifies by hash.
    const archived = rows.find((r) => r.t === 'archived' && typeof r.nodeModulesResidueManifest === 'string')!;
    const residue = JSON.parse(fs.readFileSync(String(archived.nodeModulesResidueManifest), 'utf8')) as { entries: Array<{ path: string; type: string; sha256?: string }> };
    expect(crypto.createHash('sha256').update(fs.readFileSync(String(archived.nodeModulesResidueManifest))).digest('hex')).toBe(archived.nodeModulesResidueSha256);
    const files = residue.entries.filter((e) => e.type === 'file');
    expect(files.map((e) => e.path)).toEqual(expect.arrayContaining(['node_modules/.package-lock.json', 'node_modules/fixscript/build/native.o']));
    const cas = casDir(path.join(home, '.instar', 'instar-dev-decisions-archive'));
    for (const f of files) {
      expect(crypto.createHash('sha256').update(fs.readFileSync(path.join(cas, f.sha256!))).digest('hex')).toBe(f.sha256);
    }

    // The bytes freed are recorded (the free-space change is labelled an estimate).
    const removed = rows.find((r) => r.t === 'removed')!;
    expect(removed.allocatedBytes).toBeGreaterThan(0);
    expect(removed.freeDeltaIsEstimate).toBe(true);
    expect(typeof removed.freeDeltaBytes === 'number' || removed.freeDeltaBytes === null).toBe(true);

    // The hand-edited worktree is kept, with its edit.
    expect(fs.readFileSync(path.join(edited, 'node_modules', 'fixplain', 'lib', 'util.js'), 'utf8')).toContain('// hand edit');
    expect(g(home, ['worktree', 'list', '--porcelain'])).toContain(`worktree ${edited}`);
    const report = JSON.parse(fs.readFileSync(path.join(stateDir, 'report.json'), 'utf8'));
    expect(report.nodeModules.checks[edited]).toMatchObject({ verdict: 'work' });
    expect(report.nodeModules.checks[clean]).toMatchObject({ verdict: 'node-modules-residue' });
  }, 600_000);
});
