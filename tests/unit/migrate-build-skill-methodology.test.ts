/**
 * Unit tests for migrateBuildSkillMethodology — updates the /build skill
 * with the GSD cherry-pick methodology sections for existing agents.
 *
 * installBuildSkill is install-if-missing, so existing agents need this
 * content-update migration. Tests cover: stock skill gets updated,
 * idempotency, and customized skills left untouched.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

let projectDir: string;

function makeMigrator(): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function emptyResult() {
  return { upgraded: [] as string[], skipped: [] as string[], errors: [] as string[] };
}

function writeBuildSkill(content: string): string {
  const dir = path.join(projectDir, '.claude', 'skills', 'build');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, content);
  return file;
}

// A stock /build skill missing the new methodology sections.
const STOCK_OLD = `---
name: build
---

# /build — Rigorous Build Skill

## Phase 2: EXECUTE
do work

## Phase 5: COMPLETE
merge
`;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-skill-migration-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/migrate-build-skill-methodology.test.ts' });
});

describe('migrateBuildSkillMethodology', () => {
  it('updates a stock /build skill missing the Phase 0.5 marker', () => {
    const file = writeBuildSkill(STOCK_OLD);
    const result = emptyResult();
    (makeMigrator() as unknown as { migrateBuildSkillMethodology: (r: typeof result) => void })
      .migrateBuildSkillMethodology(result);
    const updated = fs.readFileSync(file, 'utf8');
    // The bundled source has the new sections — after migration the marker is present.
    expect(updated).toContain('Phase 0.5: MUST-HAVES');
    expect(result.upgraded.some(u => u.includes('skills/build/SKILL.md'))).toBe(true);
  });

  it('is idempotent — a skill that already has the marker is left unchanged', () => {
    const alreadyUpdated = STOCK_OLD.replace('## Phase 2: EXECUTE', '## Phase 0.5: MUST-HAVES\nstuff\n\n## Phase 2: EXECUTE');
    const file = writeBuildSkill(alreadyUpdated);
    const before = fs.readFileSync(file, 'utf8');
    const result = emptyResult();
    (makeMigrator() as unknown as { migrateBuildSkillMethodology: (r: typeof result) => void })
      .migrateBuildSkillMethodology(result);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(result.upgraded).toEqual([]);
  });

  it('leaves a heavily-customized /build skill untouched (no stock fingerprint)', () => {
    const customized = `---\nname: build\n---\n\n# My Totally Custom Build Flow\n\nnothing stock here\n`;
    const file = writeBuildSkill(customized);
    const result = emptyResult();
    (makeMigrator() as unknown as { migrateBuildSkillMethodology: (r: typeof result) => void })
      .migrateBuildSkillMethodology(result);
    expect(fs.readFileSync(file, 'utf8')).toBe(customized);
    expect(result.skipped.some(s => s.includes('customized'))).toBe(true);
  });

  it('does nothing when no /build skill is installed (fresh-install path handles it)', () => {
    const result = emptyResult();
    expect(() =>
      (makeMigrator() as unknown as { migrateBuildSkillMethodology: (r: typeof result) => void })
        .migrateBuildSkillMethodology(result)
    ).not.toThrow();
    expect(result.upgraded).toEqual([]);
  });
});
