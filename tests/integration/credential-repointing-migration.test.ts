/**
 * WS5.2 Step 9 — integration: the FULL migrate() pipeline over a realistic stale
 * agent (a config.json + CLAUDE.md that predate the live-credential-repointing
 * feature) lands BOTH the dark config block and the awareness section, dark and
 * idempotent on re-run.
 *
 * This is the migration-parity proof at the pipeline level (not just the isolated
 * method): an existing agent that auto-updates picks up the dark
 * subscriptionPool.credentialRepointing config + the CLAUDE.md awareness through
 * the same migrate() entrypoint the auto-updater calls.
 *
 * Spec: docs/specs/live-credential-repointing-rebalancer.md §4.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

describe('Step 9 integration — full migrate() delivers credential-repointing parity', () => {
  let projectDir: string;
  let configPath: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-credrepoint-int-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    configPath = path.join(projectDir, '.instar', 'config.json');
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');

    // A realistic STALE agent: a real config.json (authToken present so config
    // migration runs) lacking the credentialRepointing block, and a CLAUDE.md
    // lacking the awareness section.
    fs.writeFileSync(
      configPath,
      JSON.stringify(
        { authToken: 'test-token', agentType: 'managed-project', subscriptionPool: { autoSwapOnRateLimit: false } },
        null,
        2,
      ),
    );
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md — instar\n\n## Standards\n\nSome existing content predating the feature.\n',
    );
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/integration/credential-repointing-migration.test.ts:cleanup',
    });
  });

  it('full migrate() lands the dark config block AND the awareness section', () => {
    const result = newMigrator(projectDir).migrate();
    // The pipeline must not hard-error on the credential-repointing path.
    expect(result.errors.filter(e => e.toLowerCase().includes('credential'))).toEqual([]);

    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(config.subscriptionPool.credentialRepointing).toEqual({
      enabled: false,
      dryRun: true,
      manualLeversEnabled: true,
    });

    const claudeMd = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(claudeMd).toContain('Live Credential Re-Pointing');
    expect(claudeMd).toContain('POST /credentials/set-default');
    expect(claudeMd).toContain('GET /credentials/locations');
    expect(claudeMd).toContain('flip my default account');
  });

  it('re-running migrate() is idempotent — single config block, single section, byte-stable CLAUDE.md', () => {
    newMigrator(projectDir).migrate();
    const claudeMdAfterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const configAfterFirst = JSON.parse(fs.readFileSync(configPath, 'utf-8')).subscriptionPool.credentialRepointing;

    newMigrator(projectDir).migrate();
    const claudeMdAfterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    const configAfterSecond = JSON.parse(fs.readFileSync(configPath, 'utf-8')).subscriptionPool.credentialRepointing;

    expect(claudeMdAfterSecond).toBe(claudeMdAfterFirst);
    expect(configAfterSecond).toEqual(configAfterFirst);
    expect(claudeMdAfterSecond.match(/Live Credential Re-Pointing/g)!.length).toBe(1);
  });
});
