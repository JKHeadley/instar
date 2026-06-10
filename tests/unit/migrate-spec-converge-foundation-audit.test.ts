/**
 * Unit tests for migrateSpecConvergeFoundationAudit - updates the deployed
 * spec-converge SKILL.md so existing agents get the Lessons-aware reviewer's
 * clause (d) FOUNDATION/SUBSYSTEM AUDIT (the review must reach one layer below
 * the spec boundary and weigh the subsystem the spec tests/extends/builds-on
 * against known standards). Structural fix for the 2026-06-09 gap where a
 * test-harness spec converged cleanly while the permission gate it proved still
 * held brittle blocking authority in violation of Signal-vs-Authority.
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
  const dir = path.join(projectDir, '.claude', 'skills', 'spec-converge');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, content);
  return file;
}

const run = (result: ReturnType<typeof emptyResult>) =>
  (makeMigrator() as unknown as { migrateSpecConvergeFoundationAudit: (r: typeof result) => void })
    .migrateSpecConvergeFoundationAudit(result);

// Stock fingerprint: has `# /spec-converge` + the internal-reviewers heading,
// but the OLD (a)(b)(c)-only Lessons-aware bullet (no clause-(d) marker).
const STOCK_BEFORE = `---
name: spec-converge
---

# /spec-converge

**Internal reviewers (Claude subagents):**

- **Lessons-aware.** ...then checks the spec for (a) direct contradictions of documented principles/lessons, (b) applicable lessons the spec fails to engage with, and (c) behavioral lessons violated by agent-facing surfaces the spec proposes.
`;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spec-converge-foundation-audit-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/migrate-spec-converge-foundation-audit.test.ts',
  });
});

describe('migrateSpecConvergeFoundationAudit', () => {
  it('updates a stock spec-converge skill that lacks the clause-(d) marker', () => {
    const file = writeSkill(STOCK_BEFORE);
    const result = emptyResult();
    run(result);
    const updated = fs.readFileSync(file, 'utf8');
    expect(updated).toContain('FOUNDATION/SUBSYSTEM AUDIT');
    expect(updated).toContain('one layer below the spec boundary');
    expect(updated).toContain('foundation-not-audited gap');
    expect(result.upgraded.some((u) => u.includes('skills/spec-converge/SKILL.md'))).toBe(true);
  });

  it('is idempotent when the clause-(d) marker is already present', () => {
    const already = `${STOCK_BEFORE}\nFOUNDATION/SUBSYSTEM AUDIT placeholder\n`;
    const file = writeSkill(already);
    const before = fs.readFileSync(file, 'utf8');
    const result = emptyResult();
    run(result);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(result.upgraded.length).toBe(0);
  });

  it('leaves a customized skill untouched when the stock fingerprint is missing', () => {
    const customized = `---\nname: spec-converge\n---\n# My custom convergence workflow\n`;
    const file = writeSkill(customized);
    const result = emptyResult();
    run(result);
    expect(fs.readFileSync(file, 'utf8')).toBe(customized);
    expect(result.skipped.some((s) => s.includes('customized'))).toBe(true);
  });

  it('no-ops when the skill is not installed', () => {
    const result = emptyResult();
    run(result);
    expect(result.upgraded.length).toBe(0);
    expect(result.errors.length).toBe(0);
  });

  it('the bundled source skill actually carries the clause-(d) marker (wiring integrity)', () => {
    // The migration re-copies the bundled SKILL.md; that source must contain the
    // marker or the migration would silently no-op for every existing agent.
    const bundled = path.join(__dirname, '..', '..', 'skills', 'spec-converge', 'SKILL.md');
    expect(fs.existsSync(bundled)).toBe(true);
    const text = fs.readFileSync(bundled, 'utf8');
    expect(text).toContain('FOUNDATION/SUBSYSTEM AUDIT');
    expect(text).toContain('one layer below the spec boundary');
  });
});
