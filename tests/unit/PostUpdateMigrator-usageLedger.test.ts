/**
 * Migration Parity + Agent Awareness for the unified usage ledger
 * (docs/specs/unified-usage-ledger.md): existing agents learn the /usage/* routes on
 * update, once; a fresh template carries the same section; the ledger's databases are
 * kept out of git where an ignore file exists; the snapshot is in the default backup set.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, USAGE_LEDGER_CLAUDEMD_SECTION, USAGE_LEDGER_CLAUDEMD_MARKER } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function migrator(projectDir: string) {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}

describe('PostUpdateMigrator — unified usage ledger', () => {
  let projectDir: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'instar-usage-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-usageLedger.test.ts:cleanup' });
  });

  it('adds the CLAUDE.md section once, with the Registry First reads', () => {
    fs.writeFileSync(path.join(projectDir, 'CLAUDE.md'), '# CLAUDE.md\n');
    const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (migrator(projectDir) as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
    expect(r.upgraded).toContain('CLAUDE.md: added the unified usage ledger section');
    (migrator(projectDir) as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd({ upgraded: [], skipped: [], errors: [] });
    const content = fs.readFileSync(path.join(projectDir, 'CLAUDE.md'), 'utf-8');
    expect(content.split(USAGE_LEDGER_CLAUDEMD_MARKER).length - 1).toBe(1);
    expect(content).toContain('http://localhost:4042/usage/summary?grain=day');
    expect(content).toContain('/usage/coverage');
    expect(content).toContain('usage-ledger-off');
  });

  it('a freshly generated CLAUDE.md already carries the section, so it is never double-patched', () => {
    const fresh = generateClaudeMd('test', 'echo', 4042, false);
    expect(fresh).toContain(USAGE_LEDGER_CLAUDEMD_MARKER);
    expect(USAGE_LEDGER_CLAUDEMD_SECTION(4040)).toContain(USAGE_LEDGER_CLAUDEMD_MARKER);
  });

  it('adds the ignore lines where ignore files exist, idempotently, and creates none', () => {
    fs.writeFileSync(path.join(projectDir, '.gitignore'), 'node_modules/\n');
    fs.writeFileSync(path.join(projectDir, '.instar', '.gitignore'), 'logs/\n');
    const run = () => (migrator(projectDir) as unknown as { migrateUsageLedgerGitignore(r: MigrationResult): void }).migrateUsageLedgerGitignore({ upgraded: [], skipped: [], errors: [] });
    run(); run();
    const project = fs.readFileSync(path.join(projectDir, '.gitignore'), 'utf-8');
    const state = fs.readFileSync(path.join(projectDir, '.instar', '.gitignore'), 'utf-8');
    expect(project.split('.instar/server-data/usage-ledger*').length - 1).toBe(1);
    expect(state.split('server-data/usage-ledger*').length - 1).toBe(1);
    const bare = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'instar-usage-mig-bare-'));
    fs.mkdirSync(path.join(bare, '.instar'));
    (migrator(bare) as unknown as { migrateUsageLedgerGitignore(r: MigrationResult): void }).migrateUsageLedgerGitignore({ upgraded: [], skipped: [], errors: [] });
    expect(fs.existsSync(path.join(bare, '.gitignore'))).toBe(false);
    SafeFsExecutor.safeRmSync(bare, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-usageLedger.test.ts:bare' });
  });

  it('the snapshot is in the default backup set and both databases are in the state registry', () => {
    const backup = fs.readFileSync('src/core/BackupManager.ts', 'utf-8');
    expect(backup).toContain("'server-data/usage-ledger.snapshot.db'");
    const reg = JSON.parse(fs.readFileSync('src/data/state-coherence-registry.json', 'utf-8'));
    const all = JSON.stringify(reg);
    expect(all).toContain('server-data/usage-ledger.db');
    expect(all).toContain('server-data/usage-ledger.snapshot.db');
  });
});
