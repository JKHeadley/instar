import { describe, it, expect, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

describe('PostUpdateMigrator package template shape', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      SafeFsExecutor.safeRmSync(dir, {
        recursive: true,
        force: true,
        operation: 'tests/integration/PostUpdateMigrator-packageTemplateShape.test.ts cleanup',
      });
    }
  });

  it('publishes free-text guard under src/templates even when dist/templates is absent', () => {
    const raw = execFileSync('npm', ['pack', '--dry-run', '--json'], {
      cwd: repoRoot,
      encoding: 'utf-8',
      // The pack file-list JSON crossed execFileSync's 1MB default maxBuffer at
      // ~1.05MB (ENOBUFS, CI shard-4 2026-07-08) — same headroom as
      // npm-pack-templates-smoke.test.ts.
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as Array<{ files: Array<{ path: string }> }>;
    const files = new Set(parsed[0]?.files.map(file => file.path) ?? []);

    expect(files.has('src/templates/hooks/free-text-guard.sh')).toBe(true);
    expect([...files].some(file => file.startsWith('dist/templates/'))).toBe(false);
  });

  it('runs the packed compiled migrator with only the packaged source-template layout', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pack-template-shape-'));
    tempDirs.push(tmp);

    execFileSync('npx', ['tsc'], {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const raw = execFileSync('npm', ['pack', '--json', '--pack-destination', tmp], {
      cwd: repoRoot,
      encoding: 'utf-8',
      // Same ENOBUFS headroom as above — the --json file list is ~1MB.
      maxBuffer: 16 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const parsed = JSON.parse(raw) as Array<{ filename: string }>;
    const tarball = parsed[0]?.filename;
    expect(tarball).toBeTruthy();

    const extractDir = path.join(tmp, 'extract');
    fs.mkdirSync(extractDir, { recursive: true });
    execFileSync('tar', ['-xzf', path.join(tmp, tarball), '-C', extractDir], {
      cwd: repoRoot,
      stdio: 'ignore',
    });

    const packageDir = path.join(extractDir, 'package');
    const agentDir = path.join(tmp, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(packageDir, 'node_modules'), 'dir');
    expect(fs.existsSync(path.join(packageDir, 'src', 'templates', 'hooks', 'free-text-guard.sh'))).toBe(true);
    expect(fs.existsSync(path.join(packageDir, 'dist', 'templates'))).toBe(false);

    const originalCwd = process.cwd();
    process.chdir(tmp);
    try {
      const migratorUrl = pathToFileURL(path.join(packageDir, 'dist', 'core', 'PostUpdateMigrator.js')).href;
      const { PostUpdateMigrator } = await import(
        `${migratorUrl}?packagedSmoke=${Date.now()}`
      );
      const result = { upgraded: [], skipped: [], errors: [] };
      const migrator = new PostUpdateMigrator({
        projectDir: agentDir,
        stateDir: path.join(agentDir, '.instar'),
        port: 4044,
        hasTelegram: true,
        projectName: 'packaged-template-smoke',
      });

      (migrator as unknown as {
        migrateHooks(result: { upgraded: string[]; skipped: string[]; errors: string[] }): void;
      }).migrateHooks(result);

      const installedHook = path.join(agentDir, '.instar', 'hooks', 'instar', 'free-text-guard.sh');
      const sourceTemplate = path.join(packageDir, 'src', 'templates', 'hooks', 'free-text-guard.sh');

      expect(fs.readFileSync(installedHook, 'utf-8')).toBe(fs.readFileSync(sourceTemplate, 'utf-8'));
      expect(result.errors.filter(error => error.includes('free-text-guard'))).toEqual([]);
      expect(result.upgraded.some(entry => entry.includes('free-text-guard.sh'))).toBe(true);
    } finally {
      process.chdir(originalCwd);
    }
  });
});
