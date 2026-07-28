/**
 * Verifies PostUpdateMigrator adds the Per-Feature LLM Metrics (/metrics/features)
 * awareness to existing agents' CLAUDE.md, and that the template emits it too
 * (so new agents get it). Spec: docs/specs/llm-feature-metrics-spec.md.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
const MARKER = '/metrics/features';

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

describe('PostUpdateMigrator — Per-Feature LLM Metrics CLAUDE.md awareness', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-metricsfeat-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-metricsFeatures.test.ts:cleanup',
    });
  });

  it('adds the /metrics/features awareness when absent', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nExisting.\n');
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('Per-Feature LLM Metrics'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain(MARKER);
    expect(after).toContain('Per-Feature LLM Metrics');
    expect(after).toContain('docs/specs/llm-feature-metrics-spec.md');
  });

  it('is idempotent and does not double-patch an agent that already has it', () => {
    // An agent with BOTH the base marker and the token-audit addendum sniff
    // key (`unlabeledCallShare`) gets neither section re-appended.
    fs.writeFileSync(
      claudeMdPath,
      `# CLAUDE.md\n\nAlready: ${MARKER} present, with unlabeledCallShare too.\n`,
    );
    const result = runClaudeMdMigration(newMigrator(projectDir));
    expect(result.upgraded.some(u => u.includes('Per-Feature LLM Metrics'))).toBe(false);
    expect(result.upgraded.some(u => u.includes('Token-Audit Completeness'))).toBe(false);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    const matches = after.match(/\/metrics\/features/g);
    expect(matches?.length).toBe(1);
  });

  it('appends the token-audit addendum ONCE to an agent that has the base section but not the addendum', () => {
    // Base marker present, addendum sniff key absent → the addendum (per-model
    // breakdown + usageCoverage) appends; a second run adds nothing.
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\nAlready: ${MARKER} present.\n`);
    const first = runClaudeMdMigration(newMigrator(projectDir));
    expect(first.upgraded.some(u => u.includes('Token-Audit Completeness'))).toBe(true);
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(afterFirst).toContain('unlabeledCallShare');
    expect(afterFirst).toContain('usageCoverage');

    const second = runClaudeMdMigration(newMigrator(projectDir));
    expect(second.upgraded.some(u => u.includes('Token-Audit Completeness'))).toBe(false);
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(afterSecond).toBe(afterFirst); // byte-stable across re-runs
  });
});

describe('Per-Feature LLM Metrics is in the agent template', () => {
  it('the template emits /metrics/features so fresh installs get it too', () => {
    const templateSource = fs.readFileSync(
      path.join(process.cwd(), 'src/scaffold/templates.ts'),
      'utf-8',
    );
    expect(templateSource).toContain('Per-Feature LLM Metrics');
    expect(templateSource).toContain('/metrics/features');
  });
});
