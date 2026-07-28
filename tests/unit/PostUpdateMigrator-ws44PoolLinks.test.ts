/**
 * Tier-1 migration-parity tests for WS4.4 (MULTI-MACHINE-SEAMLESSNESS-SPEC
 * §WS4.4). Migration Parity Standard: an existing agent MUST receive the new
 * dark flag on update, idempotently, without its behavior changing and without
 * clobbering an operator's explicit value.
 *
 *  - migrateConfigWs44PoolLinks(): dev-gate existence-check on
 *    multiMachine.seamlessness.ws44PoolLinks. It STRIPS a default-shaped literal
 *    `false` (the PR #1001 force-dark anti-pattern) so resolveDevAgentGate decides
 *    live; NO-OPs when the key is absent (the gate already decides) and never
 *    strips an operator's explicit `true`. Idempotent.
 *  - generateClaudeMd() / migrateClaudeMd parity: the WS4.4 awareness section is
 *    in the NEW-agent template (so init agents get it) AND content-sniffed in the
 *    migrator (so existing agents get it once, idempotently).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateConfigWs44PoolLinks, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function runClaudeMdMigration(projectDir: string): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('migrateConfigWs44PoolLinks — dev-gate existence-check (Migration Parity)', () => {
  it('NO-OP when the flag is absent — the dev-gate already decides (omit ⇒ dev-live/fleet-dark)', () => {
    const config: Record<string, unknown> = { authToken: 'x' };
    expect(migrateConfigWs44PoolLinks(config)).toBe(false);
    expect(config).toEqual({ authToken: 'x' }); // untouched
  });

  it('NO-OP when multiMachine exists but has no seamlessness block', () => {
    const config: Record<string, unknown> = { multiMachine: { enabled: false } };
    expect(migrateConfigWs44PoolLinks(config)).toBe(false);
    expect(config).toEqual({ multiMachine: { enabled: false } });
  });

  it('STRIPS a default-shaped literal false so the dev-gate resolves live (PR #1001 anti-pattern fix)', () => {
    const config: Record<string, unknown> = { multiMachine: { seamlessness: { ws44PoolLinks: false } } };
    expect(migrateConfigWs44PoolLinks(config)).toBe(true);
    // The whole emptied seamlessness block is tidied away.
    expect((config.multiMachine as any).seamlessness).toBeUndefined();
  });

  it('preserves sibling seamlessness fields when stripping the force-dark false', () => {
    const config: Record<string, unknown> = {
      multiMachine: { enabled: true, seamlessness: { ws44PoolLinks: false, ws44LoadShedLoadPerCore: 2.0 } },
    };
    expect(migrateConfigWs44PoolLinks(config)).toBe(true);
    const mm = config.multiMachine as any;
    expect(mm.enabled).toBe(true);
    expect(mm.seamlessness.ws44LoadShedLoadPerCore).toBe(2.0); // sibling kept
    expect('ws44PoolLinks' in mm.seamlessness).toBe(false); // force-dark stripped
  });

  it('NEVER strips an operator\'s explicit TRUE (the fleet-flip wins)', () => {
    const config: Record<string, unknown> = { multiMachine: { seamlessness: { ws44PoolLinks: true } } };
    expect(migrateConfigWs44PoolLinks(config)).toBe(false);
    expect((config.multiMachine as any).seamlessness.ws44PoolLinks).toBe(true);
  });

  it('is IDEMPOTENT — after stripping, a second run is a no-op', () => {
    const config: Record<string, unknown> = { multiMachine: { seamlessness: { ws44PoolLinks: false } } };
    expect(migrateConfigWs44PoolLinks(config)).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(config));
    expect(migrateConfigWs44PoolLinks(config)).toBe(false);
    expect(config).toEqual(snapshot);
  });
});

describe('CLAUDE.md awareness parity (Agent Awareness Standard)', () => {
  // generateClaudeMd(projectName, agentName, port, hasTelegram, ...)
  const md = generateClaudeMd('test', 'TestAgent', 4042, false);

  it('the NEW-agent template names WS4.4 links-that-survive-machine-boundaries', () => {
    expect(md).toContain('Links that survive machine boundaries (WS4.4');
    expect(md).toContain('multiMachine.seamlessness.ws44PoolLinks');
  });

  it('the template states the security posture (holder authorizes, raw PIN never crosses, offline=honest)', () => {
    expect(md).toMatch(/DUMB RELAY|dumb relay/);
    expect(md).toMatch(/NEVER substitutes|never substitutes/);
    expect(md).toMatch(/temporarily unavailable/i);
  });
});

describe('migrateClaudeMd — WS4.4 awareness section reaches EXISTING agents (Migration Parity)', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ws44-md-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-ws44PoolLinks.test.ts:md-cleanup' });
  });

  it('adds the WS4.4 section to an existing CLAUDE.md', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(projectDir);
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some(u => u.includes('WS4.4'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Links that survive machine boundaries (WS4.4');
    expect(after).toContain('DUMB RELAY');
    expect(after).toContain('NOT the raw PIN');
    expect(after).toContain('temporarily unavailable');
  });

  it('is idempotent — a second run skips, content unchanged + not duplicated', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(projectDir);
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const second = runClaudeMdMigration(projectDir);
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some(u => u.includes('WS4.4'))).toBe(false);
    expect(afterSecond.match(/Links that survive machine boundaries \(WS4\.4/g)!.length).toBe(1);
  });
});
