// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/** Agent Awareness + Migration Parity for the rerouted-job expired-login fix. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import {
  REROUTED_LOGIN_EXPIRED_MARKER, REROUTED_LOGIN_EXPIRED_BULLET, STANDING_SESSIONS_BULLET, generateClaudeMd,
} from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}
const count = (s: string) => s.split(REROUTED_LOGIN_EXPIRED_MARKER).length - 1;

describe('rerouted-job expired-login CLAUDE.md bullet', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-login-expired-bullet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/rerouted-login-expired-awareness.test.ts:cleanup' }));

  it('new agents get it from the template, right after the standing-sessions bullet', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(count(md)).toBe(1);
    expect(md).toContain(STANDING_SESSIONS_BULLET + '\n' + REROUTED_LOGIN_EXPIRED_BULLET);
  });

  it('existing agents get it once, after the standing-sessions bullet; idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + STANDING_SESSIONS_BULLET + '\n- **Busy-orphan detection**: …\n');
    const r1 = run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(r1.upgraded).toContain('CLAUDE.md: added rerouted-job expired-login bullet');
    expect(count(once)).toBe(1);
    expect(once).toContain(STANDING_SESSIONS_BULLET + '\n' + REROUTED_LOGIN_EXPIRED_BULLET);
    const r2 = run(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(r2.skipped).toContain('CLAUDE.md: rerouted-job expired-login bullet already present');
  });

  it('names the reason, the degradation and that pool status is untouched', () => {
    expect(REROUTED_LOGIN_EXPIRED_BULLET).toContain('rerouted-login-expired');
    expect(REROUTED_LOGIN_EXPIRED_BULLET).toContain('SessionManager.monitorTick.reroutedLoginExpired');
    expect(REROUTED_LOGIN_EXPIRED_BULLET).toContain('never changes the account');
  });
});
