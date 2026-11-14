import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, QUIET_JOB_CHOICE_SENTENCE, QUIET_NOTIFICATIONS_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-jobReportChoice.test.ts' }); });

function fixture(skill: string | null) {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-choice-')); dirs.push(projectDir);
  const stateDir = path.join(projectDir, '.instar'); fs.mkdirSync(stateDir, { recursive: true });
  const skillFile = path.join(projectDir, '.claude', 'skills', 'instar-scheduler', 'SKILL.md');
  if (skill !== null) { fs.mkdirSync(path.dirname(skillFile), { recursive: true }); fs.writeFileSync(skillFile, skill); }
  const migrator = new PostUpdateMigrator({ projectDir, stateDir, port: 4040, hasTelegram: false, projectName: 'test' } as never);
  return { migrator: migrator as unknown as { migrateSchedulerSkillReportChoice(r: object): void; patchClaudeMdContent(c: string, r: object): { content: string; patched: boolean } }, skillFile };
}
const result = () => ({ upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] });
const shipped = fs.readFileSync(path.join(process.cwd(), 'skills/instar-scheduler/SKILL.md'), 'utf8');

describe('per-job report choice migration', () => {
  it('adds the section to an installed skill once and keeps the agent\'s own lines', () => {
    const { migrator, skillFile } = fixture('# mine\n\nmy own note\n\n## Default Jobs (Ships with Instar)\nrest\n');
    const first = result(); migrator.migrateSchedulerSkillReportChoice(first);
    const once = fs.readFileSync(skillFile, 'utf8');
    expect(once).toContain("## Who sees this job's reports"); expect(once).toContain('my own note'); expect(first.upgraded).toHaveLength(1);
    expect(once.indexOf('Who sees')).toBeLessThan(once.indexOf('## Default Jobs'));
    const second = result(); migrator.migrateSchedulerSkillReportChoice(second);
    expect(fs.readFileSync(skillFile, 'utf8')).toBe(once); expect(second.upgraded).toHaveLength(0);
  });
  it('appends when the anchor is gone, and leaves an agent without the skill alone', () => {
    const custom = fixture('# rewritten skill\n');
    custom.migrator.migrateSchedulerSkillReportChoice(result());
    expect(fs.readFileSync(custom.skillFile, 'utf8')).toContain('Who sees');
    const none = fixture(null); const r = result();
    none.migrator.migrateSchedulerSkillReportChoice(r);
    expect(r.upgraded).toHaveLength(0); expect(fs.existsSync(none.skillFile)).toBe(false);
  });
  it('migrates exactly the text a new install ships', () => {
    const { migrator, skillFile } = fixture('# x\n\n## Default Jobs (Ships with Instar)\n');
    migrator.migrateSchedulerSkillReportChoice(result());
    const section = (text: string) => text.slice(text.indexOf('## Who sees'), text.indexOf('---\n\n## Default Jobs'));
    expect(section(fs.readFileSync(skillFile, 'utf8'))).toBe(section(shipped));
  });
  it('patches an older Quiet section and the new-job line, and is idempotent', () => {
    const { migrator } = fixture(null);
    const old = 'x\n2. **Need periodic checks?** Create a job in `.instar/jobs.json`.\n### Quiet by Default notifications\nCategory push: or the PIN-confirmed dashboard toggle. Never grant yourself push.\n';
    const once = migrator.patchClaudeMdContent(old, result());
    expect(once.patched).toBe(true);
    expect(once.content).toContain(QUIET_JOB_CHOICE_SENTENCE);
    expect(once.content).toContain('ask whether they want to see its reports');
    const twice = result(); const again = migrator.patchClaudeMdContent(once.content, twice);
    expect(again.content).toBe(once.content);
    expect(twice.upgraded.filter(line => /report choice/.test(line))).toHaveLength(0);
  });
  it('ships the awareness to new agents', () => {
    expect(QUIET_NOTIFICATIONS_CLAUDEMD_SECTION).toContain('/notifications/jobs/:slug/push');
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain('/notifications/jobs/SLUG/push');
    expect(md).toContain('ask whether they want to see its reports');
  });
});
