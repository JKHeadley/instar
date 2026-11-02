import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MacDesktopHost } from '../../src/core/MacDesktopHost.js';
import { DesktopHelperRetention, helperManifestPath } from '../../src/core/DesktopHelperRetention.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const built = path.resolve('dist/native/instar-desktop-host');
const skip = process.platform !== 'darwin' || !fs.existsSync(built);
const arch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

// A real signed helper in a real universal wrapper, walked through an update:
// this is the part a fake script cannot prove, that a copied helper still runs
// and still carries its signature, and that an update leaves it alone.
describe.skipIf(skip)('kept Mac desktop helper across updates', () => {
  const packaged = path.resolve('dist/native', `instar-desktop-retention-test-${process.pid}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'desktop-helper-e2e-'));
  const hostRoot = path.join(root, 'host');
  const ship = (sourceHash: string, identifier: string) => {
    const thin = path.join(root, 'thin');
    const info = spawnSync('lipo', ['-archs', built], { encoding: 'utf8' }).stdout.trim().split(/\s+/);
    if (info.length > 1) expect(spawnSync('lipo', ['-thin', arch, built, '-output', thin]).status).toBe(0);
    else fs.copyFileSync(built, thin);
    expect(spawnSync('codesign', ['--force', '--identifier', identifier, '--sign', '-', thin]).status).toBe(0);
    SafeFsExecutor.safeRmSync(packaged, { force: true, operation: 'tests/e2e/desktop-helper-retention-lifecycle.test.ts:ship' });
    expect(spawnSync('lipo', ['-create', thin, '-output', packaged]).status).toBe(0);
    fs.chmodSync(packaged, 0o755);
    fs.writeFileSync(helperManifestPath(packaged), JSON.stringify({ sourceHash }));
  };
  const host = (packageVersion: string) => {
    const retention = new DesktopHelperRetention({ packagedBinary: packaged, packageVersion, root: hostRoot, log: () => undefined });
    return { retention, host: new MacDesktopHost(packaged, retention) };
  };
  const kept = path.join(hostRoot, 'instar-desktop-host');

  beforeAll(() => { fs.mkdirSync(hostRoot, { recursive: true, mode: 0o700 }); });
  afterAll(() => {
    for (const file of [packaged, helperManifestPath(packaged)]) {
      SafeFsExecutor.safeRmSync(file, { force: true, operation: 'tests/e2e/desktop-helper-retention-lifecycle.test.ts:cleanup' });
    }
    SafeFsExecutor.safeRmSync(root, { recursive: true, force: true, operation: 'tests/e2e/desktop-helper-retention-lifecycle.test.ts:cleanup' });
  });

  it('runs a real probe from the kept path, with its signature intact', async () => {
    ship(HASH_A, 'ai.instar.desktop-host');
    const first = host('1.3.100');
    const probe = await first.host.probe();
    expect(probe.helperSource).toBe('retained');
    expect(typeof probe.screenPermission).toBe('boolean');
    expect(spawnSync('codesign', ['--verify', kept]).status).toBe(0);
  });

  it('leaves the kept file alone when an update brings new bytes from the same source', async () => {
    const before = fs.statSync(kept);
    const bytes = fs.readFileSync(kept);
    // A different signature makes different bytes, as a new toolchain would.
    ship(HASH_A, 'ai.instar.desktop-host.rebuilt');
    expect(fs.readFileSync(packaged).equals(bytes)).toBe(false);
    const probe = await host('1.3.101').host.probe();
    expect(probe.helperSource).toBe('retained');
    expect(fs.statSync(kept).ino).toBe(before.ino);
    expect(fs.readFileSync(kept).equals(bytes)).toBe(true);
  });

  it('replaces it when the source changes, and the new copy still runs', async () => {
    const before = fs.statSync(kept).ino;
    ship(HASH_B, 'ai.instar.desktop-host.changed');
    const probe = await host('1.3.102').host.probe();
    expect(probe.helperSource).not.toBeUndefined();
    expect(fs.statSync(kept).ino).not.toBe(before);
    expect(spawnSync('codesign', ['--verify', kept]).status).toBe(0);
    expect(spawnSync(kept, ['probe'], { env: { PATH: '/usr/bin:/bin' }, timeout: 10_000 }).status).toBe(0);
  });
});
