/**
 * Verifies PostUpdateMigrator backfills the throttle-survivable capture-backlog
 * note into existing agents' CLAUDE.md (Migration Parity) — and only into agents
 * that already have the Correction & Preference Learning block, so a freshly
 * initialized agent (which gets the bullet from the template) is never
 * double-patched. The template also emits the same bullet.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const MARKER = 'Throttle-survivable capture';

// A minimal stand-in for the existing "Preferences I've learned about you" block
// an already-deployed agent would carry (Slice 1b), including the /corrections
// records line the migration anchors to.
const EXISTING_CORRECTION_BLOCK =
  "# CLAUDE.md\n\n" +
  "**Preferences I've learned about you** — The Correction & Preference Learning Sentinel turns repeated corrections into durable preferences.\n" +
  "- See the active block the hook injects: `GET /preferences/session-context`.\n" +
  "- See the distilled correction/preference records the loop has captured: `GET /corrections` (deduped, scrubbed records).\n" +
  "- The **Preferences dashboard tab** is the human read surface.\n";

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function runClaudeMdMigration(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('PostUpdateMigrator — correction-capture-backlog CLAUDE.md backfill', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ccb-migrate-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true, force: true,
      operation: 'tests/unit/PostUpdateMigrator-correctionCaptureBacklog.test.ts:cleanup',
    });
  });

  it('inserts the backlog bullet right after the /corrections records line when the block exists', () => {
    fs.writeFileSync(claudeMdPath, EXISTING_CORRECTION_BLOCK);

    const result = runClaudeMdMigration(newMigrator(projectDir));

    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('correction-capture-backlog'))).toBe(true);

    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    expect(after).toContain('correction-capture-backlog.db');
    expect(after).toContain('captureBacklogMaxEntries');
    // The bullet lands AFTER the /corrections records line and BEFORE the dashboard line.
    const corrIdx = after.indexOf('records the loop has captured');
    const bulletIdx = after.indexOf(MARKER);
    const dashIdx = after.indexOf('Preferences dashboard tab');
    expect(corrIdx).toBeGreaterThan(-1);
    expect(bulletIdx).toBeGreaterThan(corrIdx);
    expect(dashIdx).toBeGreaterThan(bulletIdx);
  });

  it('is idempotent — re-running does not add a duplicate bullet', () => {
    fs.writeFileSync(claudeMdPath, EXISTING_CORRECTION_BLOCK);
    runClaudeMdMigration(newMigrator(projectDir));
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');

    const result2 = runClaudeMdMigration(newMigrator(projectDir));
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result2.upgraded.some(u => u.includes('correction-capture-backlog'))).toBe(false);
    expect(afterSecond).toBe(afterFirst);
    expect((afterSecond.match(/Throttle-survivable capture/g) || []).length).toBe(1);
  });

  it('does NOT patch an agent that lacks the Correction & Preference Learning block', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nNo correction block here.\n');

    const result = runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result.upgraded.some(u => u.includes('correction-capture-backlog'))).toBe(false);
    expect(after).not.toContain(MARKER);
  });

  it('does not double-patch a freshly-initialized agent that already has the template bullet', () => {
    const fresh =
      EXISTING_CORRECTION_BLOCK.replace(
        '- The **Preferences dashboard tab**',
        `- **${MARKER}**: already present from the template.\n- The **Preferences dashboard tab**`,
      );
    fs.writeFileSync(claudeMdPath, fresh);

    const result = runClaudeMdMigration(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMdPath, 'utf-8');

    expect(result.upgraded.some(u => u.includes('correction-capture-backlog'))).toBe(false);
    expect((after.match(/Throttle-survivable capture/g) || []).length).toBe(1);
  });
});

describe('the agent template emits the capture-backlog bullet so fresh installs get it too', () => {
  it('templates.ts contains the throttle-survivable capture bullet', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain(MARKER);
    expect(templateSource).toContain('correction-capture-backlog.db');
    expect(templateSource).toContain('captureBacklogMaxEntries');
  });
});
