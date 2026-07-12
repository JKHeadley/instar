/**
 * Verifies PostUpdateMigrator backfills the "Machine-Coherence Guard" CLAUDE.md
 * awareness section into existing agents on update (Agent Awareness + Migration
 * Parity Standards). New agents get it via generateClaudeMd; existing agents only
 * through migrateClaudeMd. This proves it at runtime and that it's idempotent —
 * the awareness surface for GET /pool/machine-coherence.
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
const MARKER = 'Machine-Coherence Guard';

describe('PostUpdateMigrator — Machine-Coherence Guard CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mc-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-machineCoherence.test.ts:cleanup' });
  });
  function newMigrator(): PostUpdateMigrator {
    return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  }

  it('adds the section (with the /pool/machine-coherence route + configured port) when CLAUDE.md lacks it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(newMigrator());
    const content = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(content).toContain(MARKER);
    expect(content).toContain('http://localhost:4042/pool/machine-coherence');
    expect(content).toContain('why did I get a machine-coherence alarm?');
    expect(result.upgraded.some((u) => u.includes('Machine-Coherence Guard'))).toBe(true);
  });

  it('is idempotent — a second run does not duplicate the section', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(newMigrator());
    const after1 = fs.readFileSync(claudeMdPath, 'utf-8');
    const result2 = runClaudeMdMigration(newMigrator());
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after2).toBe(after1);
    expect(after2.split(`### ${MARKER}`).length - 1).toBe(1);
    expect(result2.upgraded.some((u) => u.includes('Machine-Coherence Guard'))).toBe(false);
  });
});

describe('calm-alerting doc parity migrations', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mc-calm-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-machineCoherence.test.ts:calm-cleanup' });
  });
  function newMigrator(): PostUpdateMigrator {
    return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  }

  it('CONTENT-UPDATES the stale "raises ONE HIGH" narration on deployed agents (idempotent)', () => {
    const stale = 'exactly ONE elected machine raises ONE HIGH, episode-scoped attention item — impact-first, with a fix I perform on your approval (reply **fix it**) or hold open without nagging (reply **leave it**). Signal-only.';
    // A deployed agent: the section marker EXISTS (install-if-missing can never fire) with stale text.
    fs.writeFileSync(claudeMdPath, `# CLAUDE.md\n\n### Machine-Coherence Guard — x\n\n${stale}\n`);
    const r1 = runClaudeMdMigration(newMigrator());
    const after1 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after1).not.toContain('raises ONE HIGH');
    expect(after1).toContain('calm-first (calm-alerting)');
    expect(r1.upgraded.some((u) => u.includes('calm-alerting semantics'))).toBe(true);
    runClaudeMdMigration(newMigrator());
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after2).toBe(after1);
  });

  it('appends the rope-notice audit-row guidance ONCE (its own marker)', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\n### Machine-Coherence Guard — x\n\nnarrates ONE episode-scoped attention item — already calm.\n');
    runClaudeMdMigration(newMigrator());
    const after1 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after1).toContain('Rope-notice audit rows');
    expect(after1).toContain('sentinel-events.jsonl');
    runClaudeMdMigration(newMigrator());
    const after2 = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after2.split('Rope-notice audit rows').length).toBe(after1.split('Rope-notice audit rows').length);
  });
});
