/**
 * DEV-AGENT-DARK-GATE-TEETH (CMT-1438) — full rollout pipeline integration test.
 *
 * Proves the reclassification ACTUALLY changes dev behavior end-to-end, exercising
 * the real update path a deployed agent runs: PostUpdateMigrator.migrateDevGateTeethStrip
 * → applyDefaults (add-missing) → resolveDevAgentGate. The single most important
 * assertion (spec §Testing E2E): an EXISTING dev agent whose persisted config still
 * carries the stale `enabled: false` resolves the 4 reclassified features LIVE *after
 * migration* — proving the change works for deployed agents, not just new ones (the
 * cartographer trap). Plus the fleet-stays-dark side, the fresh-agent path, and the
 * releaseReadiness two-switch drift guard.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { applyDefaults, getMigrationDefaults } from '../../src/config/ConfigDefaults.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import { getConfigByPath } from '../../src/core/devGatedFeatures.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../..');

const GATED_PATHS = [
  'monitoring.parallelWorkSentinel.enabled',
  'monitoring.failureLearning.enabled',
  'monitoring.releaseReadiness.enabled',
  'monitoring.bootHealthBeacon.enabled',
];

type MigrationResult = { upgraded: string[]; skipped: string[]; errors: string[] };

describe('dev-gate teeth — full rollout pipeline (migration → defaults → resolver)', () => {
  let stateDir: string;

  function writeConfig(cfg: Record<string, unknown>): void {
    fs.writeFileSync(path.join(stateDir, 'config.json'), JSON.stringify(cfg, null, 2));
  }
  function readConfig(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf-8'));
  }
  function migrateThenApplyDefaults(): Record<string, unknown> {
    const result: MigrationResult = { upgraded: [], skipped: [], errors: [] };
    const migrator = new PostUpdateMigrator({
      projectDir: stateDir, stateDir, port: 4042, hasTelegram: false, projectName: 'test',
    });
    (migrator as unknown as { migrateDevGateTeethStrip(r: MigrationResult): void })
      .migrateDevGateTeethStrip(result);
    // The deployed update path then runs applyDefaults (add-missing) over the config.
    const cfg = readConfig();
    applyDefaults(cfg, getMigrationDefaults('standalone'));
    return cfg;
  }
  function resolves(cfg: Record<string, unknown>, p: string): boolean {
    return resolveDevAgentGate(
      getConfigByPath(cfg, p) as boolean | undefined,
      cfg as { developmentAgent?: boolean },
    );
  }

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'devgate-teeth-rollout-'));
  });
  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, { recursive: true, force: true, operation: 'tests/integration/dev-gate-teeth-rollout.test.ts' });
  });

  it('THE MOST IMPORTANT TEST — an existing dev agent with stale persisted `enabled: false` resolves all 4 LIVE after the migration runs', () => {
    // The cartographer trap: applyDefaults is add-missing-only, so without the
    // migration the stale `false` survives and the feature stays dark on the very
    // agent meant to dogfood it. This asserts the migration actually frees them.
    writeConfig({
      developmentAgent: true,
      monitoring: {
        parallelWorkSentinel: { enabled: false },
        failureLearning: { enabled: false },
        releaseReadiness: { enabled: false },
        bootHealthBeacon: { enabled: false },
      },
    });
    const cfg = migrateThenApplyDefaults();
    for (const p of GATED_PATHS) {
      expect(resolves(cfg, p), `${p} must be LIVE on the dev agent after migration`).toBe(true);
    }
  });

  it('a fleet agent with the same stale `false` stays DARK (migration is a no-op off-dev)', () => {
    writeConfig({
      developmentAgent: false,
      monitoring: {
        parallelWorkSentinel: { enabled: false },
        failureLearning: { enabled: false },
        releaseReadiness: { enabled: false },
        bootHealthBeacon: { enabled: false },
      },
    });
    const cfg = migrateThenApplyDefaults();
    for (const p of GATED_PATHS) {
      expect(resolves(cfg, p), `${p} must stay DARK on the fleet`).toBe(false);
    }
  });

  it('a fresh dev agent (no persisted block) resolves all 4 LIVE via the omitted-default path', () => {
    writeConfig({ developmentAgent: true });
    const cfg = migrateThenApplyDefaults();
    // applyDefaults injects the default blocks with `enabled` OMITTED → gate yields live.
    for (const p of GATED_PATHS) {
      expect(getConfigByPath(cfg, p), `${p} default must omit enabled`).toBeUndefined();
      expect(resolves(cfg, p), `${p} must be LIVE on a fresh dev agent`).toBe(true);
    }
  });

  it('a fresh fleet agent resolves all 4 DARK', () => {
    writeConfig({ developmentAgent: false });
    const cfg = migrateThenApplyDefaults();
    for (const p of GATED_PATHS) {
      expect(resolves(cfg, p), `${p} must be DARK on a fresh fleet agent`).toBe(false);
    }
  });

  it('two-switch drift guard: the shipped release-readiness-check job default is `enabled: false`', () => {
    // releaseReadiness is classified DEV_GATED only because its SEND capability is
    // gated behind this SEPARATE job, which must ship dark. If a future change flips
    // this default on, dev-gating releaseReadiness would silently make it a sender —
    // this assertion fails loudly and forces the classification to be re-reviewed.
    const tmpl = fs.readFileSync(
      path.join(ROOT, 'src/scaffold/templates/jobs/instar/release-readiness-check.md'),
      'utf-8',
    );
    expect(/^enabled:\s*false\s*$/m.test(tmpl)).toBe(true);
  });
});
