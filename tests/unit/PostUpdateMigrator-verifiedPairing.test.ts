/**
 * Tier-1 migration-parity tests for Secure A2A Verified Pairing (spec §5).
 *
 * Migration Parity Standard: an existing agent MUST receive the new feature's
 * config defaults + CLAUDE.md awareness on update — idempotently, without clobbering
 * an operator's explicit value, and without forcing-dark a dev agent.
 *
 *  - Config backfill (via ConfigDefaults applyDefaults, the canonical existence-check
 *    add): `threadline.verifiedPairing.{dryRun:true, credentialShareEnforced:false}`
 *    and `multiMachine.stateSync.threadlinePairing.{enabled:false, dryRun:true}` are
 *    added when missing. CRUCIALLY `threadline.verifiedPairing.enabled` is NOT written
 *    (it rides the developmentAgent gate — a literal `false` would force-dark dev
 *    agents, the PR #1001 anti-pattern, mirroring singleNegotiator). An operator's
 *    existing values are preserved. Idempotent.
 *  - CLAUDE.md parity: the awareness section is in the NEW-agent template
 *    (generateClaudeMd) AND content-sniffed in migrateClaudeMd (existing agents),
 *    added exactly once.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function runClaudeMdMigration(projectDir: string): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('Verified-Pairing config backfill (Migration Parity §5, via ConfigDefaults)', () => {
  it('adds verifiedPairing.{dryRun,credentialShareEnforced} when MISSING, but NOT enabled (dev-gate)', () => {
    const config: Record<string, unknown> = { authToken: 'x', threadline: { relayEnabled: false } };
    const { patched } = applyDefaults(config, getMigrationDefaults('standalone'));
    expect(patched).toBe(true);
    const vp = (config.threadline as Record<string, unknown>).verifiedPairing as Record<string, unknown>;
    expect(vp).toBeDefined();
    expect(vp.dryRun).toBe(true);
    expect(vp.credentialShareEnforced).toBe(false);
    // `enabled` must NOT be written — it rides the developmentAgent gate (a literal
    // false would force-dark a dev agent, the PR #1001 anti-pattern).
    expect('enabled' in vp).toBe(false);
  });

  it('adds multiMachine.stateSync.threadlinePairing.{enabled:false,dryRun:true} when MISSING', () => {
    const config: Record<string, unknown> = { authToken: 'x' };
    applyDefaults(config, getMigrationDefaults('standalone'));
    const mm = config.multiMachine as Record<string, unknown>;
    const ss = mm.stateSync as Record<string, unknown>;
    const tp = ss.threadlinePairing as Record<string, unknown>;
    expect(tp).toBeDefined();
    // This is a CREDENTIAL-GATING replicated store — ships fully DARK with an
    // EXPLICIT enabled:false + dryRun:true on EVERY agent (unlike the WS2 stores).
    expect(tp.enabled).toBe(false);
    expect(tp.dryRun).toBe(true);
  });

  it("NEVER overwrites an operator's explicit verifiedPairing values (add-missing only)", () => {
    const config: Record<string, unknown> = {
      authToken: 'x',
      threadline: { verifiedPairing: { enabled: true, dryRun: false, credentialShareEnforced: true } },
    };
    applyDefaults(config, getMigrationDefaults('standalone'));
    const vp = (config.threadline as Record<string, unknown>).verifiedPairing as Record<string, unknown>;
    expect(vp.enabled).toBe(true);            // operator's fleet-flip preserved
    expect(vp.dryRun).toBe(false);            // operator's value preserved
    expect(vp.credentialShareEnforced).toBe(true);
  });

  it('is IDEMPOTENT — a second applyDefaults pass adds nothing new for verifiedPairing', () => {
    const config: Record<string, unknown> = { authToken: 'x' };
    applyDefaults(config, getMigrationDefaults('standalone'));
    const snapshot = JSON.parse(JSON.stringify((config.threadline as Record<string, unknown>).verifiedPairing));
    const { changes } = applyDefaults(config, getMigrationDefaults('standalone'));
    expect(changes.some((c) => c.includes('verifiedPairing'))).toBe(false);
    expect((config.threadline as Record<string, unknown>).verifiedPairing).toEqual(snapshot);
  });
});

describe('CLAUDE.md awareness parity (Agent Awareness Standard) — Verified Pairing', () => {
  const md = generateClaudeMd('test', 'TestAgent', 4042, false);

  it('the NEW-agent template names the verified-pairing capability + its dark flag', () => {
    expect(md).toContain('Verified Pairing — is my channel to a peer mutually verified');
    expect(md).toContain('threadline.verifiedPairing.enabled');
  });

  it('the template names the read route, the pairing MCP tool, and the credential rule', () => {
    expect(md).toContain('/threadline/pairing');
    expect(md).toContain('threadline_pair');
    expect(md).toMatch(/never send a peer a secret until/i);
  });
});

describe('migrateClaudeMd — Verified Pairing awareness reaches EXISTING agents (Migration Parity)', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-vp-md-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-verifiedPairing.test.ts:md-cleanup' });
  });

  it('adds the Verified-Pairing section to an existing CLAUDE.md', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(projectDir);
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('Verified Pairing'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Verified Pairing — is my channel to a peer mutually verified');
    expect(after).toContain('threadline_pair');
    expect(after).toContain('threadline.verifiedPairing.enabled');
  });

  it('is idempotent — a second run skips, content unchanged + not duplicated', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(projectDir);
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const second = runClaudeMdMigration(projectDir);
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some((u) => u.includes('Verified Pairing'))).toBe(false);
    expect(afterSecond.match(/Verified Pairing — is my channel to a peer mutually verified/g)!.length).toBe(1);
  });
});
