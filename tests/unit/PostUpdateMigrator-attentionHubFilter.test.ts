/**
 * Migration parity for the Attention hub filter (operator report 2026-10-23):
 * existing agents learn what now reaches the user's Attention topic, and the
 * old "queue every failed job / CI failure" proactive line is replaced.
 * Sniff key: `attention-hub-held.jsonl`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const LABEL = 'CLAUDE.md: added Attention hub filter bullet';

describe('PostUpdateMigrator — Attention hub filter', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-hub-filter-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-attentionHubFilter.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('adds the bullet and replaces the old proactive line, once', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md', '',
      '**Attention Queue** — Signal important items to the user.',
      "- **Proactive use**: when you detect something the user should know (stale relationships, failed jobs, CI failures, overdue actions), don't just log it — queue it so it gets seen.",
      '',
    ].join('\n'));
    expect(run().upgraded).toContain(LABEL);
    const after = fs.readFileSync(claudeMdPath, 'utf8');
    expect(after).toContain('logs/attention-hub-held.jsonl');
    expect(after).not.toContain('failed jobs, CI failures, overdue actions');
    expect(after).toContain('queue an item only when the user must decide, tap or act');
    expect(run().upgraded).not.toContain(LABEL);
    expect(fs.readFileSync(claudeMdPath, 'utf8').split("What reaches the user's Attention topic").length).toBe(2);
  });

  it('new agents get the same wording from the template', () => {
    const md = generateClaudeMd('test', 'Test', 4321, true);
    expect(md).toContain("What reaches the user's Attention topic (hub filter, default on)");
    expect(md).toContain('queue an item only when the user must decide, tap or act');
    expect(md).not.toContain('failed jobs, CI failures, overdue actions');
  });
});
