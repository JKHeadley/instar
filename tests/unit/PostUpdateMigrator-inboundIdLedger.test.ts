/**
 * Migration parity for the A2A inbound message-id ledger
 * (docs/specs/a2a-inbound-id-ledger.md): the CLAUDE.md awareness section reaches
 * existing agents (sniff key `inbound message-id ledger`), idempotently, with the
 * agent's own port; the template carries the same section for new agents; the
 * config default backfills retentionDays without forcing `enabled`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { DEV_GATED_FEATURES } from '../../src/core/devGatedFeatures.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — A2A inbound message-id ledger', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-inbound-ledger-mig-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-inboundIdLedger.test.ts' }));

  const run = () => {
    const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
    return result;
  };

  it('adds the section once, with the agent port, and is idempotent', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    const r1 = run();
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded.some((u) => u.includes('inbound message-id ledger'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('### A2A inbound message-id ledger');
    expect(after).toContain('http://localhost:4321/a2a/inbound-ids?sender=');
    run();
    const again = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(again.split('### A2A inbound message-id ledger').length - 1).toBe(1);
  });

  it('an agent that ALREADY carries the ledger section receives the cross-route paragraph once', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\n### A2A inbound message-id ledger\n\nI keep a two-week list (inbound message-id ledger).\n');
    const r1 = run();
    expect(r1.errors).toEqual([]);
    expect(r1.upgraded).toContain('CLAUDE.md: added A2A cross-route copies paragraph');
    expect(r1.upgraded.some((u) => u.includes('added A2A inbound message-id ledger section'))).toBe(false);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('**A2A cross-route copies are labelled:**');
    expect(after).toContain('`crossNamespaceLabelled`');
    // The existing section is not rewritten.
    expect(after).toContain('I keep a two-week list (inbound message-id ledger).');
    const r2 = run();
    expect(r2.upgraded.some((u) => u.includes('cross-route'))).toBe(false);
    expect(fs.readFileSync(claudeMdPath, 'utf-8').split('**A2A cross-route copies are labelled:**').length - 1).toBe(1);
  });

  it('a fresh agent gets both, and the migrator text matches the template text', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n');
    run();
    const migrated = fs.readFileSync(claudeMdPath, 'utf-8');
    const template = generateClaudeMd('test', 'Test', 4321, false);
    const para = (md: string) => md.split('\n').find((l) => l.startsWith('**A2A cross-route copies are labelled:**'));
    expect(para(template)).toBeTruthy();
    expect(para(migrated)).toBe(para(template));
  });

  it('a Codex/Gemini shadow that ALREADY carries the ledger section receives the paragraph exactly once', () => {
    const MARK = '**A2A cross-route copies are labelled:**';
    const existing = '# X\n\n### A2A inbound message-id ledger\n\nI keep a two-week list (inbound message-id ledger).\n';
    fs.writeFileSync(claudeMdPath, existing.replace('# X', '# CLAUDE.md'));
    const agentsPath = path.join(projectDir, 'AGENTS.md');
    fs.writeFileSync(agentsPath, existing.replace('# X', '# AGENTS.md'));
    const shadows = () => {
      const m = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4321, hasTelegram: false, projectName: 'test' });
      const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
      (m as unknown as { migrateFrameworkShadowCapabilities(r: MigrationResult): void }).migrateFrameworkShadowCapabilities(result);
      return result;
    };
    run();
    expect(shadows().errors).toEqual([]);
    const agents = fs.readFileSync(agentsPath, 'utf-8');
    expect(agents.split(MARK).length - 1).toBe(1);
    expect(agents).toContain('`crossNamespaceLabelled`');
    // The ledger section the shadow already had is neither duplicated nor rewritten.
    expect(agents.split('### A2A inbound message-id ledger').length - 1).toBe(1);
    expect(agents).toContain('I keep a two-week list (inbound message-id ledger).');
    // Idempotent across both steps.
    run();
    shadows();
    expect(fs.readFileSync(agentsPath, 'utf-8').split(MARK).length - 1).toBe(1);
    expect(fs.readFileSync(claudeMdPath, 'utf-8').split(MARK).length - 1).toBe(1);
  });

  it('the template carries the same section for new agents', () => {
    const md = generateClaudeMd('test', 'Test', 4040, false);
    expect(md).toContain('### A2A inbound message-id ledger');
    expect(md).toContain('http://localhost:4040/a2a/inbound-ids?sender=');
  });

  it('config default backfills retentionDays and omits enabled (dev gate decides)', () => {
    const d = getMigrationDefaults('standalone') as { threadline?: { inboundIdLedger?: Record<string, unknown> } };
    expect(d.threadline?.inboundIdLedger).toEqual({ retentionDays: 14 });
    expect(DEV_GATED_FEATURES.some((f) => f.configPath === 'threadline.inboundIdLedger.enabled')).toBe(true);
  });
});
