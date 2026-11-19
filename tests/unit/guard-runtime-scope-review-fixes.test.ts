// safe-git-allow: test — removes its own temp folders; the guard under test is exercised through SafeFsExecutor.
/**
 * Second-pass review fixes (docs/specs/guard-runtime-state-scope.md §4):
 *   1. hot path — a repeated would-deny pays no classification and no `git ls-files` spawn;
 *   2. ledger home — a process that never configured the guard writes nothing outside an
 *      agent home and never creates `.instar` in an arbitrary cwd;
 *   3. fail-safe marker — a marker that cannot be checked counts as incomplete.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SafeGitExecutor } from '../../src/core/SafeGitExecutor.js';
import { guardScopeStateDir, _resetGuardRuntimeScopeForTesting } from '../../src/core/guardRuntimeScope.js';
import { isObservationIncomplete, ledgerPaths, readLedgerSummary, recordDiff, _resetLedgerMemoryForTesting } from '../../src/core/guardScopeLedger.js';
import { git, makeGuardFixture, type GuardFixture } from '../fixtures/guardScopeFixture.js';

const run = promisify(execFile);
let fx: GuardFixture;
const saved = { ledger: process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR, home: process.env.INSTAR_AGENT_HOME };

beforeEach(() => {
  fx = makeGuardFixture('guard-scope-fix-');
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = fx.ledgerDir;
  _resetGuardRuntimeScopeForTesting();
  _resetLedgerMemoryForTesting();
});
afterEach(() => {
  vi.restoreAllMocks();
  _resetGuardRuntimeScopeForTesting();
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = saved.ledger;
  if (saved.home === undefined) delete process.env.INSTAR_AGENT_HOME; else process.env.INSTAR_AGENT_HOME = saved.home;
  fx.cleanup();
});

describe('1. hot path: repeats are suppressed before any classification', () => {
  it('1,000 repeated would-deny calls on the same shape produce one ls-files call', async () => {
    // Tracked source files in an agent home under /.instar/: legacy allows (the broad
    // shortcut), the new rule refuses → a would-deny on every call, all one target shape.
    const dir = path.join(fx.home, 'src', 'gen');
    fs.mkdirSync(dir);
    const files = Array.from({ length: 1000 }, (_, i) => path.join(dir, `f${100 + i}.ts`));
    for (const f of files) fs.writeFileSync(f, '');
    git(fx.home, ['add', 'src/gen']);
    git(fx.home, ['commit', '-q', '-m', 'gen']);
    const spy = vi.spyOn(SafeGitExecutor, 'readSync');
    for (const f of files) SafeFsExecutor.safeUnlinkSync(f, { operation: 'hot-path' });
    const lsFilesCalls = spy.mock.calls.filter((c) => (c[0] as string[]).includes('ls-files'));
    expect(lsFilesCalls).toHaveLength(1);
    expect(files.every((f) => !fs.existsSync(f))).toBe(true); // report: the legacy verdict ran
    const s = await readLedgerSummary(fx.ledgerDir);
    const row = s.undisposed.find((d) => d.operation === 'hot-path');
    expect(row).toMatchObject({ rows: 1, targetClass: 'source-file' });
  }, 60_000);
});

describe('2. ledger home for processes that never configured the guard', () => {
  it('resolves INSTAR_AGENT_HOME, then a cwd that is an agent home, else nothing', () => {
    delete process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR;
    delete process.env.INSTAR_AGENT_HOME;
    process.env.INSTAR_AGENT_HOME = fx.home;
    expect(guardScopeStateDir()).toBe(path.join(fx.home, '.instar', 'state'));
    process.env.INSTAR_AGENT_HOME = path.join(fx.outside, 'no-such-home');
    const fallback = guardScopeStateDir();
    expect(fallback === null || fallback === path.join(process.cwd(), '.instar', 'state')).toBe(true);
    expect(recordDiff({ direction: 'would-deny', verb: 'unlink', recursive: false, reason: 'r', caller: 'c', operation: 'o', samplePath: '/x', targetClass: 'other' }, new Date(), null)).toBe('no-home');
  });

  it('an unconfigured child process in a temp cwd creates no .instar there; with INSTAR_AGENT_HOME the row lands in the agent home', async () => {
    const esbuild = await import('esbuild');
    const entry = path.join(fx.base, 'unconfigured-entry.ts');
    const bundle = path.join(fx.base, 'unconfigured.mjs');
    const src = path.resolve(__dirname, '../../src/core/SafeFsExecutor.ts');
    fs.writeFileSync(entry, `import { SafeFsExecutor } from ${JSON.stringify(src)};
SafeFsExecutor.safeUnlinkSync(process.argv[2], { operation: 'unconfigured-child' });
`);
    esbuild.buildSync({
      entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent',
      banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" },
    });
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'guard-scope-cwd-')));
    try {
      // Would-denies (legacy allows via the broad shortcut). Neither target is part of the
      // instar signature, so the home stays a confirmed checkout between the two runs.
      const target1 = path.join(fx.home, '.gitignore');
      const env: NodeJS.ProcessEnv = { ...process.env, INSTAR_AUDIT_LOG_DISABLED: '1' };
      delete env.INSTAR_GUARD_SCOPE_LEDGER_DIR;
      delete env.INSTAR_AGENT_HOME;
      delete env.INSTAR_GUARD_RUNTIME_SCOPE;
      await run(process.execPath, [bundle, target1], { cwd, env });
      expect(fs.existsSync(target1)).toBe(false);
      expect(fs.existsSync(path.join(cwd, '.instar'))).toBe(false);
      expect(fs.readdirSync(cwd)).toEqual([]);
      // With the agent home named, the same kind of difference is recorded there.
      const target2 = path.join(fx.home, 'package-lock.json');
      fs.writeFileSync(target2, '{}');
      await run(process.execPath, [bundle, target2], { cwd, env: { ...env, INSTAR_AGENT_HOME: fx.home } });
      expect(fs.existsSync(path.join(cwd, '.instar'))).toBe(false);
      const ledger = path.join(fx.home, '.instar', 'state', 'guard-scope-diff.jsonl');
      const rows = fs.readFileSync(ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      expect(rows.some((r) => r.operation === 'unconfigured-child' && r.direction === 'would-deny')).toBe(true);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  }, 60_000);
});

describe('3. the incomplete marker check is fail-safe', () => {
  it('ENOENT is complete; EACCES, a folder (EISDIR) and no ledger home are incomplete', () => {
    fs.mkdirSync(fx.ledgerDir, { recursive: true });
    expect(isObservationIncomplete(fx.ledgerDir)).toBe(false);
    // EISDIR-shaped: the marker is a folder.
    fs.mkdirSync(ledgerPaths(fx.ledgerDir).incomplete);
    expect(isObservationIncomplete(fx.ledgerDir)).toBe(true);
    fs.rmdirSync(ledgerPaths(fx.ledgerDir).incomplete);
    // EACCES: the folder holding the marker cannot be searched.
    fs.chmodSync(fx.ledgerDir, 0o000);
    let code: string | undefined;
    try { fs.lstatSync(ledgerPaths(fx.ledgerDir).incomplete); } catch (e) { code = (e as NodeJS.ErrnoException).code; }
    expect(code).toBe('EACCES');
    expect(isObservationIncomplete(fx.ledgerDir)).toBe(true);
    fs.chmodSync(fx.ledgerDir, 0o755);
    expect(isObservationIncomplete(null)).toBe(true);
  });
});
