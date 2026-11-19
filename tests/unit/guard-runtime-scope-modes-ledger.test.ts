/**
 * docs/specs/guard-runtime-state-scope.md §4: report vs enforce, the fenced shadow, and the
 * append-only difference ledger (dedup, dispositions, cap + incomplete marker, reviewed
 * reset, concurrent writers from several processes).
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SafeFsExecutor, SourceTreeGuardError } from '../../src/core/SafeFsExecutor.js';
import {
  configureGuardRuntimeScope,
  configuredRuntimeStateScopeMode,
  defaultLsFiles,
  _resetGuardRuntimeScopeForTesting,
  _setShadowFaultForTesting,
} from '../../src/core/guardRuntimeScope.js';
import {
  appendDisposition,
  isObservationIncomplete,
  ledgerPaths,
  readLedgerSummary,
  recordDiff,
  resetObservationWindow,
  targetShape,
  _resetLedgerMemoryForTesting,
  _setLedgerCapForTesting,
  type DiffRowInput,
} from '../../src/core/guardScopeLedger.js';
import { getInitDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { git, makeGuardFixture, makeInstarCheckout, type GuardFixture } from '../fixtures/guardScopeFixture.js';

const run = promisify(execFile);
let fx: GuardFixture;
const prevLedger = process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR;

beforeEach(() => {
  fx = makeGuardFixture();
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = fx.ledgerDir;
  _resetGuardRuntimeScopeForTesting();
  _resetLedgerMemoryForTesting();
});
afterEach(() => {
  _setLedgerCapForTesting(null);
  _resetGuardRuntimeScopeForTesting();
  process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = prevLedger;
  fx.cleanup();
});

const rows = (): Array<Record<string, unknown>> => {
  try { return fs.readFileSync(ledgerPaths(fx.ledgerDir).ledger, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};

const sample = (over: Partial<DiffRowInput> = {}): DiffRowInput => ({
  direction: 'would-deny', verb: 'unlink', recursive: false, reason: 'inside-source',
  caller: 'at x (/a/b/src/core/Foo.ts:10:5)', operation: 'op', samplePath: '/a/b/c.txt', targetClass: 'other', ...over,
});

describe('defaults and mode', () => {
  it('the default is report, for new and migrating agents', async () => {
    expect(configuredRuntimeStateScopeMode()).toBe('report');
    expect((getInitDefaults('standalone').safety as Record<string, unknown>).sourceTreeGuard).toEqual({ runtimeStateScope: 'report' });
    expect((getMigrationDefaults('managed-project').safety as Record<string, unknown>).sourceTreeGuard).toEqual({ runtimeStateScope: 'report' });
  });

  it('anything but enforce is report', async () => {
    configureGuardRuntimeScope({ mode: 'yes' });
    expect(configuredRuntimeStateScopeMode()).toBe('report');
    configureGuardRuntimeScope({ mode: 'enforce' });
    expect(configuredRuntimeStateScopeMode()).toBe('enforce');
  });
});

describe('report executes the legacy verdict exactly', () => {
  it('a source file in an agent home (legacy allows via the broad shortcut) is deleted, and recorded as a would-deny source-file', async () => {
    const extra = path.join(fx.home, 'src', 'core', 'Tracked.ts');
    fs.writeFileSync(extra, 'x');
    git(fx.home, ['add', extra]);
    git(fx.home, ['commit', '-q', '-m', 't']);
    SafeFsExecutor.safeUnlinkSync(extra, { operation: 'legacy-allows-source' });
    expect(fs.existsSync(extra)).toBe(false);
    const r = rows().find((x) => x.operation === 'legacy-allows-source');
    expect(r).toMatchObject({ direction: 'would-deny', reason: 'inside-source', targetClass: 'source-file', verb: 'unlink' });
  });

  it('enforce refuses the same delete', async () => {
    configureGuardRuntimeScope({ mode: 'enforce' });
    const f = path.join(fx.home, 'src', 'core', 'GitSync.ts');
    expect(() => SafeFsExecutor.safeUnlinkSync(f, { operation: 'enforce' })).toThrow(SourceTreeGuardError);
    expect(fs.existsSync(f)).toBe(true);
  });

  it('a whole-home rm is classed checkout-root; nuke is preset needs-scope (spec B)', async () => {
    // Do not actually delete the fixture home: delete a second checkout under /.instar/.
    const other = path.join(fx.base, '.instar', 'agents', 'other');
    fs.mkdirSync(other, { recursive: true });
    makeInstarCheckout(other);
    SafeFsExecutor.safeRmSync(other, { recursive: true, force: true, operation: 'src/commands/nuke.ts:199' });
    expect(fs.existsSync(other)).toBe(false);
    const s = await readLedgerSummary(fx.ledgerDir);
    expect(s.counts.byClass['checkout-root']).toBe(1);
    expect(s.undisposed.find((d) => d.operation.startsWith('src/commands/nuke.ts'))).toBeUndefined();
  });

  it('a throwing shadow still executes the legacy verdict and records shadow-error', async () => {
    _setShadowFaultForTesting(() => { throw new Error('injected'); });
    const ok = path.join(fx.outside, 'ok.txt');
    fs.writeFileSync(ok, '');
    SafeFsExecutor.safeUnlinkSync(ok, { operation: 'shadow-throws' });
    expect(fs.existsSync(ok)).toBe(false);
    const r = rows().find((x) => x.operation === 'shadow-throws');
    expect(r).toMatchObject({ direction: 'would-deny', reason: 'shadow-error' });
    // Legacy refusal still throws the legacy error with a throwing shadow.
    const plainSrc = path.join(fx.outside, 'plainsrc');
    fs.mkdirSync(plainSrc);
    makeInstarCheckout(plainSrc);
    expect(() => SafeFsExecutor.safeUnlinkSync(path.join(plainSrc, 'tsconfig.json'), { operation: 'shadow-throws-2' })).toThrow(SourceTreeGuardError);
  });

  it('a timed-out (slow) shadow and an unwritable ledger never block', async () => {
    process.env.INSTAR_GUARD_SCOPE_LEDGER_DIR = '/dev/null/cannot-exist';
    _setShadowFaultForTesting(() => { const t = Date.now(); while (Date.now() - t < 50) { /* slow */ } throw new Error('timeout'); });
    const ok = path.join(fx.outside, 'ok2.txt');
    fs.writeFileSync(ok, '');
    expect(() => SafeFsExecutor.safeUnlinkSync(ok, { operation: 'unwritable' })).not.toThrow();
    expect(fs.existsSync(ok)).toBe(false);
  });

  it('records a would-allow: unlinking an outside link into source (legacy follows the link and refuses)', async () => {
    const plainSrc = path.join(fx.outside, 'plainsrc');
    fs.mkdirSync(plainSrc);
    makeInstarCheckout(plainSrc);
    const link = path.join(fx.outside, 'link');
    fs.symlinkSync(path.join(plainSrc, 'tsconfig.json'), link);
    expect(() => SafeFsExecutor.safeUnlinkSync(link, { operation: 'outside-link' })).toThrow(SourceTreeGuardError);
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
    expect(rows().find((x) => x.operation === 'outside-link')).toMatchObject({ direction: 'would-allow', reason: 'ordinary' });
  });

  it('both-allow and both-deny write nothing; machine-level locks never appear', async () => {
    const lock = path.join(fx.base, '.instar', 'host-recovery-slot.json.lock');
    fs.writeFileSync(lock, '');
    SafeFsExecutor.safeUnlinkSync(lock, { operation: 'machine-lock' });
    const state = path.join(fx.home, '.instar', 'state', 's.json');
    fs.writeFileSync(state, '');
    SafeFsExecutor.safeUnlinkSync(state, { operation: 'state' });
    const plainSrc = path.join(fx.outside, 'plainsrc');
    fs.mkdirSync(plainSrc);
    makeInstarCheckout(plainSrc);
    expect(() => SafeFsExecutor.safeUnlinkSync(path.join(plainSrc, 'tsconfig.json'), { operation: 'both-deny' })).toThrow(SourceTreeGuardError);
    expect(rows()).toEqual([]);
  });
});

describe('the ledger', () => {
  it('one row per direction, verb, reason, caller, target shape and day; counts at read time', async () => {
    const d1 = new Date('2026-11-19T01:00:00Z');
    expect(recordDiff(sample({ samplePath: '/a/.feedback-canary-sib-ab12cd34ef/w.txt' }), d1, fx.ledgerDir)).toBe('appended');
    expect(recordDiff(sample({ samplePath: '/a/.feedback-canary-sib-99ff00aa11/w.txt' }), d1, fx.ledgerDir)).toBe('suppressed');
    expect(recordDiff(sample({ samplePath: '/a/other.txt' }), d1, fx.ledgerDir)).toBe('appended');
    expect(recordDiff(sample({ samplePath: '/a/other.txt', verb: 'rm' }), d1, fx.ledgerDir)).toBe('appended');
    expect(recordDiff(sample({ samplePath: '/a/other.txt', direction: 'would-allow' }), d1, fx.ledgerDir)).toBe('appended');
    const d2 = new Date('2026-11-20T01:00:00Z');
    expect(recordDiff(sample({ samplePath: '/a/other.txt' }), d2, fx.ledgerDir)).toBe('appended');
    const s = await readLedgerSummary(fx.ledgerDir);
    expect(s.counts.distinct).toBe(4);
    const other = s.undisposed.find((d) => d.shape === '/a/other.txt' && d.verb === 'unlink' && d.direction === 'would-deny');
    expect(other).toMatchObject({ rows: 2, days: 2 });
    expect(targetShape('/x/node_modules.clone-123-1700000000000')).toBe('/x/node_modules.clone-<n>-<n>');
  });

  it('a disposition can be set on a row and the summary lists only undisposed rows', async () => {
    recordDiff(sample(), new Date(), fx.ledgerDir);
    recordDiff(sample({ samplePath: '/b.txt' }), new Date(), fx.ledgerDir);
    const before = await readLedgerSummary(fx.ledgerDir);
    expect(before.counts.undisposed).toBe(2);
    appendDisposition(before.undisposed[0].fingerprint, 'correct-refusal', 'source file', 'test', fx.ledgerDir);
    const after = await readLedgerSummary(fx.ledgerDir);
    expect(after.counts.undisposed).toBe(1);
    expect(after.counts.distinct).toBe(2);
    expect(() => appendDisposition(before.undisposed[1].fingerprint, 'bogus' as never, '', 't', fx.ledgerDir)).toThrow();
  });

  it('at the cap nothing more is appended, the incomplete marker is created once, and enforce is blocked', async () => {
    _setLedgerCapForTesting(1);
    expect(recordDiff(sample(), new Date(), fx.ledgerDir)).toBe('appended'); // size 0 < 1
    const size = fs.statSync(ledgerPaths(fx.ledgerDir).ledger).size;
    expect(recordDiff(sample({ samplePath: '/z.txt' }), new Date(), fx.ledgerDir)).toBe('full');
    expect(recordDiff(sample({ samplePath: '/y.txt' }), new Date(), fx.ledgerDir)).toBe('full');
    expect(fs.statSync(ledgerPaths(fx.ledgerDir).ledger).size).toBe(size);
    expect(isObservationIncomplete(fx.ledgerDir)).toBe(true);
    const marker = fs.readFileSync(ledgerPaths(fx.ledgerDir).incomplete, 'utf8');
    expect(marker.split('\n').filter(Boolean)).toHaveLength(1);
    // enforce configured, but the observation is incomplete: the guard stays in report.
    configureGuardRuntimeScope({ mode: 'enforce' });
    expect((await readLedgerSummary(fx.ledgerDir)).effectiveMode).toBe('report');
    const f = path.join(fx.home, 'src', 'core', 'GitSync.ts');
    SafeFsExecutor.safeUnlinkSync(f, { operation: 'blocked-enforce' }); // legacy allows (broad shortcut)
    expect(fs.existsSync(f)).toBe(false);
  });

  it('the reviewed reset archives the ledger and marker and starts a fresh window', async () => {
    _setLedgerCapForTesting(1);
    recordDiff(sample(), new Date(), fx.ledgerDir);
    recordDiff(sample({ samplePath: '/q' }), new Date(), fx.ledgerDir);
    expect(isObservationIncomplete(fx.ledgerDir)).toBe(true);
    expect(() => resetObservationWindow('', new Date(), fx.ledgerDir)).toThrow();
    const { archivedTo } = resetObservationWindow('chief-of-staff', new Date(), fx.ledgerDir);
    expect(archivedTo.startsWith(path.join(fx.ledgerDir, 'guard-scope-diff', 'archive'))).toBe(true);
    expect(fs.existsSync(path.join(archivedTo, 'guard-scope-diff.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(archivedTo, 'guard-scope-diff.incomplete'))).toBe(true);
    expect(isObservationIncomplete(fx.ledgerDir)).toBe(false);
    expect((await readLedgerSummary(fx.ledgerDir)).counts.distinct).toBe(0);
    _setLedgerCapForTesting(null);
    expect(recordDiff(sample(), new Date(), fx.ledgerDir)).toBe('appended');
  });

  it('the cap holds against a large flood', async () => {
    _setLedgerCapForTesting(2_000);
    for (let i = 0; i < 200; i++) recordDiff(sample({ samplePath: `/flood/${'f'.repeat(i % 7)}x${String.fromCharCode(97 + (i % 26))}/${i}` , operation: `op-${i}` }), new Date(), fx.ledgerDir);
    const size = fs.statSync(ledgerPaths(fx.ledgerDir).ledger).size;
    expect(size).toBeLessThan(2_000 + 1_000); // at most one line past the cap
    expect(isObservationIncomplete(fx.ledgerDir)).toBe(true);
  });

  it('writes are append-only from several processes at once with no lost rows; racing writers create the marker once', async () => {
    const esbuild = await import('esbuild');
    const bundle = path.join(fx.base, 'ledger-writer.mjs');
    const entry = path.join(fx.base, 'ledger-writer-entry.ts');
    const src = path.resolve(__dirname, '../../src/core/guardScopeLedger.ts');
    fs.writeFileSync(entry, `import { recordDiff, _setLedgerCapForTesting } from ${JSON.stringify(src)};
const [dir, id, n, cap] = process.argv.slice(2);
if (cap) _setLedgerCapForTesting(Number(cap));
for (let i = 0; i < Number(n); i++) {
  recordDiff({ direction: 'would-deny', verb: 'unlink', recursive: false, reason: 'inside-source', caller: 'c', operation: 'w' + id + '-' + i, samplePath: '/p/' + id + '/' + i, targetClass: 'other' }, new Date(), dir);
}
`);
    esbuild.buildSync({ entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', outfile: bundle, logLevel: 'silent', banner: { js: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);" } });
    const writers = 6;
    const per = 150;
    await Promise.all(Array.from({ length: writers }, (_, id) => run(process.execPath, [bundle, fx.ledgerDir, String(id), String(per)])));
    const all = rows();
    expect(all).toHaveLength(writers * per);
    expect(new Set(all.map((r) => r.operation)).size).toBe(writers * per);
    // Racing writers at the cap: exactly one marker, created once.
    const capDir = path.join(fx.base, 'cap-ledger');
    fs.mkdirSync(capDir);
    fs.writeFileSync(ledgerPaths(capDir).ledger, 'x'.repeat(100) + '\n');
    await Promise.all(Array.from({ length: writers }, (_, id) => run(process.execPath, [bundle, capDir, String(id), '5', '10'])));
    expect(fs.readFileSync(ledgerPaths(capDir).incomplete, 'utf8').split('\n').filter(Boolean)).toHaveLength(1);
    expect(fs.statSync(ledgerPaths(capDir).ledger).size).toBe(101);
  }, 60_000);
});

describe('the tracked-file check runs git ls-files with the exit-code contract', () => {
  it('exit 0 = tracked, exit 1 = untracked, anything else = indeterminate', async () => {
    const tracked = path.join(fx.home, 'src', 'core', 'GitSync.ts');
    expect(defaultLsFiles(fx.home, tracked)).toBe('tracked');
    const untracked = path.join(fx.home, 'src', 'new.ts');
    fs.writeFileSync(untracked, '');
    expect(defaultLsFiles(fx.home, untracked)).toBe('untracked');
    expect(defaultLsFiles(fx.home, path.join(fx.home, 'src'))).toBe('tracked'); // a folder holding tracked files
    expect(defaultLsFiles(fx.outside, path.join(fx.outside, 'x'))).toBe('indeterminate'); // not a repository
  });
});
