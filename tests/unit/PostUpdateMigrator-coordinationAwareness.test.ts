/**
 * Verifies PostUpdateMigrator backfills the coordination-surface awareness
 * sections (Coordination Mandate / ReviewExchange / Cutover Readiness) into
 * existing agents' CLAUDE.md on update (Migration Parity Standard).
 *
 * New agents get these via generateClaudeMd; existing agents only get them
 * through migrateClaudeMd — without this backfill the whole deployed fleet
 * would never learn the /mandate, /review-exchange, or /cutover-readiness
 * surfaces exist. Proves the backfill at runtime + idempotency + the
 * security-critical copy (PIN never in chat; deny means stop; door is manual).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — coordination-surface CLAUDE.md backfill (mandate/review-exchange/cutover-readiness)', () => {
  let projectDir: string;
  let migrator: PostUpdateMigrator;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'coord-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md\n\nExisting agent content.\n');
    migrator = new PostUpdateMigrator({
      projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042,
    } as any);
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-coordinationAwareness.test.ts' }));

  it('backfills all three coordination sections into an existing CLAUDE.md', () => {
    const result = runClaudeMdMigration(migrator);
    const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');

    expect(result.upgraded.some((u) => u.includes('Coordination Mandate'))).toBe(true);
    expect(result.upgraded.some((u) => u.includes('ReviewExchange'))).toBe(true);
    expect(result.upgraded.some((u) => u.includes('Cutover Readiness'))).toBe(true);

    // The surfaces themselves.
    expect(content).toContain('/mandate/evaluate');
    expect(content).toContain('/review-exchange');
    expect(content).toContain('/cutover-readiness');
    // The configured port is baked in (not a template literal leak).
    expect(content).toContain('http://localhost:4042/mandate/evaluate');
    expect(content).not.toContain('${port}');
  });

  it('carries the security-critical copy verbatim', () => {
    runClaudeMdMigration(migrator);
    const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    // PIN discipline: never in chat; the dashboard Mandates tab is the surface.
    expect(content).toContain('NEVER ask the user to paste their PIN into chat');
    expect(content).toContain('Mandates tab');
    // Deny discipline.
    expect(content).toContain('A deny means STOP');
    // The door stays human.
    expect(content).toContain('The cutover click belongs to the operator');
  });

  it('is idempotent — a second run patches nothing', () => {
    runClaudeMdMigration(migrator);
    const after1 = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    const result2 = runClaudeMdMigration(migrator);
    const after2 = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(after2).toBe(after1);
    expect(result2.upgraded.some((u) => u.includes('Coordination Mandate'))).toBe(false);
    expect(result2.upgraded.some((u) => u.includes('ReviewExchange'))).toBe(false);
    expect(result2.upgraded.some((u) => u.includes('Cutover Readiness'))).toBe(false);
  });

  it('does not double-patch a freshly-initialized agent that already carries the sections', () => {
    // Simulate a new agent whose template already includes the markers — including
    // the import-dryrun rehearsal line a CURRENT template ships (an agent missing
    // that line is the deployed-agent splice case, covered below).
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'),
      '# CLAUDE.md\n\n/mandate/evaluate … /review-exchange … /cutover-readiness … /cutover-readiness/import-dryrun …\n');
    const result = runClaudeMdMigration(migrator);
    expect(result.upgraded.some((u) => u.includes('Coordination Mandate'))).toBe(false);
    expect(result.upgraded.some((u) => u.includes('ReviewExchange'))).toBe(false);
    expect(result.upgraded.some((u) => u.includes('Cutover Readiness'))).toBe(false);
  });

  it('splices the import-dryrun line into an agent carrying the PRE-rehearsal Cutover Readiness section', () => {
    // The deployed-agent case: the section shipped before the import rehearsal
    // existed — has the route prefix and the door line, but no dry-run line.
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), [
      '# CLAUDE.md',
      '',
      '/mandate/evaluate … /review-exchange …',
      '**Cutover Readiness** — read surface.',
      '- Check: `curl http://localhost:4042/cutover-readiness`.',
      '- **The door is NOT yours**: the cutover click belongs to the operator.',
      '',
    ].join('\n'));
    const result = runClaudeMdMigration(migrator);
    expect(result.upgraded.some((u) => u.includes('import dry-run'))).toBe(true);

    const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('/cutover-readiness/import-dryrun');
    // Spliced AHEAD of the door-discipline line (workflow order preserved).
    expect(content.indexOf('/cutover-readiness/import-dryrun'))
      .toBeLessThan(content.indexOf('**The door is NOT yours**'));
    // NEVER-greens honesty copy travels with the line.
    expect(content).toContain('NEVER greens the canonical integrity condition');

    // Idempotent: a second run leaves the file byte-identical.
    const result2 = runClaudeMdMigration(migrator);
    expect(result2.upgraded.some((u) => u.includes('import dry-run'))).toBe(false);
    expect(fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8')).toBe(content);
  });
});
