/**
 * The team-settings lookup in CLAUDE.md pointed at GET /mobile/team/context, which only the owner's
 * phone may read. The migration rewrites that phrase on the installed line (bullet or table row) to
 * the token-readable GET /team/people, once, and leaves every other line alone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-teamSwitchesRead.test.ts' }); });

function migrator() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'team-switch-read-')); dirs.push(projectDir);
  const stateDir = path.join(projectDir, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
  const m = new PostUpdateMigrator({ projectDir, stateDir, port: 4040, hasTelegram: false, projectName: 'test' } as never);
  return m as unknown as { patchClaudeMdContent(c: string, r: object): { content: string; patched: boolean } };
}
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
const OLD = '`GET /mobile/team/context` → `teamSwitches` lists each setting that is off somewhere';
const NEW = '`GET /team/people` → `teamSwitches` (my own token reads it; the owner\'s phone sees the same lines) lists each setting that is off somewhere';
const bullet = `- **Registry First — team settings:** a team needs memory privacy and app conversations on every machine. ${OLD}, with \`offOn\` (the machines).`;
const row = `| Is something off that team access needs? | **Registry First — team settings:** a team needs memory privacy. ${OLD}, with \`offOn\`. |`;

describe('team settings lookup reads GET /team/people', () => {
  it('rewrites the installed bullet and table row once, and is idempotent', () => {
    const m = migrator();
    const other = 'an unrelated line that quotes `GET /mobile/team/context` on purpose';
    const r1 = result();
    const once = m.patchClaudeMdContent(`# x\n${row}\n${other}\n${bullet}\n`, r1);
    expect(once.content).not.toContain(OLD);
    expect(once.content.split(NEW)).toHaveLength(3);
    expect(once.content).toContain(other);
    expect(r1.upgraded).toContain('CLAUDE.md: team settings lookup now reads GET /team/people');
    const r2 = result();
    const twice = m.patchClaudeMdContent(once.content, r2);
    expect(twice.content).toBe(once.content);
    expect(r2.upgraded).not.toContain('CLAUDE.md: team settings lookup now reads GET /team/people');
  });

  it('a new install and a fresh migration both name the token-readable route', () => {
    const fresh = migrator().patchClaudeMdContent('# x\n', result()).content;
    expect(fresh).toContain(NEW);
    expect(fresh).not.toContain(OLD);
    const generated = generateClaudeMd('test', 'Echo', 4040, false);
    expect(generated).toContain(NEW);
    expect(generated).not.toContain(OLD);
  });
});
