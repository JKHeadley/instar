/**
 * Migration parity for the attention-without-Telegram bullet
 * (locked-security-item-no-telegram). Sniff key: `local-attention-items.json`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const LABEL = 'CLAUDE.md: added attention-without-Telegram bullet';

describe('PostUpdateMigrator — attention without Telegram bullet', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-local-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-attentionWithoutTelegram.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('adds the bullet after the Proactive-use line, exactly once', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md', '',
      '**Attention Queue** — Signal important items to the user.',
      '- **Proactive use**: queue an item only when the user must decide, tap or act, or something they care about is genuinely broken.',
      '',
    ].join('\n'));
    expect(run().upgraded).toContain(LABEL);
    const after = fs.readFileSync(claudeMdPath, 'utf8');
    expect(after).toContain('state/local-attention-items.json');
    expect(after).toContain('surface: "local"');
    expect(after.indexOf('**No Telegram?**')).toBeGreaterThan(after.indexOf('**Proactive use**'));
    expect(run().upgraded).not.toContain(LABEL);
    expect(fs.readFileSync(claudeMdPath, 'utf8').split('**No Telegram?**').length).toBe(2);
  });

  it('new agents already carry it, so the migration leaves a fresh CLAUDE.md alone', () => {
    const fresh = generateClaudeMd('test', 'Test', 4321, false);
    expect(fresh).toContain('state/local-attention-items.json');
    fs.writeFileSync(claudeMdPath, fresh);
    expect(run().upgraded).not.toContain(LABEL);
  });
});
