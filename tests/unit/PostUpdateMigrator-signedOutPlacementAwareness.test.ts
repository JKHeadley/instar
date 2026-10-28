/**
 * Existing agents learn that placement skips machines with no signed-in account (CMT-1051),
 * through the update path (Migration Parity Standard), byte-identical to generateClaudeMd.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const BULLET_START = '- **Signed-out machines are skipped (automatic):**';
const BULLET_END = "read that machine's `quotaState` in `GET /pool`.";
const POOL = '# CLAUDE.md\n\n## Multi-Machine Session Pool (active-active — spread conversations across machines)\n\nPool prose. Quota-aware placement.\n';

function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}
const slice = (doc: string) => {
  const s = doc.indexOf(BULLET_START);
  expect(s).toBeGreaterThanOrEqual(0);
  const e = doc.indexOf(BULLET_END, s);
  expect(e).toBeGreaterThan(s);
  return doc.slice(s, e + BULLET_END.length);
};

describe('PostUpdateMigrator — signed-out machine placement bullet', () => {
  let dir: string;
  let md: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-signedout-mig-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    md = path.join(dir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-signedOutPlacementAwareness.test.ts:cleanup' });
  });

  it('adds the bullet to an agent that has the pool section but not this line', () => {
    fs.writeFileSync(md, POOL);
    const r = run(dir);
    expect(r.errors).toEqual([]);
    expect(r.upgraded).toContain('CLAUDE.md: added signed-out machine placement line');
    const after = fs.readFileSync(md, 'utf-8');
    expect(after).toContain('no-signed-in-account');
    expect(after).toContain('pinned-machine-not-signed-in');
  });

  it('leaves an agent without the pool section alone (single-machine agents)', () => {
    fs.writeFileSync(md, '# CLAUDE.md\n\nNothing about pools.\n');
    run(dir);
    // The full pool section may be appended by its own migration; this bullet then appears exactly once.
    const after = fs.readFileSync(md, 'utf-8');
    expect(after.split(BULLET_START).length - 1).toBeLessThanOrEqual(1);
  });

  it('is idempotent', () => {
    fs.writeFileSync(md, POOL);
    run(dir);
    const first = fs.readFileSync(md, 'utf-8');
    run(dir);
    const second = fs.readFileSync(md, 'utf-8');
    expect(second).toBe(first);
    expect(second.split(BULLET_START).length - 1).toBe(1);
  });

  it('is byte-identical to the bullet new agents get', () => {
    fs.writeFileSync(md, POOL);
    run(dir);
    const migrated = slice(fs.readFileSync(md, 'utf-8'));
    const fresh = generateClaudeMd('test', 'TestAgent', 4042, false);
    expect(slice(fresh)).toBe(migrated);
  });
});
