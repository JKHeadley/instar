/**
 * Tests for the unified ConfigDefaults system.
 *
 * These tests structurally enforce that init and migration stay in sync.
 * If a test here fails, it means a new config field was added to one path
 * but not the other — exactly the bug this system prevents.
 */

import { describe, it, expect } from 'vitest';
import { getInitDefaults, getMigrationDefaults, applyDefaults } from '../../src/config/ConfigDefaults.js';

describe('ConfigDefaults', () => {
  describe('getInitDefaults', () => {
    it('returns defaults for managed-project', () => {
      const defaults = getInitDefaults('managed-project');
      expect(defaults.monitoring).toBeDefined();
      expect((defaults.monitoring as any).promptGate.enabled).toBe(true);
      expect((defaults.monitoring as any).quotaTracking).toBe(false);
    });

    it('default-enables the session watchdog (compaction-idle detection requires it)', () => {
      // The compaction-resume infra is load-bearing on the watchdog poller.
      // If this regresses, sessions that compact via Telegram/Slack go silent.
      for (const t of ['managed-project', 'standalone'] as const) {
        const defaults = getInitDefaults(t);
        expect((defaults.monitoring as any).watchdog?.enabled).toBe(true);
      }
      const mig = getMigrationDefaults('managed-project');
      expect((mig.monitoring as any).watchdog?.enabled).toBe(true);
    });

    it('returns defaults for standalone', () => {
      const defaults = getInitDefaults('standalone');
      expect((defaults.monitoring as any).quotaTracking).toBe(true);
    });

    it('ships SessionReaper OFF + dry-run by default (the only kill-on-heuristic monitor)', () => {
      for (const t of ['managed-project', 'standalone'] as const) {
        const sr = (getInitDefaults(t).monitoring as any).sessionReaper;
        expect(sr).toBeDefined();
        expect(sr.enabled).toBe(false);
        expect(sr.dryRun).toBe(true);
        expect(sr.normalTierReaps).toBe(false);
        expect(sr.protectOpenCommitments).toBe(true);
      }
      // Migration parity: existing agents receive the (off) block on update.
      const mig = getMigrationDefaults('managed-project');
      expect((mig.monitoring as any).sessionReaper?.enabled).toBe(false);
    });

    it('migrates the sessionReaper block into a config that lacks it (existence-checked)', () => {
      const config: any = { monitoring: { watchdog: { enabled: true } } };
      const { patched, changes } = applyDefaults(config, getMigrationDefaults('managed-project'));
      expect(patched).toBe(true);
      expect(config.monitoring.sessionReaper.enabled).toBe(false);
      expect(changes.some((c: string) => c.includes('sessionReaper'))).toBe(true);
    });

    it('does NOT overwrite an operator-enabled sessionReaper on migration', () => {
      const config: any = { monitoring: { sessionReaper: { enabled: true, dryRun: false } } };
      applyDefaults(config, getMigrationDefaults('managed-project'));
      expect(config.monitoring.sessionReaper.enabled).toBe(true);
      expect(config.monitoring.sessionReaper.dryRun).toBe(false);
    });

    it('ships apprenticeshipCycleSla OFF by default and migrates it add-missing', () => {
      for (const t of ['managed-project', 'standalone'] as const) {
        const sla = (getInitDefaults(t).monitoring as any).apprenticeshipCycleSla;
        expect(sla).toBeDefined();
        expect(sla.enabled).toBe(false);
        expect(sla.overdueAfterMinutes).toBe(120);
      }

      const config: any = { monitoring: {} };
      const { patched, changes } = applyDefaults(config, getMigrationDefaults('managed-project'));
      expect(patched).toBe(true);
      expect(config.monitoring.apprenticeshipCycleSla.enabled).toBe(false);
      expect(config.monitoring.apprenticeshipCycleSla.overdueAfterMinutes).toBe(120);
      expect(changes.some((c: string) => c.includes('apprenticeshipCycleSla'))).toBe(true);

      const enabled: any = {
        monitoring: { apprenticeshipCycleSla: { enabled: true, overdueAfterMinutes: 30 } },
      };
      applyDefaults(enabled, getMigrationDefaults('managed-project'));
      expect(enabled.monitoring.apprenticeshipCycleSla.enabled).toBe(true);
      expect(enabled.monitoring.apprenticeshipCycleSla.overdueAfterMinutes).toBe(30);
    });

    // ── Multi-Machine Session Pool dark defaults (Track A — migration parity) ──
    it('ships multiMachine.sessionPool DARK by default (enabled:false, stage:dark, dryRun:true)', () => {
      for (const t of ['managed-project', 'standalone'] as const) {
        const sp = ((getInitDefaults(t).multiMachine as any) ?? {}).sessionPool;
        expect(sp).toBeDefined();
        expect(sp.enabled).toBe(false);
        expect(sp.stage).toBe('dark');
        expect(sp.dryRun).toBe(true);
        // Clock-skew knobs present + honor the §L2 startup invariant.
        expect(sp.clockSkewToleranceMs).toBe(300000);
        expect(sp.maxExpectedNtpDriftMs).toBe(250);
        expect(sp.clockSkewToleranceMs).toBeGreaterThanOrEqual(sp.maxExpectedNtpDriftMs * 2);
      }
      const mig = (getMigrationDefaults('managed-project').multiMachine as any).sessionPool;
      expect(mig.enabled).toBe(false);
      expect(mig.stage).toBe('dark');
    });

    it('ships threadline.a2aCheckIn (A2A Coherence Layer 4) DARK by default + migrates it', () => {
      for (const t of ['managed-project', 'standalone'] as const) {
        const c = ((getInitDefaults(t).threadline as any) ?? {}).a2aCheckIn;
        expect(c).toBeDefined();
        expect(c.enabled).toBe(false);
        expect(c.heartbeatEnabled).toBe(false);
        expect(c.heartbeatIntervalMs).toBe(420000);
      }
      // Migration backfills it on existing agents (Migration Parity).
      const mig = (getMigrationDefaults('managed-project').threadline as any).a2aCheckIn;
      expect(mig.enabled).toBe(false);
      expect(mig.heartbeatIntervalMs).toBe(420000);
    });

    it('NEVER sets multiMachine.enabled — the sessionPool block must not switch multi-machine on', () => {
      for (const t of ['managed-project', 'standalone'] as const) {
        const mm = getInitDefaults(t).multiMachine as any;
        // sessionPool exists, but enabled is not asserted by the defaults block.
        expect(mm.sessionPool).toBeDefined();
        expect(mm.enabled).toBeUndefined();
      }
    });

    it('migrates sessionPool into an EXISTING multiMachine block without clobbering its fields', () => {
      const config: any = { multiMachine: { enabled: true, leaseTtlMs: 60000 } };
      const { patched, changes } = applyDefaults(config, getMigrationDefaults('managed-project'));
      expect(patched).toBe(true);
      // Existing multiMachine fields are preserved...
      expect(config.multiMachine.enabled).toBe(true);
      expect(config.multiMachine.leaseTtlMs).toBe(60000);
      // ...and the dark sessionPool sub-block is added.
      expect(config.multiMachine.sessionPool.enabled).toBe(false);
      expect(config.multiMachine.sessionPool.stage).toBe('dark');
      expect(changes.some((c: string) => c.includes('sessionPool'))).toBe(true);
    });

    it('migrates mentor.autonomousFix (dark) into an EXISTING mentor block on update (parity)', () => {
      // An agent that already had the mentor block (pre-autonomous-fix) must
      // receive the new dark autonomousFix sub-block on update — so the "just be
      // Echo" loop is discoverable + opt-in, never silently absent.
      const config: any = { mentor: { enabled: false, mode: 'off', menteeFramework: 'codex-cli' } };
      const { patched } = applyDefaults(config, getMigrationDefaults('managed-project'));
      expect(patched).toBe(true);
      expect(config.mentor.menteeFramework).toBe('codex-cli'); // existing field preserved
      expect(config.mentor.autonomousFix.enabled).toBe(false); // ships dark
      expect(config.mentor.autonomousFix.model).toBe('opus'); // Justin's constraint
    });

    it('does NOT overwrite an operator-enabled mentor.autonomousFix on re-migration (idempotent)', () => {
      const config: any = { mentor: { enabled: true, autonomousFix: { enabled: true, model: 'opus' } } };
      const { changes } = applyDefaults(config, getMigrationDefaults('managed-project'));
      expect(config.mentor.autonomousFix.enabled).toBe(true); // operator choice kept
      expect(changes.some((c: string) => c.includes('autonomousFix.enabled'))).toBe(false);
    });

    it('migrates an inert multiMachine:{sessionPool} into a config with NO multiMachine block (does not enable it)', () => {
      const config: any = { monitoring: {} };
      applyDefaults(config, getMigrationDefaults('managed-project'));
      expect(config.multiMachine.sessionPool.stage).toBe('dark');
      expect(config.multiMachine.enabled).toBeUndefined(); // not switched on
    });

    it('is idempotent + does NOT overwrite an operator-advanced sessionPool stage', () => {
      const config: any = { multiMachine: { sessionPool: { enabled: true, stage: 'shadow', dryRun: false } } };
      const { changes } = applyDefaults(config, getMigrationDefaults('managed-project'));
      expect(config.multiMachine.sessionPool.enabled).toBe(true);
      expect(config.multiMachine.sessionPool.stage).toBe('shadow');
      expect(config.multiMachine.sessionPool.dryRun).toBe(false);
      expect(changes.some((c: string) => c.includes('sessionPool.stage'))).toBe(false);
    });

    it('backfills the Track-E deliverMessage/placement tunables into a partial sessionPool block (add-missing)', () => {
      const config: any = { multiMachine: { sessionPool: { enabled: true, stage: 'shadow' } } };
      applyDefaults(config, getMigrationDefaults('managed-project'));
      // Operator fields preserved...
      expect(config.multiMachine.sessionPool.stage).toBe('shadow');
      // ...and the new §L4 tunables are added with their safe defaults.
      expect(config.multiMachine.sessionPool.deliverMessageTimeoutMs).toBe(5000);
      expect(config.multiMachine.sessionPool.deliverMessageMaxRetries).toBe(3);
      expect(config.multiMachine.sessionPool.placementHysteresisDelta).toBe(0.15);
      expect(config.multiMachine.sessionPool.ownershipCasMaxRetries).toBe(5);
      // §L5 transfer tunables also backfill.
      expect(config.multiMachine.sessionPool.transferDrainTimeoutMs).toBe(30000);
      expect(config.multiMachine.sessionPool.transferOutputCutoffMs).toBe(1000);
      expect(config.multiMachine.sessionPool.placementCooldownMs).toBe(300000);
      expect(config.multiMachine.sessionPool.topicPlacementUpdateMinIntervalMs).toBe(10000);
    });

    it('includes externalOperations', () => {
      const defaults = getInitDefaults('managed-project');
      expect(defaults.externalOperations).toBeDefined();
      expect((defaults.externalOperations as any).trust.floor).toBe('collaborative');
    });

    it('includes threadline', () => {
      const defaults = getInitDefaults('managed-project');
      expect(defaults.threadline).toBeDefined();
      expect((defaults.threadline as any).relayEnabled).toBe(false);
    });

    it('default-enables the scheduler for new agents (autonomy continuity)', () => {
      // Regression for codex-instar audit Item 5: agents shipping without
      // an explicit scheduler.enabled lost org-intent drift audits,
      // threadline sync, post-update self-healing — anything that runs on
      // the scheduler. New agents must get enabled:true by default.
      for (const t of ['managed-project', 'standalone'] as const) {
        const defaults = getInitDefaults(t);
        expect((defaults.scheduler as any)?.enabled).toBe(true);
      }
      const mig = getMigrationDefaults('managed-project');
      expect((mig.scheduler as any)?.enabled).toBe(true);
    });

    it('backfills scheduler.enabled into existing scheduler blocks that lack it', () => {
      const config: Record<string, unknown> = {
        scheduler: { maxParallelJobs: 4, jobsFile: '/some/path/jobs.json' },
      };
      const defaults = getMigrationDefaults('managed-project');
      const { patched, changes } = applyDefaults(config, defaults);

      expect(patched).toBe(true);
      expect((config.scheduler as any).enabled).toBe(true);
      expect((config.scheduler as any).maxParallelJobs).toBe(4);
      expect((config.scheduler as any).jobsFile).toBe('/some/path/jobs.json');
      expect(changes.some(c => c === 'scheduler.enabled (added)')).toBe(true);
    });

    it('does NOT override an explicit scheduler.enabled=false (operator choice wins)', () => {
      // An operator who explicitly disabled the scheduler must keep their
      // setting on update. applyDefaults only adds MISSING keys; never
      // overrides. Tests this contract for the scheduler field specifically
      // because the audit explicitly raised it.
      const config: Record<string, unknown> = {
        scheduler: { enabled: false, maxParallelJobs: 2 },
      };
      const defaults = getMigrationDefaults('managed-project');
      applyDefaults(config, defaults);

      expect((config.scheduler as any).enabled).toBe(false);
      expect((config.scheduler as any).maxParallelJobs).toBe(2);
    });
  });

  describe('getMigrationDefaults', () => {
    it('uses conservative trust settings', () => {
      const defaults = getMigrationDefaults('managed-project');
      expect((defaults.externalOperations as any).trust.floor).toBe('supervised');
      expect((defaults.externalOperations as any).trust.autoElevateEnabled).toBe(false);
    });

    it('still includes promptGate', () => {
      const defaults = getMigrationDefaults('managed-project');
      expect((defaults.monitoring as any).promptGate.enabled).toBe(true);
    });
  });

  describe('applyDefaults', () => {
    it('adds missing keys', () => {
      const config: Record<string, unknown> = {};
      const defaults = getInitDefaults('managed-project');
      const { patched, changes } = applyDefaults(config, defaults);

      expect(patched).toBe(true);
      expect(changes.length).toBeGreaterThan(0);
      expect((config.monitoring as any).promptGate.enabled).toBe(true);
    });

    it('never overwrites existing values', () => {
      const config: Record<string, unknown> = {
        monitoring: { promptGate: { enabled: false } },
      };
      const defaults = getInitDefaults('managed-project');
      applyDefaults(config, defaults);

      expect((config.monitoring as any).promptGate.enabled).toBe(false);
    });

    it('is idempotent', () => {
      const config: Record<string, unknown> = {};
      const defaults = getInitDefaults('standalone');
      const first = applyDefaults(config, defaults);
      const second = applyDefaults(config, defaults);

      expect(first.patched).toBe(true);
      expect(second.patched).toBe(false);
      expect(second.changes).toHaveLength(0);
    });

    it('respects _instar_noMigrate for top-level keys', () => {
      const config: Record<string, unknown> = {
        _instar_noMigrate: ['externalOperations', 'threadline'],
      };
      const defaults = getInitDefaults('managed-project');
      const { skipped } = applyDefaults(config, defaults);

      // externalOperations and threadline should be skipped
      expect(skipped.some(s => s.includes('externalOperations'))).toBe(true);
      expect(skipped.some(s => s.includes('threadline'))).toBe(true);
      // But monitoring should still be added
      expect(config.monitoring).toBeDefined();
      expect((config.monitoring as any).promptGate.enabled).toBe(true);
    });

    it('treats arrays as opaque leaves', () => {
      const config: Record<string, unknown> = {
        threadline: { capabilities: ['chat', 'voice'] },
      };
      const defaults = getInitDefaults('managed-project');
      applyDefaults(config, defaults);

      // Should NOT merge/concatenate — should leave existing array alone
      expect((config.threadline as any).capabilities).toEqual(['chat', 'voice']);
    });

    it('handles type mismatches gracefully', () => {
      const config: Record<string, unknown> = {
        monitoring: true, // boolean instead of object — should not crash
      };
      const defaults = getInitDefaults('managed-project');

      // Should not throw
      expect(() => applyDefaults(config, defaults)).not.toThrow();
      // Should not overwrite the boolean
      expect(config.monitoring).toBe(true);
    });

    it('adds nested keys to existing objects', () => {
      const config: Record<string, unknown> = {
        monitoring: { quotaTracking: true },
      };
      const defaults = getInitDefaults('managed-project');
      applyDefaults(config, defaults);

      // Should add promptGate inside existing monitoring object
      expect((config.monitoring as any).promptGate).toBeDefined();
      expect((config.monitoring as any).promptGate.enabled).toBe(true);
      // Should NOT overwrite existing quotaTracking
      expect((config.monitoring as any).quotaTracking).toBe(true);
    });
  });

  describe('init/migration equivalence', () => {
    it('migration defaults cover all init default keys', () => {
      const initDefaults = getInitDefaults('managed-project');
      const migrationDefaults = getMigrationDefaults('managed-project');

      // Every top-level key in init should exist in migration
      for (const key of Object.keys(initDefaults)) {
        expect(migrationDefaults).toHaveProperty(key);
      }
    });

    it('migration defaults cover standalone init keys', () => {
      const initDefaults = getInitDefaults('standalone');
      const migrationDefaults = getMigrationDefaults('standalone');

      for (const key of Object.keys(initDefaults)) {
        expect(migrationDefaults).toHaveProperty(key);
      }
    });
  });
});
