/**
 * Codex device-limit tripwire (docs/specs/codex-device-limit-tripwire.md §11), Migration Parity:
 * existing agents get the Subscription Pool bullet (byte-identical to generateClaudeMd) and the
 * /subscription-signin skill's device-limit lines, both idempotently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, CODEX_DEVICE_LIMIT_CLAUDEMD_BULLET as BULLET } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SUBSCRIPTION_SIGNIN_SKILL_CONTENT as CONTENT } from '../../src/data/builtinSkillContent.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = 'Codex device-limit tripwire';
const POOL_HEADING = '**Subscription Pool (multi-account quota + auto-swap + enrollment)** — pool prose.';
const BLOCKER = '- **Why a sign-in repair did not start** — blockers prose.';
const RULE = '- If a page says this device has reached its limit of paid accounts';
const HELPER = '- **A device-limit page:**';

let dir: string;
function migrator() {
  return new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function runClaudeMd(): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator() as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}
function runSkill(): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator() as unknown as Record<string, (r: MigrationResult) => void>).migrateSubscriptionSigninDeviceLimit(result);
  return result;
}
const lineOf = (text: string, start: string) => {
  const i = text.indexOf(start);
  return text.slice(i, text.indexOf('\n', i) + 1);
};
const skillFile = () => path.join(dir, '.claude', 'skills', 'subscription-signin', 'SKILL.md');
function install(content: string) {
  fs.mkdirSync(path.dirname(skillFile()), { recursive: true });
  fs.writeFileSync(skillFile(), content);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-devlimit-mig-'));
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-codexDeviceLimitAwareness.test.ts:cleanup' });
});

describe('CLAUDE.md — Codex device-limit tripwire bullet', () => {
  it('the template carries the bullet once, inside the Subscription Pool section, with its required facts', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(md.split(MARKER).length - 1).toBe(1);
    expect(md).toContain(BULLET.trimEnd());
    const pool = md.indexOf('**Subscription Pool (multi-account quota');
    expect(md.indexOf(MARKER)).toBeGreaterThan(pool);
    expect(md.indexOf(MARKER)).toBeLessThan(md.indexOf('**Live Credential Re-pointing'));
    for (const fact of ['codex-device-limit', 'THIS machine', 'Jev', 'Luna', '5–60 min', 'TypeSafe', 'statusCause', 'deviceLimit',
      'logs/codex-device-limit.jsonl', 'layout decision', 'subscriptionPool.codexDeviceLimit.ignoreAccounts',
      'subscriptionPool.codexDeviceLimit.enabled', 'Proactive trigger:']) {
      expect(BULLET, fact).toContain(fact);
    }
  });

  it('inserts the bullet after the blocker bullet, and a re-run changes nothing', () => {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, `# CLAUDE.md\n\n${POOL_HEADING}\n${BLOCKER}\n- **Next** — unchanged.\n`);
    const first = runClaudeMd();
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain('CLAUDE.md: added Subscription Pool Codex device-limit tripwire bullet');
    const after = fs.readFileSync(file, 'utf-8');
    expect(after).toContain(`${BLOCKER}\n${BULLET}- **Next** — unchanged.\n`);
    const second = runClaudeMd();
    expect(second.upgraded).not.toContain('CLAUDE.md: added Subscription Pool Codex device-limit tripwire bullet');
    expect(fs.readFileSync(file, 'utf-8').split(MARKER).length - 1).toBe(1);
  });

  it('falls back to right after the section heading when the blocker bullet is absent', () => {
    const file = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(file, `# CLAUDE.md\n\n${POOL_HEADING}\n- **Other** — x.\n`);
    runClaudeMd();
    expect(fs.readFileSync(file, 'utf-8')).toContain(`${POOL_HEADING}\n${BULLET}- **Other** — x.\n`);
  });
});

describe('/subscription-signin — device-limit lines', () => {
  it('the shipped skill names the device-limit page in the hard rules and the agent-run section', () => {
    expect(CONTENT).toContain("'Device limit reached'");
    expect(CONTENT.indexOf(RULE)).toBeGreaterThan(CONTENT.indexOf('## Hard rules'));
    expect(CONTENT.indexOf(HELPER)).toBeGreaterThan(CONTENT.indexOf('### Agent-run repair'));
    expect(lineOf(CONTENT, HELPER)).toContain('"line":"device-limit"');
  });

  it('upgrades the previous version to exactly the current skill, and is idempotent', () => {
    const previous = CONTENT.replace(lineOf(CONTENT, RULE), '').replace(lineOf(CONTENT, HELPER), '');
    expect(previous).not.toContain(RULE);
    install(previous);
    const first = runSkill();
    expect(first.errors).toEqual([]);
    expect(first.upgraded).toContain('skills/subscription-signin/SKILL.md (added the device-limit hard rule and agent-run line; local edits kept)');
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(CONTENT);
    const second = runSkill();
    expect(second).toEqual({ upgraded: [], skipped: [], errors: [] });
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe(CONTENT);
  });

  it('keeps local edits and reports a customised copy without the stock anchors', () => {
    install('---\nname: subscription-signin\n---\n# My own sign-in notes\n');
    const r = runSkill();
    expect(r.upgraded).toEqual([]);
    expect(r.skipped).toContain('skills/subscription-signin/SKILL.md: customized — left untouched (no device-limit lines)');
    expect(fs.readFileSync(skillFile(), 'utf8')).toBe('---\nname: subscription-signin\n---\n# My own sign-in notes\n');
  });

  it('never touches a file that is not the subscription-signin skill', () => {
    install('# something else\n- Never use an automated browser for a sign-in page.\n');
    expect(runSkill()).toEqual({ upgraded: [], skipped: [], errors: [] });
  });
});
