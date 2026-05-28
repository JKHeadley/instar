/**
 * Unit tests for migrateTestAsSelfSkill — updates the deployed test-as-self
 * SKILL.md to the Part 2.1 version (one-button command leads; manual recipe
 * demoted). Covers update, idempotency, and customized-skill-left-untouched.
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

function writeSkill(content: string): string {
  const dir = path.join(projectDir, '.claude', 'skills', 'test-as-self');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, content);
  return file;
}

const run = (result: ReturnType<typeof emptyResult>) =>
  (makeMigrator() as unknown as { migrateTestAsSelfSkill: (r: typeof result) => void })
    .migrateTestAsSelfSkill(result);

// A stock v1 test-as-self skill: has the fingerprint, lacks the Part 2.1 marker.
const STOCK_V1 = `---
name: test-as-self
---

# /test-as-self — Throwaway-Deploy Harness (Task 4 / Part 2 v1)

## Recipe — deploy + verify
Run verify.mjs against the throwaway home.
`;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tas-skill-migration-'));
});
afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/migrate-test-as-self-skill.test.ts' });
});

describe('migrateTestAsSelfSkill', () => {
  it('updates a stock v1 skill (has fingerprint, lacks Part 2.1 marker)', () => {
    const file = writeSkill(STOCK_V1);
    const result = emptyResult();
    run(result);
    const updated = fs.readFileSync(file, 'utf8');
    expect(updated).toContain('The one-button path (Part 2.1');
    expect(result.upgraded.some((u) => u.includes('skills/test-as-self/SKILL.md'))).toBe(true);
  });

  it('is idempotent — a skill that already has the Part 2.1 marker is unchanged', () => {
    const already = STOCK_V1 + '\n## The one-button path (Part 2.1 — use this first)\n';
    const file = writeSkill(already);
    const before = fs.readFileSync(file, 'utf8');
    const result = emptyResult();
    run(result);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(result.upgraded.length).toBe(0);
  });

  it('leaves a customized skill untouched (missing the stock fingerprint)', () => {
    const customized = `---\nname: test-as-self\n---\n# My custom harness\nnothing standard here\n`;
    const file = writeSkill(customized);
    const result = emptyResult();
    run(result);
    expect(fs.readFileSync(file, 'utf8')).toBe(customized);
    expect(result.skipped.some((s) => s.includes('customized'))).toBe(true);
  });

  it('no-ops when the skill is not installed (fresh install path)', () => {
    const result = emptyResult();
    run(result);
    expect(result.upgraded.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });
});
