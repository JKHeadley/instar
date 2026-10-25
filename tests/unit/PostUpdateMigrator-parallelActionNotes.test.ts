// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Migration Parity for CMT-810:
 *  1. migrateConfig adds `parallelWork.actionNotes: { enabled: true, windowHours: 24 }`
 *     when absent, keeps siblings, and never overwrites an operator value;
 *  2. migrateClaudeMd appends the action-derived awareness bullet to an existing
 *     Parallel-Work Awareness section (idempotent on the `lastAction` sniff), and a
 *     CLAUDE.md with no section gets the section AND the bullet in one pass;
 *  3. the init template carries the same bullet (new agents + existing agents agree).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/unit/PostUpdateMigrator-parallelActionNotes.test.ts';
type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function run(m: PostUpdateMigrator, method: string): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as Record<string, (r: MigrationResult) => void>)[method](result);
  return result;
}

let projectDir: string;
beforeEach(() => { projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cmt810-mig-')); fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true }); });
afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: OP }));

describe('CMT-810 — migrateConfig: parallelWork.actionNotes default', () => {
  const cfgPath = () => path.join(projectDir, '.instar', 'config.json');
  const read = () => JSON.parse(fs.readFileSync(cfgPath(), 'utf8'));

  it('adds the block when absent (even with no parallelWork block at all)', () => {
    fs.writeFileSync(cfgPath(), JSON.stringify({ authToken: 'x' }));
    const r = run(newMigrator(projectDir), 'migrateConfig');
    expect(read().parallelWork.actionNotes).toEqual({ enabled: true, windowHours: 24 });
    expect(r.upgraded).toContain('config.json: added parallelWork.actionNotes default (enabled: true, windowHours: 24)');
  });

  it('is idempotent and never overwrites an operator value', () => {
    fs.writeFileSync(cfgPath(), JSON.stringify({ authToken: 'x', parallelWork: { actionNotes: { enabled: false, windowHours: 2 } } }));
    const r1 = run(newMigrator(projectDir), 'migrateConfig');
    expect(read().parallelWork.actionNotes).toEqual({ enabled: false, windowHours: 2 });
    expect(r1.upgraded.some((u) => u.includes('parallelWork.actionNotes'))).toBe(false);
    const r2 = run(newMigrator(projectDir), 'migrateConfig');
    expect(r2.upgraded.some((u) => u.includes('parallelWork.actionNotes'))).toBe(false);
  });
});

describe('CMT-810 — migrateClaudeMd: action-derived awareness bullet', () => {
  const mdPath = () => path.join(projectDir, 'CLAUDE.md');
  const SNIFF = 'lastAction';

  it('appends the bullet into an existing Parallel-Work Awareness section, right after its spec line', () => {
    fs.writeFileSync(mdPath(), [
      '# CLAUDE.md', '',
      '## Parallel-Work Awareness', '',
      'See what ALL your hands are doing.',
      '- Check: `GET /parallel-work/activities`.',
      '- Proactive: glance here first. Spec: `docs/specs/parallel-activity-coherence.md`.',
      '', '## Something After', 'unchanged',
    ].join('\n'));
    const r = run(newMigrator(projectDir), 'migrateClaudeMd');
    const md = fs.readFileSync(mdPath(), 'utf8');
    expect(r.upgraded).toContain('CLAUDE.md: added Parallel-Work Awareness action-derived notes (CMT-810)');
    expect(md).toContain(SNIFF);
    expect(md).toContain('GET /parallel-work/sentinel');
    expect(md).toContain('parallelWork.actionNotes.enabled: false');
    // placed inside the section, before the next heading
    expect(md.indexOf(SNIFF)).toBeLessThan(md.indexOf('## Something After'));
    expect(md).toContain('## Something After\nunchanged');
  });

  it('is idempotent (second run adds nothing)', () => {
    fs.writeFileSync(mdPath(), '# CLAUDE.md\n\n## Parallel-Work Awareness\n\nx. Spec: `docs/specs/parallel-activity-coherence.md`.\n');
    run(newMigrator(projectDir), 'migrateClaudeMd');
    const once = fs.readFileSync(mdPath(), 'utf8');
    const r2 = run(newMigrator(projectDir), 'migrateClaudeMd');
    expect(r2.upgraded.some((u) => u.includes('CMT-810'))).toBe(false);
    expect(fs.readFileSync(mdPath(), 'utf8')).toBe(once);
  });

  it('a CLAUDE.md with NO Parallel-Work section gets the section AND the bullet in one pass', () => {
    fs.writeFileSync(mdPath(), '# CLAUDE.md\n\nnothing here yet\n');
    const r = run(newMigrator(projectDir), 'migrateClaudeMd');
    const md = fs.readFileSync(mdPath(), 'utf8');
    expect(r.upgraded).toContain('CLAUDE.md: added Parallel-Work Awareness');
    expect(r.upgraded).toContain('CLAUDE.md: added Parallel-Work Awareness action-derived notes (CMT-810)');
    expect(md).toContain('## Parallel-Work Awareness');
    expect(md).toContain(SNIFF);
  });
});

describe('CMT-810 — init template parity', () => {
  it('generateClaudeMd carries the same awareness bullet new agents need', () => {
    const md = generateClaudeMd('p', 'A', 4042, true);
    expect(md).toContain('Action-derived awareness (CMT-810)');
    expect(md).toContain('lastAction');
    expect(md).toContain('/parallel-work/sentinel');
    expect(md).toContain('parallelWork.actionNotes.enabled: false');
  });
});
