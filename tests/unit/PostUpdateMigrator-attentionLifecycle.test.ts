/**
 * Migration parity for the attention lifecycle (attention-lifecycle-close-on-cause §6):
 * existing agents learn that items are one per condition, how to pass a
 * conditionKey, how to close a cleared condition, and how expiry works.
 * Sniff key: `/attention/lifecycle`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const LABEL = 'CLAUDE.md: added attention lifecycle (close-on-cause + expiry) bullet';

describe('PostUpdateMigrator — attention lifecycle bullet', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-attn-lifecycle-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-attentionLifecycle.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('adds the bullet after the Proactive-use line, once, with the agent port', () => {
    fs.writeFileSync(claudeMdPath, [
      '# CLAUDE.md', '',
      '**Attention Queue** — Signal important items to the user.',
      '- **Proactive use**: queue an item only when the user must decide, tap or act, or something they care about is genuinely broken.',
      '',
    ].join('\n'));
    expect(run().upgraded).toContain(LABEL);
    const after = fs.readFileSync(claudeMdPath, 'utf8');
    expect(after).toContain('http://localhost:4321/attention/lifecycle');
    expect(after).toContain('http://localhost:4321/attention/clear');
    expect(after).toContain('"conditionKey"');
    expect(after).toContain('closedBy: "expired"');
    expect(after.indexOf('Items close themselves')).toBeGreaterThan(after.indexOf('**Proactive use**'));
    expect(run().upgraded).not.toContain(LABEL);
    expect(after.split('Items close themselves').length).toBe(2);
  });

  it('falls back to the section header when the Proactive-use line is absent, still exactly once', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\n**Attention Queue** — Signal important items to the user.\n- Queue: curl …\n');
    expect(run().upgraded).toContain(LABEL);
    const after = fs.readFileSync(claudeMdPath, 'utf8');
    expect(after).toContain('Items close themselves');
    expect(after.split('Items close themselves').length).toBe(2);
    // Earlier migrations install the Attention Queue section into a CLAUDE.md
    // that lacks it, so the bullet lands there too — but only once.
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nNothing about attention here.\n');
    run();
    expect(fs.readFileSync(claudeMdPath, 'utf8').split('Items close themselves').length).toBe(2);
    expect(run().upgraded).not.toContain(LABEL);
  });

  it('new agents get the same wording from the template', () => {
    const md = generateClaudeMd('test', 'Test', 4321, true);
    expect(md).toContain('Items close themselves (attention lifecycle, default on)');
    expect(md).toContain('http://localhost:4321/attention/clear');
    expect(md).toContain('messaging[].config.attentionLifecycle.enabled: false');
  });
});
