// safe-fs-allow: test file — SafeFsExecutor used for tmpdir cleanup.
/** Agent Awareness + Migration Parity for the writer-agnostic replication reconciler. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const MARKER = 'Replication is writer-agnostic';
type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function run(projectDir: string): MigrationResult {
  const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}
const count = (s: string) => s.split(MARKER).length - 1;

describe('writer-agnostic replication CLAUDE.md line', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-reconcile-md-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/reconciler-claude-md-awareness.test.ts:cleanup' }));

  it('new agents get it once from the template, with the status route', () => {
    const md = generateClaudeMd('test', 'Test', 4042, false);
    expect(count(md)).toBe(1);
    expect(md).toContain('/state/reconcile');
  });

  it('an agent whose One Memory section predates it gets it once, before "When to use"; idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n\n### One Memory (replicated stores)\n\nintro /state/resolve-conflict\n- **When to use** (PROACTIVE — these are the triggers): x\n');
    run(projectDir);
    const once = fs.readFileSync(claudeMd, 'utf8');
    expect(count(once)).toBe(1);
    const section = once.indexOf('One Memory (replicated stores)');
    expect(once.indexOf(MARKER)).toBeGreaterThan(section);
    expect(once.indexOf(MARKER)).toBeLessThan(once.indexOf('- **When to use** (PROACTIVE — these are the triggers)', section));
    run(projectDir);
    run(projectDir);
    // Other chained One Memory migrations add their own lines on later passes; this line stays single.
    expect(count(fs.readFileSync(claudeMd, 'utf8'))).toBe(1);
  });

  it('an agent with no One Memory section gets the full section including the line, once', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n');
    run(projectDir);
    run(projectDir);
    expect(count(fs.readFileSync(claudeMd, 'utf8'))).toBe(1);
  });
});
