/**
 * Migration parity for the U4.1 pin-persistence awareness line
 * (docs/specs/u4-1-pin-persistence.md; Agent Awareness + Migration Parity
 * standards): deployed agents that already carry the Multi-Machine Session
 * Pool section must LEARN the verified pinState block on GET /pool/placement,
 * the deliberate POST /pool/unpin surface, and the skew-quarantine read on
 * update — a feature that only works for new agents is a broken feature.
 * Idempotent on the unique `/pool/unpin` route marker.
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

describe('PostUpdateMigrator — U4.1 pin-persistence awareness line', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-u41-pin-line-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-u41PinPersistenceLine.test.ts',
    });
  });

  it('appends the line to an existing pool section that predates /pool/unpin', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md — test',
      '',
      '## Multi-Machine Session Pool (active-active — spread conversations across machines)',
      '',
      '- **Which machine + WHY (never guess):** `GET /pool/placement?topic=N` → the owning machine.',
      '- **Every session, every machine:** API: `GET /sessions?scope=pool`.',
      '',
    ].join('\n'));

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('POST /pool/unpin');
    expect(after).toContain('pinState');
    expect(after).toContain('pin-quarantine/readmit');
    expect(after).toContain('Pin persistence (U4.1');
    expect(result.upgraded.some((u) => u.includes('U4.1 pin-persistence awareness'))).toBe(true);
  });

  it('is idempotent — the /pool/unpin marker blocks a second append', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md — test',
      '',
      '## Multi-Machine Session Pool (active-active — spread conversations across machines)',
      '',
      '- **Every session, every machine:** API: `GET /sessions?scope=pool`.',
      '- **Pin persistence (U4.1):** unpin via `POST /pool/unpin`.',
      '',
    ].join('\n'));

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after.split('/pool/unpin').length - 1).toBe(1);
    expect(result.upgraded.some((u) => u.includes('U4.1 pin-persistence awareness'))).toBe(false);
  });

  it('a CLAUDE.md without the pool section gets the section + the U4.1 line in one pass, exactly once', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test\n');

    const result = runMigrateClaudeMd(createMigrator(projectDir));
    expect(result.errors).toEqual([]);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Multi-Machine Session Pool (active-active');
    // The LINE lands exactly once (the line itself legitimately names the
    // /pool/unpin route more than once — count the line marker, not the route).
    expect(after.split('Pin persistence (U4.1').length - 1).toBe(1);
  });
});
