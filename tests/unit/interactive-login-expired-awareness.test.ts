// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/** Agent Awareness + Migration Parity for CMT-1008 (interactive session at an expired login). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import {
  INTERACTIVE_LOGIN_EXPIRED_MARKER, INTERACTIVE_LOGIN_EXPIRED_BULLET, REROUTED_LOGIN_EXPIRED_BULLET, generateClaudeMd,
  REROUTED_LOGIN_EXPIRED_POOL_SENTENCE, REROUTED_LOGIN_EXPIRED_POOL_SENTENCE_V1,
} from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}
const count = (s: string) => s.split(INTERACTIVE_LOGIN_EXPIRED_MARKER).length - 1;

describe('interactive expired-login CLAUDE.md bullet', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ile-bullet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/interactive-login-expired-awareness.test.ts:cleanup' }));

  it('new agents get it from the template, right after the rerouted-job bullet', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(count(md)).toBe(1);
    expect(md).toContain(REROUTED_LOGIN_EXPIRED_BULLET + '\n' + INTERACTIVE_LOGIN_EXPIRED_BULLET);
  });

  it('existing agents get it once, after the rerouted-job bullet; idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + REROUTED_LOGIN_EXPIRED_BULLET + '\n- **Busy-orphan detection**: …\n');
    const r1 = run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(r1.upgraded).toContain('CLAUDE.md: added interactive expired-login bullet');
    expect(count(once)).toBe(1);
    expect(once).toContain(REROUTED_LOGIN_EXPIRED_BULLET + '\n' + INTERACTIVE_LOGIN_EXPIRED_BULLET);
    const r2 = run(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(r2.skipped).toContain('CLAUDE.md: interactive expired-login bullet already present');
  });

  it('an agent carrying the 2026-10-22 pool sentence gets the readable-credential rule, once', () => {
    const v1 = REROUTED_LOGIN_EXPIRED_BULLET.replace(REROUTED_LOGIN_EXPIRED_POOL_SENTENCE, REROUTED_LOGIN_EXPIRED_POOL_SENTENCE_V1);
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + v1 + '\n');
    const r1 = run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(r1.upgraded).toContain('CLAUDE.md: rerouted-job expired-login bullet names the readable-credential rule');
    expect(once).not.toContain(REROUTED_LOGIN_EXPIRED_POOL_SENTENCE_V1);
    expect(once).toContain(REROUTED_LOGIN_EXPIRED_BULLET + '\n' + INTERACTIVE_LOGIN_EXPIRED_BULLET);
    run(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
  });

  it('names both wordings, the swap route, the cause, the kill switch and the degradation', () => {
    for (const s of ['Not logged in · Run /login', 'Login expired · Please run /login', 'POST /subscription-pool/swap',
      'cli-login-expired-observed', 'subscriptionPool.loginExpiredSwap.enabled', 'SessionManager.monitorTick.interactiveLoginExpired']) {
      expect(INTERACTIVE_LOGIN_EXPIRED_BULLET).toContain(s);
    }
  });
});
