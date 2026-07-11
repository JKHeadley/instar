/**
 * PostUpdateMigrator — Judgment Within Floors migrations
 * (ownership-gated-spawn-and-judgment-within-floors spec §3.5 + §3.6):
 *
 *  - migrateJudgmentProvenanceGitignore: existing agent homes gain the
 *    `state/judgment-provenance/` gitignore entry (machine-local decision rows
 *    must never be committed cross-machine). Idempotent; no-op without a
 *    .gitignore (not a git-managed home).
 *  - migrateJudgmentWithinFloorsReviewQuestions: installed spec-converge SKILL
 *    + instar-dev side-effects template gain the standard's review questions —
 *    marker-sniffed, fingerprint-guarded (customized files untouched),
 *    idempotent. The bundled path resolves __dirname-relative, so this runs
 *    against the REAL repo skills/ files.
 *
 * Mirrors tests/unit/PostUpdateMigrator-threeStandardsReviewChecks.test.ts +
 * PostUpdateMigrator-gitignore.test.ts conventions.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..');

const SKILL_REL = ['skills', 'spec-converge', 'SKILL.md'];
const TEMPLATE_REL = ['skills', 'instar-dev', 'templates', 'side-effects-artifact.md'];
const SKILL_MARKER = 'Decision-point classification (Judgment Within Floors';
const TEMPLATE_MARKER = '## 4b. Judgment-point check';
const GITIGNORE_ENTRY = 'state/judgment-provenance/';

interface MigrationResult { upgraded: string[]; skipped: string[]; errors: string[] }

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'judgment-floors-mig-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-judgment-floors.test.ts' }));
  return dir;
}

function makeMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runGitignoreMigration(projectDir: string): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  const m = makeMigrator(projectDir);
  (m as unknown as { migrateJudgmentProvenanceGitignore: (r: MigrationResult) => void })
    .migrateJudgmentProvenanceGitignore(result);
  return result;
}

function runReviewQuestionsMigration(projectDir: string): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  const m = makeMigrator(projectDir);
  (m as unknown as { migrateJudgmentWithinFloorsReviewQuestions: (r: MigrationResult) => void })
    .migrateJudgmentWithinFloorsReviewQuestions(result);
  return result;
}

describe('migrateJudgmentProvenanceGitignore', () => {
  it('no .gitignore → no-op, no error, no file created (not a git-managed home)', () => {
    const projectDir = tmpProject();
    const r = runGitignoreMigration(projectDir);
    expect(r.errors).toEqual([]);
    expect(r.upgraded).toEqual([]);
    expect(fs.existsSync(path.join(projectDir, '.gitignore'))).toBe(false);
  });

  it('.gitignore without the entry → entry appended once (with the comment block)', () => {
    const projectDir = tmpProject();
    const gi = path.join(projectDir, '.gitignore');
    fs.writeFileSync(gi, 'node_modules\ndist/\n');
    const r = runGitignoreMigration(projectDir);
    expect(r.errors).toEqual([]);
    expect(r.upgraded.join()).toContain(GITIGNORE_ENTRY);
    const content = fs.readFileSync(gi, 'utf-8');
    expect(content).toContain('node_modules'); // existing content preserved
    expect(content).toContain(GITIGNORE_ENTRY);
    expect((content.match(/state\/judgment-provenance\//g) ?? []).length).toBe(1);
  });

  it('run twice → appended ONCE (idempotent)', () => {
    const projectDir = tmpProject();
    const gi = path.join(projectDir, '.gitignore');
    fs.writeFileSync(gi, 'node_modules\n');
    runGitignoreMigration(projectDir);
    const afterFirst = fs.readFileSync(gi, 'utf-8');
    const r2 = runGitignoreMigration(projectDir);
    expect(r2.upgraded).toEqual([]);
    expect(fs.readFileSync(gi, 'utf-8')).toBe(afterFirst);
    expect((afterFirst.match(/state\/judgment-provenance\//g) ?? []).length).toBe(1);
  });

  it('.gitignore already carrying the entry → untouched byte-for-byte', () => {
    const projectDir = tmpProject();
    const gi = path.join(projectDir, '.gitignore');
    const original = 'node_modules\nstate/judgment-provenance/\ndist/\n';
    fs.writeFileSync(gi, original);
    const r = runGitignoreMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(fs.readFileSync(gi, 'utf-8')).toBe(original);
  });

  it('recognizes the entry without the trailing slash too (regex allows both)', () => {
    const projectDir = tmpProject();
    const gi = path.join(projectDir, '.gitignore');
    const original = 'state/judgment-provenance\n';
    fs.writeFileSync(gi, original);
    const r = runGitignoreMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(fs.readFileSync(gi, 'utf-8')).toBe(original);
  });

  it('handles a missing trailing newline (entry lands on its own line)', () => {
    const projectDir = tmpProject();
    const gi = path.join(projectDir, '.gitignore');
    fs.writeFileSync(gi, 'node_modules'); // no trailing newline
    runGitignoreMigration(projectDir);
    const content = fs.readFileSync(gi, 'utf-8');
    expect(/^state\/judgment-provenance\/$/m.test(content)).toBe(true);
    expect(content).not.toContain('node_modulesstate');
  });
});

describe('migrateJudgmentWithinFloorsReviewQuestions', () => {
  it('the bundled repo files actually carry the markers (the migration has something real to ship)', () => {
    const skill = fs.readFileSync(path.join(repoRoot, ...SKILL_REL), 'utf-8');
    expect(skill).toContain(SKILL_MARKER);
    expect(skill).toContain('# /spec-converge'); // the fingerprint survives in the bundled copy
    const tpl = fs.readFileSync(path.join(repoRoot, ...TEMPLATE_REL), 'utf-8');
    expect(tpl).toContain(TEMPLATE_MARKER);
    expect(tpl).toContain('## 5. Interactions'); // the template fingerprint
  });

  it('upgrades stock installed copies lacking the marker (and is idempotent)', () => {
    const projectDir = tmpProject();
    const skillPath = path.join(projectDir, '.claude', ...SKILL_REL);
    const tplPath = path.join(projectDir, '.claude', ...TEMPLATE_REL);
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.mkdirSync(path.dirname(tplPath), { recursive: true });
    fs.writeFileSync(skillPath, '# /spec-converge\n\nold stock skill without the classification question\n');
    fs.writeFileSync(tplPath, '## 5. Interactions\n\nold stock template without the judgment-point check\n');

    const r1 = runReviewQuestionsMigration(projectDir);
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded.length).toBe(2);
    expect(fs.readFileSync(skillPath, 'utf-8')).toContain(SKILL_MARKER);
    expect(fs.readFileSync(tplPath, 'utf-8')).toContain(TEMPLATE_MARKER);

    const r2 = runReviewQuestionsMigration(projectDir);
    expect(r2.upgraded).toEqual([]); // marker present → idempotent no-op
    expect(r2.errors).toEqual([]);
  });

  it('an installed file WITH the marker is untouched (even if otherwise divergent)', () => {
    const projectDir = tmpProject();
    const skillPath = path.join(projectDir, '.claude', ...SKILL_REL);
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    const custom = `# /spec-converge\n\nlocally adjusted copy\n${SKILL_MARKER} — structurally-checked question)\n`;
    fs.writeFileSync(skillPath, custom);
    const r = runReviewQuestionsMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(fs.readFileSync(skillPath, 'utf-8')).toBe(custom);
  });

  it('an installed file WITHOUT the fingerprint is skipped as customized', () => {
    const projectDir = tmpProject();
    const skillPath = path.join(projectDir, '.claude', ...SKILL_REL);
    fs.mkdirSync(path.dirname(skillPath), { recursive: true });
    fs.writeFileSync(skillPath, 'totally custom operator-authored skill\n'); // lacks '# /spec-converge'
    const r = runReviewQuestionsMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(r.skipped.join()).toContain('customized — left untouched');
    expect(fs.readFileSync(skillPath, 'utf-8')).toContain('totally custom');
  });

  it('missing installed files are skipped silently (fresh installs get bundled copies elsewhere)', () => {
    const projectDir = tmpProject();
    const r = runReviewQuestionsMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});
