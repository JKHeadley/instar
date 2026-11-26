/**
 * /subscription-signin "A machine with no usable browser" section + three failure-table rows
 * (proven 2026-09-27 on a Windows/WSL machine signed in from a Mac): existing agents get both,
 * local edits are kept, and the migration is idempotent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SUBSCRIPTION_SIGNIN_SKILL_CONTENT as CONTENT } from '../../src/data/builtinSkillContent.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = '### A machine with no usable browser (sign it in from a Mac)';
const TABLE = '## 4. When a repair does not finish';
const ROWS = '| "Continue with Google" returns "There was an error logging you in" |';
const ANY_ROW = '| Anything else | Read the reason |';
const V1 = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'skills', 'subscription-signin-v1.md'), 'utf8');
// The version before this change: today's content without the new section and rows.
const PREVIOUS = CONTENT.slice(0, CONTENT.indexOf(MARKER)) + CONTENT.slice(CONTENT.indexOf(TABLE), CONTENT.indexOf(ROWS))
  + CONTENT.slice(CONTENT.indexOf(ANY_ROW));

let projectDir: string;
const skillFile = () => path.join(projectDir, '.claude', 'skills', 'subscription-signin', 'SKILL.md');
function run(): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  const m = migrator as unknown as Record<string, (r: MigrationResult) => void>;
  m.migrateSubscriptionSigninByHand(result);
  m.migrateSubscriptionSigninAgentRun(result);
  m.migrateSubscriptionSigninCrossMachine(result);
  return result;
}
function install(content: string): void {
  fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
  fs.writeFileSync(skillFile(), content);
}
beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-signin-crossmachine-')); fs.mkdirSync(path.join(projectDir, '.instar')); });
afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-subscriptionSigninCrossMachine.test.ts' }); });

describe('PostUpdateMigrator — subscription-signin cross-machine section', () => {
  it('the shipped skill carries the section before the repair table and the rows inside it', () => {
    expect(CONTENT.indexOf(MARKER)).toBeGreaterThan(CONTENT.indexOf('### Agent-run repair'));
    expect(CONTENT.indexOf(MARKER)).toBeLessThan(CONTENT.indexOf(TABLE));
    expect(CONTENT.indexOf(ROWS)).toBeGreaterThan(CONTENT.indexOf(TABLE));
    expect(CONTENT.indexOf(ROWS)).toBeLessThan(CONTENT.indexOf(ANY_ROW));
    expect(CONTENT).toContain('a locked screen is **not** a blocker');
    expect(CONTENT).toContain('Select a workspace');
    expect(PREVIOUS).not.toContain(MARKER);
    expect(PREVIOUS).not.toContain(ROWS);
  });

  it('upgrades the previous version to exactly the current skill, and is idempotent', () => {
    install(PREVIOUS);
    const first = run();
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain('skills/subscription-signin/SKILL.md (added cross-machine section and three failure-table rows; local edits kept)');
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(CONTENT);
    const second = run();
    expect(second.upgraded).toEqual([]);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(CONTENT);
  });

  it('keeps local edits', () => {
    install(PREVIOUS.replace('## 5. Keeping it healthy', '## 5. Keeping it healthy\n\n- my own local note'));
    run();
    const after = fs.readFileSync(skillFile(), 'utf8');
    expect(after).toContain('- my own local note');
    expect(after).toContain(MARKER);
    expect(after).toContain(ROWS);
  });

  it('a stock first-shipped copy ends up with the full current skill', () => {
    install(V1);
    run();
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(CONTENT);
  });

  it('leaves a customized copy without the stock headings untouched, and an absent file alone', () => {
    run();
    expect(fs.existsSync(skillFile())).toBe(false);
    install('---\nname: subscription-signin\n---\n# mine\n');
    const result = run();
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe('---\nname: subscription-signin\n---\n# mine\n');
    expect(result.skipped.some((s) => s.includes('no cross-machine section'))).toBe(true);
  });
});
