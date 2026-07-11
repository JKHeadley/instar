/**
 * Single-source parity for the iterative-converging-audit skill
 * (audit-convergence-enforcement §4 / Integration-R2 M3 + lessons-aware M1).
 *
 * The skill content previously lived in THREE places (repo SKILL.md, an init.ts
 * inline copy, and a would-be migration payload) that silently drifted. This test
 * fails if they drift again: init.ts and the PostUpdateMigrator migration must
 * BOTH consume the one shared constant, and the constant + repo SKILL.md must both
 * carry the canonical-report/validator behavior.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT } from '../../src/data/builtinSkillContent.js';

const ROOT = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const CANONICAL_MARKER = 'docs/audits/<slug>.md';
const VALIDATOR_MARKER = 'write-audit-convergence.mjs';

describe('iterative-converging-audit skill single-source', () => {
  it('the shared constant carries the canonical-report + validator behavior', () => {
    expect(ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT).toContain(CANONICAL_MARKER);
    expect(ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT).toContain(VALIDATOR_MARKER);
  });

  it('the repo SKILL.md carries the same behavior (both delivered together)', () => {
    const skill = read('skills/iterative-converging-audit/SKILL.md');
    expect(skill).toContain(CANONICAL_MARKER);
    expect(skill).toContain(VALIDATOR_MARKER);
  });

  it('init.ts consumes the shared constant — no divergent inline copy', () => {
    const initTs = read('src/commands/init.ts');
    expect(initTs).toContain('content: ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT');
    // guard: the old inline "# /iterative-converging-audit" body must not co-exist
    // as a second literal source (it now lives ONLY in the constant module).
    const inlineBodies = initTs.split('# /iterative-converging-audit').length - 1;
    expect(inlineBodies).toBe(0);
  });

  it('the PostUpdateMigrator migration consumes the shared constant and is wired', () => {
    const mig = read('src/core/PostUpdateMigrator.ts');
    expect(mig).toContain("import { ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT }");
    expect(mig).toContain('migrateIterativeConvergingAuditSkill(result)'); // called in migrate()
    expect(mig).toContain('fs.writeFileSync(skillFile, ITERATIVE_CONVERGING_AUDIT_SKILL_CONTENT)');
  });
});
