// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/** Agent Awareness + Migration Parity for the test-runner wait-budget line (CMT-908). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OLD = '- A `git push` run under an OUTER command timeout needs that timeout ≥ the pre-push acquire budget (default 10 min interactive) — a correctly-WAITING push must not be killed by its own caller.';
const NEW_MARKER = 'A full suite waits up to 45 min for its slot by default';
type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}

describe('test-runner wait-budget CLAUDE.md line', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-trb-budget-line-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/test-runner-budget-awareness.test.ts:cleanup' }));

  it('new agents get the current budget line, never the stale one', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(md).toContain(NEW_MARKER);
    expect(md).not.toContain(OLD);
  });

  it('existing agents have the stale line replaced in place, once; idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n**Test-Runner Concurrency Bound (host-wide vitest cap)** — …\n' + OLD + '\n- Kill switch: …\n');
    const r1 = run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(r1.upgraded).toContain('CLAUDE.md: updated Test-Runner Concurrency Bound wait-budget line');
    expect(once).not.toContain(OLD);
    expect(once.split(NEW_MARKER).length - 1).toBe(1);
    expect(once).toContain(NEW_MARKER);
    const r2 = run(projectDir);
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(r2.upgraded).not.toContain('CLAUDE.md: updated Test-Runner Concurrency Bound wait-budget line');
  });
});
