/**
 * Migration parity for pool-wide session visibility (GET /sessions?scope=pool,
 * 2026-06-05): deployed agents that already carry the Multi-Machine Session
 * Pool section must LEARN the new "every session, every machine" line on
 * update — and a CLAUDE.md without the section gets it via the fresh inject
 * (which already includes the line). Idempotent on the route-qualified
 * `sessions?scope=pool` marker (a bare `scope=pool` would collide with other
 * sections' pool-scoped routes, e.g. the Guard Posture /guards?scope=pool).
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

  it('is idempotent — the sessions?scope=pool marker blocks a second append', () => {
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
    // Count the route-qualified marker — other sections (e.g. Guard Posture's
    // /guards?scope=pool) legitimately contain a bare `scope=pool`.
    expect(after.split('sessions?scope=pool').length - 1).toBe(1);
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

describe('PostUpdateMigrator — post-transfer closeout line', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-closeout-line-'));
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

  it('appends the closeout line to a pool section that has scope=pool but predates the closeout', () => {
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
    expect(after).toContain('Post-transfer closeout');
    expect(after).toContain('no duplicate sessions doing duplicate work');
    expect(result.upgraded.some(u => u.includes('post-transfer closeout'))).toBe(true);
  });

  it('is idempotent — the closeout marker blocks a second append', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md — test',
      '',
      '## Multi-Machine Session Pool (active-active — spread conversations across machines)',
      '',
      '- **Every session, every machine:** API: `GET /sessions?scope=pool`.',
      '- **Post-transfer closeout (automatic):** old sessions close on move.',
      '',
    ].join('\n'));

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after.split('Post-transfer closeout').length - 1).toBe(1);
    expect(result.upgraded.some(u => u.includes('post-transfer closeout'))).toBe(false);
  });

  it('the sessions?scope=pool append now carries the closeout line in one shot (no double-append)', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md — test',
      '',
      '## Multi-Machine Session Pool (active-active — spread conversations across machines)',
      '',
      '- **Which machine + WHY (never guess):** `GET /pool/placement?topic=N`.',
      '',
    ].join('\n'));

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    // Both lines present, each exactly once (route-qualified count — see above).
    expect(after.split('sessions?scope=pool').length - 1).toBe(1);
    expect(after.split('Post-transfer closeout').length - 1).toBe(1);
  });
});
