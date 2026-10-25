/**
 * The signed-inbound labelling bullet reaches EXISTING agents (Migration
 * Parity): an agent whose CLAUDE.md already carries the ASP section — installed
 * before this bullet existed — would be skipped forever by the section-level
 * content sniff. A bullet-level marker closes that, idempotently.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  PostUpdateMigrator,
  AGENT_SIGNATURE_PROVENANCE_CLAUDEMD_SECTION,
  ASP_SIGNED_INBOUND_LABEL_MARKER,
  ASP_SIGNED_INBOUND_LABEL_BULLET,
} from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

function newMigrator(projectDir: string): PostUpdateMigrator {
  return new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
}
function run(m: PostUpdateMigrator): MigrationResult {
  const r: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (m as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(r);
  return r;
}

describe('PostUpdateMigrator — signed-inbound labelling bullet', () => {
  let projectDir: string; let claudeMd: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-asp-bullet-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMd = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-aspSignedInboundBullet.test.ts:cleanup' }));

  it('the generated section carries the bullet (new agents)', () => {
    expect(AGENT_SIGNATURE_PROVENANCE_CLAUDEMD_SECTION(4042)).toContain(ASP_SIGNED_INBOUND_LABEL_MARKER);
    expect(ASP_SIGNED_INBOUND_LABEL_BULLET).toContain("from agent <id> (signed) via <name>'s account");
    expect(ASP_SIGNED_INBOUND_LABEL_BULLET).toContain('NEVER binds that human');
  });

  it('inserts the bullet into a pre-existing section that lacks it, before the AUTHORITY BOUNDARY', () => {
    const old = AGENT_SIGNATURE_PROVENANCE_CLAUDEMD_SECTION(4042).replace(ASP_SIGNED_INBOUND_LABEL_BULLET + '\n', '');
    expect(old).not.toContain(ASP_SIGNED_INBOUND_LABEL_MARKER);
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + old);
    const r = run(newMigrator(projectDir));
    const after = fs.readFileSync(claudeMd, 'utf8');
    expect(r.upgraded.some((u) => u.includes('signed-inbound labelling bullet'))).toBe(true);
    expect(after.split(ASP_SIGNED_INBOUND_LABEL_MARKER).length - 1).toBe(1);
    expect(after.indexOf(ASP_SIGNED_INBOUND_LABEL_MARKER)).toBeLessThan(after.indexOf('**AUTHORITY BOUNDARY'));
    expect(after.split('### Agent-Signature Provenance').length - 1).toBe(1);
  });

  it('is idempotent', () => {
    fs.writeFileSync(claudeMd, '# CLAUDE.md\n' + AGENT_SIGNATURE_PROVENANCE_CLAUDEMD_SECTION(4042));
    run(newMigrator(projectDir));
    const once = fs.readFileSync(claudeMd, 'utf8');
    run(newMigrator(projectDir));
    expect(fs.readFileSync(claudeMd, 'utf8')).toBe(once);
    expect(once.split(ASP_SIGNED_INBOUND_LABEL_MARKER).length - 1).toBe(1);
  });
});
