import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PostUpdateMigrator, SESSION_HANDOFF_CLAUDEMD_MARKER } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type Result = { upgraded: string[]; skipped: string[]; errors: string[] };
const dirs: string[] = [];

function migrate(projectDir: string): Result {
  const result: Result = { upgraded: [], skipped: [], errors: [] };
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'echo' });
  (migrator as unknown as { migrateClaudeMd(value: Result): void }).migrateClaudeMd(result);
  return result;
}

// Bug 2026-11-03 (Echo Bugs topic 10000001474): agents had no documented
// session-to-session channel, so a desk posted coordination into the user's topic.
describe('Talking to my other sessions — agent awareness', () => {
  afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-sessionHandoff.test.ts' }); });

  it('generateClaudeMd carries the section once, with the working route and the no-user-topic rule', () => {
    const fresh = generateClaudeMd('instar', 'Echo', 4042, true);
    expect(fresh.split(SESSION_HANDOFF_CLAUDEMD_MARKER)).toHaveLength(2);
    expect(fresh).toContain('http://localhost:4042/messages/send');
    expect(fresh).toContain('"type":"handoff"');
    expect(fresh).toContain("It is never a channel between my own sessions, jobs or desks");
    expect(fresh).toContain('the outbound check (B22) holds it');
  });

  it('migrateClaudeMd adds it once to an existing agent (content-sniffed, idempotent)', () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-handoff-awareness-'));
    dirs.push(projectDir);
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# Existing agent\n');
    const first = migrate(projectDir);
    expect(first.upgraded).toContain('CLAUDE.md: added Talking to my other sessions section');
    const migrated = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(migrated).toContain('http://localhost:4042/messages/send');
    const second = migrate(projectDir);
    expect(second.upgraded).not.toContain('CLAUDE.md: added Talking to my other sessions section');
    const after = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf8');
    expect(after.split(SESSION_HANDOFF_CLAUDEMD_MARKER)).toHaveLength(2);
  });
});
