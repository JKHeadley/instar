/**
 * Unit tests for UpdateChecker.applyUpdate() and fetchChangelog().
 *
 * Covers: changelog fetching, update application, version verification,
 * error handling, and edge cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type ExecSeam = { execAsync(cmd: string, args: string[], timeoutMs: number): Promise<string> };

describe('UpdateChecker.applyUpdate()', () => {
  let tmpDir: string;
  let checker: UpdateChecker;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-update-apply-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/update-checker-apply.test.ts:29' });
  });

  it('returns already-up-to-date when no update available', async () => {
    // Mock check to return no update available
    vi.spyOn(checker, 'check').mockResolvedValue({
      currentVersion: '0.1.12',
      latestVersion: '0.1.12',
      updateAvailable: false,
      checkedAt: new Date().toISOString(),
    });
    vi.spyOn(checker, 'getInstalledVersion').mockReturnValue('0.1.12');

    const result = await checker.applyUpdate();

    expect(result.success).toBe(true);
    expect(result.restartNeeded).toBe(false);
    expect(result.message).toContain('Already up to date');
    expect(result.healthCheck).toBe('skipped');
  });

  it('returns structured result on update failure', async () => {
    vi.spyOn(checker, 'check').mockResolvedValue({
      currentVersion: '0.1.10',
      latestVersion: '0.1.12',
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
    });

    // Mock the exec seam so no real npm runs: a unit test must never reach the
    // network. Before 2026-09-03 this relied on a REAL npm invocation failing
    // fast; a slow registry made it hang to the 30s timeout on every CI shard
    // and locally (ACT-361).
    vi.spyOn(checker as never as { execAsync(cmd: string, args: string[], t: number): Promise<string> }, 'execAsync' as never)
      .mockRejectedValue(new Error('npm install failed (mocked network seam)'));
    const result = await checker.applyUpdate();

    // Should return a structured result even on failure
    expect(result).toHaveProperty('success');
    expect(result).toHaveProperty('previousVersion');
    expect(result).toHaveProperty('newVersion');
    expect(result).toHaveProperty('message');
    expect(result).toHaveProperty('restartNeeded');
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
  }, 30000);

  it('includes changeSummary in message when available', async () => {
    vi.spyOn(checker, 'check').mockResolvedValue({
      currentVersion: '0.1.10',
      latestVersion: '0.1.12',
      updateAvailable: true,
      checkedAt: new Date().toISOString(),
      changeSummary: 'Fixed security issues and improved performance',
    });
    // Same mocked exec seam as above — never a real npm call (ACT-361).
    vi.spyOn(checker as never as { execAsync(cmd: string, args: string[], t: number): Promise<string> }, 'execAsync' as never)
      .mockRejectedValue(new Error('npm install failed (mocked network seam)'));

    const result = await checker.applyUpdate();

    // Even if the npm update fails, the result should be structured
    expect(result).toHaveProperty('message');
    expect(typeof result.message).toBe('string');
  }, 30000);
});

describe('UpdateChecker.fetchChangelog()', () => {
  let tmpDir: string;
  let checker: UpdateChecker;
  let originalFetch: typeof global.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-changelog-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
    originalFetch = global.fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/update-checker-apply.test.ts:104' });
  });

  it('returns changelog body from GitHub release', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        body: 'Fixed a critical bug in session management.\nImproved health checks.',
        name: 'v0.1.12',
      }),
    });

    const result = await checker.fetchChangelog('0.1.12');

    expect(result).toBeDefined();
    expect(result).toContain('critical bug');
    expect(result).toContain('health checks');
  });

  it('prepends v to version if missing', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body: 'Changelog text', name: 'v0.1.12' }),
    });
    global.fetch = mockFetch;

    await checker.fetchChangelog('0.1.12');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/tags/v0.1.12'),
      expect.any(Object),
    );
  });

  it('does not double-prepend v', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body: 'Changelog', name: 'v0.1.12' }),
    });
    global.fetch = mockFetch;

    await checker.fetchChangelog('v0.1.12');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/tags/v0.1.12'),
      expect.any(Object),
    );
    // Should NOT contain /tags/vv0.1.12
    const url = (mockFetch.mock.calls[0][0] as string);
    expect(url).not.toContain('vv');
  });

  it('truncates long changelogs to 500 chars', async () => {
    const longBody = 'A'.repeat(600);
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body: longBody, name: 'v0.1.12' }),
    });

    const result = await checker.fetchChangelog('0.1.12');

    expect(result).toBeDefined();
    expect(result!.length).toBeLessThanOrEqual(503); // 500 + '...'
    expect(result).toContain('...');
  });

  it('returns release name when body is empty', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ body: '', name: 'Security Update v0.1.12' }),
    });

    const result = await checker.fetchChangelog('0.1.12');

    expect(result).toBe('Security Update v0.1.12');
  });

  it('returns undefined on 404', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });

    const result = await checker.fetchChangelog('99.99.99');

    expect(result).toBeUndefined();
  });

  it('returns undefined on network error', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network unreachable'));

    const result = await checker.fetchChangelog('0.1.12');

    expect(result).toBeUndefined();
  });

  it('returns undefined on timeout', async () => {
    global.fetch = vi.fn().mockRejectedValue(new DOMException('Aborted', 'AbortError'));

    const result = await checker.fetchChangelog('0.1.12');

    expect(result).toBeUndefined();
  });
});

describe('UpdateChecker.rollback()', () => {
  let tmpDir: string;
  let checker: UpdateChecker;
  let exec: MockInstance<ExecSeam['execAsync']>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-rollback-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
    vi.spyOn(checker, 'getInstalledVersion').mockReturnValue('0.1.12');
    exec = vi.spyOn(checker as unknown as ExecSeam, 'execAsync')
      .mockRejectedValue(new Error('fixture install unavailable'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/update-checker-apply.test.ts:218' });
  });

  it('returns error when no rollback info exists', async () => {
    expect(checker.canRollback()).toBe(false);

    const result = await checker.rollback();
    expect(result.success).toBe(false);
    expect(result.message).toContain('No rollback info');
    expect(exec).not.toHaveBeenCalled();
  });

  it('canRollback returns true after saving rollback info', () => {
    // Simulate a successful update by writing rollback file
    const rollbackFile = path.join(tmpDir, 'state', 'update-rollback.json');
    fs.writeFileSync(rollbackFile, JSON.stringify({
      previousVersion: '0.1.11',
      updatedVersion: '0.1.12',
      updatedAt: new Date().toISOString(),
    }));

    expect(checker.canRollback()).toBe(true);
  });

  it('getRollbackInfo returns saved data', () => {
    const rollbackFile = path.join(tmpDir, 'state', 'update-rollback.json');
    const info = {
      previousVersion: '0.1.11',
      updatedVersion: '0.1.12',
      updatedAt: '2026-02-20T00:00:00Z',
    };
    fs.writeFileSync(rollbackFile, JSON.stringify(info));

    const result = checker.getRollbackInfo();
    expect(result).toEqual(info);
  });

  it('getRollbackInfo returns null when file missing', () => {
    expect(checker.getRollbackInfo()).toBeNull();
  });

  it('getRollbackInfo returns null on corrupted file', () => {
    const rollbackFile = path.join(tmpDir, 'state', 'update-rollback.json');
    fs.writeFileSync(rollbackFile, 'bad json {{');

    expect(checker.getRollbackInfo()).toBeNull();
  });

  it('attempts npm install with previous version', async () => {
    const rollbackFile = path.join(tmpDir, 'state', 'update-rollback.json');
    fs.writeFileSync(rollbackFile, JSON.stringify({
      previousVersion: '0.1.11',
      updatedVersion: '0.1.12',
      updatedAt: new Date().toISOString(),
    }));

    // Exercise real rollback handling without launching npm or using the network.
    const result = await checker.rollback();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('npm', [
      'install', 'instar@0.1.11', '--ignore-scripts',
      '--prefix', path.join(tmpDir, 'shadow-install'),
    ], 120000);
    expect(result).toEqual({
      success: false, previousVersion: '0.1.12', restoredVersion: '0.1.12',
      message: 'Rollback failed: fixture install unavailable',
    });
    expect(checker.getRollbackInfo()).toMatchObject({
      previousVersion: '0.1.11', updatedVersion: '0.1.12',
    });
  });

  it('refuses rollback below the delivery compatibility floor while evidence is live', async () => {
    fs.writeFileSync(path.join(tmpDir, 'state', 'update-rollback.json'), JSON.stringify({
      previousVersion: '0.1.11', updatedVersion: '0.1.12', updatedAt: new Date().toISOString(),
    }));
    fs.writeFileSync(path.join(tmpDir, 'state', 'codex-lifecycle-downgrade-floor.json'), JSON.stringify({ liveEvidence: 1 }));
    const result = await checker.rollback();
    expect(result.success).toBe(false);
    expect(result.message).toContain('compatibility-projector floor');
    expect(exec).not.toHaveBeenCalled();
  });
});

describe('UpdateChecker.check() with changeSummary', () => {
  let tmpDir: string;
  let checker: UpdateChecker;
  let exec: MockInstance<ExecSeam['execAsync']>;
  let changelog: MockInstance<UpdateChecker['fetchChangelog']>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-check-summary-'));
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
    vi.spyOn(checker, 'getInstalledVersion').mockReturnValue('0.1.11');
    exec = vi.spyOn(checker as unknown as ExecSeam, 'execAsync').mockResolvedValue('0.1.12');
    changelog = vi.spyOn(checker, 'fetchChangelog').mockResolvedValue('Fixed important bugs');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/update-checker-apply.test.ts:299' });
  });

  it('includes changeSummary in UpdateInfo when update available', async () => {
    const info = await checker.check();
    expect(exec).toHaveBeenCalledTimes(1);
    expect(exec).toHaveBeenCalledWith('npm', ['view', 'instar', 'version'], 15000);
    expect(changelog).toHaveBeenCalledTimes(1);
    expect(changelog).toHaveBeenCalledWith('0.1.12');
    expect(info).toMatchObject({
      currentVersion: '0.1.11', latestVersion: '0.1.12', updateAvailable: true,
      changeSummary: 'Fixed important bugs', checkedAt: expect.any(String),
    });
  });

  it('persists changeSummary to state file', async () => {
    changelog.mockResolvedValue('Big improvements');
    const info = await checker.check();
    expect(info.updateAvailable).toBe(true);
    expect(info.changeSummary).toBe('Big improvements');
    expect(checker.getLastCheck()).toEqual(info);
    expect(JSON.parse(fs.readFileSync(path.join(tmpDir, 'state', 'update-check.json'), 'utf8'))).toEqual(info);
  });

  it('persists a same-version check without fetching a changelog', async () => {
    exec.mockResolvedValue('0.1.11');
    const info = await checker.check();
    expect(info).toMatchObject({ currentVersion: '0.1.11', latestVersion: '0.1.11', updateAvailable: false });
    expect(info.changeSummary).toBeUndefined();
    expect(changelog).not.toHaveBeenCalled();
    expect(checker.getLastCheck()).toEqual(info);
  });

  it('returns a current-version fallback offline without inventing saved state', async () => {
    exec.mockRejectedValue(new Error('fixture registry unavailable'));
    const info = await checker.check();
    expect(info).toEqual({
      currentVersion: '0.1.11', latestVersion: '0.1.11', updateAvailable: false,
      checkedAt: expect.any(String),
    });
    expect(changelog).not.toHaveBeenCalled();
    expect(checker.getLastCheck()).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'state', 'update-check.json'))).toBe(false);
  });

  it('returns the unchanged saved result offline without overwriting it', async () => {
    const saved = await checker.check();
    const stateFile = path.join(tmpDir, 'state', 'update-check.json');
    const bytes = fs.readFileSync(stateFile, 'utf8');
    exec.mockRejectedValue(new Error('fixture registry unavailable'));
    changelog.mockClear();
    vi.mocked(checker.getInstalledVersion).mockReturnValue('0.1.13');

    expect(await checker.check()).toEqual(saved);
    expect(changelog).not.toHaveBeenCalled();
    expect(checker.getLastCheck()).toEqual(saved);
    expect(fs.readFileSync(stateFile, 'utf8')).toBe(bytes);
  });
});
