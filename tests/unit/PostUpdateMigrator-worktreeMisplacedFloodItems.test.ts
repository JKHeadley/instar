/**
 * Verifies PostUpdateMigrator.migrateWorktreeMisplacedFloodItems purges the
 * stale per-path `worktree-misplaced:<sha256>` attention items left behind by
 * the 2026-06-05 false-positive flood (110 OPEN items on flooded agents),
 * while keeping every other item — including the fixed detector's new
 * aggregated `worktree-misplaced-summary:*` items.
 *
 * Part of the "Bounded Notification Surface" standard
 * (docs/STANDARDS-REGISTRY.md).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({
    projectDir,
    stateDir: path.join(projectDir, '.instar'),
    port: 4042,
    hasTelegram: false,
    projectName: 'test',
  });
}

function run(migrator: PostUpdateMigrator): MigrationResult {
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateWorktreeMisplacedFloodItems(r: MigrationResult): void }).migrateWorktreeMisplacedFloodItems(result);
  return result;
}

describe('PostUpdateMigrator — worktree-misplaced flood-item purge', () => {
  let projectDir: string;
  let storePath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-wt-flood-purge-'));
    const stateDir = path.join(projectDir, '.instar', 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    storePath = path.join(stateDir, 'attention-items.json');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-worktreeMisplacedFloodItems.test.ts:cleanup' });
  });

  it('skips when no attention store exists', () => {
    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.skipped.some((s) => s.includes('no attention store'))).toBe(true);
  });

  it('purges old per-path items, keeps everything else (incl. the new summary format)', () => {
    const items = [
      { id: 'worktree-misplaced:' + 'a'.repeat(64), title: 'Worktree placed outside agent home', status: 'OPEN' },
      { id: 'worktree-misplaced:' + 'b'.repeat(64), title: 'Worktree placed outside agent home', status: 'OPEN' },
      { id: 'worktree-misplaced-summary:abcdef0123456789', title: '2 worktree(s) placed outside agent homes', status: 'OPEN' },
      { id: 'collab-redrive-1', title: 'unrelated item', status: 'OPEN' },
    ];
    fs.writeFileSync(storePath, JSON.stringify({ items }, null, 2));

    const result = run(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((s) => s.includes('purged 2 stale'))).toBe(true);

    const after = JSON.parse(fs.readFileSync(storePath, 'utf-8')) as { items: Array<{ id: string }> };
    expect(after.items.map((i) => i.id)).toEqual([
      'worktree-misplaced-summary:abcdef0123456789',
      'collab-redrive-1',
    ]);
  });

  it('is idempotent — a second run skips with none present', () => {
    fs.writeFileSync(storePath, JSON.stringify({
      items: [{ id: 'worktree-misplaced:' + 'c'.repeat(64), status: 'OPEN' }],
    }));
    const migrator = newMigrator(projectDir);
    const first = run(migrator);
    expect(first.upgraded.length).toBe(1);
    const second = run(migrator);
    expect(second.upgraded.length).toBe(0);
    expect(second.skipped.some((s) => s.includes('none present'))).toBe(true);
    expect(second.errors).toEqual([]);
  });

  it('reports an error (not a crash) on a corrupt store', () => {
    fs.writeFileSync(storePath, '{ not json');
    const result = run(newMigrator(projectDir));
    expect(result.errors.length).toBe(1);
  });
});
