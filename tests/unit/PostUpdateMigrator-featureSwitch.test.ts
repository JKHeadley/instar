// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/**
 * Feature switches apply their setting — Agent Awareness + Migration Parity
 * (spec feature-transition-applies-action §7).
 *  - generateClaudeMd carries the section (new agents learn `apply` + `effective`).
 *  - migrateClaudeMd appends the SAME text to an existing CLAUDE.md, idempotently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PostUpdateMigrator, FEATURE_SWITCH_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const HEADING = '### Feature switches apply their setting';
const UPGRADE_LINE = 'CLAUDE.md: added Feature switches apply their setting section';

function runMigrateClaudeMd(m: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('FEATURE_SWITCH_CLAUDEMD_SECTION', () => {
  it('names apply, effective, the six statuses, the operator proof header and the port (never hardcoded)', () => {
    const text = FEATURE_SWITCH_CLAUDEMD_SECTION(4321);
    expect(text).toContain(HEADING);
    expect(text).toContain('`apply`');
    expect(text).toContain('`effective`');
    for (const s of ['on-after-restart', 'off-after-restart', 'recorded-only', 'not-recorded']) expect(text).toContain(s);
    expect(text).toContain('X-Instar-Operator-Session');
    expect(text).toContain('http://localhost:4321/features/X');
    expect(text).not.toContain('4042');
    expect(text).toContain('never say "running"');
  });

  it('generateClaudeMd carries the section verbatim (Agent Awareness)', () => {
    const md = generateClaudeMd('fixture', 'Fixture', 4042, true);
    expect(md).toContain(FEATURE_SWITCH_CLAUDEMD_SECTION(4042).trim());
  });
});

describe('migrateClaudeMd — Feature switches section', () => {
  let projectDir: string;
  let claudeMd: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-feature-switch-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
    fs.writeFileSync(claudeMd, '# CLAUDE.md — existing agent\n\nSome prior content.\n');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-featureSwitch.test.ts' });
  });

  it('appends the section to an existing CLAUDE.md with the agent port, and is idempotent', () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: true, projectName: 'test-agent' });
    const first = runMigrateClaudeMd(m);
    expect(first.upgraded).toContain(UPGRADE_LINE);
    const after1 = fs.readFileSync(claudeMd, 'utf-8');
    expect(after1).toContain(FEATURE_SWITCH_CLAUDEMD_SECTION(4042).trim());

    const second = runMigrateClaudeMd(m);
    expect(second.upgraded).not.toContain(UPGRADE_LINE);
    const after2 = fs.readFileSync(claudeMd, 'utf-8');
    expect(after2.split(HEADING).length - 1).toBe(1);
  });
});
