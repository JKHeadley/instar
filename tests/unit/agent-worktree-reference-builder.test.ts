/**
 * The reference builder (spec docs/specs/reaper-node-modules-regenerable.md §1, §3,
 * Testing: reference builder, pinned sources' inner install). The build child runs
 * the REAL npm offline against a LOCAL cache; wrappers around npm record what the
 * scratch folder held and what environment npm saw. The supervisor runs with fake
 * process seams.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import {
  readNpmMajor,
  readReferenceInputs,
  referenceKey,
  readManifest,
  readBuildStatus,
  runNodeModulesPass,
  NodeModulesMemo,
  type NodeModulesPassSummary,
} from '../../src/monitoring/agentWorktreeNodeModules.js';
import { runReferenceBuild, stripScripts, scratchRoot, type ReferenceBuildInput } from '../../src/monitoring/agentWorktreeReferenceBuildMain.js';
import { AgentWorktreeReferenceBuilder, nextBuildAttemptAt, planManifests, chooseBuildKey, REFERENCE_BUILD_DEFAULTS, type ReferenceBuilderSeams } from '../../src/monitoring/agentWorktreeReferenceBuilder.js';
import { makeNpmFixture, type NpmFixture } from '../helpers/npmNodeModulesFixture.js';

const OP = 'tests/unit/agent-worktree-reference-builder.test.ts';
const DAY = 86_400_000;

describe('reference builder', () => {
  let root: string;
  let fx: NpmFixture;
  let npmMajor: string;
  let source: string;
  let key: string;
  let refsDir: string;
  let n = 0;

  const wrapper = (name: string, body: string): string => {
    const f = path.join(root, 'bin', name);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(f, 0o755);
    return f;
  };
  const build = (over: Partial<ReferenceBuildInput> = {}) => runReferenceBuild({
    buildId: crypto.randomBytes(16).toString('hex'), key, sourceCheckout: source, refsDir, npmMajor,
    npmCacheDir: fx.cacheDir, scratchCeilingBytes: 512 * 1024 * 1024, timeoutMs: 120_000,
    resultPath: path.join(refsDir, 'results', `${++n}.json`), ...over,
  });

  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'nm-builder-')));
    fx = makeNpmFixture(root);
    npmMajor = readNpmMajor('npm', root)!;
    source = path.join(root, 'source');
    fx.writeProject(source, { rootPostinstallMarker: 'ROOT_MARKER' });
    fx.install(source);
    key = referenceKey(readReferenceInputs(source)!, npmMajor);
  }, 120_000);
  afterAll(() => { SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP }); });
  beforeEach(() => { refsDir = path.join(root, `refs-${++n}`); });

  describe('the build child', () => {
    it('runs with --ignore-scripts and a scratch package.json without scripts: neither the package nor the root postinstall marker is written', async () => {
      const log = path.join(root, `scratch-${n}.log`);
      const npm = wrapper(`npm-record-${n}`, `npm "$@"; rc=$?; { echo "ARGS $*"; find . -name ROOT_MARKER -o -name native.o; cat package.json; } > "${log}"; exit $rc`);
      const r = await build({ npmPath: npm });
      expect(r.ok, r.error).toBe(true);
      const seen = fs.readFileSync(log, 'utf8');
      expect(seen).toContain('ARGS ci --ignore-scripts --offline --no-audit --no-fund');
      expect(seen).not.toContain('ROOT_MARKER');
      expect(seen).not.toContain('native.o');
      expect(seen).not.toContain('"scripts"');
      expect(stripScripts(Buffer.from(JSON.stringify({ name: 'x', scripts: { postinstall: 'evil' } })))).not.toContain('scripts');
      // the session's own install DID run them (the residue the proof archives)
      expect(fs.existsSync(path.join(source, 'ROOT_MARKER'))).toBe(true);
    }, 120_000);

    it('the manifest is written atomically, keyed with npm\'s major, and scratch is gone afterwards', async () => {
      const r = await build();
      expect(r.ok).toBe(true);
      expect(key).toMatch(new RegExp(`-npm${npmMajor}$`));
      expect(referenceKey(readReferenceInputs(source)!, String(Number(npmMajor) + 1))).not.toBe(key);
      const m = readManifest(refsDir, key)!;
      expect(m.npmMajor).toBe(npmMajor);
      expect(Object.keys(m.files)).toContain('node_modules/fixplain/index.js');
      expect(fs.readdirSync(path.join(refsDir, 'manifests')).filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(fs.existsSync(scratchRoot(refsDir))).toBe(false);
      expect(r.scratchHighWaterBytes).toBeGreaterThan(0);
    }, 120_000);

    it('the inner install inherits npm_config_ignore_scripts and npm_config_offline: a git-dependency-style prepare/postinstall writes no marker', async () => {
      // pacote packs a git dependency with install-type scripts by running an inner
      // `npm install --force` whose flags carry --offline but not --ignore-scripts.
      // This wrapper runs exactly that inner install in a package whose prepare and
      // postinstall would each write a marker, with the environment the build gave npm.
      const gitDep = path.join(root, `gitdep-${n}`);
      fs.mkdirSync(gitDep, { recursive: true });
      fs.writeFileSync(path.join(gitDep, 'package.json'), JSON.stringify({ name: 'gitdep', version: '1.0.0', scripts: {
        prepare: "node -e \"require('fs').writeFileSync('PREPARE_MARKER','x')\"",
        postinstall: "node -e \"require('fs').writeFileSync('POSTINSTALL_MARKER','x')\"",
      } }));
      const envLog = path.join(root, `env-${n}.log`);
      const npm = wrapper(`npm-inner-${n}`, `env | grep -E '^npm_config_(ignore_scripts|offline)=' > "${envLog}"; (cd "${gitDep}" && npm install --force --cache="${fx.cacheDir}" --prefer-offline=false --offline >/dev/null 2>&1); npm "$@"`);
      const r = await build({ npmPath: npm });
      expect(r.ok, r.error).toBe(true);
      const env = fs.readFileSync(envLog, 'utf8');
      expect(env).toContain('npm_config_ignore_scripts=true');
      expect(env).toContain('npm_config_offline=true');
      expect(fs.existsSync(path.join(gitDep, 'PREPARE_MARKER'))).toBe(false);
      expect(fs.existsSync(path.join(gitDep, 'POSTINSTALL_MARKER'))).toBe(false);
      // control: the same inner install WITHOUT the inherited setting does write them
      const ctlEnv = { ...process.env, npm_config_cache: fx.cacheDir };
      delete ctlEnv.npm_config_ignore_scripts;
      execFileSync('npm', ['install', '--force', '--offline'], { cwd: gitDep, env: ctlEnv, stdio: 'pipe' });
      expect(fs.existsSync(path.join(gitDep, 'POSTINSTALL_MARKER'))).toBe(true);
    }, 120_000);

    it('a key failing for missing cache entries fails fast as npm-cache-missing and writes no manifest', async () => {
      const r = await build({ npmCacheDir: path.join(root, `empty-cache-${n}`) });
      expect(r).toMatchObject({ ok: false, cause: 'npm-cache-missing' });
      expect(readManifest(refsDir, key)).toBeNull();
      expect(fs.existsSync(scratchRoot(refsDir))).toBe(false);
    }, 120_000);

    it('aborts past the scratch ceiling and on its timeout, deleting scratch each time; a new build deletes leftover scratch first', async () => {
      const slow = wrapper(`npm-slow-${n}`, 'head -c 200000 /dev/zero > big.bin; sleep 5; exit 0');
      const over = await build({ npmPath: slow, scratchCeilingBytes: 1_000, measureEveryMs: 20 });
      expect(over).toMatchObject({ ok: false, cause: 'scratch-ceiling' });
      expect(fs.existsSync(scratchRoot(refsDir))).toBe(false);
      const hang = wrapper(`npm-hang-${n}`, 'sleep 30');
      const timed = await build({ npmPath: hang, timeoutMs: 300 });
      expect(timed).toMatchObject({ ok: false, cause: 'timeout' });
      expect(fs.existsSync(scratchRoot(refsDir))).toBe(false);
      const leftover = path.join(scratchRoot(refsDir), 'killed-earlier');
      fs.mkdirSync(leftover, { recursive: true });
      fs.writeFileSync(path.join(leftover, 'junk'), 'x');
      expect((await build()).ok).toBe(true);
      expect(fs.existsSync(leftover)).toBe(false);
    }, 120_000);

    it('a git source on an unknown host is unsupported-source and no build (no clone) is attempted', async () => {
      const bad = path.join(root, `bad-${n}`);
      fs.mkdirSync(path.join(bad, 'node_modules', 'dep'), { recursive: true });
      fs.writeFileSync(path.join(bad, 'package.json'), '{"name":"bad","version":"0.0.0"}');
      fs.writeFileSync(path.join(bad, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: { '': {}, 'node_modules/dep': { version: '1.0.0', resolved: 'git+ssh://git@gitlab.example.com/o/dep.git#' + 'a'.repeat(40) } } }));
      const log = path.join(root, `never-${n}.log`);
      const npm = wrapper(`npm-never-${n}`, `echo ran > "${log}"; exit 1`);
      const r = await build({ sourceCheckout: bad, key: referenceKey(readReferenceInputs(bad)!, npmMajor), npmPath: npm });
      expect(r).toMatchObject({ ok: false, cause: 'unsupported-source' });
      expect(fs.existsSync(log)).toBe(false);
    });
  });

  describe('retries and the cap (pure rules)', () => {
    it('a cache miss retries daily; other failures back off 1, 2 and 4 days, then weekly', () => {
      let st = nextBuildAttemptAt(undefined, 'npm-cache-missing', 0);
      for (let i = 0; i < 5; i++) { expect(st.nextAt - st.lastAt).toBe(DAY); st = nextBuildAttemptAt(st, 'npm-cache-missing', st.nextAt); }
      let e = nextBuildAttemptAt(undefined, 'build-error', 0);
      const gaps: number[] = [];
      for (let i = 0; i < 5; i++) { gaps.push((e.nextAt - e.lastAt) / DAY); e = nextBuildAttemptAt(e, 'timeout', e.nextAt); }
      expect(gaps).toEqual([1, 2, 4, 7, 7]);
    });

    it('an input change (a new key) is built at once while the old key backs off', () => {
      const status = { keys: { ['a'.repeat(64) + '-npm11']: nextBuildAttemptAt(undefined, 'build-error', 1_000) }, scratchHighWaterBytes: 0 };
      const needed = [{ key: 'a'.repeat(64) + '-npm11', sourceCheckout: '/x' }];
      expect(chooseBuildKey(needed, status, new Set(), 2_000)).toBeNull();
      expect(chooseBuildKey([...needed, { key: 'b'.repeat(64) + '-npm11', sourceCheckout: '/y' }], status, new Set(), 2_000)?.key).toBe('b'.repeat(64) + '-npm11');
      expect(chooseBuildKey(needed, status, new Set(), 1_000 + DAY)?.key).toBe(needed[0].key);
    });

    it('unneeded manifests and ones unused for 14 days are deleted; at the cap the LRU unneeded one is evicted; all needed ⇒ no build', () => {
      const now = 100 * DAY;
      const k = (i: number) => `${String(i).padStart(64, '0')}-npm11`;
      const plan1 = planManifests([{ key: k(1), lastUsedAt: now }, { key: k(2), lastUsedAt: now - 15 * DAY }, { key: k(3), lastUsedAt: now }], { keysInUse: [k(2), k(3)], eligibleKeys: [] }, { now, maxManifests: 30, retentionMs: 14 * DAY });
      expect(plan1.remove.sort()).toEqual([k(1), k(2)]);
      const thirty = Array.from({ length: 30 }, (_, i) => ({ key: k(i), lastUsedAt: now - i * 1000 }));
      const allInUse = thirty.map((m) => m.key);
      const plan2 = planManifests(thirty, { keysInUse: allInUse, eligibleKeys: allInUse.slice(0, 20) }, { now, maxManifests: 30, retentionMs: 14 * DAY });
      expect(plan2).toEqual({ remove: [k(29)], roomForOne: true }); // the least recently used unneeded one
      const plan3 = planManifests(thirty, { keysInUse: allInUse, eligibleKeys: allInUse }, { now, maxManifests: 30, retentionMs: 14 * DAY });
      expect(plan3).toEqual({ remove: [], roomForOne: false });
    });
  });

  describe('the supervisor', () => {
    const pass = (over: Partial<NodeModulesPassSummary> = {}): NodeModulesPassSummary => ({
      passId: 'p', checks: {}, eligibleKeys: [key], needed: [{ key, sourceCheckout: source }], keysInUse: [key],
      manifests: { count: 0, bytes: 0 }, storeBytes: 0, scratchHighWaterBytes: 0, npmMajor, ...over,
    });
    const seams = (over: Partial<ReferenceBuilderSeams> & { exits?: Array<() => void>; killed?: string[] } = {}): ReferenceBuilderSeams => {
      const exits = over.exits ?? [];
      return {
        spawnChild: (_a, _c, onExit) => { exits.push(onExit); return { pid: 777 }; },
        killGroup: (_p, sig) => { over.killed?.push(sig); const e = exits.shift(); if (e) e(); },
        freeBytes: async () => 10 * 1024 ** 4,
        now: () => Date.now(),
        setTimer: (fn, ms) => { const t = setTimeout(fn, ms); return { cancel: () => clearTimeout(t) }; },
        ...over,
      };
    };
    const cfg = (over: Record<string, unknown> = {}) => ({ refsDir, agentHome: root, mainScript: '/x.js', nodePath: process.execPath, ...over });

    it('at most one build per pass, never during a reclaim run, none below the 3 GB floor', async () => {
      const exits: Array<() => void> = [];
      const b = new AgentWorktreeReferenceBuilder(cfg(), seams({ exits }));
      expect(await b.afterPass(pass(), { reclaimRunActive: true })).toMatchObject({ started: false, reason: 'reclaim-run-active' });
      const low = new AgentWorktreeReferenceBuilder(cfg(), seams({ freeBytes: async () => REFERENCE_BUILD_DEFAULTS.freeFloorBytes - 1 }));
      expect(await low.afterPass(pass(), { reclaimRunActive: false })).toMatchObject({ started: false, reason: 'below-free-floor' });
      expect(await b.afterPass(pass(), { reclaimRunActive: false })).toMatchObject({ started: true, key });
      expect(await b.afterPass(pass(), { reclaimRunActive: false })).toMatchObject({ started: false, reason: 'build-running' });
      exits.shift()!();
      await new Promise((r) => setTimeout(r, 20));
      // no result file ⇒ a failed build: no manifest, the key is unavailable with its cause, and it backs off
      expect(b.status().lastOutcome).toMatchObject({ ok: false, cause: 'killed' });
      expect(readBuildStatus(refsDir).keys[key]).toMatchObject({ failures: 1, cause: 'killed' });
      expect(await b.afterPass(pass(), { reclaimRunActive: false })).toMatchObject({ started: false, reason: 'nothing-needed' });
    });

    it('a build past its timeout is killed by process group, recorded as timeout, and its scratch deleted', async () => {
      const killed: string[] = [];
      const b = new AgentWorktreeReferenceBuilder(cfg({ timeoutMs: 30 }), seams({ killed }));
      fs.mkdirSync(path.join(scratchRoot(refsDir), 'x'), { recursive: true });
      expect((await b.afterPass(pass(), { reclaimRunActive: false })).started).toBe(true);
      for (let i = 0; i < 100 && b.status().running; i++) await new Promise((r) => setTimeout(r, 10));
      await new Promise((r) => setTimeout(r, 50));
      expect(killed[0]).toBe('SIGTERM');
      expect(readBuildStatus(refsDir).keys[key]).toMatchObject({ cause: 'timeout', failures: 1 });
      expect(fs.existsSync(scratchRoot(refsDir))).toBe(false);
    });

    it('a failed key reads reference-unavailable with its cause in the next pass', () => {
      fs.mkdirSync(refsDir, { recursive: true });
      SafeFsExecutor.atomicWriteJsonSync(path.join(refsDir, 'status.json'), { keys: { [key]: nextBuildAttemptAt(undefined, 'npm-cache-missing', Date.now()) }, scratchHighWaterBytes: 0 }, { operation: OP });
      const memo = new NodeModulesMemo(null);
      const s = runNodeModulesPass({
        deps: { isInUse: () => false, isMerged: () => true, isCleanExceptRootNodeModules: () => true },
        worktrees: [{ path: source, branch: 'b', headSha: 'x' }], memo, refsDir, archiveRoot: path.join(root, 'archive'),
        maxHashes: 20, npmMajor, passId: 'p1',
      });
      expect(s.checks[source]).toMatchObject({ verdict: 'reference-unavailable', reason: 'npm-cache-missing' });
      expect(s.needed).toEqual([{ key, sourceCheckout: source }]);
    });
  });
});
