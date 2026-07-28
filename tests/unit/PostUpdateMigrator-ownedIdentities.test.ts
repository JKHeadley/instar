/**
 * Verifies PostUpdateMigrator adds the Owned-Identities Registry awareness section
 * to existing agents' CLAUDE.md on update, and that the source template carries the
 * Rung-0 owned-identities line for fresh installs (Agent Awareness + Migration Parity).
 *
 * Spec: docs/specs/correction-derived-hardening.md.
 *
 * Without this migration, existing agents would never learn that Rung 0 of
 * self-unblock now includes identities they themselves provisioned — the exact gap
 * behind the 2026-07-18 wrong "operator-only" escalation (the agent owned the
 * workspace-controlling identity and never consulted its own records).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

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

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — Owned-Identities Registry awareness', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-owned-ids-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-ownedIdentities.test.ts:cleanup',
    });
  });

  it('adds the Owned-Identities Registry section when CLAUDE.md does not already contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('Owned-Identities Registry'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('owned-identities.json');
    expect(after).toContain('Register what you create');
    // The pointer-not-value rule is stated.
    expect(after).toContain('never a secret value');
  });

  it('is idempotent — re-running does not duplicate the section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    runClaudeMdMigration(newMigrator(projectDir));

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    const occurrences = after.split('Owned-Identities Registry').length - 1;
    expect(occurrences).toBe(1);
  });

  it('skips a CLAUDE.md that already mentions owned-identities (content-sniff)', () => {
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\nRung 0 includes your owned-identities registry already.\n',
    );

    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.upgraded.some(u => u.includes('Owned-Identities Registry'))).toBe(false);
  });

  it('fresh-install template carries the Rung-0 owned-identities line + registration trigger', () => {
    const template = generateClaudeMd('test', 'test-agent', 4042, false);
    expect(template).toContain('owned-identities');
    expect(template).toContain('Register what you create');
  });
});
