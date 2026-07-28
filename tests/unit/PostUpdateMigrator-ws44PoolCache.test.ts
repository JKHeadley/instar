/**
 * Tier-1 migration-parity tests for WS4.4(f) global pool-cache unification
 * (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.4 clause (f); CMT-1416). Migration Parity
 * Standard: an existing agent MUST receive the new dark flag on update,
 * idempotently, without its behavior changing and without clobbering an operator's
 * explicit value.
 *
 *  - migrateConfigWs44PoolCache(): dev-gate existence-check on
 *    multiMachine.seamlessness.ws44PoolCache. It STRIPS a default-shaped literal
 *    `false` (the PR #1001 force-dark anti-pattern) so resolveDevAgentGate decides
 *    live; NO-OPs when the key is absent (the gate already decides) and never
 *    strips an operator's explicit `true`. Idempotent.
 *  - generateClaudeMd() / migrateClaudeMd parity: the WS4.4(f) awareness section is
 *    in the NEW-agent template (so init agents get it) AND content-sniffed in the
 *    migrator (so existing agents get it once, idempotently).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { migrateConfigWs44PoolCache, PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { generateClaudeMd } from '../../src/scaffold/templates.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };
function runClaudeMdMigration(projectDir: string): MigrationResult {
  const migrator = new PostUpdateMigrator({ projectDir, stateDir: path.join(projectDir, '.instar'), port: 4042, hasTelegram: false, projectName: 'test' });
  const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
  (migrator as unknown as { migrateClaudeMd(r: MigrationResult): void }).migrateClaudeMd(result);
  return result;
}

describe('migrateConfigWs44PoolCache — dev-gate existence-check (Migration Parity)', () => {
  it('NO-OP when the flag is absent — the dev-gate already decides (omit ⇒ dev-live/fleet-dark)', () => {
    const config: Record<string, unknown> = { authToken: 'x' };
    expect(migrateConfigWs44PoolCache(config)).toBe(false);
    expect(config).toEqual({ authToken: 'x' }); // untouched
  });

  it('NO-OP when multiMachine exists but has no seamlessness block', () => {
    const config: Record<string, unknown> = { multiMachine: { enabled: false } };
    expect(migrateConfigWs44PoolCache(config)).toBe(false);
    expect(config).toEqual({ multiMachine: { enabled: false } });
  });

  it('STRIPS a default-shaped literal false so the dev-gate resolves live (PR #1001 anti-pattern fix)', () => {
    const config: Record<string, unknown> = { multiMachine: { seamlessness: { ws44PoolCache: false } } };
    expect(migrateConfigWs44PoolCache(config)).toBe(true);
    // The whole emptied seamlessness block is tidied away.
    expect((config.multiMachine as Record<string, unknown>).seamlessness).toBeUndefined();
  });

  it('preserves sibling seamlessness fields when stripping the force-dark false', () => {
    const config: Record<string, unknown> = {
      multiMachine: { enabled: true, seamlessness: { ws44PoolCache: false, ws44PoolCacheTtlMs: 5000 } },
    };
    expect(migrateConfigWs44PoolCache(config)).toBe(true);
    const mm = config.multiMachine as Record<string, Record<string, unknown>>;
    expect((config.multiMachine as Record<string, unknown>).enabled).toBe(true);
    expect(mm.seamlessness.ws44PoolCacheTtlMs).toBe(5000); // sibling kept
    expect('ws44PoolCache' in mm.seamlessness).toBe(false); // force-dark stripped
  });

  it("NEVER strips an operator's explicit TRUE (the fleet-flip wins)", () => {
    const config: Record<string, unknown> = { multiMachine: { seamlessness: { ws44PoolCache: true } } };
    expect(migrateConfigWs44PoolCache(config)).toBe(false);
    expect((config.multiMachine as Record<string, Record<string, unknown>>).seamlessness.ws44PoolCache).toBe(true);
  });

  it('is IDEMPOTENT — after stripping, a second run is a no-op', () => {
    const config: Record<string, unknown> = { multiMachine: { seamlessness: { ws44PoolCache: false } } };
    expect(migrateConfigWs44PoolCache(config)).toBe(true);
    const snapshot = JSON.parse(JSON.stringify(config));
    expect(migrateConfigWs44PoolCache(config)).toBe(false);
    expect(config).toEqual(snapshot);
  });
});

describe('CLAUDE.md awareness parity (Agent Awareness Standard) — WS4.4(f)', () => {
  const md = generateClaudeMd('test', 'TestAgent', 4042, false);

  it('the NEW-agent template names the WS4.4(f) shared pool-cache + its dark flag', () => {
    expect(md).toContain('Shared pool-cache (WS4.4(f)');
    expect(md).toContain('multiMachine.seamlessness.ws44PoolCache');
  });

  it('the template names the observability route + the honest load-shed staleness', () => {
    expect(md).toContain('/pool/poll-cache');
    expect(md).toMatch(/stale: true|load-shed/i);
  });
});

describe('migrateClaudeMd — WS4.4(f) awareness section reaches EXISTING agents (Migration Parity)', () => {
  let projectDir: string;
  let claudeMdPath: string;
  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-ws44f-md-'));
    fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
    claudeMdPath = path.join(projectDir, 'CLAUDE.md');
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-ws44PoolCache.test.ts:md-cleanup' });
  });

  it('adds the WS4.4(f) section to an existing CLAUDE.md', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    const result = runClaudeMdMigration(projectDir);
    expect(result.errors).toEqual([]);
    expect(result.upgraded.some((u) => u.includes('WS4.4(f)'))).toBe(true);
    const after = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(after).toContain('Shared pool-cache (WS4.4(f)');
    expect(after).toContain('/pool/poll-cache');
    expect(after).toContain('multiMachine.seamlessness.ws44PoolCache');
  });

  it('is idempotent — a second run skips, content unchanged + not duplicated', () => {
    fs.writeFileSync(claudeMdPath, '# CLAUDE.md\n\nMy existing CLAUDE.md.\n');
    runClaudeMdMigration(projectDir);
    const afterFirst = fs.readFileSync(claudeMdPath, 'utf-8');
    const second = runClaudeMdMigration(projectDir);
    const afterSecond = fs.readFileSync(claudeMdPath, 'utf-8');
    expect(afterSecond).toBe(afterFirst);
    expect(second.upgraded.some((u) => u.includes('WS4.4(f)'))).toBe(false);
    expect(afterSecond.match(/Shared pool-cache \(WS4\.4\(f\)/g)!.length).toBe(1);
  });
});
