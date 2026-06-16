/**
 * Tier-1 migration-parity tests for mergerunner-auto-arm-handoff (M1 + §k).
 * Migration Parity Standard: an EXISTING agent (one that already has the
 * Green-PR section) MUST receive the corrected disarm-reach + mergeStrategy
 * awareness on update — the OLD content-sniff only APPENDED when the route
 * string was absent, so the exact agent that most needs the new facts (Echo)
 * took the SKIP branch and never got them. This verifies the content-sniff
 * REPLACE and the config-defaults backfill.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateConfigGreenPrAutoArmDefaults, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function runClaudeMdMigration(projectDir: string): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

/** The OLD Green-PR section verbatim (route present, NO mergeStrategy marker). */
const OLD_SECTION = `
## Green-PR Auto-Merge (Phase 7 becomes machinery)

When one of my own PRs goes green, a background watcher merges it.

- Status: \`curl http://localhost:4042/green-pr-automerge\` — last tick, breaker, episodes.
- **Holds always win.** A \`[HOLD: …]\` title excludes a PR.
- **Kill switch:** \`POST /green-pr-automerge/rollback\`.
- Proactive: operator asks "why didn't my PR merge?" → GET /green-pr-automerge.
`;

describe('migrateConfigGreenPrAutoArmDefaults — config defaults (Migration Parity §k)', () => {
  it('NO-OP when monitoring.greenPrAutoMerge is absent (never force-creates the feature)', () => {
    const config: Record<string, unknown> = { authToken: 'x' };
    expect(migrateConfigGreenPrAutoArmDefaults(config)).toBe(false);
    expect(config).toEqual({ authToken: 'x' });
  });

  it('adds all FIVE defaults when the greenPrAutoMerge block exists without them', () => {
    const config: Record<string, unknown> = { monitoring: { greenPrAutoMerge: { enabled: true, expectedGhLogin: 'echo-bot' } } };
    expect(migrateConfigGreenPrAutoArmDefaults(config)).toBe(true);
    const block = (config.monitoring as Record<string, Record<string, unknown>>).greenPrAutoMerge;
    expect(block.mergeStrategy).toBe('auto');
    expect(block.armedConfirmCeilingMs).toBe(86_400_000);
    expect(block.armedOverdueReraiseMs).toBe(86_400_000);
    expect(block.armTimeoutMs).toBe(60_000);
    expect(block.unconfirmedArmCeiling).toBe(3);
    // Existing fields are preserved.
    expect(block.enabled).toBe(true);
    expect(block.expectedGhLogin).toBe('echo-bot');
  });

  it("NEVER clobbers an operator's explicit override", () => {
    const config: Record<string, unknown> = { monitoring: { greenPrAutoMerge: { enabled: true, mergeStrategy: 'admin', armTimeoutMs: 120_000 } } };
    expect(migrateConfigGreenPrAutoArmDefaults(config)).toBe(true); // still backfills the missing 3
    const block = (config.monitoring as Record<string, Record<string, unknown>>).greenPrAutoMerge;
    expect(block.mergeStrategy).toBe('admin');   // preserved
    expect(block.armTimeoutMs).toBe(120_000);    // preserved
    expect(block.unconfirmedArmCeiling).toBe(3); // backfilled
  });

  it('is IDEMPOTENT — a second run is a no-op', () => {
    const config: Record<string, unknown> = { monitoring: { greenPrAutoMerge: { enabled: true } } };
    expect(migrateConfigGreenPrAutoArmDefaults(config)).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(config));
    expect(migrateConfigGreenPrAutoArmDefaults(config)).toBe(false);
    expect(config).toEqual(snapshot);
  });
});

describe('migrateClaudeMd — Green-PR section REPLACE for already-armed agents (M1)', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-gpr-autoarm-md-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-mergeRunnerAutoArm.test.ts:md-cleanup' });
  });

  it('REPLACES the OLD section (route present, mergeStrategy absent) with the new disarm-reach content', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nIntro.\n' + OLD_SECTION + '\n## Next Section\n\nAfter.\n');
    const result = runClaudeMdMigration(projectDir);
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => /updated Green-PR Auto-Merge/.test(u))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    // The behavior-changing safety correction landed.
    expect(after).toContain('a HOLD label alone does NOT stop');
    expect(after).toContain('mergeStrategy');
    expect(after).toContain('--disable-auto');
    expect(after).toContain('armedCount');
    // The following section is preserved (the replace did not eat it).
    expect(after).toContain('## Next Section');
    expect(after).toContain('After.');
    // No duplicated heading.
    expect(after.match(/## Green-PR Auto-Merge/g)!.length).toBe(1);
  });

  it('APPENDS the section for a brand-new agent that has no Green-PR section at all', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nNo green-pr here.\n');
    const result = runClaudeMdMigration(projectDir);
    expect(result.upgraded.some((u) => /added Green-PR Auto-Merge/.test(u))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('## Green-PR Auto-Merge');
    expect(after).toContain('mergeStrategy');
  });

  it('is IDEMPOTENT for the Green-PR section — once the new marker is present, a second run skips and does not duplicate', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nIntro.\n' + OLD_SECTION);
    runClaudeMdMigration(projectDir);
    // Re-read, then run AGAIN from the migrated content (the green-pr marker is
    // now present), and assert the green-pr migration itself is a no-op + the
    // heading is not duplicated. (The full-file pass touches other sections too;
    // this test is scoped to THIS migration's idempotency.)
    const second = runClaudeMdMigration(projectDir);
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(second.upgraded.some((u) => /Green-PR Auto-Merge/.test(u))).toBe(false);
    expect(second.skipped.some((u) => /Green-PR Auto-Merge section already up to date/.test(u))).toBe(true);
    expect(afterSecond.match(/## Green-PR Auto-Merge/g)!.length).toBe(1);
  });
});
