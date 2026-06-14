/**
 * Verifies PostUpdateMigrator adds the Guard Posture (`GET /guards`) capability
 * section to existing agents' CLAUDE.md on update (Migration Parity Standard +
 * GUARD-POSTURE-ENDPOINT-SPEC §4 Agent Awareness / §2.5 hazard containment).
 *
 * The tripwire section only covers boot-time TRANSITIONS; without this section
 * an agent asked "are my guards on?" (or worse — one about to re-enable a guard
 * via PATCH /config) never learns the steady-state read surface exists, nor
 * that a partial config block ERASES sibling tuning (lived 2026-06-11: the
 * Mini's reaper remediation had to hand-reconstruct the full block).
 *
 * Also pins byte-parity: generateClaudeMd (new agents) and migrateClaudeMd
 * (existing agents) must produce the identical section.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const PORT = 4042;

const MARKER = 'Guard Posture — which safety systems are genuinely on';
const SECTION_END = 'persists across consecutive probes.';

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: PORT,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

function sliceSection(doc: string): string {
  const start = doc.indexOf(MARKER);
  expect(start, 'section marker must be present').toBeGreaterThanOrEqual(0);
  const end = doc.indexOf(SECTION_END, start);
  expect(end, 'section terminator must be present').toBeGreaterThan(start);
  return doc.slice(start, end + SECTION_END.length);
}

describe('PostUpdateMigrator — Guard Posture (/guards) CLAUDE.md capability section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-guardscap-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-guardsCapabilitySection.test.ts:cleanup',
    });
  });

  it('adds the section when CLAUDE.md does not contain it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('Guard Posture (/guards)'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    // The read surface, both scopes, port-templated.
    expect(after).toContain(`http://localhost:${PORT}/guards`);
    expect(after).toContain(`http://localhost:${PORT}/guards?scope=pool`);
    // The §2.5 PATCH /config one-level-deep-merge hazard.
    expect(after).toContain('PATCH /config');
    expect(after).toContain('a partial block erases sibling tuning');
    // Effective-state vocabulary (the honesty layer) is named.
    expect(after).toContain('off-runtime-divergent');
    expect(after).toContain('diverged-from-default');
    // Cross-reference: tripwire = boot transitions, probe = persisting anomalies.
    expect(after).toContain('Guard-Posture Tripwire');
    expect(after).toContain('GuardPostureProbe');
  });

  it('is idempotent — a second run skips, content unchanged, section appears once', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');

    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(afterSecond).toBe(afterFirst);
    expect(afterSecond.split(MARKER).length - 1).toBe(1);
    expect(second.upgraded.some(u => u.includes('Guard Posture (/guards)'))).toBe(false);
    expect(second.skipped.some(s => s.includes('Guard Posture (/guards)'))).toBe(true);
  });

  it('migrated section is byte-identical to the generateClaudeMd (fresh init) section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test\n');
    runClaudeMdMigration(newMigrator(projectDir));

    const migrated = sliceSection(fs.readFileSync(claudeMdPath, 'utf-8'));
    const fresh = sliceSection(generateClaudeMd('test', 'TestAgent', PORT, false));
    expect(migrated).toBe(fresh);
  });

  it('generateClaudeMd carries the section for new agents (Agent Awareness Standard)', () => {
    const fresh = generateClaudeMd('test', 'TestAgent', PORT, false);
    expect(fresh).toContain(MARKER);
    expect(fresh).toContain(`http://localhost:${PORT}/guards?scope=pool`);
    expect(fresh).toContain('a partial block erases sibling tuning');
  });
});
