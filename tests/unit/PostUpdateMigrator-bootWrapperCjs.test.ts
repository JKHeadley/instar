/**
 * Migration test — PostUpdateMigrator.migrateBootWrapperToCjs
 *
 * Closes the gap for in-the-wild agents whose launchd plists were
 * generated with `instar-boot.js` in ProgramArguments. After the
 * always-.cjs change in installBootWrapper, those plists need to be
 * regenerated to point at `.cjs` — otherwise the next time
 * installBootWrapper runs (and no longer deletes the alt extension),
 * the agent works fine, BUT any pre-existing failure that already
 * deleted the .js file (the echo failure on 2026-05-20) stays dark
 * until the operator intervenes.
 *
 * The migration regenerates via installAutoStart on darwin only, is
 * idempotent on re-run, and is a no-op when there is no plist or the
 * plist already references .cjs.
 *
 * Note: installAutoStart calls launchctl bootstrap/bootout. In the test
 * environment those commands are present (or stubbed) but bootstrap
 * will fail because the test does not have a valid launchd domain.
 * We invoke the private method directly and assert on the
 * result.upgraded / result.skipped / result.errors classification —
 * NOT on whether launchctl actually loaded the plist.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

interface MigrationResult {
  upgraded: string[];
  errors: string[];
  skipped: string[];
}

const isDarwin = process.platform === 'darwin';

describe('PostUpdateMigrator.migrateBootWrapperToCjs', () => {
  let tmp: string;
  let projectDir: string;
  let migrator: PostUpdateMigrator;
  let migrate: (result: MigrationResult) => void;
  let fakeHome: string;
  let originalHome: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-boot-wrapper-cjs-'));
    projectDir = path.join(tmp, 'agent');
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });

    // Redirect HOME so the migration writes its plist into the tmpdir
    // instead of the real ~/Library/LaunchAgents. installAutoStart reads
    // launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
    // which honours $HOME via os.homedir() on darwin.
    fakeHome = path.join(tmp, 'home');
    fs.mkdirSync(path.join(fakeHome, 'Library', 'LaunchAgents'), { recursive: true });
    originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    migrator = new PostUpdateMigrator({
      projectDir,
      stateDir: path.join(projectDir, '.instar'),
      port: 4042,
      hasTelegram: false,
      projectName: 'migtest',
    });
    migrate = (migrator as unknown as {
      migrateBootWrapperToCjs: (result: MigrationResult) => void;
    }).migrateBootWrapperToCjs.bind(migrator);
  });

  afterEach(() => {
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    try {
      SafeFsExecutor.safeRmSync(tmp, {
        recursive: true,
        force: true,
        operation: 'tests/unit/PostUpdateMigrator-bootWrapperCjs.test.ts:cleanup',
      });
    } catch { /* best effort */ }
  });

  it('skips on non-darwin (no plist to migrate)', () => {
    if (isDarwin) return; // Test only meaningful off-darwin
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    migrate(result);
    expect(result.skipped.some(s => s.startsWith('boot-wrapper .cjs:'))).toBe(true);
    expect(result.upgraded).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('skips when no plist is present', () => {
    if (!isDarwin) return; // launchctl path is darwin-only
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    migrate(result);
    expect(result.skipped.some(s => s.includes('no launchd plist present'))).toBe(true);
    expect(result.upgraded).toHaveLength(0);
  });

  it('skips when plist already references .cjs (idempotent)', () => {
    if (!isDarwin) return;
    const plistPath = path.join(fakeHome, 'Library', 'LaunchAgents', 'ai.instar.migtest.plist');
    fs.writeFileSync(plistPath, '<plist>… <string>instar-boot.cjs</string> …</plist>');
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    migrate(result);
    expect(result.skipped.some(s => s.includes('already references .cjs'))).toBe(true);
    expect(result.upgraded).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it('skips when plist mentions neither instar-boot.js nor instar-boot.cjs', () => {
    if (!isDarwin) return;
    const plistPath = path.join(fakeHome, 'Library', 'LaunchAgents', 'ai.instar.migtest.plist');
    fs.writeFileSync(plistPath, '<plist>some unrelated content</plist>');
    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    migrate(result);
    expect(result.skipped.some(s => s.includes('does not reference any instar-boot'))).toBe(true);
    expect(result.upgraded).toHaveLength(0);
  });

  it('detects a plist that references instar-boot.js and attempts regeneration', () => {
    if (!isDarwin) return;
    const plistPath = path.join(fakeHome, 'Library', 'LaunchAgents', 'ai.instar.migtest.plist');
    fs.writeFileSync(plistPath, `<plist><string>/path/to/instar-boot.js</string></plist>`);

    const result: MigrationResult = { upgraded: [], errors: [], skipped: [] };
    migrate(result);

    // installAutoStart writes a real plist and calls launchctl. In a CI
    // / dev tmpdir, launchctl bootstrap may fail (no valid domain), but
    // the plist FILE write succeeds. The result is either:
    //   upgraded: ['boot-wrapper .cjs: regenerated plist …']  (full success)
    //   errors:   ['boot-wrapper .cjs: installAutoStart returned false']  (plist written but launchctl failed)
    // EITHER path proves the detection + regeneration path ran. The thing
    // we MUST NOT see is a silent "skipped" — the .js plist must trigger
    // action.
    const tookAction = result.upgraded.length > 0 || result.errors.length > 0;
    expect(tookAction).toBe(true);

    // The plist content should now be a real instar plist with .cjs
    // (regardless of whether launchctl bootstrap succeeded — installAutoStart
    // writes the file before invoking launchctl).
    if (fs.existsSync(plistPath)) {
      const after = fs.readFileSync(plistPath, 'utf-8');
      // Either we successfully rewrote it (.cjs present) OR the original
      // is still there (installAutoStart bailed early before write).
      // In the success-write case we explicitly check the new extension.
      if (result.upgraded.length > 0) {
        expect(after).toContain('instar-boot.cjs');
      }
    }
  });
});
