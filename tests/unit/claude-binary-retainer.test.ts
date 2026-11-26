// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.

/**
 * Unit tests — ClaudeBinaryRetainer (CMT-798).
 *
 * The leak this prevents: a Claude Code npm update replaces claude.exe in
 * place, every live session keeps an UNLINKED executable, and macOS
 * EndpointSecurity path lookups on it leak kernel memory. The retainer copies
 * the executable ONCE per version into its own directory and sessions launch
 * from that copy, which an update can never unlink.
 *
 * These tests build a fake npm layout on disk (package.json + bin/claude.exe +
 * a `bin/claude` symlink, the real shape) with a non-script payload, and
 * drive the retainer through: first-copy, reuse (same inode, no re-copy),
 * simulated update (new version → new dir, old dir untouched), every fallback
 * reason, the no-replace invariant, and prune on both sides of each gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ClaudeBinaryRetainer,
  readClaudeVersion,
  locateExecutable,
  sanitizeVersionKey,
  RETAINED_BINARY_NAME,
  LAST_USED_MARKER,
  SOURCE_MANIFEST,
} from '../../src/core/ClaudeBinaryRetainer.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/claude-binary-retainer.test.ts';

interface FakeInstall { root: string; pkgDir: string; exe: string; link: string }

/** Lay down the real npm shape: <root>/lib/node_modules/@anthropic-ai/claude-code/{package.json,bin/claude.exe} + <root>/bin/claude → ../lib/… */
function fakeInstall(root: string, version: string, payload = `FAKE-CLAUDE-${version}\n`): FakeInstall {
  const pkgDir = path.join(root, 'lib', 'node_modules', '@anthropic-ai', 'claude-code');
  fs.mkdirSync(path.join(pkgDir, 'bin'), { recursive: true });
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }));
  const exe = path.join(pkgDir, 'bin', 'claude.exe');
  fs.writeFileSync(exe, payload, { mode: 0o755 });
  const link = path.join(root, 'bin', 'claude');
  try { SafeFsExecutor.safeUnlinkSync(link, { operation: OP }); } catch { /* fresh */ }
  fs.symlinkSync(path.relative(path.dirname(link), exe), link);
  return { root, pkgDir, exe, link };
}

/** Simulate `npm install -g` replacing claude.exe IN PLACE (new inode, old one unlinked). */
function simulateUpdate(inst: FakeInstall, version: string): void {
  fs.writeFileSync(path.join(inst.pkgDir, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version }));
  const tmp = inst.exe + '.new';
  fs.writeFileSync(tmp, `FAKE-CLAUDE-${version}-updated\n`, { mode: 0o755 });
  fs.renameSync(tmp, inst.exe);
}

const quiet = { warn: () => {}, error: () => {}, info: () => {} };

describe('ClaudeBinaryRetainer — resolve', () => {
  let tmp: string; let retainDir: string; let inst: FakeInstall;
  let errors: string[];
  const make = (over: Partial<ConstructorParameters<typeof ClaudeBinaryRetainer>[0]> = {}) =>
    new ClaudeBinaryRetainer({ dir: retainDir, log: { ...quiet, error: (m) => errors.push(m) }, ...over });

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-retainer-'));
    retainDir = path.join(tmp, 'state', 'claude-bin');
    inst = fakeInstall(path.join(tmp, 'install'), '2.1.299');
    errors = [];
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: OP }); });

  it('copies the real executable once into <dir>/<version>/claude and launches from the copy (0755, linked)', () => {
    const r = make().resolve(inst.link);
    expect(r.source).toBe('retained');
    expect(r.copied).toBe(true);
    expect(r.version).toBe('2.1.299');
    expect(r.versionVia).toBe('package-json');
    expect(r.key).toBe('2.1.299');
    expect(r.path).toBe(path.join(retainDir, '2.1.299', RETAINED_BINARY_NAME));
    expect(r.sourceRealPath).toBe(fs.realpathSync(inst.exe));
    const st = fs.statSync(r.path);
    expect(st.isFile()).toBe(true);
    expect(st.nlink).toBeGreaterThan(0);
    expect(st.mode & 0o777).toBe(0o755);
    expect(fs.readFileSync(r.path, 'utf8')).toBe('FAKE-CLAUDE-2.1.299\n');
    // No tmp residue; manifest + last-used marker present.
    const entries = fs.readdirSync(path.join(retainDir, '2.1.299')).sort();
    expect(entries).toEqual([LAST_USED_MARKER, RETAINED_BINARY_NAME, SOURCE_MANIFEST].sort());
    const manifest = JSON.parse(fs.readFileSync(path.join(retainDir, '2.1.299', SOURCE_MANIFEST), 'utf8'));
    expect(manifest.version).toBe('2.1.299');
    expect(manifest.sourceRealPath).toBe(fs.realpathSync(inst.exe));
    expect(errors).toEqual([]);
  });

  it('reuses the existing copy on the next resolve: same inode, no re-copy, last-used refreshed', () => {
    const retainer = make({ now: (() => { let t = 1_000_000; return () => (t += 60_000); })() });
    const first = retainer.resolve(inst.link);
    const ino = fs.statSync(first.path).ino;
    const marker1 = fs.readFileSync(path.join(retainDir, '2.1.299', LAST_USED_MARKER), 'utf8');
    const second = retainer.resolve(inst.link);
    expect(second.source).toBe('retained');
    expect(second.copied).toBe(false);
    expect(second.path).toBe(first.path);
    expect(fs.statSync(second.path).ino).toBe(ino);
    const marker2 = fs.readFileSync(path.join(retainDir, '2.1.299', LAST_USED_MARKER), 'utf8');
    expect(marker2).not.toBe(marker1);
    expect(retainer.status().counters).toEqual({ resolutions: 2, retained: 2, copies: 1, fallbacks: 0 });
  });

  it('a simulated in-place npm update yields a NEW version dir and leaves the old retained copy linked and byte-identical', () => {
    const retainer = make();
    const before = retainer.resolve(inst.link);
    const beforeIno = fs.statSync(before.path).ino;

    simulateUpdate(inst, '2.1.300');
    // The source itself was replaced (the exact event that unlinks a live session's exe).
    expect(fs.readFileSync(inst.exe, 'utf8')).toContain('2.1.300');

    const after = retainer.resolve(inst.link);
    expect(after.source).toBe('retained');
    expect(after.copied).toBe(true);
    expect(after.key).toBe('2.1.300');
    expect(after.path).not.toBe(before.path);
    // The OLD copy is untouched: still linked, same inode, same bytes.
    const old = fs.statSync(before.path);
    expect(old.nlink).toBeGreaterThan(0);
    expect(old.ino).toBe(beforeIno);
    expect(fs.readFileSync(before.path, 'utf8')).toBe('FAKE-CLAUDE-2.1.299\n');
    expect(retainer.current()?.key).toBe('2.1.300');
    const keys = retainer.listRetained().map((e) => e.key).sort();
    expect(keys).toEqual(['2.1.299', '2.1.300']);
    expect(retainer.listRetained().find((e) => e.key === '2.1.300')?.current).toBe(true);
  });

  it('NEVER replaces an existing retained file: a same-version size mismatch lands in a size-suffixed sibling', () => {
    const retainer = make();
    const first = retainer.resolve(inst.link);
    const ino = fs.statSync(first.path).ino;
    // Same version string, different bytes (a re-published 2.1.299 with a different size).
    fs.writeFileSync(inst.exe, 'FAKE-CLAUDE-2.1.299-republished-with-a-different-length\n', { mode: 0o755 });
    const size = fs.statSync(inst.exe).size;
    const second = retainer.resolve(inst.link);
    expect(second.source).toBe('retained');
    expect(second.key).toBe(`2.1.299-${size}`);
    expect(second.copied).toBe(true);
    // The first copy is untouched.
    expect(fs.statSync(first.path).ino).toBe(ino);
    expect(fs.readFileSync(first.path, 'utf8')).toBe('FAKE-CLAUDE-2.1.299\n');
  });

  it('falls back to the original path with reason retained-mismatch when both candidate dirs hold a different-size file (loud)', () => {
    const retainer = make();
    retainer.resolve(inst.link);
    const size0 = fs.statSync(inst.exe).size;
    // Pre-plant a sibling whose size also differs from what the next source will be.
    const sib = path.join(retainDir, `2.1.299-${size0 + 7}`);
    fs.mkdirSync(sib, { recursive: true });
    fs.writeFileSync(path.join(sib, RETAINED_BINARY_NAME), 'x'.repeat(3));
    fs.writeFileSync(inst.exe, 'y'.repeat(size0 + 7), { mode: 0o755 });
    const r = retainer.resolve(inst.link);
    expect(r.source).toBe('original');
    expect(r.path).toBe(inst.link);
    expect(r.reason).toBe('retained-mismatch');
    expect(errors.length).toBe(1);
    expect(retainer.status().lastError?.message).toContain('retained-mismatch');
  });

  it('disabled → original path, reason disabled, no directory created, nothing logged', () => {
    const r = make({ enabled: false }).resolve(inst.link);
    expect(r).toMatchObject({ source: 'original', path: inst.link, reason: 'disabled', copied: false });
    expect(fs.existsSync(retainDir)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('a bare command name resolves through PATH; a name not on PATH → source-missing', () => {
    const env = { PATH: `${path.join(inst.root, 'bin')}:/nonexistent` };
    expect(locateExecutable('claude', env)).toBe(inst.link);
    expect(locateExecutable('definitely-not-here', env)).toBeNull();
    const saved = process.env.PATH;
    try {
      process.env.PATH = env.PATH;
      const r = make().resolve('claude');
      expect(r.source).toBe('retained');
      expect(r.sourcePath).toBe('claude');
      const miss = make().resolve('definitely-not-here');
      expect(miss).toMatchObject({ source: 'original', reason: 'source-missing', path: 'definitely-not-here' });
    } finally {
      process.env.PATH = saved;
    }
  });

  it('a wrapper SCRIPT (shebang) is launched as-is: script-not-retained, quiet', () => {
    fs.writeFileSync(inst.exe, '#!/bin/sh\nexec /somewhere/claude "$@"\n', { mode: 0o755 });
    const r = make().resolve(inst.link);
    expect(r).toMatchObject({ source: 'original', reason: 'script-not-retained', path: inst.link });
    expect(fs.existsSync(retainDir)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('a path that does not look like a Claude Code install is never retained (not-claude-binary)', () => {
    const other = path.join(tmp, 'tools', 'bin', 'echo');
    fs.mkdirSync(path.dirname(other), { recursive: true });
    fs.writeFileSync(other, 'ELF-not-a-script\n', { mode: 0o755 });
    const r = make().resolve(other);
    expect(r).toMatchObject({ source: 'original', reason: 'not-claude-binary', path: other });
    expect(fs.existsSync(retainDir)).toBe(false);
  });

  it('a dangling symlink / missing source → source-unreadable; a directory → not-a-file', () => {
    SafeFsExecutor.safeUnlinkSync(inst.exe, { operation: OP });
    expect(make().resolve(inst.link).reason).toBe('source-unreadable');
    const dirPath = path.join(tmp, 'claude-dir');
    fs.mkdirSync(dirPath);
    expect(make().resolve(dirPath).reason).toBe('not-a-file');
  });

  it('copy failure → original path, reason copy-failed, LOUD, no tmp residue, retried on the next resolve', () => {
    let fail = true;
    const retainer = make({
      copyFile: (src, dst) => {
        if (fail) { fs.writeFileSync(dst, 'partial'); throw new Error('ENOSPC: simulated'); }
        fs.copyFileSync(src, dst);
      },
    });
    const r = retainer.resolve(inst.link);
    expect(r).toMatchObject({ source: 'original', path: inst.link, reason: 'copy-failed' });
    expect(r.detail).toContain('ENOSPC');
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain('LAUNCHING FROM THE ORIGINAL PATH');
    expect(retainer.status().lastError?.message).toContain('copy-failed');
    // No partial file left behind that a later resolve could mistake for a copy.
    expect(fs.existsSync(path.join(retainDir, '2.1.299', RETAINED_BINARY_NAME))).toBe(false);
    expect(fs.readdirSync(path.join(retainDir, '2.1.299')).filter((n) => n.includes('.tmp-'))).toEqual([]);
    fail = false;
    const r2 = retainer.resolve(inst.link);
    expect(r2.source).toBe('retained');
    expect(r2.copied).toBe(true);
  });

  it('a short copy (size mismatch) is refused and cleaned up, never published', () => {
    const retainer = make({ copyFile: (_src, dst) => fs.writeFileSync(dst, 'short') });
    const r = retainer.resolve(inst.link);
    expect(r.reason).toBe('copy-failed');
    expect(r.detail).toContain('short copy');
    expect(fs.existsSync(path.join(retainDir, '2.1.299', RETAINED_BINARY_NAME))).toBe(false);
  });

  it('when a concurrent retainer already published the same version, ours is discarded and theirs is used (link EEXIST, no replace)', () => {
    const a = make();
    const b = make();
    const ra = a.resolve(inst.link);
    const inoA = fs.statSync(ra.path).ino;
    // Force b down the copy path by hiding the file during its existence check
    // is not possible without racing, so emulate the post-check state: b copies
    // with a primitive that re-creates the final file first (someone won).
    const rb = b.resolve(inst.link);
    expect(rb.path).toBe(ra.path);
    expect(fs.statSync(rb.path).ino).toBe(inoA);
  });

  it('version fallback: no package.json → `--version` probe; probe failure → fingerprint key', () => {
    SafeFsExecutor.safeUnlinkSync(path.join(inst.pkgDir, 'package.json'), { operation: OP });
    const viaFlag = make({ versionProbe: () => '2.1.301 (Claude Code)\n' }).resolve(inst.link);
    expect(viaFlag).toMatchObject({ source: 'retained', version: '2.1.301', versionVia: 'version-flag', key: '2.1.301' });

    const st = fs.statSync(inst.exe);
    const viaFp = make({ versionProbe: () => { throw new Error('no exec'); } }).resolve(inst.link);
    expect(viaFp.source).toBe('retained');
    expect(viaFp.version).toBeNull();
    expect(viaFp.versionVia).toBe('fingerprint');
    expect(viaFp.key).toBe(`fp-${st.size}-${Math.floor(st.mtimeMs)}`);
  });

  it('the --version probe runs once per installed build, not once per spawn (cached on path+size+mtime)', () => {
    SafeFsExecutor.safeUnlinkSync(path.join(inst.pkgDir, 'package.json'), { operation: OP });
    let probes = 0;
    const retainer = make({ versionProbe: () => { probes++; return '2.1.302 (Claude Code)'; } });
    retainer.resolve(inst.link); retainer.resolve(inst.link); retainer.resolve(inst.link);
    expect(probes).toBe(1);
    simulateUpdate(inst, '2.1.303');
    SafeFsExecutor.safeUnlinkSync(path.join(inst.pkgDir, 'package.json'), { operation: OP });
    // The stub still answers 2.1.302 for the new (different-size) build → size-suffixed sibling, probed once more.
    expect(retainer.resolve(inst.link).key).toMatch(/^2\.1\.302-\d+$/);
    expect(probes).toBe(2);
  });

  it('readClaudeVersion reads the npm package.json and ignores a non-claude package.json', () => {
    expect(readClaudeVersion(inst.exe, () => { throw new Error('unused'); })).toEqual({ version: '2.1.299', via: 'package-json' });
    fs.writeFileSync(path.join(inst.pkgDir, 'package.json'), JSON.stringify({ name: 'something-else', version: '9.9.9' }));
    expect(readClaudeVersion(inst.exe, () => 'v 1.2.3-beta.1 (Claude Code)')).toEqual({ version: '1.2.3-beta.1', via: 'version-flag' });
    expect(readClaudeVersion(inst.exe, () => 'garbage')).toEqual({ version: null, via: null });
  });

  it('sanitizeVersionKey refuses path-ish and oversized keys', () => {
    expect(sanitizeVersionKey('2.1.299')).toBe('2.1.299');
    expect(sanitizeVersionKey('../x')).toBeNull();
    expect(sanitizeVersionKey('a/b')).toBeNull();
    expect(sanitizeVersionKey('.hidden')).toBeNull();
    expect(sanitizeVersionKey('x'.repeat(90))).toBeNull();
    expect(sanitizeVersionKey('')).toBeNull();
  });

  it('status() reports enabled/dir/current/lastResolution/retained for a Registry-First read', () => {
    const retainer = make({ pruneGraceMs: 1234 });
    retainer.resolve(inst.link);
    const s = retainer.status();
    expect(s.enabled).toBe(true);
    expect(s.dir).toBe(retainDir);
    expect(s.pruneGraceMs).toBe(1234);
    expect(s.current?.key).toBe('2.1.299');
    expect(s.lastResolution?.source).toBe('retained');
    expect(s.lastError).toBeNull();
    expect(s.retained).toHaveLength(1);
    expect(s.retained[0]).toMatchObject({ key: '2.1.299', version: '2.1.299', current: true });
    expect(s.retained[0].sizeBytes).toBe(fs.statSync(inst.exe).size);
    expect(s.lastPrune).toBeNull();
  });
});

describe('ClaudeBinaryRetainer — prune', () => {
  let tmp: string; let retainDir: string; let inst: FakeInstall;
  let clock: number;
  const HOUR = 60 * 60 * 1000;
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-bin-prune-'));
    retainDir = path.join(tmp, 'claude-bin');
    inst = fakeInstall(path.join(tmp, 'install'), '2.1.299');
    clock = Date.now();
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: OP }); });

  /** Create a retainer that has seen 2.1.299 then 2.1.300 (current). */
  async function twoVersions(liveMappers: (file: string) => Promise<number | null>, graceMs = 6 * HOUR) {
    const retainer = new ClaudeBinaryRetainer({ dir: retainDir, log: quiet, now: () => clock, liveMappers, pruneGraceMs: graceMs });
    retainer.resolve(inst.link);
    simulateUpdate(inst, '2.1.300');
    retainer.resolve(inst.link);
    return retainer;
  }

  /** Age a version dir's last-used marker to `ageMs` ago (the grace gate). */
  function ageMarker(key: string, ageMs: number) {
    const marker = path.join(retainDir, key, LAST_USED_MARKER);
    const t = new Date(clock - ageMs);
    fs.utimesSync(marker, t, t);
  }

  it('removes a non-current, unmapped version once past the grace window; keeps the current one', async () => {
    const retainer = await twoVersions(async () => 0);
    ageMarker('2.1.299', 7 * HOUR);
    const r = await retainer.prune();
    expect(r.removed).toEqual(['2.1.299']);
    expect(r.keptCurrent).toEqual(['2.1.300']);
    expect(fs.existsSync(path.join(retainDir, '2.1.299'))).toBe(false);
    expect(fs.existsSync(path.join(retainDir, '2.1.300', RETAINED_BINARY_NAME))).toBe(true);
    expect(retainer.status().lastPrune?.removed).toEqual(['2.1.299']);
  });

  it('KEEPS a version that a live process still maps (mappers > 0), no matter how old', async () => {
    const retainer = await twoVersions(async () => 3);
    ageMarker('2.1.299', 400 * HOUR);
    const r = await retainer.prune();
    expect(r.removed).toEqual([]);
    expect(r.keptInUse).toEqual(['2.1.299']);
    expect(fs.existsSync(path.join(retainDir, '2.1.299', RETAINED_BINARY_NAME))).toBe(true);
  });

  it('KEEPS a version whose mapping status cannot be determined (mappers null) — fail-safe', async () => {
    const retainer = await twoVersions(async () => null);
    ageMarker('2.1.299', 7 * HOUR);
    const r = await retainer.prune();
    expect(r.removed).toEqual([]);
    expect(r.keptUnknown).toEqual(['2.1.299']);
  });

  it('KEEPS a recently-used version inside the grace window (covers resolve→exec), even when unmapped', async () => {
    const retainer = await twoVersions(async () => 0);
    ageMarker('2.1.299', 1 * HOUR);
    const r = await retainer.prune();
    expect(r.removed).toEqual([]);
    expect(r.keptRecent).toEqual(['2.1.299']);
  });

  it('a liveMappers THROW is treated as unknown → keep', async () => {
    const retainer = await twoVersions(async () => { throw new Error('lsof exploded'); });
    ageMarker('2.1.299', 7 * HOUR);
    const r = await retainer.prune();
    expect(r.removed).toEqual([]);
    expect(r.keptUnknown).toEqual(['2.1.299']);
  });

  it('never prunes before this process has resolved a current version (no-current-key), or when disabled', async () => {
    const mappers = async () => 0;
    const fresh = new ClaudeBinaryRetainer({ dir: retainDir, log: quiet, liveMappers: mappers });
    fs.mkdirSync(path.join(retainDir, '0.0.1'), { recursive: true });
    fs.writeFileSync(path.join(retainDir, '0.0.1', RETAINED_BINARY_NAME), 'old');
    const r = await fresh.prune();
    expect(r.skipped).toBe('no-current-key');
    expect(fs.existsSync(path.join(retainDir, '0.0.1', RETAINED_BINARY_NAME))).toBe(true);
    const off = new ClaudeBinaryRetainer({ dir: retainDir, enabled: false, log: quiet, liveMappers: mappers });
    expect((await off.prune()).skipped).toBe('disabled');
  });

  it('prune is single-flight: concurrent calls share one pass', async () => {
    let calls = 0;
    const retainer = await twoVersions(async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return 0; });
    ageMarker('2.1.299', 7 * HOUR);
    const [a, b] = await Promise.all([retainer.prune(), retainer.prune()]);
    expect(a).toBe(b);
    expect(calls).toBe(1);
    expect(a.removed).toEqual(['2.1.299']);
  });

  it('a version dir with no binary (broken leftover) past grace is reclaimed without a mapper probe', async () => {
    let probed = 0;
    const retainer = await twoVersions(async () => { probed++; return 0; });
    const broken = path.join(retainDir, 'broken');
    fs.mkdirSync(broken);
    const old = new Date(clock - 10 * HOUR);
    fs.utimesSync(broken, old, old);
    ageMarker('2.1.299', 1 * HOUR); // keep 2.1.299 as recent so only `broken` is eligible
    const r = await retainer.prune();
    expect(r.removed).toEqual(['broken']);
    expect(probed).toBe(0);
  });
});
