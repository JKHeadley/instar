/**
 * Tier-1 — guard-posture effective-state derivation, inventory assembly,
 * projection allowlist (GUARD-POSTURE-ENDPOINT-SPEC §2.1/§2.2/§6).
 *
 * Every effective-state vocabulary edge from the normative precedence table
 * is pinned here; the spec's named regressions (enabled:true,lastTickAt:0 →
 * on-stale; off-runtime-divergent never folds into on-unverified) each have
 * a dedicated test.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGuardInventory,
  buildHeartbeatPostureBlock,
  deriveGuardRow,
  ROW_FIELD_ALLOWLIST,
  RUNTIME_FIELD_ALLOWLIST,
} from '../../../src/monitoring/guardPostureView.js';
import { GuardRegistry } from '../../../src/monitoring/GuardRegistry.js';
import {
  GUARD_MANIFEST,
  manifestByKey,
  type GuardManifestEntry,
} from '../../../src/monitoring/guardManifest.js';
import {
  extractGuardPosture,
  type ResolvedGuardConfigSnapshot,
} from '../../../src/monitoring/guardPosture.js';

const NOW = 1_781_300_000_000;

const reaperManifest = manifestByKey().get('monitoring.sessionReaper.enabled')!;

function derive(overrides: Partial<Parameters<typeof deriveGuardRow>[0]>) {
  return deriveGuardRow({
    key: 'monitoring.sessionReaper.enabled',
    manifest: reaperManifest,
    configEnabled: true,
    defaultEnabled: false,
    configDryRun: false,
    bootValue: true,
    bootSnapshotAvailable: true,
    runtime: { kind: 'ok', status: { enabled: true, lastTickAt: NOW - 10_000 } },
    now: NOW,
    ...overrides,
  });
}

describe('deriveGuardRow — the normative precedence table', () => {
  it('on-confirmed: config on + live runtime + fresh tick', () => {
    const row = derive({});
    expect(row.effective).toBe('on-confirmed');
    expect(row.offClass).toBeNull();
    expect(row.runtime?.stale).toBe(false);
  });

  it('on-stale: enabled:true with lastTickAt:0 (the Mini regression pin)', () => {
    const row = derive({ runtime: { kind: 'ok', status: { enabled: true, lastTickAt: 0 } } });
    expect(row.effective).toBe('on-stale');
  });

  it('on-stale: enabled with lastTickAt absent', () => {
    const row = derive({ runtime: { kind: 'ok', status: { enabled: true } } });
    expect(row.effective).toBe('on-stale');
  });

  it('on-stale: tick age beyond 5× declared cadence', () => {
    const row = derive({
      runtime: { kind: 'ok', status: { enabled: true, lastTickAt: NOW - 120_000 * 5 - 1_000 } },
    });
    expect(row.effective).toBe('on-stale');
    expect(row.runtime?.tickAgeMs).toBeGreaterThan(600_000);
  });

  it('staleness boundary: EXACTLY 5x cadence is NOT stale; one ms past is', () => {
    const atBoundary = derive({
      runtime: { kind: 'ok', status: { enabled: true, lastTickAt: NOW - 120_000 * 5 } },
    });
    expect(atBoundary.effective).toBe('on-confirmed');
    const pastBoundary = derive({
      runtime: { kind: 'ok', status: { enabled: true, lastTickAt: NOW - 120_000 * 5 - 1 } },
    });
    expect(pastBoundary.effective).toBe('on-stale');
  });

  it('runtime dryRun OVERRIDES config dryRun (nullish-coalescing precedence)', () => {
    const row = derive({
      configDryRun: true,
      runtime: { kind: 'ok', status: { enabled: true, dryRun: false, lastTickAt: NOW - 1_000 } },
    });
    expect(row.effective).toBe('on-confirmed'); // runtime says live; config dryRun loses
  });

  it('staleness does NOT apply to guards with no declared cadence', () => {
    const noTick: GuardManifestEntry = { ...reaperManifest, expectedTickMs: undefined };
    const row = derive({ manifest: noTick, runtime: { kind: 'ok', status: { enabled: true } } });
    expect(row.effective).toBe('on-confirmed');
  });

  it('on-dry-run wins over on-stale (precedence), with stale still visible in the runtime block', () => {
    const row = derive({
      runtime: { kind: 'ok', status: { enabled: true, dryRun: true, lastTickAt: 0 } },
    });
    expect(row.effective).toBe('on-dry-run');
    expect(row.runtime?.stale).toBe(true);
  });

  it('on-dry-run from config dryRun when runtime carries no dryRun field', () => {
    const row = derive({
      configDryRun: true,
      runtime: { kind: 'ok', status: { enabled: true, lastTickAt: NOW - 1_000 } },
    });
    expect(row.effective).toBe('on-dry-run');
  });

  it('on-unverified: config on, no runtime surface — NEVER green', () => {
    const notInstrumented: GuardManifestEntry = { ...reaperManifest, expectRuntime: false };
    const row = derive({ manifest: notInstrumented, runtime: { kind: 'unregistered' } });
    expect(row.effective).toBe('on-unverified');
    expect(row.runtimeReason).toBe('not-instrumented');
  });

  it('off with offClass dark-default (config == default == false)', () => {
    const row = derive({
      configEnabled: false,
      defaultEnabled: false,
      bootValue: false,
      runtime: { kind: 'unregistered' },
    });
    expect(row.effective).toBe('off');
    expect(row.offClass).toBe('dark-default');
  });

  it('off with offClass diverged-from-default (default on, currently off — the load-shed signature)', () => {
    const row = derive({
      configEnabled: false,
      defaultEnabled: true,
      bootValue: false,
      runtime: { kind: 'unregistered' },
    });
    expect(row.effective).toBe('off');
    expect(row.offClass).toBe('diverged-from-default');
  });

  it('diverged-pending-restart: disk differs from boot snapshot (both directions)', () => {
    const offNow = derive({ configEnabled: false, bootValue: true, runtime: { kind: 'unregistered' } });
    expect(offNow.effective).toBe('diverged-pending-restart');
    const onNow = derive({ configEnabled: true, bootValue: false, runtime: { kind: 'unregistered' } });
    expect(onNow.effective).toBe('diverged-pending-restart');
  });

  it('diverged-pending-restart is SUPPRESSED for liveConfig guards (the change is already live)', () => {
    const live: GuardManifestEntry = { ...reaperManifest, liveConfig: true };
    const row = derive({
      manifest: live,
      configEnabled: false,
      defaultEnabled: true,
      bootValue: true,
      runtime: { kind: 'unregistered' },
    });
    expect(row.effective).toBe('off');
    expect(row.divergence).toBe('none');
  });

  it('snapshot-unavailable: absent boot snapshot suppresses divergence AND flags it', () => {
    const row = derive({
      bootSnapshotAvailable: false,
      bootValue: undefined,
      configEnabled: true,
      runtime: { kind: 'ok', status: { enabled: true, lastTickAt: NOW - 1_000 } },
    });
    expect(row.divergence).toBe('snapshot-unavailable');
    expect(row.effective).toBe('on-confirmed');
  });

  it('older-inventory snapshot (key missing) degrades to snapshot-unavailable for that guard', () => {
    const row = derive({ bootSnapshotAvailable: true, bootValue: undefined });
    expect(row.divergence).toBe('snapshot-unavailable');
  });

  it('off-runtime-divergent: config on + disk matches boot + runtime self-reports off (Tier-1 pin)', () => {
    const row = derive({
      configEnabled: true,
      bootValue: true,
      runtime: { kind: 'ok', status: { enabled: false } },
    });
    expect(row.effective).toBe('off-runtime-divergent');
  });

  it('off-runtime-divergent still derives when the snapshot is unavailable (runtime contradiction is snapshot-independent)', () => {
    const row = derive({
      configEnabled: true,
      bootSnapshotAvailable: false,
      bootValue: undefined,
      runtime: { kind: 'ok', status: { enabled: false } },
    });
    expect(row.effective).toBe('off-runtime-divergent');
    expect(row.divergence).toBe('snapshot-unavailable'); // both facts visible at once
  });

  it('disk divergence outranks the runtime contradiction when BOTH present', () => {
    // disk now off, boot was on, runtime reports off: the disk edit explains
    // the runtime, diverged-pending-restart is the truthful state.
    const row = derive({
      configEnabled: false,
      bootValue: true,
      runtime: { kind: 'ok', status: { enabled: false } },
    });
    expect(row.effective).toBe('diverged-pending-restart');
  });

  it('errored: a throwing getter gets LOUDER, not quieter', () => {
    const row = derive({ runtime: { kind: 'error', message: 'boom' } });
    expect(row.effective).toBe('errored');
    expect(row.runtimeReason).toBe('status-error');
    expect(row.error).toBe('boom');
  });

  it('missing: expectRuntime + config on + nothing registered (reconciliation pin)', () => {
    const row = derive({ runtime: { kind: 'unregistered' } });
    expect(reaperManifest.expectRuntime).toBe(true);
    expect(row.effective).toBe('missing');
    expect(row.runtimeReason).toBe('not-registered');
  });

  it('missing does NOT apply when config is off (off wins by construction)', () => {
    const row = derive({
      configEnabled: false,
      defaultEnabled: true,
      bootValue: false,
      runtime: { kind: 'unregistered' },
    });
    expect(row.effective).toBe('off');
  });

  it('out-of-process (lifeline) guards are config-derived only — on-unverified at best', () => {
    const lifeline = manifestByKey().get('lifeline.driftPromoter.enabled')!;
    const row = deriveGuardRow({
      key: lifeline.key,
      manifest: lifeline,
      configEnabled: true,
      defaultEnabled: true,
      configDryRun: undefined,
      bootValue: undefined,
      bootSnapshotAvailable: true,
      runtime: { kind: 'unregistered' },
      now: NOW,
    });
    expect(row.effective).toBe('on-unverified');
    expect(row.runtimeReason).toBe('out-of-process');
    expect(row.runtime).toBeNull();
  });

  it('code-default guards report divergence not-applicable (honest scope line)', () => {
    const codeDefault = manifestByKey().get('messaging.attentionTopicGuard')!;
    const row = deriveGuardRow({
      key: codeDefault.key,
      manifest: codeDefault,
      configEnabled: undefined,
      defaultEnabled: undefined,
      configDryRun: undefined,
      bootValue: undefined,
      bootSnapshotAvailable: true,
      runtime: { kind: 'unregistered' },
      now: NOW,
    });
    expect(row.divergence).toBe('not-applicable');
    expect(row.configEnabled).toBe(true); // codeDefault value
    expect(row.effective).toBe('on-unverified');
  });
});

// ── Inventory assembly ──

function snapshotFixture(overrides?: {
  resolved?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
}): ResolvedGuardConfigSnapshot {
  return {
    resolved: overrides?.resolved ?? {
      monitoring: {
        sessionReaper: { enabled: true, dryRun: false },
        watchdog: { enabled: true },
        burnDetection: { enabled: true, alertTopicId: 4242 },
      },
      scheduler: { enabled: true },
    },
    defaults: overrides?.defaults ?? {
      monitoring: {
        sessionReaper: { enabled: false, dryRun: true },
        watchdog: { enabled: true },
      },
      scheduler: { enabled: true },
    },
    fileAbsent: false,
  };
}

describe('buildGuardInventory', () => {
  it('inventory = extractor ∪ manifest, deduped, sorted — endpoint inventory ⊇ tripwire inventory (single-funnel pin)', () => {
    const snapshot = snapshotFixture();
    const inv = buildGuardInventory({
      snapshot,
      bootSnapshot: null,
      registry: new GuardRegistry(),
      now: NOW,
    });
    const keys = new Set(inv.guards.map(g => g.key));
    // Every tripwire-extracted key appears…
    for (const key of Object.keys(extractGuardPosture(snapshot.resolved))) {
      expect(keys.has(key), `extractor key ${key} missing from inventory`).toBe(true);
    }
    // …and every declared manifest key appears.
    for (const entry of GUARD_MANIFEST) {
      expect(keys.has(entry.key), `manifest key ${entry.key} missing from inventory`).toBe(true);
    }
    // Deduped:
    expect(keys.size).toBe(inv.guards.length);
  });

  it('a guard ABSENT from the config file still appears with its default-resolved state', () => {
    // sessionReaper absent from resolved → manifest configPath finds nothing →
    // falls to defaults (enabled:false) → appears as off, never omitted.
    const inv = buildGuardInventory({
      snapshot: snapshotFixture({
        resolved: { monitoring: {}, scheduler: { enabled: true } },
      }),
      bootSnapshot: null,
      registry: new GuardRegistry(),
      now: NOW,
    });
    const reaper = inv.guards.find(g => g.key === 'monitoring.sessionReaper.enabled');
    expect(reaper).toBeDefined();
    expect(reaper!.effective).toBe('off');
  });

  it('summary counts every state and reports the runtimeEnriched floor', () => {
    const registry = new GuardRegistry();
    registry.register('monitoring.sessionReaper.enabled', () => ({ enabled: true, lastTickAt: NOW - 5_000 }));
    registry.register('scheduler.enabled', () => ({ enabled: true, lastTickAt: NOW - 5_000, jobCount: 3, pausedJobCount: 0 }));
    const inv = buildGuardInventory({
      snapshot: snapshotFixture(),
      bootSnapshot: { ts: new Date(NOW).toISOString(), posture: extractGuardPosture(snapshotFixture().resolved) },
      registry,
      now: NOW,
    });
    expect(inv.summary.onConfirmed).toBeGreaterThanOrEqual(2);
    const [n, total] = inv.summary.runtimeEnriched.split('/').map(Number);
    expect(n).toBeGreaterThanOrEqual(2);
    expect(total).toBe(inv.guards.length);
  });

  it('one snapshot in, no per-guard disk reads: assembly is pure over its inputs', () => {
    // Pure-function property: same inputs → same output, no fs access at all
    // (the module imports no fs). This pins the one-read-per-request rule at
    // the unit level; the route-level test pins the single readFileSync call.
    const snapshot = snapshotFixture();
    const a = buildGuardInventory({ snapshot, bootSnapshot: null, registry: new GuardRegistry(), now: NOW });
    const b = buildGuardInventory({ snapshot, bootSnapshot: null, registry: new GuardRegistry(), now: NOW });
    expect(a).toEqual(b);
  });
});

// ── Projection allowlist (the no-secrets guarantee, enforced not promised) ──

describe('strict output projection', () => {
  it('alertTopicId NEVER appears anywhere in the inventory output (leak pin)', () => {
    const registry = new GuardRegistry();
    // A malicious/naive getter trying to smuggle extra fields through:
    registry.register('monitoring.burnDetection.enabled', () =>
      ({ enabled: true, alertTopicId: 4242, secret: 'x' }) as never,
    );
    const inv = buildGuardInventory({
      snapshot: snapshotFixture(),
      bootSnapshot: null,
      registry,
      now: NOW,
    });
    expect(JSON.stringify(inv)).not.toContain('alertTopicId');
    expect(JSON.stringify(inv)).not.toContain('4242');
  });

  it('every row field and every runtime field is inside the closed allowlist', () => {
    const registry = new GuardRegistry();
    registry.register('monitoring.sessionReaper.enabled', () =>
      ({ enabled: true, lastTickAt: NOW - 1_000, dryRun: false, jobCount: 1, pausedJobCount: 0, extra: 'leak' }) as never,
    );
    const inv = buildGuardInventory({
      snapshot: snapshotFixture(),
      bootSnapshot: { ts: 'x', posture: {} },
      registry,
      now: NOW,
    });
    for (const row of inv.guards) {
      for (const field of Object.keys(row)) {
        expect(ROW_FIELD_ALLOWLIST.has(field), `row field '${field}' outside allowlist`).toBe(true);
      }
      if (row.runtime) {
        for (const field of Object.keys(row.runtime)) {
          expect(RUNTIME_FIELD_ALLOWLIST.has(field), `runtime field '${field}' outside allowlist`).toBe(true);
        }
      }
    }
  });
});

// ── Heartbeat compact block ──

describe('buildHeartbeatPostureBlock', () => {
  it('carries counts + ONLY the two key-carrying classes', () => {
    const registry = new GuardRegistry();
    registry.register('monitoring.watchdog.enabled', () => ({ enabled: false }));
    const snapshot = snapshotFixture({
      resolved: {
        monitoring: {
          sessionReaper: { enabled: false },     // default off → dark-default
          watchdog: { enabled: true },           // runtime says off → off-runtime-divergent
          activeWorkSilenceSentinel: { enabled: false }, // default on → diverged-from-default
        },
        scheduler: { enabled: true },
      },
      defaults: {
        monitoring: {
          sessionReaper: { enabled: false },
          watchdog: { enabled: true },
          activeWorkSilenceSentinel: { enabled: true },
        },
        scheduler: { enabled: true },
      },
    });
    const inv = buildGuardInventory({
      snapshot,
      bootSnapshot: { ts: 'x', posture: extractGuardPosture(snapshot.resolved) },
      registry,
      now: NOW,
    });
    const block = buildHeartbeatPostureBlock(inv, new Date(NOW).toISOString());
    expect(block.offDeviantKeys).toContain('monitoring.activeWorkSilenceSentinel.enabled');
    expect(block.offRuntimeDivergentKeys).toContain('monitoring.watchdog.enabled');
    expect(block.offDeviant).toBe(block.offDeviantKeys.length);
    expect(block.offRuntimeDivergent).toBe(block.offRuntimeDivergentKeys.length);
    expect(block.generatedAt).toBe(new Date(NOW).toISOString());
    // Compact: no per-guard rows ride the heartbeat.
    expect((block as Record<string, unknown>).guards).toBeUndefined();
  });
});
