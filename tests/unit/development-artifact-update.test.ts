import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'development-artifact-test:cleanup' }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'development-update-test-'));
  dirs.push(dir);
  const artifact = path.join(dir, 'artifact.tgz');
  fs.writeFileSync(artifact, 'trusted package bytes');
  const version = '1.3.1719-dev.1794096000.123456789abc';
  const sha512 = createHash('sha512').update(fs.readFileSync(artifact)).digest('hex');
  const checker = new UpdateChecker(dir);
  vi.spyOn(checker, 'getInstalledVersion').mockReturnValue('1.3.1719');
  return { dir, artifact, version, sha512, checker };
}

describe('explicit development artifact installs', () => {
  it('rejects corrupt bytes before npm or the active install is touched', async () => {
    const f = fixture();
    const check = vi.spyOn(f.checker, 'check');
    await expect(f.checker.applyDevelopmentArtifact({ path: f.artifact, version: f.version, sha512: '0'.repeat(128) }))
      .rejects.toThrow('checksum mismatch');
    expect(check).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(f.dir, 'shadow-install'))).toBe(false);
  });

  it('rejects a stable version masquerading as a development artifact', async () => {
    const f = fixture();
    await expect(f.checker.applyDevelopmentArtifact({ path: f.artifact, version: '9.0.0', sha512: f.sha512 }))
      .rejects.toThrow('development artifact version');
  });

  it('installs a verified snapshot and executes the real validation and promotion pipeline', async () => {
    const f = fixture();
    const oldPkg = path.join(f.dir, 'shadow-install/node_modules/instar');
    fs.mkdirSync(path.join(oldPkg, 'dist'), { recursive: true });
    const oldVersion = '1.3.1710-dev.1794000000.abcdef123456';
    fs.writeFileSync(path.join(oldPkg, 'package.json'), JSON.stringify({ version: oldVersion }));
    fs.writeFileSync(path.join(oldPkg, 'dist/cli.js'), '// prior install');
    const check = vi.spyOn(f.checker, 'check');
    let snapshot = '';
    const calls: string[][] = [];
    const seam = f.checker as unknown as { execAsync(cmd: string, args: string[]): Promise<string>; stripCandidateXattrs(): Promise<void> };
    vi.spyOn(seam, 'stripCandidateXattrs').mockResolvedValue();
    vi.spyOn(seam, 'execAsync').mockImplementation(async (_cmd, args) => {
      calls.push(args);
      if (args[0] === 'install') {
        snapshot = args[1];
        expect(snapshot).not.toBe(f.artifact);
        fs.writeFileSync(f.artifact, 'changed after verification');
        expect(fs.readFileSync(snapshot, 'utf8')).toBe('trusted package bytes');
        const prefix = args[args.indexOf('--prefix') + 1];
        const pkgDir = path.join(prefix, 'node_modules/instar');
        fs.mkdirSync(path.join(pkgDir, 'dist'), { recursive: true });
        fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ version: f.version }));
        fs.writeFileSync(path.join(pkgDir, 'dist/cli.js'), '// runnable fixture');
      }
      return args.includes('--version') ? f.version : '';
    });
    const result = await f.checker.applyDevelopmentArtifact({ path: f.artifact, version: f.version, sha512: f.sha512 });
    expect(result.success).toBe(true);
    expect(result.previousVersion).toBe(oldVersion);
    expect(result.restartNeeded).toBe(true);
    expect(check).not.toHaveBeenCalled();
    expect(calls.some(args => args[0] === 'rebuild' && args[1] === 'better-sqlite3')).toBe(true);
    expect(calls.some(args => args[0] === '-e' && args[1].includes('SELECT 1'))).toBe(true);
    expect(f.checker.getShadowInstalledVersion()).toBe(f.version);
    expect(fs.existsSync(snapshot)).toBe(false);
    expect(fs.existsSync(path.join(f.dir, 'state/update-rollback.json'))).toBe(true);
    expect(f.checker.getRollbackInfo()?.previousVersion).toBe('1.3.1710');
  });

  it('returns to the stable channel when a later patch appears', async () => {
    const f = fixture();
    vi.mocked(f.checker.getInstalledVersion).mockReturnValue(f.version);
    const seam = f.checker as unknown as { execAsync(cmd: string, args: string[]): Promise<string> };
    vi.spyOn(seam, 'execAsync').mockResolvedValue('1.3.1720');
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false } as Response);
    expect((await f.checker.check()).updateAvailable).toBe(true);
  });
});
