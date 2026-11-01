/**
 * Console makeover — Agent Awareness + Migration Parity for the CLAUDE.md bullet
 * (docs/specs/console-makeover.md, "Migration parity and agent awareness").
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { CONSOLE_MARKER, CONSOLE_BULLET, DASHBOARD_PREVIEW_BULLET, DASHBOARD_PREVIEW_MARKER, generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}
const count = (s: string) => s.split(CONSOLE_MARKER).length - 1;
const FEATURES = '- Features: Real-time terminal streaming, session management, file browser/editor, model badges, mobile-responsive';

describe('console CLAUDE.md bullet', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-console-bullet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/console-claude-md-awareness.test.ts:cleanup' }));

  it('new agents get it from the template, under the Dashboard features line', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(count(md)).toBe(1);
    expect(md).toContain(FEATURES + '\n' + CONSOLE_BULLET);
  });

  it('existing agents get it once, under the Dashboard features line; idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n**Dashboard** — x\n' + FEATURES + '\n- **Sharing the dashboard**: y\n');
    const r1 = run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(r1.upgraded).toContain('CLAUDE.md: added the new console (beside the dashboard) awareness');
    expect(count(once)).toBe(1);
    expect(once).toContain(FEATURES + '\n' + CONSOLE_BULLET + '\n' + DASHBOARD_PREVIEW_BULLET + '\n- **Sharing the dashboard**');
    run(projectDir);
    expect(count(fs.readFileSync(claudeMd, 'utf8'))).toBe(1);
  });

  it('a CLAUDE.md without the anchor gets it appended', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n');
    run(projectDir);
    expect(count(fs.readFileSync(claudeMd, 'utf8'))).toBe(1);
  });

  it('names the console URL and that legacy stays the default', () => {
    expect(CONSOLE_BULLET).toContain('/dashboard/console/');
    expect(CONSOLE_BULLET).toContain('stays the default');
  });
  it('the feature-preview bullet: new agents under the console bullet; existing agents once, idempotent', () => {
    const preview = (t: string) => t.split(DASHBOARD_PREVIEW_MARKER).length - 1;
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(md).toContain(CONSOLE_BULLET + '\n' + DASHBOARD_PREVIEW_BULLET);
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + FEATURES + '\n' + CONSOLE_BULLET + '\n- **Sharing the dashboard**: y\n');
    const r = run(projectDir);
    expect(r.upgraded).toContain('CLAUDE.md: added the dashboard preview (try features before merge) awareness');
    run(projectDir);
    const after = fs.readFileSync(claudeMd, 'utf8');
    expect(preview(after)).toBe(1);
    expect(after).toContain(CONSOLE_BULLET + '\n' + DASHBOARD_PREVIEW_BULLET);
    expect(DASHBOARD_PREVIEW_BULLET).toContain('/dashboard/preview/');
  });
});
