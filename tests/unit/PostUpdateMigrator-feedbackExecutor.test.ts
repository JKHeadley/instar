/**
 * Existing agents learn about the feedback executor (docs/specs/feedback-triage-and-execution.md §4):
 * the Phase 1 triage section's "not built yet" sentence becomes a pointer, and the executor section
 * (status route, conversational levers, PIN-only authorities) is appended once. Content-sniffed and
 * idempotent; a fresh template already carries both.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'PostUpdateMigrator-feedbackExecutor.test.ts' }); });

function migrate(projectDir: string): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — feedback executor section', () => {
  it('updates the Phase 1 sentence, appends the executor section once, and is idempotent', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feedback-exec-'));
    dirs.push(projectDir);
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    const file = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(file, '# Agent\n\n**Feedback triage and execution (operated feedback factory)** — triage. The executor that turns work items into pull requests is not built yet.\n');
    const first = migrate(projectDir).upgraded;
    expect(first).toContain('CLAUDE.md: updated Feedback triage section (executor built)');
    expect(first).toContain('CLAUDE.md: added Feedback executor section');
    const once = fs.readFileSync(file, 'utf8');
    expect(once).not.toContain('is not built yet');
    expect(once).toContain('**Feedback executor (operated feedback factory)**');
    expect(once).toContain('http://localhost:4042/feedback-factory/execute/status');
    expect(once).toContain('accept-approver-dependence');
    const second = migrate(projectDir).upgraded;
    expect(second.filter((u) => /Feedback executor|executor built/.test(u))).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe(once);
  });

  it('a new agent\'s template already carries the executor section and no "not built yet"', () => {
    const md = generateClaudeMd('test', 'agent', 4042, false);
    expect(md).toContain('**Feedback executor (operated feedback factory)**');
    expect(md).not.toContain('The executor that turns work items into pull requests is not built yet.');
  });
});
