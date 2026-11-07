import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('native update candidate with production CLI', () => {
  it('starts the real CLI and opens the real SQLite binding before promotion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-native-preflight-integration-'));
    const stateDir = path.join(dir, '.instar');
    const checkout = path.resolve(__dirname, '../..');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'instar-boot.cjs'), '// old wrapper without interrupted-update recovery');
    const checker = new UpdateChecker(stateDir);
    const version = checker.getInstalledVersion();
    const active = path.join(stateDir, 'shadow-install', 'node_modules', 'instar');
    fs.mkdirSync(active, { recursive: true });
    fs.writeFileSync(path.join(active, 'package.json'), JSON.stringify({ version: '0.0.1' }));
    vi.spyOn(checker, 'check').mockResolvedValue({ currentVersion: '0.0.1', latestVersion: version, updateAvailable: true, checkedAt: new Date().toISOString() });
    // Only npm is faked: the candidate's CLI and SQLite probes run through this helper too, and they
    // are what this test proves.
    const realExec = (checker as any).execAsync.bind(checker);
    vi.spyOn(checker as any, 'execAsync').mockImplementation(async (cmd: string, args: string[], timeoutMs: number) => {
      if (cmd !== 'npm') return realExec(cmd, args, timeoutMs);
      if (args[0] === 'install') {
        const nodeModules = path.join(args[args.indexOf('--prefix') + 1], 'node_modules');
        fs.mkdirSync(nodeModules, { recursive: true });
        fs.symlinkSync(checkout, path.join(nodeModules, 'instar'), 'dir');
        fs.symlinkSync(path.join(checkout, 'node_modules', 'better-sqlite3'), path.join(nodeModules, 'better-sqlite3'), 'dir');
      }
      return '';
    });
    try {
      const result = await checker.applyUpdate();
      expect(result.success).toBe(true);
      expect(result.restartNeeded).toBe(true);
      expect(checker.getShadowInstalledVersion()).toBe(version);
      expect(fs.readFileSync(path.join(stateDir, 'instar-boot.cjs'), 'utf-8')).toContain('Restored previous install after interrupted update');
    } finally {
      vi.restoreAllMocks();
      SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/integration/native-update-preflight.test.ts' });
    }
  });
});
