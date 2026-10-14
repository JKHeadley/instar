/**
 * Standing sessions (`sessions.standingSessions`) — config normalization, the
 * server.ts wiring (the guard dep and topic resolver must be REAL delegations,
 * not absent), and Migration Parity for the CLAUDE.md bullet.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { normalizeStandingSessions } from '../../src/core/Config.js';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import {
  STANDING_SESSIONS_MARKER, STANDING_SESSIONS_BULLET, REAPER_BACKGROUND_WORK_BULLET, generateClaudeMd,
} from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const ROOT = path.resolve(__dirname, '../..');
const serverSrc = () => fs.readFileSync(path.join(ROOT, 'src/commands/server.ts'), 'utf8');

describe('normalizeStandingSessions', () => {
  it('keeps trimmed non-empty strings, drops everything else', () => {
    expect(normalizeStandingSessions(['echo-desk', ' topic:52075 ', '', 3, null])).toEqual(['echo-desk', 'topic:52075']);
    expect(normalizeStandingSessions(undefined)).toEqual([]);
    expect(normalizeStandingSessions('echo-desk')).toEqual([]);
  });
});

describe('server.ts wiring', () => {
  it('feeds the shared ReapGuard a real standing-session predicate', () => {
    expect(serverSrc()).toContain('isStandingSession: (s) => sessionManager.isStandingSession(s),');
  });
  it('wires the topic resolver so topic:<id> entries can match', () => {
    expect(serverSrc()).toContain('sessionManager.setStandingTopicResolver(_resolveTopic);');
  });
  it('marks the topic-transfer drain close as a trusted duplicate-removing close', () => {
    expect(serverSrc()).toMatch(/via: 'ws12-drain',\s*topicTransferClose: true,/);
  });
  it('gives the dashboard topic spawn a liveness probe so a dead mapping does not refuse', () => {
    expect(serverSrc()).toContain('isSessionAlive: (tmux) => sessionManager.isSessionAlive(tmux),');
  });
});

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}
const count = (s: string) => s.split(STANDING_SESSIONS_MARKER).length - 1;

describe('standing-sessions CLAUDE.md bullet (Agent Awareness + Migration Parity)', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-standing-bullet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/standing-sessions-wiring.test.ts:cleanup' }));

  it('new agents get it from the template, right after the background-work bullet', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(count(md)).toBe(1);
    expect(md).toContain(REAPER_BACKGROUND_WORK_BULLET + '\n' + STANDING_SESSIONS_BULLET);
  });

  it('existing agents get it once, placed after the background-work bullet; idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + REAPER_BACKGROUND_WORK_BULLET + '\n- **Busy-orphan detection**: …\n');
    const r1 = run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(r1.upgraded).toContain('CLAUDE.md: added standing-sessions bullet');
    expect(count(once)).toBe(1);
    expect(once).toContain(REAPER_BACKGROUND_WORK_BULLET + '\n' + STANDING_SESSIONS_BULLET);
    const r2 = run(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(r2.skipped).toContain('CLAUDE.md: standing-sessions bullet already present');
  });

  it('steers users away from protectedSessions for a restartable coordinator', () => {
    expect(STANDING_SESSIONS_BULLET).toContain('never to `protectedSessions`');
  });
});
