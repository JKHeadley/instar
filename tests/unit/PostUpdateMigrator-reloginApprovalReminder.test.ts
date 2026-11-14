/**
 * Migration parity for CMT-1541: existing agents whose CLAUDE.md carries the one-tap repair bullet get
 * the approval-reminder and unreachable-notice bullets once, with the template's own wording.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const ADDED = 'CLAUDE.md: added sign-in approval reminder and unreachable-notice awareness';
const ONE_TAP = '- **One-tap repair setting (Accounts page)** — the console Accounts page has an Automatic sign-in repair section.';

describe('PostUpdateMigrator — sign-in approval reminder awareness (CMT-1541)', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-cmt1541-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-reloginApprovalReminder.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };
  const bullets = (s: string) => s.split('\n').filter((l) => l.startsWith('- **Repair waiting for approval: reminder**') || l.startsWith('- **Unreachable-machine notices**'));

  it('adds both bullets right after the one-tap bullet, once', () => {
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${ONE_TAP}\n- next\n`);
    expect(run().upgraded).toContain(ADDED);
    expect(run().upgraded).not.toContain(ADDED);
    const lines = fs.readFileSync(claudeMdPath, 'utf-8').split('\n');
    const at = lines.indexOf(ONE_TAP);
    expect(lines[at + 1]).toMatch(/^- \*\*Repair waiting for approval: reminder\*\*/);
    expect(lines[at + 2]).toMatch(/^- \*\*Unreachable-machine notices\*\*/);
    expect(bullets(lines.join('\n'))).toHaveLength(2);
  });

  it('a fresh migration ends with exactly one copy of each, in the template wording', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    run(); run();
    expect(bullets(fs.readFileSync(claudeMdPath, 'utf-8')).length).toBeLessThanOrEqual(2);
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n${ONE_TAP}\n`);
    run();
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(bullets(fs.readFileSync(claudeMdPath, 'utf-8'))).toEqual(bullets(md));
    expect(bullets(md)).toHaveLength(2);
  });
});
