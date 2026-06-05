/**
 * Migration parity for pool-wide session visibility (GET /sessions?scope=pool,
 * 2026-06-05): deployed agents that already carry the Multi-Machine Session
 * Pool section must LEARN the new "every session, every machine" line on
 * update — and a CLAUDE.md without the section gets it via the fresh inject
 * (which already includes the line). Idempotent on the `scope=pool` marker.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function createMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: true,
    projectName: 'test-agent',
  });
}

function runMigrateClaudeMd(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — pool-wide session visibility line', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-pool-sessions-vis-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-poolSessionsVisibility.test.ts',
    });
  });

  it('appends the line to an existing pool section that predates scope=pool', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md — test',
      '',
      '## Multi-Machine Session Pool (active-active — spread conversations across machines)',
      '',
      '- **See the pool:** the **Machines tab** in the dashboard, or `GET /pool` (Bearer-auth).',
      '- **Which machine + WHY (never guess):** `GET /pool/placement?topic=N` → the owning machine.',
      '',
    ].join('\n'));

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('GET /sessions?scope=pool');
    expect(after).toContain('Every session, every machine');
    expect(result.upgraded.some(u => u.includes('pool-wide session visibility'))).toBe(true);
  });

  it('is idempotent — the scope=pool marker blocks a second append', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md — test',
      '',
      '## Multi-Machine Session Pool (active-active — spread conversations across machines)',
      '',
      '- **Which machine + WHY (never guess):** `GET /pool/placement?topic=N`.',
      '- **Every session, every machine:** API: `GET /sessions?scope=pool`.',
      '',
    ].join('\n'));

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after.split('scope=pool').length - 1).toBe(1);
    expect(result.upgraded.some(u => u.includes('pool-wide session visibility'))).toBe(false);
  });

  it('a fresh pool-section inject already carries the line (no stale inject)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test\n');

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Multi-Machine Session Pool (active-active');
    expect(after).toContain('GET /sessions?scope=pool');
    // The append migration must NOT also fire on the same pass (inject carries it).
    expect(after.split('Every session, every machine').length - 1).toBe(1);
  });
});
