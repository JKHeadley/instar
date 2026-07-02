/**
 * Tier-1 — G3 dark-but-load-bearing classification
 * (g3-dark-but-load-bearing-guards §2.1/§2.2/§2.6).
 *
 * The three-state precedence (accepted → soaking-within-window → gap), the soak
 * lapse, the declaredLoadBearingAt lint fallback, the closed-projection six-field
 * allowlist, the summary/heartbeat key-lists, the caller-threaded accept map
 * (both functions stay PURE), and the two NEW manifest lints.
 */
import { describe, expect, it } from 'vitest';
import {
  buildGuardInventory,
  buildHeartbeatPostureBlock,
  deriveGuardRow,
  ROW_FIELD_ALLOWLIST,
} from '../../../src/monitoring/guardPostureView.js';
import { GuardRegistry } from '../../../src/monitoring/GuardRegistry.js';
import {
  GUARD_MANIFEST,
  manifestByKey,
  validateGuardManifest,
  type GuardManifestEntry,
} from '../../../src/monitoring/guardManifest.js';
import { extractGuardPosture, type ResolvedGuardConfigSnapshot } from '../../../src/monitoring/guardPosture.js';

const DECLARED = Date.parse('2026-07-01T00:00:00.000Z');
const DAY = 86_400_000;

// A synthetic load-bearing guard for precise control over the soak clause.
const LB_KEY = 'multiMachine.sessionPool.inboundQueue.enabled';
const lbManifest: GuardManifestEntry = {
  key: LB_KEY,
  kind: 'config',
  configPath: LB_KEY,
  defaultEnabled: false,
  dryRunConfigPath: 'multiMachine.sessionPool.inboundQueue.dryRun',
  expectedTickMs: 15_000,
  process: 'server',
  expectRuntime: false,
  component: 'QueueDrainLoop',
  description: 'test',
  loadBearing: true,
  criticalPath: 'operator inbound message delivery',
  soakWindowDays: 30,
  declaredLoadBearingAt: '2026-07-01',
};

const reaperManifest = manifestByKey().get('monitoring.sessionReaper.enabled')!;

function deriveLb(overrides: Partial<Parameters<typeof deriveGuardRow>[0]>) {
  return deriveGuardRow({
    key: LB_KEY,
    manifest: lbManifest,
    configEnabled: false,
    defaultEnabled: false,
    configDryRun: false,
    bootValue: false,
    bootSnapshotAvailable: true,
    runtime: { kind: 'unregistered' },
    now: DECLARED + 5 * DAY,
    ...overrides,
  });
}

describe('deriveGuardRow — G3 three-state classification', () => {
  it('loadBearing dark-default off, not accepted → loadBearingGap (loud)', () => {
    const row = deriveLb({});
    expect(row.effective).toBe('off');
    expect(row.offClass).toBe('dark-default');
    expect(row.loadBearing).toBe(true);
    expect(row.criticalPath).toBe('operator inbound message delivery');
    expect(row.loadBearingGap).toBe(true);
    expect(row.loadBearingSoaking).toBeUndefined();
    expect(row.loadBearingAccepted).toBeUndefined();
  });

  it('non-loadBearing dark-default off stays quiet (no load-bearing flags)', () => {
    const row = deriveGuardRow({
      key: 'monitoring.sessionReaper.enabled',
      manifest: reaperManifest,
      configEnabled: false,
      defaultEnabled: false,
      configDryRun: false,
      bootValue: false,
      bootSnapshotAvailable: true,
      runtime: { kind: 'unregistered' },
      now: DECLARED,
    });
    expect(row.effective).toBe('off');
    expect(row.offClass).toBe('dark-default');
    expect(row.loadBearing).toBeUndefined();
    expect(row.loadBearingGap).toBeUndefined();
    expect(row.criticalPath).toBeUndefined();
  });

  it('on-dry-run WITHIN the soak window → loadBearingSoaking (graduate arm), not gap', () => {
    const row = deriveLb({
      configEnabled: true,
      bootValue: true,
      configDryRun: true,
      runtime: { kind: 'ok', status: { enabled: true, dryRun: true, lastTickAt: DECLARED + 5 * DAY - 1_000 } },
      now: DECLARED + 10 * DAY,
    });
    expect(row.effective).toBe('on-dry-run');
    expect(row.loadBearingSoaking).toBe(true);
    expect(row.loadBearingGap).toBeUndefined();
    expect(row.criticalPath).toBe('operator inbound message delivery');
  });

  it('on-dry-run PAST the soak window → lapses to loadBearingGap (Close-the-Loop)', () => {
    const row = deriveLb({
      configEnabled: true,
      bootValue: true,
      configDryRun: true,
      runtime: { kind: 'ok', status: { enabled: true, dryRun: true, lastTickAt: DECLARED + 40 * DAY - 1_000 } },
      now: DECLARED + 40 * DAY,
    });
    expect(row.effective).toBe('on-dry-run');
    expect(row.loadBearingGap).toBe(true);
    expect(row.loadBearingSoaking).toBeUndefined();
  });

  it('soakWindowDays>0 with ABSENT declaredLoadBearingAt → falls to gap (safe/loud, never silently non-soaking)', () => {
    const noDeclared: GuardManifestEntry = { ...lbManifest, declaredLoadBearingAt: undefined };
    const row = deriveLb({
      manifest: noDeclared,
      configEnabled: true,
      bootValue: true,
      configDryRun: true,
      runtime: { kind: 'ok', status: { enabled: true, dryRun: true, lastTickAt: DECLARED } },
      now: DECLARED + 5 * DAY,
    });
    expect(row.loadBearingGap).toBe(true);
    expect(row.loadBearingSoaking).toBeUndefined();
  });

  it('soakWindowDays>0 with MALFORMED declaredLoadBearingAt → falls to gap', () => {
    const bad: GuardManifestEntry = { ...lbManifest, declaredLoadBearingAt: 'not-a-date' };
    const row = deriveLb({
      manifest: bad,
      configEnabled: true,
      bootValue: true,
      configDryRun: true,
      runtime: { kind: 'ok', status: { enabled: true, dryRun: true, lastTickAt: DECLARED } },
      now: DECLARED + 5 * DAY,
    });
    expect(row.loadBearingGap).toBe(true);
  });

  it('loadBearing on-confirmed → flag + criticalPath ONLY (no gap/soaking/accepted)', () => {
    const row = deriveLb({
      configEnabled: true,
      bootValue: true,
      configDryRun: false,
      runtime: { kind: 'ok', status: { enabled: true, lastTickAt: DECLARED + 5 * DAY - 1_000 } },
      now: DECLARED + 5 * DAY,
    });
    expect(row.effective).toBe('on-confirmed');
    expect(row.loadBearing).toBe(true);
    expect(row.criticalPath).toBe('operator inbound message delivery');
    expect(row.loadBearingGap).toBeUndefined();
    expect(row.loadBearingSoaking).toBeUndefined();
    expect(row.loadBearingAccepted).toBeUndefined();
  });

  it('operator-accept clears the gap → loadBearingAccepted + the reason on the VISIBLE row', () => {
    const row = deriveLb({
      acceptedFallback: { reason: 'inbound queue graduation deferred; deliberate', owner: 'justin', acceptedAt: '2026-07-01T12:00:00.000Z' },
    });
    expect(row.loadBearingAccepted).toBe(true);
    expect(row.acceptedFallbackReason).toBe('inbound queue graduation deferred; deliberate');
    expect(row.loadBearingGap).toBeUndefined();
    expect(row.loadBearingSoaking).toBeUndefined();
  });

  it('accept OUTRANKS soaking (precedence): accepted even for an in-window dry-run guard', () => {
    const row = deriveLb({
      configEnabled: true,
      bootValue: true,
      configDryRun: true,
      runtime: { kind: 'ok', status: { enabled: true, dryRun: true, lastTickAt: DECLARED } },
      now: DECLARED + 5 * DAY,
      acceptedFallback: { reason: 'owned', owner: 'justin', acceptedAt: '2026-07-01T00:00:00.000Z' },
    });
    expect(row.loadBearingAccepted).toBe(true);
    expect(row.loadBearingSoaking).toBeUndefined();
    expect(row.loadBearingGap).toBeUndefined();
  });

  it('criticalPath travels on off-runtime-divergent (+ missing / errored / on-stale) with NO loadBearingGap (no double-alarm)', () => {
    const offRuntime = deriveLb({
      configEnabled: true,
      bootValue: true,
      runtime: { kind: 'ok', status: { enabled: false } },
    });
    expect(offRuntime.effective).toBe('off-runtime-divergent');
    expect(offRuntime.criticalPath).toBe('operator inbound message delivery');
    expect(offRuntime.loadBearingGap).toBeUndefined();

    const withRuntime: GuardManifestEntry = { ...lbManifest, expectRuntime: true };
    const missing = deriveLb({ manifest: withRuntime, configEnabled: true, bootValue: true, runtime: { kind: 'unregistered' } });
    expect(missing.effective).toBe('missing');
    expect(missing.criticalPath).toBe('operator inbound message delivery');
    expect(missing.loadBearingGap).toBeUndefined();

    const errored = deriveLb({ configEnabled: true, bootValue: true, runtime: { kind: 'error', message: 'boom' } });
    expect(errored.effective).toBe('errored');
    expect(errored.criticalPath).toBe('operator inbound message delivery');
    expect(errored.loadBearingGap).toBeUndefined();

    const stale = deriveLb({
      configEnabled: true, bootValue: true, configDryRun: false,
      runtime: { kind: 'ok', status: { enabled: true, lastTickAt: 0 } },
    });
    expect(stale.effective).toBe('on-stale');
    expect(stale.criticalPath).toBe('operator inbound message delivery');
    expect(stale.loadBearingGap).toBeUndefined();
  });
});

// ── Projection allowlist: all SIX new fields named ──

describe('ROW_FIELD_ALLOWLIST — all six load-bearing fields (round-3 six-not-five)', () => {
  it('includes every one of the six by name', () => {
    for (const f of ['loadBearing', 'criticalPath', 'loadBearingGap', 'loadBearingSoaking', 'loadBearingAccepted', 'acceptedFallbackReason']) {
      expect(ROW_FIELD_ALLOWLIST.has(f), `allowlist missing '${f}'`).toBe(true);
    }
  });

  it('a fully-populated accepted row stays inside the closed allowlist over the real inventory', () => {
    const snapshot: ResolvedGuardConfigSnapshot = {
      resolved: { multiMachine: { sessionPool: { inboundQueue: { enabled: false } } }, scheduler: { enabled: true } },
      defaults: { scheduler: { enabled: true } },
      fileAbsent: false,
    };
    const inv = buildGuardInventory({
      snapshot,
      bootSnapshot: null,
      registry: new GuardRegistry(),
      now: DECLARED,
      acceptedFallbacks: { [LB_KEY]: { reason: 'owned', owner: 'justin', acceptedAt: '2026-07-01T00:00:00.000Z' } },
    });
    for (const row of inv.guards) {
      for (const field of Object.keys(row)) {
        expect(ROW_FIELD_ALLOWLIST.has(field), `row field '${field}' outside allowlist`).toBe(true);
      }
    }
    const accepted = inv.guards.find((g) => g.key === LB_KEY)!;
    expect(accepted.loadBearingAccepted).toBe(true);
    expect(accepted.acceptedFallbackReason).toBe('owned');
  });
});

// ── Summary + heartbeat key-lists ──

describe('buildGuardInventory + buildHeartbeatPostureBlock — load-bearing key-lists', () => {
  function invWith(accept?: Record<string, { reason: string; owner: string; acceptedAt: string }>) {
    const snapshot: ResolvedGuardConfigSnapshot = {
      // inboundQueue dark → gap (unless accepted); strandedTopicSentinel dark → gap.
      resolved: { multiMachine: { sessionPool: { inboundQueue: { enabled: false } } }, monitoring: { strandedTopicSentinel: { enabled: false } }, scheduler: { enabled: true } },
      defaults: { scheduler: { enabled: true } },
      fileAbsent: false,
    };
    return buildGuardInventory({ snapshot, bootSnapshot: null, registry: new GuardRegistry(), now: DECLARED, acceptedFallbacks: accept });
  }

  it('summary.loadBearingGapKeys lists the loud, silent-and-past-grace subset', () => {
    const inv = invWith();
    expect(inv.summary.loadBearingGapKeys).toContain(LB_KEY);
    expect(inv.summary.loadBearingGapKeys).toContain('monitoring.strandedTopicSentinel.enabled');
    expect(inv.summary.loadBearingAcceptedKeys).toEqual([]);
  });

  it('an accepted guard moves from Gap-keys to Accepted-keys', () => {
    const inv = invWith({ [LB_KEY]: { reason: 'owned', owner: 'justin', acceptedAt: '2026-07-01T00:00:00.000Z' } });
    expect(inv.summary.loadBearingGapKeys).not.toContain(LB_KEY);
    expect(inv.summary.loadBearingAcceptedKeys).toContain(LB_KEY);
  });

  it('the heartbeat block carries the three key-lists', () => {
    const hb = buildHeartbeatPostureBlock(invWith(), '2026-07-01T00:00:00.000Z');
    expect(hb.loadBearingGapKeys).toContain(LB_KEY);
    expect(hb.loadBearingSoakingKeys).toEqual([]);
    expect(hb.loadBearingAcceptedKeys).toEqual([]);
  });
});

// ── Purity: the caller threads the accept map; neither function does I/O ──

describe('purity — accept map threaded by the caller (no fs in either function)', () => {
  it('same inputs → same output; the accept map changes the output deterministically', () => {
    const snapshot: ResolvedGuardConfigSnapshot = {
      resolved: { multiMachine: { sessionPool: { inboundQueue: { enabled: false } } }, scheduler: { enabled: true } },
      defaults: { scheduler: { enabled: true } },
      fileAbsent: false,
    };
    const a = buildGuardInventory({ snapshot, bootSnapshot: null, registry: new GuardRegistry(), now: DECLARED });
    const b = buildGuardInventory({ snapshot, bootSnapshot: null, registry: new GuardRegistry(), now: DECLARED });
    expect(a).toEqual(b);
    // Threading an accept flips the classification purely (no disk touched).
    const accepted = buildGuardInventory({
      snapshot, bootSnapshot: null, registry: new GuardRegistry(), now: DECLARED,
      acceptedFallbacks: { [LB_KEY]: { reason: 'owned', owner: 'justin', acceptedAt: '2026-07-01T00:00:00.000Z' } },
    });
    expect(accepted.guards.find((g) => g.key === LB_KEY)!.loadBearingAccepted).toBe(true);
    expect(a.guards.find((g) => g.key === LB_KEY)!.loadBearingGap).toBe(true);
  });
});

// ── The two NEW manifest lints ──

describe('validateGuardManifest — the two G3 manifest lints', () => {
  it('the REAL GUARD_MANIFEST is well-formed (zero violations)', () => {
    expect(validateGuardManifest(GUARD_MANIFEST)).toEqual([]);
  });

  it('the curated load-bearing set is non-empty and each entry carries a criticalPath + soak window', () => {
    const lb = GUARD_MANIFEST.filter((e) => e.loadBearing);
    expect(lb.length).toBeGreaterThanOrEqual(1);
    for (const e of lb) {
      expect(e.criticalPath && e.criticalPath.trim().length).toBeGreaterThan(0);
      expect(typeof e.soakWindowDays).toBe('number');
      expect(Number.isNaN(Date.parse(e.declaredLoadBearingAt!))).toBe(false);
    }
  });

  it('loadBearing without criticalPath is a violation', () => {
    const bad: GuardManifestEntry = { ...lbManifest, criticalPath: undefined };
    const v = validateGuardManifest([bad]);
    expect(v.some((s) => s.includes('criticalPath is missing'))).toBe(true);
  });

  it('soakWindowDays>0 without declaredLoadBearingAt is a violation', () => {
    const bad: GuardManifestEntry = { ...lbManifest, declaredLoadBearingAt: undefined };
    const v = validateGuardManifest([bad]);
    expect(v.some((s) => s.includes('declaredLoadBearingAt is missing'))).toBe(true);
  });

  it('a malformed declaredLoadBearingAt is a violation', () => {
    const bad: GuardManifestEntry = { ...lbManifest, declaredLoadBearingAt: 'yesterday' };
    const v = validateGuardManifest([bad]);
    expect(v.some((s) => s.includes('not a valid ISO date'))).toBe(true);
  });
});
