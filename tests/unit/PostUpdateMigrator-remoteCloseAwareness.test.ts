/**
 * Verifies PostUpdateMigrator adds the pool remote-session-close bullet to
 * existing agents' CLAUDE.md on update (Migration Parity Standard +
 * REMOTE-SESSION-CLOSE-SPEC §2.4 Agent Awareness).
 *
 * §2.0 names "the operator's authenticated agent" as a caller of the relayed
 * close. An agent that never learns `POST /sessions/:name/remote-close`
 * hand-issues curl against the peer's tunnel URL (lived 2026-06-11, five
 * stale Mini sessions) instead of the audited, allowlisted relay.
 *
 * Also pins byte-parity: generateClaudeMd (new agents) and migrateClaudeMd
 * (existing agents) must produce the identical bullet.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const PORT = 4042;

// The child-marker content sniff (§2.4): insert when the parent Multi-Machine
// Session Pool section exists but this marker is missing.
const MARKER = 'remote-close';
const BULLET_START = '- **Remote close (any machine, from here):**';
const BULLET_END = 'reap-log entry carries `viaClaim`.';
const PARENT_MARKER = 'Multi-Machine Session Pool (active-active';

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: PORT,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

function sliceBullet(doc: string): string {
  const start = doc.indexOf(BULLET_START);
  expect(start, 'remote-close bullet must be present').toBeGreaterThanOrEqual(0);
  const end = doc.indexOf(BULLET_END, start);
  expect(end, 'bullet terminator must be present').toBeGreaterThan(start);
  return doc.slice(start, end + BULLET_END.length);
}

describe('PostUpdateMigrator — pool remote session close CLAUDE.md bullet', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-remoteclose-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-remoteCloseAwareness.test.ts:cleanup',
    });
  });

  it('adds the bullet when the pool section exists but the remote-close marker is missing', () => {
    // An agent that already carries the parent Multi-Machine Session Pool
    // section (so the full-section append skips) but predates remote close.
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n## Multi-Machine Session Pool (active-active — spread conversations across machines)\n\n' +
        'Pool prose. `/pool/machines/` rename, `/pool/placement` read, `sessions?scope=pool`, ' +
        'Post-transfer closeout, Quota-aware placement.\n',
    );

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('pool remote session close'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    expect(after).toContain('POST /sessions/<name>/remote-close');
    expect(after).toContain('{"machineId":"<id>","sessionUuid":"<uuid>"}');
    // §2.0 authority honesty: protected sessions ARE closeable; the confirm is the safety.
    expect(after).toContain('it WILL close a protected session');
    // §2.3 delivery honesty: timeout = outcome-unknown, never a fake verdict.
    expect(after).toContain('outcome-UNKNOWN');
    // §2.3 both-ends audit trail.
    expect(after).toContain('logs/remote-close-audit.jsonl');
    expect(after).toContain('viaClaim');
  });

  it('adds the bullet for an agent missing the pool section entirely (section append + child insert in one run)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(PARENT_MARKER);
    expect(after).toContain(BULLET_START);
    // Exactly once — the full-section append now carries the bullet, so the
    // child-marker migration must NOT double-insert in the same run.
    expect(after.split(BULLET_START).length - 1).toBe(1);
  });

  it('is idempotent — a second run changes nothing and the bullet appears once', () => {
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n## Multi-Machine Session Pool (active-active — spread conversations across machines)\n\n' +
        'Pool prose. `/pool/machines/` `/pool/placement` `sessions?scope=pool` ' +
        'Post-transfer closeout, Quota-aware placement.\n',
    );

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.split(BULLET_START).length - 1).toBe(1);
    expect(second.upgraded.some(u => u.includes('pool remote session close'))).toBe(false);
  });

  it('migrated bullet is byte-identical to the generateClaudeMd (fresh init) bullet', () => {
    fs.writeFileSync(
      claudeMdPath,
      '# CLAUDE.md\n\n## Multi-Machine Session Pool (active-active — spread conversations across machines)\n\n' +
        'Pool prose. `/pool/machines/` `/pool/placement` `sessions?scope=pool` ' +
        'Post-transfer closeout, Quota-aware placement.\n',
    );
    runClaudeMdMigration(newMigrator(projectDir));

    const migrated = sliceBullet(fs.readFileSync(claudeMdPath, 'utf-8'));
    const fresh = sliceBullet(generateClaudeMd('test', 'TestAgent', PORT, false));
    expect(migrated).toBe(fresh);
  });

  it('generateClaudeMd carries the bullet for new agents (Agent Awareness Standard)', () => {
    const fresh = generateClaudeMd('test', 'TestAgent', PORT, false);
    expect(fresh).toContain(BULLET_START);
    expect(fresh).toContain('POST /sessions/<name>/remote-close');
    expect(fresh).toContain('it WILL close a protected session');
    expect(fresh).toContain('logs/remote-close-audit.jsonl');
  });
});
