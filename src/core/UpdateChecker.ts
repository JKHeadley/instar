/**
 * Update Checker — detects, understands, and applies updates intelligently.
 *
 * Part of the Dawn → Agents push layer: when Dawn publishes an update,
 * agents detect it, understand what changed, communicate with their user,
 * and optionally apply it automatically.
 *
 * Flow: detect → understand → communicate → execute → verify → report
 *
 * Uses `npm view instar version` to check the registry and
 * GitHub releases API for changelogs.
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { UpdateInfo, UpdateResult } from './types.js';

const GITHUB_RELEASES_URL = 'https://api.github.com/repos/SageMindAI/instar/releases';

export class UpdateChecker {
  private stateDir: string;
  private stateFile: string;

  constructor(stateDir: string) {
    this.stateDir = stateDir;
    this.stateFile = path.join(stateDir, 'state', 'update-check.json');
  }

  /**
   * Check npm for the latest version, fetch changelog, and compare to installed.
   */
  async check(): Promise<UpdateInfo> {
    const currentVersion = this.getInstalledVersion();
    let latestVersion: string;

    try {
      latestVersion = await this.execAsync('npm', ['view', 'instar', 'version'], 15000);
    } catch {
      // Offline or registry error — return last known state
      const lastState = this.getLastCheck();
      if (lastState) return lastState;

      return {
        currentVersion,
        latestVersion: currentVersion,
        updateAvailable: false,
        checkedAt: new Date().toISOString(),
      };
    }

    const updateAvailable = this.isNewer(latestVersion, currentVersion);

    const info: UpdateInfo = {
      currentVersion,
      latestVersion,
      updateAvailable,
      checkedAt: new Date().toISOString(),
      changelogUrl: `https://github.com/SageMindAI/instar/releases`,
    };

    // Fetch changelog if update is available
    if (updateAvailable) {
      try {
        info.changeSummary = await this.fetchChangelog(latestVersion);
      } catch {
        // Non-critical — proceed without changelog
      }
    }

    this.saveState(info);
    return info;
  }

  /**
   * Apply the update: npm update, verify new version, check health.
   */
  async applyUpdate(): Promise<UpdateResult> {
    const previousVersion = this.getInstalledVersion();

    // Check if there's actually an update available
    const info = await this.check();
    if (!info.updateAvailable) {
      return {
        success: true,
        previousVersion,
        newVersion: previousVersion,
        message: `Already up to date (v${previousVersion}).`,
        restartNeeded: false,
        healthCheck: 'skipped',
      };
    }

    try {
      // Execute npm update
      await this.execAsync('npm', ['update', '-g', 'instar'], 120000);
    } catch (err) {
      return {
        success: false,
        previousVersion,
        newVersion: previousVersion,
        message: `Update failed: ${err instanceof Error ? err.message : String(err)}`,
        restartNeeded: false,
        healthCheck: 'skipped',
      };
    }

    // Verify the update was applied by checking npm again
    let newVersion: string;
    try {
      newVersion = await this.execAsync('npm', ['list', '-g', 'instar', '--depth=0', '--json'], 15000);
      // Parse JSON output to extract version
      const parsed = JSON.parse(newVersion);
      newVersion = parsed?.dependencies?.instar?.version || 'unknown';
    } catch {
      newVersion = 'unknown';
    }

    const success = newVersion !== previousVersion && newVersion !== 'unknown';

    return {
      success,
      previousVersion,
      newVersion,
      message: success
        ? `Updated from v${previousVersion} to v${newVersion}. ${info.changeSummary || 'Restart to use the new version.'}`
        : `Update command ran but version didn't change (still v${previousVersion}). May need manual intervention.`,
      restartNeeded: success,
      healthCheck: 'skipped', // Can't check health until after restart
    };
  }

  /**
   * Fetch human-readable changelog from GitHub releases.
   */
  async fetchChangelog(version: string): Promise<string | undefined> {
    try {
      const tag = version.startsWith('v') ? version : `v${version}`;
      const response = await fetch(`${GITHUB_RELEASES_URL}/tags/${tag}`, {
        headers: {
          'Accept': 'application/vnd.github.v3+json',
          'User-Agent': 'instar-update-checker',
        },
        signal: AbortSignal.timeout(10000),
      });

      if (!response.ok) return undefined;

      const release = await response.json() as { body?: string; name?: string };
      if (release.body) {
        // Truncate to first 500 chars for concise summary
        const summary = release.body.slice(0, 500);
        return summary.length < release.body.length ? summary + '...' : summary;
      }
      if (release.name) return release.name;
    } catch {
      // Non-critical
    }
    return undefined;
  }

  /**
   * Get the last check result without hitting npm.
   */
  getLastCheck(): UpdateInfo | null {
    if (!fs.existsSync(this.stateFile)) return null;
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf-8'));
    } catch {
      return null;
    }
  }

  /**
   * Get the currently installed version from package.json.
   */
  getInstalledVersion(): string {
    try {
      // Try to find instar's package.json relative to this module
      const pkgPath = path.resolve(
        new URL(import.meta.url).pathname,
        '..', '..', '..', 'package.json'
      );
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        return pkg.version || '0.0.0';
      }
    } catch { /* fallback below */ }

    return '0.0.0';
  }

  /**
   * Run a command asynchronously, returning trimmed stdout.
   */
  private execAsync(cmd: string, args: string[], timeoutMs: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(cmd, args, {
        encoding: 'utf-8',
        timeout: timeoutMs,
      }, (err, stdout) => {
        if (err) reject(err);
        else resolve((stdout || '').trim());
      });
      // Safety: ensure child doesn't leak if parent is GC'd
      child.unref?.();
    });
  }

  /**
   * Simple semver comparison — is `a` newer than `b`?
   */
  private isNewer(a: string, b: string): boolean {
    // Extract major.minor.patch, ignoring pre-release suffixes
    const semverRe = /^(\d+)\.(\d+)\.(\d+)/;
    const matchA = semverRe.exec(a);
    const matchB = semverRe.exec(b);
    if (!matchA || !matchB) return false;

    for (let i = 1; i <= 3; i++) {
      const va = Number(matchA[i]);
      const vb = Number(matchB[i]);
      if (va > vb) return true;
      if (va < vb) return false;
    }
    return false;
  }

  private saveState(info: UpdateInfo): void {
    const dir = path.dirname(this.stateFile);
    fs.mkdirSync(dir, { recursive: true });
    // Atomic write: unique temp filename to prevent concurrent corruption
    const tmpPath = this.stateFile + `.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
      fs.writeFileSync(tmpPath, JSON.stringify(info, null, 2));
      fs.renameSync(tmpPath, this.stateFile);
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
      throw err;
    }
  }
}
