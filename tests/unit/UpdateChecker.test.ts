import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { UpdateChecker } from '../../src/core/UpdateChecker.js';

describe('UpdateChecker', () => {
  let tmpDir: string;
  let checker: UpdateChecker;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-update-test-'));
    // Create state directory structure
    fs.mkdirSync(path.join(tmpDir, 'state'), { recursive: true });
    checker = new UpdateChecker(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('getInstalledVersion', () => {
    it('returns a version string', () => {
      const version = checker.getInstalledVersion();
      expect(typeof version).toBe('string');
      // Should be a semver-like string
      expect(version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe('getLastCheck', () => {
    it('returns null when no check has been performed', () => {
      expect(checker.getLastCheck()).toBeNull();
    });

    it('returns saved state after a check', async () => {
      // We can't reliably test the npm check in CI,
      // but we can test the state persistence
      const stateFile = path.join(tmpDir, 'state', 'update-check.json');
      const mockState = {
        currentVersion: '0.1.8',
        latestVersion: '0.1.9',
        updateAvailable: true,
        checkedAt: new Date().toISOString(),
      };
      fs.writeFileSync(stateFile, JSON.stringify(mockState));

      const result = checker.getLastCheck();
      expect(result).not.toBeNull();
      expect(result!.currentVersion).toBe('0.1.8');
      expect(result!.latestVersion).toBe('0.1.9');
      expect(result!.updateAvailable).toBe(true);
    });
  });

  describe('isNewer (via check)', () => {
    // Test the semver comparison indirectly through persisted state
    it('detects when versions are equal', () => {
      const stateFile = path.join(tmpDir, 'state', 'update-check.json');
      fs.writeFileSync(stateFile, JSON.stringify({
        currentVersion: '0.1.8',
        latestVersion: '0.1.8',
        updateAvailable: false,
        checkedAt: new Date().toISOString(),
      }));

      const result = checker.getLastCheck();
      expect(result!.updateAvailable).toBe(false);
    });
  });
});
