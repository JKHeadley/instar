/**
 * Unit tests for the verify-claim skill registration (GSD cherry-pick).
 *
 * Asserts the skill is installed by `installBuiltinSkills`, has valid
 * frontmatter, is user-invocable, documents the 4-tier protocol, and that
 * re-running installBuiltinSkills is idempotent (does not overwrite a
 * user-customized copy).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { installBuiltinSkills } from '../../src/commands/init.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let skillsDir: string;

beforeEach(() => {
  skillsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-verify-claim-skill-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(skillsDir, { recursive: true, force: true, operation: 'tests/unit/init-verifyClaimSkill.test.ts' });
});

describe('installBuiltinSkills — verify-claim', () => {
  it('installs verify-claim/SKILL.md on fresh setup', () => {
    installBuiltinSkills(skillsDir, 4042);
    expect(fs.existsSync(path.join(skillsDir, 'verify-claim', 'SKILL.md'))).toBe(true);
  });

  it('SKILL.md carries valid frontmatter with name + description', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(path.join(skillsDir, 'verify-claim', 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/^---\n/);
    expect(content).toContain('name: verify-claim');
    expect(content).toContain('description:');
  });

  it('is marked user-invocable', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(path.join(skillsDir, 'verify-claim', 'SKILL.md'), 'utf-8');
    expect(content).toMatch(/user_invocable:\s*"true"/);
  });

  it('documents all four verification levels', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(path.join(skillsDir, 'verify-claim', 'SKILL.md'), 'utf-8');
    expect(content).toContain('EXISTENCE');
    expect(content).toContain('SUBSTANTIVE');
    expect(content).toContain('WIRED');
    expect(content).toContain('DATA-FLOW');
  });

  it('documents the status taxonomy', () => {
    installBuiltinSkills(skillsDir, 4042);
    const content = fs.readFileSync(path.join(skillsDir, 'verify-claim', 'SKILL.md'), 'utf-8');
    for (const status of ['VERIFIED', 'HOLLOW', 'ORPHANED', 'STUB', 'MISSING']) {
      expect(content).toContain(status);
    }
  });

  it('is idempotent — does not overwrite a customized copy', () => {
    installBuiltinSkills(skillsDir, 4042);
    const skillFile = path.join(skillsDir, 'verify-claim', 'SKILL.md');
    fs.writeFileSync(skillFile, 'CUSTOMIZED BY USER');
    installBuiltinSkills(skillsDir, 4042);
    expect(fs.readFileSync(skillFile, 'utf-8')).toBe('CUSTOMIZED BY USER');
  });
});
