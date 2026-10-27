/**
 * Migration parity for Every Ask Is Actionable: existing agents learn that an item
 * they raise for the user carries its one tap (the POST "action"), and where posts
 * with nothing to tap are logged. Sniff key: `attention-unactionable`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const LABEL = 'CLAUDE.md: added Every Ask Is Actionable (attention action) bullet';

describe('PostUpdateMigrator — Every Ask Is Actionable bullet', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-actionable-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-attentionActionable.test.ts' }));
  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('adds the bullet under the Attention Queue once', () => {
    fs.writeFileSync(claudeMdPath, ['# CLAUDE.md', '', '**Attention Queue** — Signal important items to the user.',
      '- **Proactive use**: queue an item only when the user must decide, tap or act.', ''].join('\n'));
    expect(run().upgraded).toContain(LABEL);
    const after = fs.readFileSync(claudeMdPath, 'utf8');
    expect(after).toContain('Every Ask Is Actionable');
    expect(after).toContain('"action":{"kind":"open"');
    expect(after).toContain('logs/attention-unactionable.jsonl');
    expect(after.indexOf('Every ask carries one tap')).toBeGreaterThan(after.indexOf('**Proactive use**'));
    expect(run().upgraded).not.toContain(LABEL);
    expect(fs.readFileSync(claudeMdPath, 'utf8').split('Every ask carries one tap').length).toBe(2);
  });

  it('new agents get the same wording from the template', () => {
    const md = generateClaudeMd('test', 'Test', 4321, true);
    expect(md).toContain('Every ask carries one tap (Every Ask Is Actionable)');
    expect(md).toContain('logs/attention-unactionable.jsonl');
  });
});
