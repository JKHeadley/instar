/**
 * /subscription-signin by-hand update (operator directive 2026-09-25): existing agents get the
 * "Signing in by hand" section. A stock copy is replaced whole; an edited copy keeps its edits.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SUBSCRIPTION_SIGNIN_SKILL_CONTENT } from '../../src/data/builtinSkillContent.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const V1 = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'skills', 'subscription-signin-v1.md'), 'utf8');

let projectDir: string;
const skillFile = () => path.join(projectDir, '.claude', 'skills', 'subscription-signin', 'SKILL.md');
function run(): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateSubscriptionSigninByHand(r: MigrationResult): void }).migrateSubscriptionSigninByHand(result);
  return result;
}
function install(content: string): void {
  fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
  fs.writeFileSync(skillFile(), content);
}

beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-signin-byhand-')); fs.mkdirSync(path.join(projectDir, '.instar')); });
afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-subscriptionSigninByHand.test.ts' }); });

describe('PostUpdateMigrator — subscription-signin by-hand section', () => {
  it('the shipped skill carries the by-hand recipe and the password-page rule', () => {
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('## 3. Signing in by hand');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('Stay signed out');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain("Type a password only into Google's or Claude's own sign-in page");
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('`screencapture -x a.png b.png c.png`');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('Never solve or work around a CAPTCHA');
  });

  it('replaces a stock first-version copy with the new skill, and a second run changes nothing', () => {
    install(V1);
    expect(run().upgraded).toHaveLength(1);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(SUBSCRIPTION_SIGNIN_SKILL_CONTENT);
    const again = run();
    expect(again.upgraded).toHaveLength(0);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(SUBSCRIPTION_SIGNIN_SKILL_CONTENT);
  });

  it('keeps an agent\'s own edits and inserts the section before the repair table', () => {
    install(V1.replace('| Repeated failures on one account |', '| My own learned row | x | y |\n| Repeated failures on one account |'));
    const result = run();
    expect(result.upgraded[0]).toContain('local edits kept');
    const out = fs.readFileSync(skillFile(), 'utf8');
    expect(out).toContain('| My own learned row | x | y |');
    expect(out.indexOf('## 3. Signing in by hand')).toBeLessThan(out.indexOf('## 4. When a repair does not finish'));
    expect(out).not.toContain('## 3. When a repair does not finish');
    expect(run().upgraded).toHaveLength(0);
  });

  it('leaves an unrecognizable copy alone and does nothing when the skill is absent', () => {
    install('---\nname: subscription-signin\n---\nmy own procedure');
    expect(run().skipped[0]).toContain('customized');
    expect(fs.readFileSync(skillFile(), 'utf8')).toContain('my own procedure');
    SafeFsExecutor.safeRmSync(skillFile(), { force: true, operation: 'test' });
    expect(run()).toEqual({ upgraded: [], skipped: [], errors: [] });
  });
});
