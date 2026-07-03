/**
 * Three-standards review-checks migration (three-standards-enforcement spec,
 * 2026-07-03): deployed agents' installed copies of the spec-converge SKILL and
 * the integration-reviewer template gain the Standard A (reject undefended
 * machine-local; default `unified`) + Standard B (self-heal-before-notify)
 * review-checks — marker-sniffed (`machine-local-justification`),
 * fingerprint-guarded (customized files untouched), idempotent.
 *
 * The A/B checks are /spec-converge reviewer PROMPTS (LLM authority), so the
 * deterministic assertion available to a unit test is that the shipped prompt
 * TEXT carries the review-check — i.e. the reviewer is now INSTRUCTED to flag an
 * undefended machine-local as a MATERIAL FINDING (and to contest a mislabeled
 * self-heal). That instruction presence is what makes the lens live on the next
 * review run.
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
const TEMPLATE_REL = ['skills', 'spec-converge', 'templates', 'reviewer-integration.md'];

const cleanups: Array<() => void> = [];
afterEach(() => { while (cleanups.length) cleanups.pop()!(); });

function tmpProject(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'three-standards-mig-'));
  cleanups.push(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-threeStandardsReviewChecks.test.ts' }));
  return dir;
}

function installStockWithoutMarker(projectDir: string, rel: string[], fingerprint: string) {
  const p = path.join(projectDir, '.claude', ...rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${fingerprint}\n\nold stock content without the review-check\n`);
  return p;
}

function runMigration(projectDir: string) {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar') } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
  const result = { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
  (m as unknown as { migrateThreeStandardsReviewChecks: (r: typeof result) => void }).migrateThreeStandardsReviewChecks(result);
  return result;
}

describe('Standard A/B review-check content (the bundled reviewer prompts carry the lens)', () => {
  it('the spec-converge SKILL instructs the integration reviewer on Standard A (undefended machine-local = MATERIAL FINDING)', () => {
    const skill = fs.readFileSync(path.join(repoRoot, ...SKILL_REL), 'utf8');
    expect(skill).toContain('machine-local-justification');
    // The upgrade: default is `unified`, an undefended machine-local is a finding.
    expect(skill).toContain('MATERIAL FINDING');
    // The closed taxonomy keys.
    expect(skill).toContain('physical-credential-locality');
    expect(skill).toContain('hardware-bound-resource');
    expect(skill).toContain('operator-ratified-exception');
    // Bidirectional: an infeasible `unified` is equally a finding.
    expect(skill).toContain('BIDIRECTIONAL');
  });

  it('the spec-converge SKILL instructs the reviewer on Standard B (self-heal before notify)', () => {
    const skill = fs.readFileSync(path.join(repoRoot, ...SKILL_REL), 'utf8');
    expect(skill).toContain('Self-Heal Before Notify');
    expect(skill).toContain('remediation-actions');
    expect(skill).toContain('max-notification-latency');
    expect(skill).toContain('selfHealAttempted');
    // First-detection escalation on a recoverable degradation is a finding.
    expect(skill.toLowerCase()).toContain('first detection');
  });

  it('the integration-reviewer TEMPLATE carries both review-checks (the prompt actually spawned)', () => {
    const tpl = fs.readFileSync(path.join(repoRoot, ...TEMPLATE_REL), 'utf8');
    expect(tpl).toContain('machine-local-justification');
    expect(tpl).toContain('MATERIAL FINDING');
    expect(tpl).toContain('Self-Heal Before Notify');
    expect(tpl).toContain('selfHealAttempted');
  });
});

describe('migrateThreeStandardsReviewChecks', () => {
  it('the bundled sources actually carry the marker (the migration has something real to ship)', () => {
    for (const rel of [SKILL_REL, TEMPLATE_REL]) {
      const bundled = fs.readFileSync(path.join(repoRoot, ...rel), 'utf8');
      expect(bundled, rel.join('/')).toContain('machine-local-justification');
    }
  });

  it('upgrades stock installed copies to the bundled versions (and is idempotent)', () => {
    const projectDir = tmpProject();
    const skill = installStockWithoutMarker(projectDir, SKILL_REL, '# /spec-converge');
    const tpl = installStockWithoutMarker(projectDir, TEMPLATE_REL, '# Reviewer Prompt — Integration');

    const r1 = runMigration(projectDir);
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded.length).toBe(2);
    expect(fs.readFileSync(skill, 'utf8')).toContain('machine-local-justification');
    expect(fs.readFileSync(tpl, 'utf8')).toContain('machine-local-justification');

    const r2 = runMigration(projectDir);
    expect(r2.upgraded).toEqual([]); // marker present → idempotent no-op
    expect(r2.errors).toEqual([]);
  });

  it('leaves a CUSTOMIZED installed copy untouched and reports it', () => {
    const projectDir = tmpProject();
    const p = path.join(projectDir, '.claude', ...SKILL_REL);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, 'totally custom operator-authored skill\n'); // lacks fingerprint
    const r = runMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(r.skipped.join()).toContain('customized — left untouched');
    expect(fs.readFileSync(p, 'utf8')).toContain('totally custom');
  });

  it('missing installed files are skipped silently (fresh installs get bundled copies elsewhere)', () => {
    const projectDir = tmpProject();
    const r = runMigration(projectDir);
    expect(r.upgraded).toEqual([]);
    expect(r.errors).toEqual([]);
  });
});
