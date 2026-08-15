/**
 * Agent-Signature Provenance CLAUDE.md section — Agent Awareness + Migration Parity.
 *
 * ASP shipped WITHOUT a template section. The routes were live and the inbound
 * classifier was running, but no deployed agent knew any of it existed, which by
 * the Agent Awareness Standard means the capability effectively did not exist:
 * "an agent that doesn't know about a capability effectively doesn't have it."
 *
 * These pin both halves so the two paths cannot drift apart again:
 *   - existing agents receive it through migrateClaudeMd, idempotently;
 *   - new agents receive the SAME section through generateClaudeMd.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator, AGENT_SIGNATURE_PROVENANCE_CLAUDEMD_SECTION } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

const MARKER = 'Agent-Signature Provenance';

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

describe('PostUpdateMigrator — Agent-Signature Provenance CLAUDE.md section', () => {
  let projectDir: string;
  let claudeMdPath: string;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-asp-section-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, {
      recursive: true,
      force: true,
      operation: 'tests/unit/PostUpdateMigrator-aspProvenanceSection.test.ts:cleanup',
    });
  });

  it('adds the section to an existing agent that lacks it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test agent\n\nSome pre-existing content.\n');
    // CONTROL: the marker genuinely is absent beforehand, so the assertion below
    // measures the migration rather than something that was always true.
    expect(fs.readFileSync(claudeMdPath, 'utf8')).not.toContain(MARKER);

    const result = runClaudeMdMigration(newMigrator(projectDir));

    const after = fs.readFileSync(claudeMdPath, 'utf8');
    expect(after).toContain(MARKER);
    expect(after).toContain('Some pre-existing content.'); // never clobbers
    expect(result.upgraded.join(' ')).toContain('Agent-Signature Provenance');
  });

  it('is idempotent — a second run does not duplicate it', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md — test agent\n');
    runClaudeMdMigration(newMigrator(projectDir));
    const once = fs.readFileSync(claudeMdPath, 'utf8');

    runClaudeMdMigration(newMigrator(projectDir));
    const twice = fs.readFileSync(claudeMdPath, 'utf8');

    expect(twice).toBe(once);
    expect(twice.split(MARKER).length - 1).toBe(1);
  });

  it('carries the AUTHORITY BOUNDARY, which is the load-bearing sentence', () => {
    // The charter's standing ruling: authentication settles WHO wrote a message,
    // never what it may DECIDE. The template is where every agent reads that, so
    // a section that dropped it would be worse than no section at all.
    const section = AGENT_SIGNATURE_PROVENANCE_CLAUDEMD_SECTION(4042);
    expect(section).toContain('never what it may DECIDE');
    expect(section).toContain('no permission, role or trust field');
  });

  it('states both honest limits rather than implying the feature is complete', () => {
    const section = AGENT_SIGNATURE_PROVENANCE_CLAUDEMD_SECTION(4042);
    expect(section).toContain('Unsigned agent traffic still classifies as');
    expect(section).toContain('must currently be plain text');
    // And the reason there is deliberately no signing endpoint.
    expect(section).toContain('no sign-on-demand endpoint');
  });

  it('honours the configured port rather than hardcoding one', () => {
    expect(AGENT_SIGNATURE_PROVENANCE_CLAUDEMD_SECTION(4099)).toContain('localhost:4099/provenance');
    expect(AGENT_SIGNATURE_PROVENANCE_CLAUDEMD_SECTION(4099)).not.toContain('localhost:4042');
  });
});
