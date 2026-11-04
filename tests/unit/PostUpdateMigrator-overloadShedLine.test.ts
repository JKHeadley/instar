/**
 * An installed agent's CLAUDE.md says a shed move is a plain transfer and that it waits on
 * admission. Neither is true after session-pool-rebalancing-finish, and the section-level
 * sniff would skip it forever, so the line is replaced in place (Migration Parity).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, OVERLOAD_SHED_CLAUDE_MD_LINE } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const OLD = '- **Overload shed (trustworthy-machine-load, P3):** a machine that has refused new work for 3 minutes moves its EXISTING conversations off. The move is an ordinary cooperative ownership transfer through the reconciler, like a pin move but never written as a pin.';

describe('PostUpdateMigrator — overload shed line', () => {
  let dir: string; let claudeMd: string;
  const run = (): MigrationResult => {
    const m = new PostUpdateMigrator({ projectDir: dir, stateDir: path.join(dir, '.instar'), port: 4042, hasTelegram: false, projectName: 'x' } as ConstructorParameters<typeof PostUpdateMigrator>[0]);
    const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
    return r;
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-shed-line-'));
    fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
    claudeMd = path.join(dir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-overloadShedLine.test.ts' }));

  it('replaces the old line in place, leaving the lines around it', () => {
    fs.writeFileSync(claudeMd, `# Agent\n\nbefore\n${OLD}\nafter\n`);
    run();
    const out = fs.readFileSync(claudeMd, 'utf-8');
    expect(out).not.toContain('ordinary cooperative ownership transfer');
    expect(out).toContain(`before\n${OVERLOAD_SHED_CLAUDE_MD_LINE}\nafter`);
  });

  it('is idempotent', () => {
    fs.writeFileSync(claudeMd, `# Agent\n${OLD}\n`);
    run();
    const once = fs.readFileSync(claudeMd, 'utf-8');
    expect(run().upgraded.filter((u) => u.includes('overload shed'))).toEqual([]);
    expect(fs.readFileSync(claudeMd, 'utf-8')).toBe(once);
  });

  it('the shared line says what is now true, and new agents get the same line', () => {
    expect(OVERLOAD_SHED_CLAUDE_MD_LINE).toContain('POST /session-pool/rebalance-proof');
    expect(OVERLOAD_SHED_CLAUDE_MD_LINE).not.toContain('\\`');
    const generated = generateClaudeMd('x', 'y', 4042, false, false);
    if (generated.includes('Overload shed (trustworthy-machine-load, P3)')) expect(generated).toContain(OVERLOAD_SHED_CLAUDE_MD_LINE);
  });
});
