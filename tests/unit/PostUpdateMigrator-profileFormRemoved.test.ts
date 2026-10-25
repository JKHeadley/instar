/**
 * The Subscriptions dashboard's "Create a dedicated sign-in profile" form was removed (it only
 * made an empty Chrome profile + registry row and never signed in; the agent now creates and signs
 * in these profiles itself). Existing agents must stop being told to use it:
 *   - CLAUDE.md: the old "Remote/phone-complete provisioning" bullet (either shipped wording) and
 *     the old Registry-First row answer are rewritten to the agent-does-it text. Only the exact
 *     stock text is swapped: operator additions survive, an edited wording is left intact (and
 *     reported in `skipped`); idempotent; unrelated text untouched.
 *   - /subscription-signin skill: the one "Phone-first alternative" sentence is dropped; local
 *     edits kept; idempotent.
 * The provision ROUTE itself is unchanged (see tests/integration/playwright-profile-routes.test.ts).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PostUpdateMigrator,
  DEDICATED_PROFILE_PROVISIONING_CLAUDEMD_BULLET,
  DEDICATED_PROFILE_REGISTRY_ROW_ANSWER,
  PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SUBSCRIPTION_SIGNIN_SKILL_CONTENT } from '../../src/data/builtinSkillContent.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const OLD_SECTION_BULLET = '- **Remote/phone-complete provisioning**: the Subscriptions dashboard creates and materializes a dedicated Google profile after a recent PIN unlock. Programmatic equivalent: `POST /playwright-profiles/provision` with `X-Instar-Operator-Session` + `{profileId,identity,loginMethod}`. Handle everything else yourself; if a password/TOTP is missing, send ONE Secret Drop link. Never ask the operator to access the host machine.\n';
const OLD_PATCHED_BULLET = '- **Remote/phone-complete provisioning**: use the Subscriptions dashboard or `POST /playwright-profiles/provision` with a recent dashboard operator session to create + materialize a dedicated Google profile. If credentials are missing, send one Secret Drop link; never ask the operator to access the host machine.\n';
const ROW_QUESTION = '| How do I create a dedicated Google browser profile without host-machine access? | ';
const OLD_ROW = ROW_QUESTION + 'Use the Subscriptions dashboard or PIN-scoped `POST /playwright-profiles/provision`; if credentials are needed, send one Secret Drop link and continue after receipt — never ask the operator to access the machine |\n';
const NEW_ROW = ROW_QUESTION + DEDICATED_PROFILE_REGISTRY_ROW_ANSWER + ' |\n';
const UPGRADED = 'CLAUDE.md: profile provisioning guidance no longer points at the removed dashboard form';
const STALE_SKILL_SENTENCE = " Phone-first alternative: the Subscriptions dashboard's profile provisioning.";

let projectDir: string;
function migrator(): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function runClaudeMd(): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator() as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}
function runSkill(): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator() as unknown as { migrateSubscriptionSigninDropProfileFormPointer(r: MigrationResult): void })
    .migrateSubscriptionSigninDropProfileFormPointer(result);
  return result;
}
const claudeMd = () => path.join(projectDir, 'CLAUDE.md');
const skillFile = () => path.join(projectDir, '.claude', 'skills', 'subscription-signin', 'SKILL.md');

beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-profile-form-removed-')); fs.mkdirSync(path.join(projectDir, '.instar')); });
afterEach(() => { SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-profileFormRemoved.test.ts' }); });

describe('shipped text no longer points at the removed dashboard form', () => {
  it('the CLAUDE.md template and section tell the agent to provision profiles itself', () => {
    const section = PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION(4042);
    expect(section).toContain(DEDICATED_PROFILE_PROVISIONING_CLAUDEMD_BULLET);
    expect(section).not.toContain('Remote/phone-complete provisioning');
    const full = generateClaudeMd('test', 'Agent', 4042, false);
    expect(full).not.toContain('Use the Subscriptions dashboard or PIN-scoped');
    expect(full).not.toContain('Subscriptions dashboard creates and materializes');
    expect(full).toContain('/playwright-profiles/provision'); // the route is still documented
    expect(full).toContain(NEW_ROW);
  });

  it('the shipped /subscription-signin skill has no pointer to the form', () => {
    expect(SUBSCRIPTION_SIGNIN_SKILL_CONTENT).not.toContain('Phone-first alternative');
  });
});

describe('PostUpdateMigrator — CLAUDE.md provisioning bullet', () => {
  for (const [label, oldBullet] of [['section wording', OLD_SECTION_BULLET], ['patched wording', OLD_PATCHED_BULLET]] as const) {
    it(`rewrites the old ${label} and is idempotent`, () => {
      const before = PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION(4042).replace(DEDICATED_PROFILE_PROVISIONING_CLAUDEMD_BULLET, oldBullet);
      expect(before).toContain('Remote/phone-complete provisioning');
      fs.writeFileSync(claudeMd(), `# Agent\n${before}\n## Tail\nkeep me\n`);
      const first = runClaudeMd();
      expect(first.errors).toEqual([]);
      expect(first.upgraded).toContain(UPGRADED);
      const once = fs.readFileSync(claudeMd(), 'utf8');
      expect(once).not.toContain('Remote/phone-complete provisioning');
      expect(once.split(DEDICATED_PROFILE_PROVISIONING_CLAUDEMD_BULLET).length).toBe(2); // exactly one copy
      expect(once).toContain('- **Assign an account to a profile**:');
      expect(once).toContain('keep me');
      const second = runClaudeMd();
      expect(second.upgraded).not.toContain(UPGRADED);
      expect(fs.readFileSync(claudeMd(), 'utf8')).toBe(once);
    });
  }

  it('keeps operator additions around the stock bullet, and is idempotent', () => {
    const custom = OLD_SECTION_BULLET.trimEnd() + ' Only for approved@example.test; keep the existing finance profile.\n';
    const before = PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION(4042).replace(DEDICATED_PROFILE_PROVISIONING_CLAUDEMD_BULLET, custom);
    fs.writeFileSync(claudeMd(), `# Agent\n${before}`);
    expect(runClaudeMd().upgraded).toContain(UPGRADED);
    const once = fs.readFileSync(claudeMd(), 'utf8');
    expect(once).not.toContain('Subscriptions dashboard');
    expect(once).toContain(DEDICATED_PROFILE_PROVISIONING_CLAUDEMD_BULLET.trimEnd() + ' Only for approved@example.test; keep the existing finance profile.\n');
    expect(runClaudeMd().upgraded).not.toContain(UPGRADED);
    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe(once);
  });

  it('leaves a customized bullet wording intact (reported, never silently rewritten), and is idempotent', () => {
    const custom = '- **Remote/phone-complete provisioning**: ONLY for approved@example.test, via the Subscriptions dashboard or `POST /playwright-profiles/provision`. Never touch the existing finance profile.\n';
    const before = `# Agent\n${PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION(4042).replace(DEDICATED_PROFILE_PROVISIONING_CLAUDEMD_BULLET, custom)}`;
    fs.writeFileSync(claudeMd(), before);
    const first = runClaudeMd();
    expect(first.upgraded).not.toContain(UPGRADED);
    expect(first.skipped.some(s => s.includes('customized profile provisioning guidance left as-is'))).toBe(true);
    const once = fs.readFileSync(claudeMd(), 'utf8');
    expect(once).toContain(custom);
    expect(once).not.toContain(DEDICATED_PROFILE_PROVISIONING_CLAUDEMD_BULLET); // no second, contradicting bullet
    runClaudeMd();
    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe(once);
  });

  it('leaves a current CLAUDE.md alone', () => {
    fs.writeFileSync(claudeMd(), `# Agent\n${PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION(4042)}`);
    const result = runClaudeMd();
    expect(result.upgraded).not.toContain(UPGRADED);
    expect(fs.readFileSync(claudeMd(), 'utf8').split(DEDICATED_PROFILE_PROVISIONING_CLAUDEMD_BULLET).length).toBe(2);
  });
});

describe('PostUpdateMigrator — /subscription-signin form pointer', () => {
  function installSkill(content: string): void {
    fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
    fs.writeFileSync(skillFile(), content);
  }
  const marker = '`{"service":"google","identity":"<email>","owner":"operator"|"agent","vaultRefs":[...]}`.';

  it('drops the sentence, keeps local edits, and is idempotent', () => {
    const old = SUBSCRIPTION_SIGNIN_SKILL_CONTENT.replace(marker, marker + STALE_SKILL_SENTENCE) + '\n- my own local note\n';
    expect(old).toContain(STALE_SKILL_SENTENCE);
    installSkill(old);
    const first = runSkill();
    expect(first.upgraded).toContain('skills/subscription-signin/SKILL.md (removed the pointer to the retired dashboard profile form)');
    const once = fs.readFileSync(skillFile(), 'utf8');
    expect(once).toBe(SUBSCRIPTION_SIGNIN_SKILL_CONTENT + '\n- my own local note\n');
    expect(runSkill().upgraded).toEqual([]);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(once);
  });

  it('does nothing to a current skill or a missing one', () => {
    expect(runSkill()).toEqual({ upgraded: [], skipped: [], errors: [] });
    installSkill(SUBSCRIPTION_SIGNIN_SKILL_CONTENT);
    expect(runSkill().upgraded).toEqual([]);
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(SUBSCRIPTION_SIGNIN_SKILL_CONTENT);
  });
});

describe('PostUpdateMigrator — CLAUDE.md Registry-First table row', () => {
  it('rewrites the old stock row answer, keeps the rest of the table, and is idempotent', () => {
    const table = '| Question | Answer |\n|---|---|\n' + OLD_ROW + '| Project architecture? | This file (CLAUDE.md), then project docs |\n';
    fs.writeFileSync(claudeMd(), `# Agent\n${table}${PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION(4042)}`);
    const first = runClaudeMd();
    expect(first.upgraded).toContain(UPGRADED);
    const once = fs.readFileSync(claudeMd(), 'utf8');
    expect(once).not.toContain('Use the Subscriptions dashboard or PIN-scoped');
    expect(once).toContain(NEW_ROW);
    expect(once).toContain('| Project architecture? | This file (CLAUDE.md), then project docs |');
    expect(runClaudeMd().upgraded).not.toContain(UPGRADED);
    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe(once);
  });

  it('keeps operator text appended to the stock row answer', () => {
    const custom = OLD_ROW.replace(' |\n', '. Ask Dana first. |\n');
    fs.writeFileSync(claudeMd(), `# Agent\n${custom}`);
    runClaudeMd();
    const once = fs.readFileSync(claudeMd(), 'utf8');
    expect(once).toContain(ROW_QUESTION + DEDICATED_PROFILE_REGISTRY_ROW_ANSWER + '. Ask Dana first. |\n');
    runClaudeMd();
    expect(fs.readFileSync(claudeMd(), 'utf8')).toBe(once);
  });
});
