/**
 * WS5.2 Step 9 — Migration parity for the live-credential-repointing feature
 * (spec: live-credential-repointing-rebalancer.md §4).
 *
 * Two halves of the parity:
 *   1. CONFIG: existing agents pick up the dark `subscriptionPool.credentialRepointing`
 *      block on update. It lives in SHARED_DEFAULTS (ConfigDefaults Step 1), so the
 *      GENERIC applyDefaults path inside migrateConfig add-missings it idempotently —
 *      no hardcoded migrator block is added (no behavior creep, single source of truth
 *      for the dark shape). These tests prove the migrateConfig() method actually
 *      delivers it dark AND never clobbers an operator-set enabled:true.
 *   2. CLAUDE.md: existing agents pick up the awareness section via the content-sniffed
 *      migrateClaudeMd branch (the ### H3 form; the template emits the **-bold form).
 *
 * The load-bearing invariant is DARK-POSTURE PARITY: an existing agent post-migration
 * is in the SAME dark posture as a fresh agent (enabled:false + dryRun:true +
 * manualLeversEnabled:true), and an operator's deliberate enabled:true is preserved.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runConfigMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateConfig(r: MigrationResult): void }).migrateConfig(result);
  return result;
}

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — live-credential-repointing migration parity (Step 9)', () => {
  let projectDir: string;
  let stateDir: string;
  let configPath: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-credrepoint-'));
    stateDir = path.join(projectDir, '.instar');
    fs.mkdirSync(stateDir, { recursive: true });
    configPath = path.join(stateDir, 'config.json');
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-credentialRepointing.test.ts:cleanup',
    });
  });

  describe('config dark-posture parity', () => {
    it('a config WITHOUT the block gets the explicit dark defaults (enabled:false+dryRun:true+manualLeversEnabled:true)', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify({ authToken: 'x', subscriptionPool: { autoSwapOnRateLimit: false } }, null, 2),
      );

      const result = runConfigMigration(newMigrator(projectDir));
      expect(result.errors).toEqual([]);

      const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(after.subscriptionPool.credentialRepointing).toEqual({
        enabled: false,
        dryRun: true,
        manualLeversEnabled: true,
      });
    });

    it('a config with NO subscriptionPool at all still gets the dark block', () => {
      fs.writeFileSync(configPath, JSON.stringify({ authToken: 'x' }, null, 2));

      const result = runConfigMigration(newMigrator(projectDir));
      expect(result.errors).toEqual([]);

      const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(after.subscriptionPool.credentialRepointing).toEqual({
        enabled: false,
        dryRun: true,
        manualLeversEnabled: true,
      });
    });

    it('an operator-set enabled:true (dryRun:false) is NEVER clobbered (idempotent add-missing)', () => {
      fs.writeFileSync(
        configPath,
        JSON.stringify(
          {
            authToken: 'x',
            subscriptionPool: {
              credentialRepointing: { enabled: true, dryRun: false, manualLeversEnabled: true },
            },
          },
          null,
          2,
        ),
      );

      runConfigMigration(newMigrator(projectDir));

      const after = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      expect(after.subscriptionPool.credentialRepointing).toEqual({
        enabled: true,
        dryRun: false,
        manualLeversEnabled: true,
      });
    });

    it('double-migration leaves a single dark block (idempotent)', () => {
      fs.writeFileSync(configPath, JSON.stringify({ authToken: 'x' }, null, 2));

      runConfigMigration(newMigrator(projectDir));
      const afterFirst = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      const second = runConfigMigration(newMigrator(projectDir));
      const afterSecond = JSON.parse(fs.readFileSync(configPath, 'utf-8'));

      expect(afterSecond.subscriptionPool.credentialRepointing).toEqual(
        afterFirst.subscriptionPool.credentialRepointing,
      );
      // Second run does not re-report adding the credentialRepointing block.
      expect(second.upgraded.some(u => u.includes('credentialRepointing'))).toBe(false);
    });
  });

  describe('CLAUDE.md awareness parity', () => {
    it('injects the Live Credential Re-Pointing section when absent (existing agents)', () => {
      fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

      const result = runClaudeMdMigration(newMigrator(projectDir));
      expect(result.errors).toEqual([]);
      expect(result.upgraded.some(u => u.includes('Live Credential Re-Pointing'))).toBe(true);

      const after = fs.readFileSync(claudeMdPath, 'utf-8');
      expect(after).toContain('Live Credential Re-Pointing');
      // The proactive triggers (verbatim intent) + the two routes.
      expect(after).toContain('flip my default account');
      expect(after).toContain('which account is this');
      expect(after).toContain('POST /credentials/set-default');
      expect(after).toContain('GET /credentials/locations');
      // Dark posture is stated and the deprecation note is folded in.
      expect(after).toContain('subscriptionPool.credentialRepointing');
      expect(after).toContain('/switch-account');
    });

    it('skips when the section is already present (content-sniff)', () => {
      fs.writeFileSync(
        claudeMdPath,
        '# CLAUDE.md\n\n### Live Credential Re-Pointing (already here)\n\nbody\n',
      );

      const result = runClaudeMdMigration(newMigrator(projectDir));
      expect(result.upgraded.some(u => u.includes('Live Credential Re-Pointing'))).toBe(false);
    });

    it('is idempotent — a second run leaves the file unchanged and one section', () => {
      fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nbody.\n');

      runClaudeMdMigration(newMigrator(projectDir));
      const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
      const second = runClaudeMdMigration(newMigrator(projectDir));
      const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

      expect(afterSecond).toBe(afterFirst);
      expect(second.upgraded.some(u => u.includes('Live Credential Re-Pointing'))).toBe(false);
      expect(afterSecond.match(/Live Credential Re-Pointing/g)!.length).toBe(1);
    });
  });
});
