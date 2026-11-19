/**
 * docs/specs/guard-runtime-state-scope.md §1–§2: the shortcut, the three-way ancestor
 * classifier, the protection check, symlinks (both directions), indeterminate walks and
 * raw-component rejection. Every fixture lives under a temp path that itself contains
 * `/.instar/`, as an agent home does.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor, SourceTreeGuardError } from '../../src/core/SafeFsExecutor.js';
import {
  configureGuardRuntimeScope,
  evaluateRuntimeScopePolicy,
  rawComponentProblem,
  _resetGuardRuntimeScopeForTesting,
  type GuardRequest,
} from '../../src/core/guardRuntimeScope.js';
import { classifySourceTreeAncestor } from '../../src/core/SourceTreeGuard.js';
import { _resetLedgerMemoryForTesting, readLedgerSummary } from '../../src/core/guardScopeLedger.js';
import { git, makeGuardFixture, makeInstarCheckout, type GuardFixture } from '../fixtures/guardScopeFixture.js';

const req = (target: string, verb: GuardRequest['verb'] = 'unlink', recursive = false): GuardRequest => ({ target, verb, recursive, force: recursive, scopes: {} });

let fx: GuardFixture;
const prevLedger = process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR;

beforeEach(() => {
  fx = makeGuardFixture();
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = fx.ledgerDir;
  _resetGuardRuntimeScopeForTesting();
  _resetLedgerMemoryForTesting();
});
afterEach(() => {
  _resetGuardRuntimeScopeForTesting();
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = prevLedger;
  fx.cleanup();
});

describe('the shortcut (§1)', () => {
  it('allows an entry inside <home>/.instar/ where <home> is an instar checkout under a parent /.instar/ folder', async () => {
    const f = path.join(fx.home, '.instar', 'state', 'x.json');
    fs.writeFileSync(f, '{}');
    const v = evaluateRuntimeScopePolicy(req(f));
    expect(v).toMatchObject({ allow: true, reason: 'runtime-state' });
  });

  it('allows an entry inside a nested instar checkout under <home>/.instar/worktrees/x/', async () => {
    const nested = path.join(fx.home, '.instar', 'worktrees', 'x');
    fs.mkdirSync(nested, { recursive: true });
    makeInstarCheckout(nested);
    const v = evaluateRuntimeScopePolicy(req(path.join(nested, 'src', 'core', 'GitSync.ts')));
    expect(v).toMatchObject({ allow: true, reason: 'runtime-state' });
    expect(v.detail).toContain(path.join(fx.home, '.instar'));
  });

  it('does not cover the .instar folder itself', async () => {
    const v = evaluateRuntimeScopePolicy(req(path.join(fx.home, '.instar'), 'rm', true));
    expect(v).toMatchObject({ allow: false, reason: 'inside-source' });
  });

  it('covers a .session.lock under <home>/.instar/worktrees/x/ and a gate record in <home>/.worktrees/x/.instar/ without a scope', async () => {
    const lock = path.join(fx.home, '.instar', 'worktrees', 'x', '.session.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, '');
    expect(evaluateRuntimeScopePolicy(req(lock)).allow).toBe(true);
    const wt = path.join(fx.home, '.worktrees', 'x');
    git(fx.home, ['worktree', 'add', '-q', wt]);
    const gate = path.join(wt, '.instar', 'instar-dev-traces', 'g.json');
    fs.mkdirSync(path.dirname(gate), { recursive: true });
    fs.writeFileSync(gate, '{}');
    expect(evaluateRuntimeScopePolicy(req(gate))).toMatchObject({ allow: true, reason: 'runtime-state' });
  });
});

describe('the protection check (§2), in enforce', () => {
  beforeEach(() => configureGuardRuntimeScope({ mode: 'enforce' }));

  it('refuses a source file under the home and leaves it', async () => {
    const f = path.join(fx.home, 'src', 'core', 'GitSync.ts');
    expect(() => SafeFsExecutor.safeUnlinkSync(f, { operation: 'test' })).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses a path under <home>/.worktrees/x outside any scope', async () => {
    const f = path.join(fx.home, '.worktrees', 'x', 'file.txt');
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, 'x');
    expect(() => SafeFsExecutor.safeUnlinkSync(f, { operation: 'test' })).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('refuses an entry in an ordinary repository nested inside an instar checkout', async () => {
    const foo = path.join(fx.home, 'foo');
    fs.mkdirSync(foo);
    git(foo, ['init', '-q']);
    const f = path.join(foo, 'a.txt');
    fs.writeFileSync(f, 'a');
    expect(classifySourceTreeAncestor(foo).kind).toBe('ordinary');
    expect(evaluateRuntimeScopePolicy(req(f))).toMatchObject({ allow: false, reason: 'inside-source' });
    expect(() => SafeFsExecutor.safeUnlinkSync(f, { operation: 'test' })).toThrow(SourceTreeGuardError);
  });

  it('refuses a deeply nested source path', async () => {
    const deep = path.join(fx.home, 'src', 'a', 'b', 'c', 'd', 'e');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'f.ts'), '');
    expect(() => SafeFsExecutor.safeUnlinkSync(path.join(deep, 'f.ts'), { operation: 'test' })).toThrow(SourceTreeGuardError);
  });

  it('refuses the checkout root itself (the entry is a confirmed checkout)', async () => {
    expect(evaluateRuntimeScopePolicy(req(fx.home, 'rm', true))).toMatchObject({ allow: false, reason: 'inside-source' });
  });

  it('allows a machine-level lock outside any checkout', async () => {
    const lock = path.join(fx.base, '.instar', 'host-spawn-holders.json.lock');
    fs.writeFileSync(lock, '');
    SafeFsExecutor.safeUnlinkSync(lock, { operation: 'test' });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('refuses a directory carrying the .instar-source-tree marker without .git, as today', async () => {
    const marked = path.join(fx.outside, 'marked');
    fs.mkdirSync(marked);
    fs.writeFileSync(path.join(marked, '.instar-source-tree'), '');
    fs.writeFileSync(path.join(marked, 'a.txt'), '');
    expect(() => SafeFsExecutor.safeUnlinkSync(path.join(marked, 'a.txt'), { operation: 'test' })).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(path.join(marked, 'a.txt'))).toBe(true);
  });
});

describe('symlinks: the entry, not the referent', () => {
  beforeEach(() => configureGuardRuntimeScope({ mode: 'enforce' }));

  it('refuses unlinking a link inside source that points at runtime state; the link survives', async () => {
    const state = path.join(fx.home, '.instar', 'state', 's.json');
    fs.writeFileSync(state, '{}');
    const link = path.join(fx.home, 'src', 'link-to-state');
    fs.symlinkSync(state, link);
    expect(() => SafeFsExecutor.safeUnlinkSync(link, { operation: 'test' })).toThrow(SourceTreeGuardError);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('refuses unlinking a link inside source that points at /tmp outside every checkout', async () => {
    const tmpTarget = path.join(fx.outside, 't.txt');
    fs.writeFileSync(tmpTarget, 't');
    const link = path.join(fx.home, 'src', 'link-to-tmp');
    fs.symlinkSync(tmpTarget, link);
    expect(() => SafeFsExecutor.safeUnlinkSync(link, { operation: 'test' })).toThrow(SourceTreeGuardError);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
  });

  it('allows unlinking a link outside source that points into source; the target is untouched', async () => {
    const src = path.join(fx.home, 'src', 'core', 'GitSync.ts');
    const link = path.join(fx.outside, 'link-into-source');
    fs.symlinkSync(src, link);
    SafeFsExecutor.safeUnlinkSync(link, { operation: 'test' });
    expect(fs.existsSync(link)).toBe(false);
    expect(fs.readFileSync(src, 'utf8')).toBe('export {};\n');
  });
});

describe('indeterminate', () => {
  it('an unreadable ancestor (no search permission) is indeterminate, never an allow', async () => {
    const locked = path.join(fx.outside, 'locked');
    fs.mkdirSync(path.join(locked, 'inner'), { recursive: true });
    fs.writeFileSync(path.join(locked, 'inner', 'f'), '');
    fs.chmodSync(locked, 0o000);
    const v = evaluateRuntimeScopePolicy(req(path.join(locked, 'inner', 'f')));
    expect(v.allow).toBe(false);
    expect(v.reason).toBe('indeterminate');
  });

  it('an ancestor whose package.json cannot be read is indeterminate, not ordinary', async () => {
    const d = path.join(fx.outside, 'pkg');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'package.json'), '{"name":"instar"}');
    fs.chmodSync(path.join(d, 'package.json'), 0o000);
    fs.writeFileSync(path.join(d, 'a'), '');
    expect(classifySourceTreeAncestor(d).kind).toBe('indeterminate');
    expect(evaluateRuntimeScopePolicy(req(path.join(d, 'a')))).toMatchObject({ allow: false, reason: 'indeterminate' });
  });

  it('an instar checkout whose only evidence (.git/config) is unreadable is indeterminate', async () => {
    const d = path.join(fx.outside, 'remote-only');
    fs.mkdirSync(d);
    git(d, ['init', '-q']);
    git(d, ['remote', 'add', 'origin', 'https://github.com/dawn/instar.git']);
    expect(classifySourceTreeAncestor(d).kind).toBe('instar');
    fs.chmodSync(path.join(d, '.git', 'config'), 0o000);
    expect(classifySourceTreeAncestor(d).kind).toBe('indeterminate');
  });

  it('the 40-level walk cap is indeterminate', async () => {
    let deep = fx.outside;
    for (let i = 0; i < 42; i++) deep = path.join(deep, 'd');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'f'), '');
    const v = evaluateRuntimeScopePolicy(req(path.join(deep, 'f')));
    expect(v).toMatchObject({ allow: false, reason: 'indeterminate' });
  });

  it('in enforce an indeterminate walk is refused', async () => {
    configureGuardRuntimeScope({ mode: 'enforce' });
    const d = path.join(fx.outside, 'pkg2');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'package.json'), '{}');
    fs.chmodSync(path.join(d, 'package.json'), 0o000);
    fs.writeFileSync(path.join(d, 'a'), '');
    expect(() => SafeFsExecutor.safeUnlinkSync(path.join(d, 'a'), { operation: 'test' })).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(path.join(d, 'a'))).toBe(true);
  });

  it('in report it writes a would-deny row with reason indeterminate and executes the legacy allow', async () => {
    const d = path.join(fx.outside, 'pkg3');
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'package.json'), '{}');
    fs.chmodSync(path.join(d, 'package.json'), 0o000);
    fs.writeFileSync(path.join(d, 'a'), '');
    SafeFsExecutor.safeUnlinkSync(path.join(d, 'a'), { operation: 'test-indeterminate' });
    expect(fs.existsSync(path.join(d, 'a'))).toBe(false);
    const s = await readLedgerSummary(fx.ledgerDir);
    expect(s.undisposed.find((r) => r.operation === 'test-indeterminate')).toMatchObject({ direction: 'would-deny', reason: 'indeterminate' });
  });
});

describe('raw components are rejected before normalisation', () => {
  it.each([
    ['a/../b', "'..' component"],
    ['/x//y', 'empty path component'],
    ['/x/y/', 'empty path component'],
    ['/x/\0y', 'NUL in path'],
  ])('%s', (p, problem) => {
    expect(rawComponentProblem(p)).toBe(problem);
    expect(evaluateRuntimeScopePolicy(req(p))).toMatchObject({ allow: false, reason: 'raw-component' });
  });

  it('a normal absolute path has no problem', async () => {
    expect(rawComponentProblem('/a/b/c')).toBeNull();
  });

  it('a .. traversal out of runtime state into source is refused in enforce, even though it normalises back', async () => {
    configureGuardRuntimeScope({ mode: 'enforce' });
    const viaDots = path.join(fx.home, '.instar', 'state') + '/../../src/core/GitSync.ts';
    expect(() => SafeFsExecutor.safeUnlinkSync(viaDots, { operation: 'test' })).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(path.join(fx.home, 'src', 'core', 'GitSync.ts'))).toBe(true);
  });
});
