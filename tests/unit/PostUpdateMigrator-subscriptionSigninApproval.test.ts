import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SUBSCRIPTION_SIGNIN_SKILL_CONTENT } from '../../src/data/builtinSkillContent.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
let projectDir: string;
const skillFile = () => path.join(projectDir, '.claude', 'skills', 'subscription-signin', 'SKILL.md');
function migrate(): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateSubscriptionSigninApprovalBoundary(r: MigrationResult): void }).migrateSubscriptionSigninApprovalBoundary(r);
  return r;
}
beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-signin-approval-'));
  fs.mkdirSync(path.join(projectDir, '.claude', 'skills', 'subscription-signin'), { recursive: true });
});
afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-subscriptionSigninApproval.test.ts' }); });

describe('subscription sign-in approval guidance', () => {
  it('the shipped skill separates sign-in approval, credential transfer, and cold recovery', () => {
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('The operator may approve auto-login for an exact account and machine');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('if it already authorizes this repair, do not ask again');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('Threadline/Witness agent identity alone');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('Approval of sign-in does not by itself authorize copying');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('A profile alone does not prove cold recovery');
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).toContain('including an existing Bitwarden or Keychain path');
  });
  it('migrates the installed default skill without losing local notes and is idempotent', () => {
    const old = SUBSCRIPTION_SIGNIN_SKILL_CONTENT
      .replace(/^\- The operator may approve auto-login.*\n\- When another agent relays approval.*\n\- Approval of sign-in.*\n/m, '')
      .replace(/1\. \*\*Each Google account has its own Chrome profile on each machine\*\*[^\n]*/, '1. **Each Google account has its own Chrome profile on each machine**, kept signed in to Google. Claude and Codex both sign in "with Google", so a healthy Google session in that profile is what makes every later re-sign-in a few clicks.\n   When Google itself asks to sign in again, use a password from the vault.')
      .replace(/2\. Check which recovery method the operator approved[^\n]*/, "2. Make sure the vault holds the account's Google password and its authenticator (TOTP) secret, then sign in.");
    fs.writeFileSync(skillFile(), old + '\nMy local note.\n');
    const first = migrate();
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain('skills/subscription-signin/SKILL.md (added verified approval boundary)');
    const once = fs.readFileSync(skillFile(), 'utf8');
    expect(once).toContain('My local note.');
    expect(once).toContain('Check which recovery method the operator approved');
    expect(once).toContain('A profile alone does not prove cold recovery');
    expect(once).not.toContain('what makes every later re-sign-in a few clicks');
    expect(once).toContain('Threadline/Witness agent identity alone');
    migrate();
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(once);
  });
  it('repairs stale recovery prose even when the approval marker was installed earlier', () => {
    const partial = SUBSCRIPTION_SIGNIN_SKILL_CONTENT.replace(
      /2\. Check which recovery method the operator approved[^\n]*/,
      "2. Check which recovery method the operator approved. For unattended cold recovery, use vault credentials only when transfer was separately approved.",
    );
    fs.writeFileSync(skillFile(), partial);
    expect(migrate().errors).toEqual([]);
    const repaired = fs.readFileSync(skillFile(), 'utf8');
    expect(repaired).toContain('including an existing Bitwarden or Keychain path');
    expect(repaired).not.toContain('only when transfer was separately approved');
    migrate();
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(repaired);
  });
});
