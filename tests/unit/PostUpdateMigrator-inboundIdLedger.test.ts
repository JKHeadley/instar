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
