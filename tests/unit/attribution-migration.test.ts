/**
 * Migration Parity + wiring for the attribution paper trail: existing agents receive the hook, the
 * setting, the job and the awareness, and none of it restricts them.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { BackupManager } from '../../src/core/BackupManager.js';
import { buildInstarCodexHookGroups, installCodexHooks } from '../../src/core/installCodexHooks.js';
import { ensureInstarWritePreToolUseHooks, INSTAR_WRITE_PRETOOLUSE_HOOKS } from '../../src/core/instarSettingsHooks.js';
import { PostUpdateMigrator, type MigrationResult } from '../../src/core/PostUpdateMigrator.js';
import { getDefaultJobs } from '../../src/commands/init.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('attribution migration parity', () => {
  let project: string;
  let state: string;
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), 'attr-mig-'));
    state = path.join(project, '.instar');
    fs.mkdirSync(path.join(state, 'hooks', 'instar'), { recursive: true });
    fs.mkdirSync(path.join(project, '.claude'), { recursive: true });
    fs.writeFileSync(path.join(state, 'config.json'), JSON.stringify({ port: 4042, projectName: 'x' }));
  });
  afterEach(() => { SafeFsExecutor.safeRmSync(project, { recursive: true, force: true, operation: 'tests/unit/attribution-migration.test.ts:cleanup' }); });
  const migrator = () => new PostUpdateMigrator({ projectDir: project, stateDir: state, port: 4042, hasTelegram: false, projectName: 'x' });
  const empty = (): MigrationResult => ({ upgraded: [], skipped: [], errors: [] });

  it('migrateHooks overwrites the hook every run', () => {
    const hook = path.join(state, 'hooks', 'instar', 'attribution-gate.js');
    fs.writeFileSync(hook, 'stale');
    (migrator() as unknown as { migrateHooks(r: MigrationResult): void }).migrateHooks(empty());
    expect(fs.readFileSync(hook, 'utf8')).toContain('/attribution/check');
  });

  it('migrateSettings adds the write matcher once and keeps a user hook', () => {
    const settings = path.join(project, '.claude', 'settings.json');
    fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: 'mine.sh' }] }] } }));
    const m = migrator() as unknown as { migrateSettings(r: MigrationResult): void };
    m.migrateSettings(empty());
    m.migrateSettings(empty());
    const pre = JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.PreToolUse as Array<{ matcher: string; hooks: Array<{ command: string }> }>;
    const entry = pre.find((e) => e.matcher === 'Write|Edit|MultiEdit')!;
    expect(entry.hooks.map((h) => h.command).filter((c) => c.includes('attribution-gate.js'))).toHaveLength(1);
    expect(entry.hooks.some((h) => h.command === 'mine.sh')).toBe(true);
  });

  it('the shared ensure is idempotent and matches the template', () => {
    const list: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }> = [];
    expect(ensureInstarWritePreToolUseHooks(list)).toEqual(['attribution-gate.js']);
    expect(ensureInstarWritePreToolUseHooks(list)).toEqual([]);
    const template = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../src/templates/hooks/settings-template.json'), 'utf8'));
    const entry = template.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === 'Write|Edit|MultiEdit');
    expect(entry.hooks[0].command).toBe(INSTAR_WRITE_PRETOOLUSE_HOOKS[0].command);
  });

  it('Codex registers the hook with its timeout set explicitly, over its 20s budget', () => {
    const hooks = buildInstarCodexHookGroups(project).PreToolUse[0].hooks;
    const entry = hooks.find((h) => h.command.includes('attribution-gate.js'))!;
    expect(entry.timeout).toBe(25000);
    const written = JSON.parse(fs.readFileSync(installCodexHooks(project), 'utf8'));
    expect(JSON.stringify(written.hooks.PreToolUse)).toContain('attribution-gate.js');
  });

  it('migrateClaudeMd adds the section once', () => {
    const claude = path.join(project, 'CLAUDE.md');
    fs.writeFileSync(claude, '# CLAUDE.md\n');
    const m = migrator() as unknown as { migrateClaudeMd(r: MigrationResult): void };
    m.migrateClaudeMd(empty());
    m.migrateClaudeMd(empty());
    const text = fs.readFileSync(claude, 'utf8');
    expect(text.match(/## Attribution paper trail/g)).toHaveLength(1);
    expect(text).toContain('http://localhost:4042/attribution/status');
    expect(text).not.toContain('${port}');
  });

  it('migrateConfig adds record mode and never turns it on or to enforce', () => {
    const cfg: Record<string, unknown> = {};
    applyDefaults(cfg, getMigrationDefaults('standalone'));
    expect(cfg.attribution).toEqual({ mode: 'record' });
    const opted: Record<string, unknown> = { attribution: { mode: 'enforce', enabled: true } };
    applyDefaults(opted, getMigrationDefaults('standalone'));
    expect(opted.attribution).toEqual({ mode: 'enforce', enabled: true });
  });

  it('the job is inert unless the status route says enforce', () => {
    const job = (getDefaultJobs(4042) as Array<{ slug: string; gate?: string; enabled?: boolean }>).find((j) => j.slug === 'attribution-review')!;
    expect(job.gate).toContain('/attribution/status');
    expect(job.gate).toContain("=='enforce'");
    expect(job.gate).toContain('curl -sf');
  });

  it('the template teaches the capability, the registry row and the trigger', () => {
    const text = generateClaudeMd('p', 'a', 4042, false);
    expect(text).toContain('## Attribution paper trail');
    expect(text).toContain('/attribution/trace?q=WORDS');
    expect(text).toContain('credit someone with a rule or a statement');
    expect(text).not.toContain('localhost:${port}/attribution');
  });

  it('backups carry pins and the ledger', () => {
    const manager = new BackupManager(state);
    expect((manager as unknown as { config: { includeFiles: string[] } }).config.includeFiles).toContain('attribution/');
  });
});
