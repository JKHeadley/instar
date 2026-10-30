/**
 * CMT-1118 — the auto-expiry review-ledger awareness line reaches EXISTING
 * agents through migrateClaudeMd (Migration Parity), once, and new agents get
 * it from the template.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = '**Auto-expiry review ledgers:**';

function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}

describe('PostUpdateMigrator — auto-expiry review ledger awareness (CMT-1118)', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-autoexpiry-ledger-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-autoExpiryLedgerAwareness.test.ts:cleanup' }));

  it('appends the line once and is idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n');
    const first = run(projectDir);
    expect(first.upgraded).toContain('CLAUDE.md: added auto-expiry review ledger awareness (CMT-1118)');
    run(projectDir);
    const after = fs.readFileSync(claudeMd, 'utf8');
    expect(after.split(MARKER).length - 1).toBe(1);
    expect(after).toContain('logs/commitments-auto-expiry.jsonl');
    expect(after).toContain('logs/evolution-actions-auto-expiry.jsonl');
  });

  it('is in the template for new agents', () => {
    const md = (generateClaudeMd as unknown as (...a: unknown[]) => string)('test', 'Echo', 4042, false);
    expect(md).toContain(MARKER);
  });

  it('CMT-1132: corrects the shipped delete wording and adds the hold line once', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n\n- **Evolution action auto-expiry:** x; turning dry-run off removes eligible items in one coalesced save and emits replication tombstones so peers cannot resurrect them.\n');
    run(projectDir);
    run(projectDir);
    const after = fs.readFileSync(claudeMd, 'utf8');
    expect(after).not.toContain('tombstones');
    expect(after).toContain('archives eligible items with their full content');
    expect(after.split('**Auto-expiry holds and archive:**').length - 1).toBe(1);
  });
});
