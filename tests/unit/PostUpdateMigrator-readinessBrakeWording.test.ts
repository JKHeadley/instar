/**
 * Existing agents learn that a single readiness-authority timeout is retried and a
 * same-machine restart keeps the approval (live 2026-10-01: one codex timeout demoted the
 * authority for good). The old section said only "spend cap or model mismatch".
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'PostUpdateMigrator-readinessBrakeWording.test.ts' });
});

function migrate(projectDir: string): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — readiness authority brake wording', () => {
  it('rewrites the old brake wording once and is idempotent', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-readiness-brake-'));
    dirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Agent\n\n**Feedback Readiness Authority (operator approval)** — card.\n- `proposal-only` means a safety brake paused it (spend cap or model mismatch); `blockers` says why.\n');
    expect(migrate(projectDir).upgraded).toContain('CLAUDE.md: updated Feedback Readiness Authority brake wording');
    const once = fs.readFileSync(file, 'utf8');
    expect(once).not.toContain('(spend cap or model mismatch)');
    expect(once).toContain('a single timeout or rejected answer is just retried, and a restart on the same machine keeps the approval');
    expect(once).toContain('`lastReadinessFailure` names the exact check');
    expect(migrate(projectDir).upgraded).not.toContain('CLAUDE.md: updated Feedback Readiness Authority brake wording');
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  });

  // 2026-10-02: the 10-01 wording still said nothing about rejected answers or the diagnosis.
  it('rewrites the 2026-10-01 wording to the current one', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-readiness-brake-'));
    dirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Agent\n\n**Feedback Readiness Authority (operator approval)** — card.\n- `proposal-only` means a safety brake paused it (spend cap, model/schema mismatch, or three timeouts or provider errors in a row; a single timeout is just retried, and a restart on the same machine keeps the approval); `blockers` says why.\n');
    expect(migrate(projectDir).upgraded).toContain('CLAUDE.md: updated Feedback Readiness Authority brake wording');
    const once = fs.readFileSync(file, 'utf8');
    expect(once).not.toContain('model/schema mismatch');
    expect(once).toContain('answers that failed the checks');
    expect(migrate(projectDir).upgraded).not.toContain('CLAUDE.md: updated Feedback Readiness Authority brake wording');
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  });
});
