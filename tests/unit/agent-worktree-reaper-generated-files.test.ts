/**
 * The worktree reaper recognises the repo's own generated files
 * (docs/specs/reaper-generated-files-regenerable.md). Both sides of every rule:
 *   - the registry copy is `regenerable` only when its blob equals HEAD:docs/STANDARDS-REGISTRY.md;
 *   - the closed residue list is `archived-residue` only as regular files, folders one level deep;
 *   - isClean treats archived residue like gate records;
 *   - the archive step copies in bounded memory, verifies, and keeps the checkout on any failure;
 *   - the final re-check keeps the checkout on any residue change or a process now inside it;
 *   - the report carries the archive size and the dry-run projections.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  classifyIgnoredEntry,
  makeAgentWorktreeReaperDeps,
  preserveGateRecords,
  recheckResidueManifest,
  projectReclaim,
  ARCHIVED_RESIDUE_FILES,
  type ReadGit,
} from '../../src/monitoring/agentWorktreeGit.js';
import { AgentWorktreeReaper, summarizeReclaim, type AgentWorktreeReaperDeps, type WorktreeInfo } from '../../src/monitoring/AgentWorktreeReaper.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/agent-worktree-reaper-generated-files.test.ts';
const HUSKY_INDEX = new URL('../../node_modules/husky/index.js', import.meta.url).href;

const readGit: ReadGit = (args, cwd) => SafeGitExecutor.readSync(args, {
  cwd, encoding: 'utf-8', timeout: 30_000, operation: OP, sourceTreeReadOk: true, sourceTreeWorktreeManagerOk: true,
});

const GITIGNORE = [
  'src/data/standards-registry.md',
  'src/data/standards-registry.meta.json',
  'src/data/standards-guard-index.json',
  'src/data/standards-guard-index.meta.json',
  'src/data/builtin-manifest.json',
  'src/data/other.json',
  '.instar/audit/',
  '.instar/standards-coverage.json',
  '.instar/dup-build-cache.json',
  '.instar/docs-coverage.json',
  '.instar/docs-coverage.md',
  'logs/',
  'node_modules',
  '',
].join('\n');

const REGISTRY = '# Standards registry\n\nRule one.\n';

describe('reaper generated files (reaper-generated-files-regenerable)', () => {
  let root: string;
  let repo: string;
  let worktreesDir: string;
  let wt: string;
  let archive: string;

  const g = (cwd: string, args: string[]) => SafeGitExecutor.run(args, { cwd, operation: OP });
  const write = (rel: string, body: string | Buffer, base = wt) => {
    fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true });
    fs.writeFileSync(path.join(base, rel), body);
  };
  const huskyInstall = (cwd: string) => {
    const env = { ...process.env };
    delete env.HUSKY;
    execFileSync(process.execPath, ['--input-type=module', '-e', `import h from ${JSON.stringify(HUSKY_INDEX)}; const r = h(); if (r) { console.error(r); process.exit(1); }`], { cwd, env, stdio: 'pipe' });
  };
  /** Every generated file the spec lists, as a build + prepare + audit would leave them. */
  const generateAll = () => {
    fs.copyFileSync(path.join(wt, 'docs', 'STANDARDS-REGISTRY.md'), path.join(wt, 'src', 'data', 'standards-registry.md'));
    for (const rel of Object.keys(ARCHIVED_RESIDUE_FILES)) write(rel, `{"generated":"${rel}"}\n`);
    write('.instar/audit/destructive-ops.jsonl', '{"op":"unlink"}\n');
    write('.instar/audit/destructive-ops.jsonl.1', '{"op":"older"}\n');
    write('.instar/audit/credential-resolution.jsonl', '{"kind":"resolution"}\n');
    huskyInstall(wt);
  };
  const noProcs = { cwdRoots: () => new Set<string>(), commandLines: () => [] as string[] };
  const mkDeps = (over: Partial<Parameters<typeof makeAgentWorktreeReaperDeps>[0]> = {}) =>
    makeAgentWorktreeReaperDeps({ instarRepo: repo, worktreesDir, gateRecordArchiveDir: archive, githubMergeCheck: false, readGit, ...noProcs, ...over });

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'awr-gen-')));
    repo = path.join(root, 'home');
    fs.mkdirSync(repo);
    g(repo, ['init', '-q', '-b', 'main']);
    g(repo, ['config', 'user.email', 't@t.l']);
    g(repo, ['config', 'user.name', 'T']);
    g(repo, ['config', 'commit.gpgsign', 'false']);
    write('.gitignore', GITIGNORE, repo);
    write('docs/STANDARDS-REGISTRY.md', REGISTRY, repo);
    // Tracked siblings, as in the real repo, so these folders are never wholly ignored.
    write('src/data/README.md', 'data', repo);
    write('.instar/README.md', 'state', repo);
    write('.husky/pre-commit', 'exit 0\n', repo);
    g(repo, ['add', '-A']);
    g(repo, ['commit', '-qm', 'init']);
    worktreesDir = path.join(repo, '.worktrees');
    fs.mkdirSync(worktreesDir);
    wt = path.join(worktreesDir, 'merged');
    g(repo, ['worktree', 'add', '-q', wt, '-b', 'feat-merged', 'HEAD']);
    archive = path.join(repo, '.instar', 'instar-dev-decisions-archive');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.INSTAR_AUDIT_LOG_DIR;
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: OP });
  });

  describe('registry copy: regenerable only with git-level proof', () => {
    it('blob hash equal to HEAD:docs/STANDARDS-REGISTRY.md → regenerable; checkout clean', () => {
      fs.copyFileSync(path.join(wt, 'docs', 'STANDARDS-REGISTRY.md'), path.join(wt, 'src', 'data', 'standards-registry.md'));
      expect(classifyIgnoredEntry('src/data/standards-registry.md', wt, readGit)).toBe('regenerable');
      expect(mkDeps().isClean(wt)).toBe(true);
    });

    it('proof holds inside a source-tree checkout (every real agent worktree), where git hash-object is refused', () => {
      // Production worktrees are checkouts of the instar source; SafeGitExecutor refuses
      // `hash-object` there. The marker makes this fixture look the same to the guard.
      write('.instar-source-tree', '');
      fs.copyFileSync(path.join(wt, 'docs', 'STANDARDS-REGISTRY.md'), path.join(wt, 'src', 'data', 'standards-registry.md'));
      expect(() => readGit(['-C', wt, 'hash-object', '--no-filters', '--', path.join(wt, 'src', 'data', 'standards-registry.md')], wt)).toThrow(/instar source tree/);
      expect(classifyIgnoredEntry('src/data/standards-registry.md', wt, readGit)).toBe('regenerable');
      write('src/data/standards-registry.md', REGISTRY.replace('one', 'onE'));
      expect(classifyIgnoredEntry('src/data/standards-registry.md', wt, readGit)).toBe('work');
    });

    it('one byte different → work; checkout kept', () => {
      write('src/data/standards-registry.md', REGISTRY.replace('one', 'onE'));
      expect(classifyIgnoredEntry('src/data/standards-registry.md', wt, readGit)).toBe('work');
      expect(mkDeps().isClean(wt)).toBe(false);
    });

    it('no read-only git to prove it, or a symlinked copy → work', () => {
      fs.copyFileSync(path.join(wt, 'docs', 'STANDARDS-REGISTRY.md'), path.join(wt, 'src', 'data', 'standards-registry.md'));
      expect(classifyIgnoredEntry('src/data/standards-registry.md', wt)).toBe('work');
      SafeFsExecutor.safeUnlinkSync(path.join(wt, 'src', 'data', 'standards-registry.md'), { operation: OP });
      fs.symlinkSync(path.join(wt, 'docs', 'STANDARDS-REGISTRY.md'), path.join(wt, 'src', 'data', 'standards-registry.md'));
      expect(classifyIgnoredEntry('src/data/standards-registry.md', wt, readGit)).toBe('work');
    });
  });

  describe('archived residue: closed list, regular files only', () => {
    it('each listed path as a regular file → archived-residue', () => {
      for (const rel of Object.keys(ARCHIVED_RESIDUE_FILES)) {
        write(rel, '{}');
        expect(classifyIgnoredEntry(rel, wt, readGit)).toBe('archived-residue');
      }
    });

    it('each listed path as a symlink → work', () => {
      const target = path.join(root, 'elsewhere.json');
      fs.writeFileSync(target, '{}');
      for (const rel of Object.keys(ARCHIVED_RESIDUE_FILES)) {
        fs.mkdirSync(path.dirname(path.join(wt, rel)), { recursive: true });
        fs.symlinkSync(target, path.join(wt, rel));
        expect(classifyIgnoredEntry(rel, wt, readGit)).toBe('work');
      }
    });

    it('a listed name under a deeper folder, or a folder above it that is a link → work', () => {
      write('src/data/sub/builtin-manifest.json', '{}');
      expect(classifyIgnoredEntry('src/data/sub/builtin-manifest.json', wt, readGit)).toBe('work');
      write('.instar/audit/sub/x.jsonl', '{}');
      expect(classifyIgnoredEntry('.instar/audit/sub/x.jsonl', wt, readGit)).toBe('work');
      const elsewhere = path.join(root, 'linked-data');
      fs.mkdirSync(elsewhere);
      fs.writeFileSync(path.join(elsewhere, 'builtin-manifest.json'), '{}');
      fs.symlinkSync(elsewhere, path.join(wt, 'gen'));
      expect(classifyIgnoredEntry('gen/builtin-manifest.json', wt, readGit)).toBe('work');
    });

    it('unlisted paths stay work', () => {
      write('logs/x', 'log');
      write('src/data/other.json', '{}');
      expect(classifyIgnoredEntry('logs/x', wt, readGit)).toBe('work');
      expect(classifyIgnoredEntry('logs/', wt, readGit)).toBe('work');
      expect(classifyIgnoredEntry('src/data/other.json', wt, readGit)).toBe('work');
    });
  });

  describe('folder entries: one level, every child checked', () => {
    it('.husky/_/ from a real husky install → archived-residue', () => {
      huskyInstall(wt);
      expect(fs.existsSync(path.join(wt, '.husky', '_', 'h'))).toBe(true);
      const listed = readGit(['-C', wt, 'ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], wt).split('\0').filter(Boolean);
      expect(listed).toContain('.husky/_/');
      expect(classifyIgnoredEntry('.husky/_/', wt, readGit)).toBe('archived-residue');
      expect(mkDeps().isClean(wt)).toBe(true);
    });

    it('a subfolder inside .husky/_/ → work', () => {
      huskyInstall(wt);
      write('.husky/_/extra/notes.md', 'mine');
      expect(classifyIgnoredEntry('.husky/_/', wt, readGit)).toBe('work');
      expect(mkDeps().isClean(wt)).toBe(false);
    });

    it('.husky/_ as a symlink → work', () => {
      const real = path.join(root, 'husky-elsewhere');
      fs.mkdirSync(real);
      fs.writeFileSync(path.join(real, 'h'), 'x');
      fs.symlinkSync(real, path.join(wt, '.husky', '_'));
      expect(classifyIgnoredEntry('.husky/_/', wt, readGit)).toBe('work');
      expect(classifyIgnoredEntry('.husky/_', wt, readGit)).toBe('work');
    });

    it('.instar/audit/ with only *.jsonl and *.jsonl.1 children → archived-residue', () => {
      write('.instar/audit/destructive-ops.jsonl', '{}\n');
      write('.instar/audit/destructive-ops.jsonl.1', '{}\n');
      expect(classifyIgnoredEntry('.instar/audit/', wt, readGit)).toBe('archived-residue');
      expect(mkDeps().isClean(wt)).toBe(true);
    });

    it('.instar/audit/ with one non-matching child, a link child, or a subfolder → work', () => {
      write('.instar/audit/destructive-ops.jsonl', '{}\n');
      write('.instar/audit/notes.txt', 'mine');
      expect(classifyIgnoredEntry('.instar/audit/', wt, readGit)).toBe('work');
      SafeFsExecutor.safeUnlinkSync(path.join(wt, '.instar/audit/notes.txt'), { operation: OP });
      fs.symlinkSync(path.join(root, 'nowhere.jsonl'), path.join(wt, '.instar/audit/linked.jsonl'));
      expect(classifyIgnoredEntry('.instar/audit/', wt, readGit)).toBe('work');
      SafeFsExecutor.safeUnlinkSync(path.join(wt, '.instar/audit/linked.jsonl'), { operation: OP });
      write('.instar/audit/old/x.jsonl', '{}');
      expect(classifyIgnoredEntry('.instar/audit/', wt, readGit)).toBe('work');
      expect(mkDeps().isClean(wt)).toBe(false);
    });
  });

  describe('isClean', () => {
    it('only proven-regenerable, archived residue and gate records → clean; any other ignored file → dirty', () => {
      generateAll();
      write('.instar/instar-dev-traces/2026-10-26T07-42-44-062Z-some-change-6648946c.json', '{}');
      expect(mkDeps().isClean(wt)).toBe(true);
      write('logs/x.log', 'a log');
      expect(mkDeps().isClean(wt)).toBe(false);
    });
  });

  describe('archive step', () => {
    it('copies every residue child and record (streaming a large file), verifies, then removes the checkout', () => {
      generateAll();
      const big = Buffer.alloc(3 * 1024 * 1024 + 17, 7);
      big[1234567] = 1;
      write('.instar/audit/destructive-ops.jsonl', big);
      const decision = '.instar/instar-dev-decisions/2026-10-23T19-33-42-871Z-some-change.json';
      write(decision, '{"d":1}');
      const originals = new Map<string, Buffer>();
      const collect = (dir: string) => {
        for (const e of fs.readdirSync(path.join(wt, dir), { withFileTypes: true })) {
          if (e.isFile()) originals.set(`${dir}/${e.name}`, fs.readFileSync(path.join(wt, dir, e.name)));
        }
      };
      collect('.husky/_');
      collect('.instar/audit');
      for (const rel of [...Object.keys(ARCHIVED_RESIDUE_FILES), decision]) originals.set(rel, fs.readFileSync(path.join(wt, rel)));
      const deps = mkDeps();
      expect(deps.isClean(wt)).toBe(true);
      deps.removeWorktree(wt);
      expect(fs.existsSync(wt)).toBe(false);
      for (const [rel, bytes] of originals) {
        expect(fs.readFileSync(path.join(archive, 'merged', rel)).equals(bytes), rel).toBe(true);
      }
      // The registry copy is proven, so not archived; no temp names left behind.
      expect(fs.existsSync(path.join(archive, 'merged', 'src/data/standards-registry.md'))).toBe(false);
      const leftovers: string[] = [];
      const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name.endsWith('.tmp')) leftovers.push(e.name); } };
      walk(archive);
      expect(leftovers).toEqual([]);
    });

    it('a forced copy mismatch keeps the checkout and leaves no partial file', () => {
      generateAll();
      const realWrite = fs.writeSync;
      vi.spyOn(fs, 'writeSync').mockImplementation(((fd: number, buf: Buffer, off?: number, len?: number) => {
        if (Buffer.isBuffer(buf) && typeof off === 'number' && typeof len === 'number' && len > 0) {
          const copy = Buffer.from(buf.subarray(off, off + len));
          copy[0] = copy[0] ^ 0xff;
          return realWrite(fd, copy, 0, copy.length);
        }
        return (realWrite as (...a: unknown[]) => number)(fd, buf, off, len);
      }) as typeof fs.writeSync);
      expect(() => mkDeps().removeWorktree(wt)).toThrow(/archive verification failed/);
      vi.restoreAllMocks();
      expect(fs.existsSync(path.join(wt, '.instar/audit/destructive-ops.jsonl'))).toBe(true);
      const files: string[] = [];
      const walk = (d: string) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else files.push(e.name); } };
      walk(path.join(archive, 'merged'));
      expect(files.filter((f) => f.endsWith('.tmp'))).toEqual([]);
      expect(files).not.toContain('destructive-ops.jsonl');
    });

    it('the free-space floor refuses when the copy would not fit, and keeps the checkout untouched', () => {
      generateAll();
      const decision = '.instar/instar-dev-decisions/2026-10-23T19-33-42-871Z-x.json';
      write(decision, '{"d":2}');
      vi.spyOn(fs, 'statfsSync').mockReturnValue({ bavail: 0, bsize: 4096 } as unknown as fs.StatsFs);
      expect(() => mkDeps().removeWorktree(wt)).toThrow(/too little free space/);
      expect(fs.existsSync(path.join(wt, decision))).toBe(true);
      expect(fs.existsSync(archive)).toBe(false);
    });

    it('INSTAR_AUDIT_LOG_DIR pointing inside the checkout keeps it', () => {
      generateAll();
      process.env.INSTAR_AUDIT_LOG_DIR = path.join(wt, '.instar', 'audit');
      expect(() => mkDeps().removeWorktree(wt)).toThrow(/INSTAR_AUDIT_LOG_DIR/);
      expect(fs.existsSync(wt)).toBe(true);
      expect(fs.existsSync(archive)).toBe(false);
    });

    it('preserveGateRecords accepts the new class and returns the manifest of what stays', () => {
      generateAll();
      const manifest = preserveGateRecords(wt, archive, readGit);
      const rels = manifest.entries.map((e) => e.relPath);
      expect(rels).toContain('.instar/audit/destructive-ops.jsonl.1');
      expect(rels).toContain('.husky/_/h');
      expect(rels).toContain('src/data/builtin-manifest.json');
      expect(rels).not.toContain('src/data/standards-registry.md');
      expect(manifest.archived).toBe(rels.length);
    });
  });

  describe('final re-check before removal', () => {
    it('a residue file appended after its copy → kept (through removeWorktree)', () => {
      generateAll();
      let statusCalls = 0;
      const appending: ReadGit = (args, cwd) => {
        if (args.includes('status') && ++statusCalls === 2) fs.appendFileSync(path.join(wt, '.instar/audit/destructive-ops.jsonl'), '{"late":1}\n');
        return readGit(args, cwd);
      };
      expect(() => mkDeps({ readGit: appending }).removeWorktree(wt)).toThrow(/residue changed since archive/);
      expect(fs.existsSync(wt)).toBe(true);
      expect(statusCalls).toBe(2);
    });

    it('a new audit file after the archive (manifest addition) → kept', () => {
      generateAll();
      const manifest = preserveGateRecords(wt, archive, readGit);
      write('.instar/audit/new-trail.jsonl', '{}\n');
      expect(() => recheckResidueManifest(wt, manifest, readGit)).toThrow(/file list differs/);
    });

    it('a rotation renaming x.jsonl to x.jsonl.1 after the archive → kept', () => {
      write('.instar/audit/destructive-ops.jsonl', '{"a":1}\n');
      const manifest = preserveGateRecords(wt, archive, readGit);
      fs.renameSync(path.join(wt, '.instar/audit/destructive-ops.jsonl'), path.join(wt, '.instar/audit/destructive-ops.jsonl.1'));
      expect(() => recheckResidueManifest(wt, manifest, readGit)).toThrow(/file list differs/);
    });

    it('a file replaced by one of the same size but different bytes → kept; unchanged → passes', () => {
      write('.instar/dup-build-cache.json', '{"a":1}');
      const manifest = preserveGateRecords(wt, archive, readGit);
      expect(() => recheckResidueManifest(wt, manifest, readGit)).not.toThrow();
      write('.instar/dup-build-cache.json', '{"a":2}');
      expect(() => recheckResidueManifest(wt, manifest, readGit)).toThrow(/residue changed since archive: \.instar\/dup-build-cache\.json/);
    });

    it('a process started in the checkout after evaluation → kept, even inside the 10 s scan memo', async () => {
      generateAll();
      let roots = new Set<string>();
      const deps = mkDeps({ cwdRoots: () => roots, inboundLinks: async () => new Set<string>() });
      await deps.preparePass!();
      expect(deps.isInUse(wt)).toBe(false); // memoizes an empty scan
      roots = new Set([wt]);
      expect(() => deps.removeWorktree(wt)).toThrow(/a process now works inside the checkout/);
      expect(fs.existsSync(wt)).toBe(true);
    });

    it('a process naming the checkout on its command line, or an unreadable scan → kept', () => {
      generateAll();
      expect(() => mkDeps({ commandLines: () => [`node ${wt}/dist/cli.js`] }).removeWorktree(wt)).toThrow(/names the checkout/);
      expect(() => mkDeps({ cwdRoots: () => null }).removeWorktree(wt)).toThrow(/scan failed/);
      expect(() => mkDeps({ commandLines: () => null }).removeWorktree(wt)).toThrow(/unreadable/);
      expect(fs.existsSync(wt)).toBe(true);
    });
  });

  describe('report', () => {
    it('projectReclaim measures residue bytes and apparent bytes for a real checkout', () => {
      write('.instar/dup-build-cache.json', '12345');
      write('.instar/audit/destructive-ops.jsonl', '1234567890');
      const p = projectReclaim(wt, readGit);
      expect(p).not.toBeNull();
      expect(p!.residueBytes).toBe(15);
      expect(p!.apparentBytes).toBeGreaterThanOrEqual(15);
    });

    it('a dry-run pass carries per-worktree projections, totals, the archive size and node_modules counts', async () => {
      const info = (name: string): WorktreeInfo => ({ path: `/wt/${name}`, branch: `b-${name}`, headSha: 'x' });
      const list = [info('a'), info('b'), info('real'), info('sym')];
      const fakeDeps: AgentWorktreeReaperDeps = {
        listWorktrees: () => ({ ok: true as const, worktrees: list }),
        isClean: (p) => p !== '/wt/real' && p !== '/wt/sym',
        isMerged: () => true,
        isInUse: () => false,
        currentBranch: () => null,
        removeWorktree: vi.fn(),
        projectReclaim: (p) => (p === '/wt/a' ? { residueBytes: 100, apparentBytes: 5000 } : { residueBytes: 50, apparentBytes: 1000 }),
        nodeModulesKind: (p) => (p === '/wt/real' ? 'real' : 'symlink'),
        archiveBytes: () => 4242,
      };
      const reaper = new AgentWorktreeReaper(fakeDeps, { enabled: true, dryRun: true });
      const pass = await reaper.reap();
      expect(pass.evaluations.find((e) => e.path === '/wt/a')!.projection).toEqual({ residueBytes: 100, apparentBytes: 5000 });
      expect(pass.evaluations.find((e) => e.path === '/wt/real')!.projection).toBeUndefined();
      const snap = reaper.snapshot();
      expect(snap.archiveBytes).toBe(4242);
      expect(snap.projection).toEqual({ eligible: 2, measured: 2, residueBytes: 150, apparentBytes: 6000 });
      expect(snap.nodeModules).toEqual({ keptForRealNodeModules: 1, withSymlinkedNodeModules: 3 });
      expect(fakeDeps.removeWorktree).not.toHaveBeenCalled();
    });

    it('an unmeasured eligible checkout makes the totals unknown, never zero; live removal has no projection', () => {
      const evals = [
        { path: '/a', branch: 'a', verdict: 'reap-eligible' as const, reason: 'merged-clean-idle', projection: { residueBytes: 1, apparentBytes: 2 } },
        { path: '/b', branch: 'b', verdict: 'reap-eligible' as const, reason: 'merged-clean-idle', projection: null },
      ];
      expect(summarizeReclaim(evals, null, true).projection).toEqual({ eligible: 2, measured: 1, residueBytes: null, apparentBytes: null });
      expect(summarizeReclaim(evals, 10, false).projection).toBeNull();
    });
  });
});
