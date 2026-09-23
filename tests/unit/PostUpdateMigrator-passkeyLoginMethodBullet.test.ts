/**
 * The `google-passkey` login-method bullet reaches EXISTING agents (Migration Parity,
 * spec agent-held-google-passkey §6): an agent whose CLAUDE.md already carries the
 * Playwright Profile Registry section is skipped by the section-level content sniff, so
 * a bullet-level marker (the revert route path) inserts it, idempotently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PostUpdateMigrator,
  PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION,
  PASSKEY_LOGIN_METHOD_CLAUDEMD_BULLET,
} from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = '/passkeys/revert-method';

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function run(m: PostUpdateMigrator): MigrationResult {
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}

describe('PostUpdateMigrator — passkey login-method bullet', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-passkey-bullet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-passkeyLoginMethodBullet.test.ts:cleanup' }));

  it('the generated section AND the new-agent template carry the bullet', () => {
    expect(PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION(4042)).toContain(MARKER);
    expect(PASSKEY_LOGIN_METHOD_CLAUDEMD_BULLET).toContain('priorLoginMethod');
    expect(PASSKEY_LOGIN_METHOD_CLAUDEMD_BULLET).toContain('never guesses a method');
    expect(generateClaudeMd({ projectName: 'p', agentName: 'a', userName: 'u', port: 4042 } as never)).toContain(MARKER);
  });

  it('inserts the bullet into a pre-existing section that lacks it, before the "Pick the right profile" bullet', () => {
    const old = PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION(4042).replace(PASSKEY_LOGIN_METHOD_CLAUDEMD_BULLET, '');
    expect(old).not.toContain(MARKER);
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + old);
    const r = run(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMd, 'utf8');
    expect(r.upgraded.some((u) => u.includes('passkey login method'))).toBe(true);
    expect(after.split(MARKER).length - 1).toBe(1);
    expect(after.indexOf(MARKER)).toBeLessThan(after.indexOf('- **Pick the right profile for a task**:'));
    expect(after.split('### Playwright Profile Registry').length - 1).toBe(1);
  });

  it('extends an OLDER single passkey bullet (revert-method known, grants unknown) in place — increment 5 parity', () => {
    const oldBullet = '- **Passkey login method (`google-passkey`, ⚗️ dark)**: an account may carry `loginMethod: "google-passkey"` … Rollback lever: `POST /passkeys/revert-method` with the dashboard PIN … so the path is inert.\n';
    const section = PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION(4042).replace(PASSKEY_LOGIN_METHOD_CLAUDEMD_BULLET, oldBullet);
    expect(section).toContain(MARKER);
    expect(section).not.toContain('/passkeys/grants');
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + section);
    const r = run(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMd, 'utf8');
    expect(r.upgraded.some((u) => u.includes('grants/issuers/mandate'))).toBe(true);
    expect(after.split('/passkeys/grants').length - 1).toBe(1);
    expect(after.split('- **Passkey login method (').length - 1).toBe(1);
    expect(after).not.toContain('… Rollback lever');
    expect(after.indexOf('/passkeys/grants')).toBeLessThan(after.indexOf('- **Pick the right profile for a task**:'));
    // Idempotent on the marker.
    run(newMigrator(projectDir));
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(after);
  });

  it('is idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + PLAYWRIGHT_PROFILE_REGISTRY_CLAUDEMD_SECTION(4042));
    run(newMigrator(projectDir));
    const once = fs.readFileSync(claudeMd, 'utf8');
    run(newMigrator(projectDir));
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(once.split(MARKER).length - 1).toBe(1);
  });
});
