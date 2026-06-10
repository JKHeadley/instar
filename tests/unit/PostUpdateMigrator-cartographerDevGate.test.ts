/**
 * Verifies PostUpdateMigrator.migrateCartographerDevGate — the one-shot,
 * dev-agent-only migration that strips a DEFAULT-SHAPED `cartographer.enabled:
 * false` and `cartographer.conformanceAudit.enabled: false` from an EXISTING dev
 * agent's config so the developmentAgent gate resolves the zero-cost cartographer
 * read surfaces LIVE (DEV-AGENT-DARK-GATE-ENFORCEMENT, Migration Parity).
 *
 * Covers both sides of every boundary: dev-agent strip, fleet-agent no-op,
 * NEVER-touches freshnessSweep.enabled (the cost-bearing surface), idempotency via
 * the _instar_migrations run-once marker (so a re-added operator `false` is never
 * re-stripped), no-config skip, and corrupt-config error with bytes preserved.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('PostUpdateMigrator — cartographer dev-gate strip', () => {
  let projectDir: string;
  let stateDir: string;

  function configPath(): string {
    return path.join(stateDir, 'config.json');
  }

  function writeConfig(cfg: Record<string, unknown>): void {
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  }

  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath(), 'utf-8'));
  }

  function runMigration(): MigrationResult {
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    const migrator = new PostUpdateMigrator({
      projectDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test',
    });
    (migrator as unknown as { migrateCartographerDevGate(r: MigrationResult): void })
      .migrateCartographerDevGate(result);
    return result;
  }

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'carto-mig-'));
    stateDir = projectDir; // migrator reads config.json at stateDir/config.json
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(projectDir, { recursive: true, force: true, operation: 'tests/unit/PostUpdateMigrator-cartographerDevGate.test.ts' });
  });

  it('dev agent: strips the two default-shaped `false`s and records upgraded', () => {
    writeConfig({
      developmentAgent: true,
      cartographer: {
        enabled: false,
        conformanceAudit: { enabled: false },
        freshnessSweep: { enabled: false },
      },
    });
    const result = runMigration();
    const cfg = readConfig();
    const cart = cfg.cartographer as Record<string, any>;
    expect(cart.enabled).toBeUndefined();
    expect(cart.conformanceAudit.enabled).toBeUndefined();
    // NEVER touch the cost-bearing surface.
    expect(cart.freshnessSweep.enabled).toBe(false);
    expect(result.upgraded.some((u) => u.includes('cartographer-dev-gate'))).toBe(true);
  });

  it('fleet agent: no-op (the dark default is correct for the fleet)', () => {
    writeConfig({
      cartographer: { enabled: false, conformanceAudit: { enabled: false } },
    });
    const result = runMigration();
    const cfg = readConfig();
    const cart = cfg.cartographer as Record<string, any>;
    expect(cart.enabled).toBe(false);
    expect(cart.conformanceAudit.enabled).toBe(false);
    expect(result.upgraded.length).toBe(0);
    expect(result.skipped.some((s) => s.includes('not a development agent'))).toBe(true);
    // The marker is NOT set, so a later promotion to dev agent can still strip once.
    expect((cfg._instar_migrations as string[] | undefined) ?? []).not.toContainEqual(
      expect.stringContaining('cartographer-dev-gate-strip'),
    );
  });

  it('NEVER strips an EXPLICIT operator value that is not exactly false', () => {
    // An operator who set enabled:true keeps it; the migration only strips false.
    writeConfig({
      developmentAgent: true,
      cartographer: { enabled: true, conformanceAudit: { enabled: true } },
    });
    runMigration();
    const cart = readConfig().cartographer as Record<string, any>;
    expect(cart.enabled).toBe(true);
    expect(cart.conformanceAudit.enabled).toBe(true);
  });

  it('idempotent: a re-added operator `false` is NOT re-stripped after the marker is set', () => {
    writeConfig({
      developmentAgent: true,
      cartographer: { enabled: false, conformanceAudit: { enabled: false } },
    });
    runMigration(); // first run strips + sets marker
    // Operator deliberately re-adds false later.
    const cfg = readConfig();
    (cfg.cartographer as Record<string, any>).enabled = false;
    writeConfig(cfg);
    const result2 = runMigration();
    const cart = readConfig().cartographer as Record<string, any>;
    // The run-once marker means the deliberate `false` is preserved.
    expect(cart.enabled).toBe(false);
    expect(result2.skipped.some((s) => s.includes('already migrated'))).toBe(true);
  });

  it('no config.json: skips cleanly without error', () => {
    const result = runMigration();
    expect(result.errors.length).toBe(0);
    expect(result.skipped.some((s) => s.includes('config.json not found'))).toBe(true);
  });

  it('corrupt config.json: reports an error and preserves bytes', () => {
    fs.writeFileSync(configPath(), '{ not valid json');
    const result = runMigration();
    expect(result.errors.length).toBeGreaterThanOrEqual(1);
    expect(fs.readFileSync(configPath(), 'utf-8')).toBe('{ not valid json');
  });
});
