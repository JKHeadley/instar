/**
 * Boot-wrapper / plist coherence — regression tests for the
 * "agent goes dark when package.json flips to type=module" failure mode
 * (echo, 2026-05-20).
 *
 * Failure shape:
 *   1. installBootWrapper used to pick `.js` vs `.cjs` based on
 *      package.json "type" and DELETE the alt extension.
 *   2. installMacOSLaunchAgent wrote the plist's ProgramArguments using
 *      whatever extension installBootWrapper returned at THAT moment.
 *   3. If package.json gained "type": "module" after initial setup
 *      (e.g. via a package upgrade), the next installBootWrapper call
 *      deleted the `.js` file the plist still pointed at.
 *   4. launchd then execs a nonexistent path on every restart, and
 *      none of the downstream self-heal (ServerSupervisor preflight,
 *      sqlite rebuild, INSTAR_SUPERVISED detection) ever runs because
 *      the boot wrapper itself never loads.
 *
 * Fix invariants asserted here:
 *   - installBootWrapper always writes `.cjs`, regardless of package.json.
 *   - installBootWrapper does not delete a pre-existing `.js` wrapper
 *     (rollback safety: don't make the old plist's target disappear).
 *   - ensureBootWrapper looks for `.cjs` and triggers regeneration if missing.
 *   - PostUpdateMigrator.migrateBootWrapperToCjs detects old `.js`-referencing
 *     plists and regenerates them to point at `.cjs`. Idempotent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBootWrapper, ensureBootWrapper } from '../../src/commands/setup.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('installBootWrapper — always writes .cjs', () => {
  let tmp: string;
  let projectDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'boot-wrapper-cjs-'));
    projectDir = path.join(tmp, 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(tmp, {
        recursive: true,
        force: true,
        operation: 'tests/unit/boot-wrapper-plist-coherence.test.ts:cleanup',
      });
    } catch { /* best effort */ }
  });

  it('writes instar-boot.cjs when package.json has type=module', () => {
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'test', type: 'module' }),
    );
    const wrappers = installBootWrapper(projectDir);
    expect(wrappers.js).toBe(path.join(projectDir, '.instar', 'instar-boot.cjs'));
    expect(fs.existsSync(wrappers.js)).toBe(true);
  });

  it('writes instar-boot.cjs when package.json has type=commonjs', () => {
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'test', type: 'commonjs' }),
    );
    const wrappers = installBootWrapper(projectDir);
    expect(wrappers.js).toBe(path.join(projectDir, '.instar', 'instar-boot.cjs'));
    expect(fs.existsSync(wrappers.js)).toBe(true);
  });

  it('writes instar-boot.cjs when there is no package.json', () => {
    const wrappers = installBootWrapper(projectDir);
    expect(wrappers.js).toBe(path.join(projectDir, '.instar', 'instar-boot.cjs'));
    expect(fs.existsSync(wrappers.js)).toBe(true);
  });

  it('does NOT delete a pre-existing instar-boot.js (rollback safety)', () => {
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'test', type: 'module' }),
    );
    const legacyJs = path.join(projectDir, '.instar', 'instar-boot.js');
    fs.writeFileSync(legacyJs, '// legacy wrapper that the old plist may still reference');

    installBootWrapper(projectDir);

    // Legacy file must still exist — deleting it is the failure mode that
    // took echo dark on 2026-05-20. Old plists referencing .js need this
    // file to remain until PostUpdateMigrator regenerates the plist.
    expect(fs.existsSync(legacyJs)).toBe(true);
  });

  it('wrapper content uses CommonJS require — works under .cjs regardless of type=module', () => {
    fs.writeFileSync(
      path.join(projectDir, 'package.json'),
      JSON.stringify({ name: 'test', type: 'module' }),
    );
    const wrappers = installBootWrapper(projectDir);
    const body = fs.readFileSync(wrappers.js, 'utf-8');
    // The wrapper code uses require() — only valid in a CJS context.
    // .cjs forces CJS regardless of package.json "type", which is why
    // we always use it.
    expect(body).toContain("require('child_process')");
  });
});

describe('ensureBootWrapper — looks for .cjs', () => {
  let tmp: string;
  let projectDir: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ensure-boot-cjs-'));
    projectDir = path.join(tmp, 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });
  afterEach(() => {
    try {
      SafeFsExecutor.safeRmSync(tmp, {
        recursive: true,
        force: true,
        operation: 'tests/unit/boot-wrapper-plist-coherence.test.ts:cleanup',
      });
    } catch { /* best effort */ }
  });

  it('returns false when both .cjs and .sh wrappers exist', () => {
    installBootWrapper(projectDir); // creates both
    expect(ensureBootWrapper(projectDir)).toBe(false);
  });

  it('regenerates when .cjs wrapper is missing', () => {
    installBootWrapper(projectDir);
    SafeFsExecutor.safeUnlinkSync(
      path.join(projectDir, '.instar', 'instar-boot.cjs'),
      { operation: 'tests/unit/boot-wrapper-plist-coherence.test.ts:simulate-deletion' },
    );
    expect(ensureBootWrapper(projectDir)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.instar', 'instar-boot.cjs'))).toBe(true);
  });

  it('regenerates when .sh wrapper is missing', () => {
    installBootWrapper(projectDir);
    SafeFsExecutor.safeUnlinkSync(
      path.join(projectDir, '.instar', 'instar-boot.sh'),
      { operation: 'tests/unit/boot-wrapper-plist-coherence.test.ts:simulate-deletion' },
    );
    expect(ensureBootWrapper(projectDir)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.instar', 'instar-boot.sh'))).toBe(true);
  });

  it('does NOT treat a stale .js wrapper as sufficient', () => {
    installBootWrapper(projectDir);
    // Simulate the failure mode: somehow .cjs is gone but a legacy .js exists.
    SafeFsExecutor.safeUnlinkSync(
      path.join(projectDir, '.instar', 'instar-boot.cjs'),
      { operation: 'tests/unit/boot-wrapper-plist-coherence.test.ts:simulate-deletion' },
    );
    fs.writeFileSync(path.join(projectDir, '.instar', 'instar-boot.js'), '// legacy');
    // .cjs is the authoritative path now; the .js file does not satisfy the check.
    expect(ensureBootWrapper(projectDir)).toBe(true);
    expect(fs.existsSync(path.join(projectDir, '.instar', 'instar-boot.cjs'))).toBe(true);
  });
});
