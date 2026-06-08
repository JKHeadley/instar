/**
 * Unit tests for the iterative-converging-audit skill registration.
 *
 * Asserts the skill is installed by `installBuiltinSkills`, has valid
 * frontmatter, is user-invocable, documents the audit→fix→re-audit loop and
 * the convergence criterion, and that re-running installBuiltinSkills is
 * idempotent (does not overwrite a user-customized copy).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinSkills } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let skillsDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-iterative-audit-skill-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(skillsDir, { recursive: true, force: true, operation: 'tests/unit/init-iterativeConvergingAuditSkill.test.ts' });
});

const skillPath = () => path.join(skillsDir, 'iterative-converging-audit', 'SKILL.md');

describe('installBuiltinSkills — iterative-converging-audit', () => {
  it('installs iterative-converging-audit/SKILL.md on fresh setup', () => {
    installBuiltinSkills(skillsDir, 4042);
    expect(fs.existsSync(skillPath())).toBe(true);
  });

  it('SKILL.md carries valid frontmatter and is user-invocable', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(skillPath(), 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: iterative-converging-audit');
    expect(content).toContain('description:');
    expect(content).toContain('user_invocable: "true"');
  });

  it('documents the convergence loop + the honest-incompleteness rule', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(skillPath(), 'utf-8');
    expect(content).toContain('RE-AUDIT');
    expect(content).toContain('zero new discoveries');
    expect(content).toMatch(/INCOMPLETE/);
    expect(content).toContain('STANDARDS-REGISTRY.md'); // ties to the constitution standard
  });

  it('re-running installBuiltinSkills does NOT overwrite a customized copy (idempotent)', () => {
    installBuiltinSkills(skillsDir, 4042);
    const custom = '---\nname: iterative-converging-audit\n---\n\n# customized by user\n';
    fs.writeFileSync(skillPath(), custom);
    installBuiltinSkills(skillsDir, 4042);
    expect(fs.readFileSync(skillPath(), 'utf-8')).toBe(custom);
  });
});
