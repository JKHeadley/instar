import { afterEach, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compareVersions, DesktopHelperRetention, helperManifestPath } from '../../src/core/DesktopHelperRetention.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const roots: string[] = [];
const FAT = Buffer.from([0xca, 0xfe, 0xba, 0xbe]);
const hash = (name: string) => crypto.createHash('sha256').update(name).digest('hex');

function world() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-helper-'));
  roots.push(dir);
  const packagedBinary = path.join(dir, 'pkg', 'instar-desktop-host');
  fs.mkdirSync(path.dirname(packagedBinary));
  const ship = (bytes: string, source: string | null, head = FAT) => {
    fs.writeFileSync(packagedBinary, Buffer.concat([head, Buffer.from(bytes)]), { mode: 0o755 });
    if (source === null) SafeFsExecutor.safeRmSync(helperManifestPath(packagedBinary), { force: true, operation: 'tests/unit/DesktopHelperRetention.test.ts:no-manifest' });
    else fs.writeFileSync(helperManifestPath(packagedBinary), JSON.stringify({ sourceHash: hash(source) }));
  };
  const agent = (packageVersion: string, enabled?: boolean) => new DesktopHelperRetention({
    packagedBinary, packageVersion, root: path.join(dir, 'host'), enabled, log: () => undefined });
  return { dir, packagedBinary, ship, agent, retained: path.join(dir, 'host', 'instar-desktop-host') };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/unit/DesktopHelperRetention.test.ts:cleanup' });
  }
});

describe('DesktopHelperRetention', () => {
  it('keeps the same file when bytes differ but the source does not', () => {
    const w = world();
    w.ship('toolchain-a', 'source-1');
    const first = w.agent('1.3.100');
    expect(first.resolve()).toEqual({ path: w.retained, source: 'retained' });
    first.noteGranted();
    const kept = fs.readFileSync(w.retained);
    const ino = fs.statSync(w.retained).ino;
    w.ship('toolchain-b-rebuilt', 'source-1');
    const updated = w.agent('1.3.101');
    expect(updated.resolve().source).toBe('retained');
    expect(fs.readFileSync(w.retained).equals(kept)).toBe(true);
    expect(fs.statSync(w.retained).ino).toBe(ino);
    expect(updated.permissionChange()).toBeNull();
  });

  it('replaces the file when the source changes and names the change', () => {
    const w = world();
    w.ship('old', 'source-1');
    const first = w.agent('1.3.100');
    first.resolve();
    first.noteGranted();
    const oldIno = fs.statSync(w.retained).ino;
    w.ship('new', 'source-2');
    const updated = w.agent('1.3.101');
    updated.resolve();
    expect(fs.statSync(w.retained).ino).not.toBe(oldIno);
    expect(fs.readFileSync(w.retained).subarray(4).toString()).toBe('new');
    expect(updated.permissionChange()).toEqual({ kind: 'source-changed', version: '1.3.101', helperPath: w.retained });
    updated.noteGranted();
    expect(updated.permissionChange()).toBeNull();
  });

  it('calls a Mac that never granted the kept copy a first grant, not a change', () => {
    const w = world();
    w.ship('x', 'source-1');
    const first = w.agent('1.3.100');
    first.resolve();
    expect(first.permissionChange()?.kind).toBe('first-grant');
  });

  it('never lets an older agent swap the helper back', () => {
    const w = world();
    w.ship('new', 'source-2');
    w.agent('1.3.101').resolve();
    w.ship('old', 'source-1');
    expect(w.agent('1.3.100').resolve()).toEqual({ path: w.packagedBinary, source: 'packaged', reason: 'older-than-retained' });
    expect(fs.readFileSync(w.retained).subarray(4).toString()).toBe('new');
  });

  it('refuses a same-version source swap, which is a development build', () => {
    const w = world();
    w.ship('a', 'source-1');
    w.agent('1.3.100').resolve();
    w.ship('b', 'source-2');
    expect(w.agent('1.3.100').resolve().reason).toBe('same-version-different-source');
  });

  it.each([
    ['no manifest', () => null, FAT, 'no-manifest'],
    ['a thin local build', () => 'source-1', Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), 'not-release-build'],
  ])('uses the installed copy for %s', (_name, source, head, reason) => {
    const w = world();
    w.ship('x', source(), head);
    expect(w.agent('1.3.100').resolve()).toEqual({ path: w.packagedBinary, source: 'packaged', reason });
    expect(fs.existsSync(w.retained)).toBe(false);
  });

  it('honours the off switch', () => {
    const w = world();
    w.ship('x', 'source-1');
    expect(w.agent('1.3.100', false).resolve().source).toBe('packaged');
    expect(fs.existsSync(w.retained)).toBe(false);
  });

  it('restores a tampered copy from the package', () => {
    const w = world();
    w.ship('good', 'source-1');
    w.agent('1.3.100').resolve();
    fs.writeFileSync(w.retained, 'tampered');
    expect(w.agent('1.3.100').resolve().source).toBe('retained');
    expect(fs.readFileSync(w.retained).subarray(4).toString()).toBe('good');
  });

  it('notices a replacement during a long-lived process', () => {
    const w = world();
    w.ship('good', 'source-1');
    const running = w.agent('1.3.100');
    running.resolve();
    fs.writeFileSync(w.retained, 'tampered-longer-than-before');
    expect(running.resolve().source).toBe('retained');
    expect(fs.readFileSync(w.retained).subarray(4).toString()).toBe('good');
  });

  it('replaces a copy others could write instead of running it', () => {
    const w = world();
    w.ship('good', 'source-1');
    w.agent('1.3.100').resolve();
    fs.chmodSync(w.retained, 0o777);
    expect(w.agent('1.3.100').resolve().source).toBe('retained');
    expect(fs.statSync(w.retained).mode & 0o022).toBe(0);
  });

  it('refuses a kept folder that is a symlink', () => {
    const w = world();
    w.ship('good', 'source-1');
    const elsewhere = path.join(w.dir, 'elsewhere');
    fs.mkdirSync(elsewhere, { mode: 0o700 });
    fs.symlinkSync(elsewhere, path.join(w.dir, 'host'));
    expect(w.agent('1.3.100').resolve()).toEqual({ path: w.packagedBinary, source: 'packaged', reason: 'retained-unsafe' });
  });

  it('falls back when the kept folder cannot be written', () => {
    const w = world();
    w.ship('x', 'source-1');
    fs.writeFileSync(path.join(w.dir, 'host'), 'a file where the folder belongs');
    expect(w.agent('1.3.100').resolve()).toEqual({ path: w.packagedBinary, source: 'packaged', reason: 'copy-failed' });
  });

  it('stays on the installed copy for the process once marked broken', () => {
    const w = world();
    w.ship('x', 'source-1');
    const agent = w.agent('1.3.100');
    agent.resolve();
    agent.markBroken();
    expect(agent.resolve().source).toBe('packaged');
  });

  it('lets one agent on a Mac raise the notice for one helper', () => {
    const w = world();
    w.ship('x', 'source-1');
    const a = w.agent('1.3.100');
    const b = w.agent('1.3.100');
    a.resolve();
    expect(a.claimNotice()).toBe(true);
    expect(b.claimNotice()).toBe(false);
    a.noteGranted();
    expect(b.claimNotice()).toBe(true);
    b.releaseNotice();
    expect(a.claimNotice()).toBe(true);
  });

  it('says a grant is needed after restoring damaged bytes, instead of implying it is fine', () => {
    const w = world();
    w.ship('good', 'source-1');
    const first = w.agent('1.3.100');
    first.resolve();
    first.noteGranted();
    fs.writeFileSync(w.retained, 'tampered');
    const after = w.agent('1.3.100');
    after.resolve();
    expect(after.permissionChange()?.kind).toBe('first-grant');
  });

  it('names an unrunnable copy instead of calling it disabled', () => {
    const w = world();
    w.ship('x', 'source-1');
    const agent = w.agent('1.3.100');
    agent.resolve();
    agent.markBroken();
    expect(agent.resolve().reason).toBe('retained-unrunnable');
  });

  it('compares versions numerically', () => {
    expect(compareVersions('1.3.1000', '1.3.999')).toBe(1);
    expect(compareVersions('1.3.5', '1.3.5')).toBe(0);
    expect(compareVersions('1.2.9', '1.3.0')).toBe(-1);
  });
});
