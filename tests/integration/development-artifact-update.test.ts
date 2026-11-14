import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('development artifact through the real npm installation pipeline', () => {
  it('installs an offline tarball, opens native SQLite, promotes it and runs its migration', async () => {
    const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-development-artifact-integration-'));
    const fixture = path.join(temp, 'package');
    const stateDir = path.join(temp, 'agent', '.instar');
    const agentHome = path.dirname(stateDir);
    const version = '1.3.1719-dev.1794096000.123456789abc';
    const checkoutRequire = createRequire(import.meta.url);
    const previousEnv = Object.fromEntries(['npm_config_cache', 'npm_config_offline', 'npm_config_audit', 'npm_config_fund']
      .map(key => [key, process.env[key]]));
    try {
      process.env.npm_config_cache = path.join(temp, 'npm-cache');
      process.env.npm_config_offline = 'true';
      process.env.npm_config_audit = 'false';
      process.env.npm_config_fund = 'false';
      fs.mkdirSync(path.join(fixture, 'dist'), { recursive: true });
      const modules = path.join(fixture, 'node_modules');
      const dependencies: Record<string, string> = {};
      for (const name of ['better-sqlite3', 'bindings', 'file-uri-to-path']) {
        const source = path.dirname(checkoutRequire.resolve(`${name}/package.json`));
        const target = path.join(modules, name);
        const pkg = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
        dependencies[name] = pkg.version;
        if (name === 'better-sqlite3') {
          // Reuse the checkout's REAL compiled native binding, not a JS stand-in.
          // The fixture bundles only its runtime files so the test remains
          // offline. npm rebuild is real, but compilation is already complete.
          fs.mkdirSync(path.join(target, 'build', 'Release'), { recursive: true });
          fs.cpSync(path.join(source, 'lib'), path.join(target, 'lib'), { recursive: true });
          fs.copyFileSync(path.join(source, 'build', 'Release', 'better_sqlite3.node'),
            path.join(target, 'build', 'Release', 'better_sqlite3.node'));
          fs.writeFileSync(path.join(target, 'package.json'), JSON.stringify({ name, version: pkg.version,
            main: pkg.main, files: ['lib', 'build/Release'], dependencies: { bindings: dependencies.bindings ?? '1.5.0' } }));
        } else {
          fs.cpSync(source, target, { recursive: true });
        }
      }
      fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({ name: 'instar', version,
        type: 'module', files: ['dist'], dependencies, bundledDependencies: Object.keys(dependencies) }));
      fs.writeFileSync(path.join(fixture, 'dist', 'cli.js'), `
        import fs from 'node:fs'; import path from 'node:path';
        if (process.argv.includes('--version')) console.log(${JSON.stringify(version)});
        else if (process.argv.includes('migrate')) {
          const home=process.argv[process.argv.indexOf('--dir')+1];
          fs.writeFileSync(path.join(home, 'development-migration-ran'), ${JSON.stringify(version)});
          // Real migration output can exceed execFile's default 1 MiB.
          console.log(JSON.stringify({upgraded: ['development-migration-ran'], errors: [], details: 'm'.repeat(1_200_000)}));
        } else process.exitCode=1;
      `);
      const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temp],
        { cwd: fixture, encoding: 'utf8', timeout: 30_000, maxBuffer: 4 * 1024 * 1024 }));
      const artifactPath = path.join(temp, packed[0].filename);
      const sha512 = createHash('sha512').update(fs.readFileSync(artifactPath)).digest('hex');
      const active = path.join(stateDir, 'shadow-install', 'node_modules', 'instar');
      fs.mkdirSync(path.join(active, 'dist'), { recursive: true });
      fs.writeFileSync(path.join(active, 'package.json'), JSON.stringify({ version: '1.3.1700' }));
      fs.writeFileSync(path.join(active, 'dist', 'cli.js'), '// prior active install');
      const checker = new UpdateChecker({ stateDir, projectDir: agentHome });
      const result = await checker.applyDevelopmentArtifact({ path: artifactPath, version, sha512 });
      expect(result.success, result.message).toBe(true);
      expect(result.previousVersion).toBe('1.3.1700');
      expect(result.restartNeeded).toBe(true);
      expect(result.message).toContain('Intelligence download: 1 files upgraded (development-migration-ran)');
      expect(checker.getShadowInstalledVersion()).toBe(version);
      expect(fs.readFileSync(path.join(agentHome, 'development-migration-ran'), 'utf8')).toBe(version);
      expect(checker.getRollbackInfo()?.previousVersion).toBe('1.3.1700');
      expect(fs.existsSync(path.join(stateDir, 'shadow-install.previous'))).toBe(false);
      const installedRequire = createRequire(path.join(active, 'dist', 'cli.js'));
      const Database = installedRequire('better-sqlite3');
      const db = new Database(':memory:');
      try {
        expect(db.prepare('SELECT 42 AS answer').get()).toEqual({ answer: 42 });
      } finally { db.close(); }
    } finally {
      for (const [key, value] of Object.entries(previousEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      SafeFsExecutor.safeRmSync(temp, { recursive: true, force: true,
        operation: 'tests/integration/development-artifact-update.test.ts:cleanup' });
    }
  });
});
