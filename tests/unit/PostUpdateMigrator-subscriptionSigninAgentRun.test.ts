/**
 * /subscription-signin "Agent-run repair" subsection (spec skill-driven-signin-repair): existing
 * agents get it. It tells an Instar-started helper to post ONLY to the loopback code route and
 * never touch the enroll/complete/reissue routes the by-hand steps mention.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SUBSCRIPTION_SIGNIN_SKILL_CONTENT } from '../../src/data/builtinSkillContent.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = '### Agent-run repair (when Instar starts you as the sign-in helper)';
const V1 = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'skills', 'subscription-signin-v1.md'), 'utf8');
// The version #2075 shipped: today's content without the agent-run subsection.
const V2 = SUBSCRIPTION_SIGNIN_SKILL_CONTENT.slice(0, SUBSCRIPTION_SIGNIN_SKILL_CONTENT.indexOf(MARKER))
  + SUBSCRIPTION_SIGNIN_SKILL_CONTENT.slice(SUBSCRIPTION_SIGNIN_SKILL_CONTENT.indexOf('## 4. When a repair does not finish'));

let projectDir: string;
const skillFile = () => path.join(projectDir, '.claude', 'skills', 'subscription-signin', 'SKILL.md');
function run(): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  const m = migrator as unknown as { migrateSubscriptionSigninByHand(r: MigrationResult): void; migrateSubscriptionSigninAgentRun(r: MigrationResult): void };
  m.migrateSubscriptionSigninByHand(result);
  m.migrateSubscriptionSigninAgentRun(result);
  return result;
}
function install(content: string): void {
  fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
  fs.writeFileSync(skillFile(), content);
}
beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-signin-agentrun-')); fs.mkdirSync(path.join(projectDir, '.instar')); });
afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-subscriptionSigninAgentRun.test.ts' }); });

describe('PostUpdateMigrator — subscription-signin agent-run subsection', () => {
  it('the shipped skill carries the subsection inside section 3, before the repair table', () => {
    const at = SUBSCRIPTION_SIGNIN_SKILL_CONTENT.indexOf(MARKER);
    expect(at).toBeGreaterThan(SUBSCRIPTION_SIGNIN_SKILL_CONTENT.indexOf('## 3. Signing in by hand'));
    expect(at).toBeLessThan(SUBSCRIPTION_SIGNIN_SKILL_CONTENT.indexOf('## 4. When a repair does not finish'));
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('/subscription-relogin/<episode>/code');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('X-Relogin-Helper-Token');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('Do NOT enroll, cancel, reissue or complete any login');
  });

  it('adds it to the #2075 version, keeps local edits, and is idempotent', () => {
    install(V2.replace('## 5. Keeping it healthy', '## 5. Keeping it healthy\n\n- my own local note'));
    const first = run();
    expect(first.upgraded).toContain('skills/subscription-signin/SKILL.md (added the agent-run repair subsection; local edits kept)');
    const once = fs.readFileSync(skillFile(), 'utf8');
    expect(once).toContain(MARKER);
    expect(once).toContain('- my own local note');
    expect(once.indexOf(MARKER)).toBeLessThan(once.indexOf('## 4. When a repair does not finish'));
    run();
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(once);
  });

  it('a stock first-shipped copy ends up with the full current skill after both migrations', () => {
    install(V1);
    run();
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(SUBSCRIPTION_SIGNIN_SKILL_CONTENT);
  });

  it('leaves a customized copy without section 3 untouched, and an absent file alone', () => {
    run();
    expect(fs.existsSync(skillFile())).toBe(false);
    install('---\nname: subscription-signin\n---\n# mine\n## 4. When a repair does not finish\n');
    const result = run();
    expect(fs.readFileSync(skillFile(), 'utf8')).not.toContain(MARKER);
    expect(result.skipped.some((s) => s.includes('no agent-run repair subsection'))).toBe(true);
  });
});
