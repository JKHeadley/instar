/**
 * Unit tests for migrateInstarDevInternalOnlyReleaseNoteLane - updates the
 * deployed instar-dev SKILL.md so existing agents know the internal-only
 * release-note lane added to the assembler and pre-push gate.
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
  const dir = path.join(projectDir, '.claude', 'skills', 'instar-dev');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'SKILL.md');
  fs.writeFileSync(file, content);
  return file;
}

const run = (result: ReturnType<typeof emptyResult>) =>
  (makeMigrator() as unknown as { migrateInstarDevInternalOnlyReleaseNoteLane: (r: typeof result) => void })
    .migrateInstarDevInternalOnlyReleaseNoteLane(result);

const STOCK_BEFORE = `---
name: instar-dev
---

# /instar-dev

### Phase 2 — Planning

The agent uses the standard planning patterns from /build.
`;

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-dev-skill-internal-only-lane-'));
});

afterEach(() => {
  SafeFsExecutor.safeRmSync(projectDir, {
    recursive: true,
    force: true,
    operation: 'tests/unit/migrate-instar-dev-internal-only-lane.test.ts',
  });
});

describe('migrateInstarDevInternalOnlyReleaseNoteLane', () => {
  it('updates a stock instar-dev skill that lacks the internal-only lane marker', () => {
    const file = writeSkill(STOCK_BEFORE);
    const result = emptyResult();
    run(result);
    const updated = fs.readFileSync(file, 'utf8');
    expect(updated).toContain('The internal-only release-note lane');
    expect(updated).toContain('<!-- internal-only -->');
    expect(updated).toContain('omit the two user-facing sections');
    expect(updated).toContain('only when every contributing fragment in the release is marked internal-only');
    expect(updated).toContain('rejects an internal-only fragment when the diff includes runtime `src/*.ts` changes');
    expect(result.upgraded.some((u) => u.includes('skills/instar-dev/SKILL.md'))).toBe(true);
  });

  it('is idempotent when the marker is already present', () => {
    const already = `${STOCK_BEFORE}\n## The internal-only release-note lane\n`;
    const file = writeSkill(already);
    const before = fs.readFileSync(file, 'utf8');
    const result = emptyResult();
    run(result);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    expect(result.upgraded.length).toBe(0);
  });

  it('leaves a customized skill untouched when the stock fingerprint is missing', () => {
    const customized = `---\nname: instar-dev\n---\n# My custom dev workflow\n`;
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
});
