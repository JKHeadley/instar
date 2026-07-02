/**
 * U4.2 — OwnershipReconciler integration points (docs/specs/u4-2-stale-owner-release.md).
 *
 * Locks the one-actor inversion (§2.7.6): the StaleOwnerReleaseEngine rides the
 * reconciler's tick and SUPERSEDES the legacy pin-based Case C force-claim; the
 * claim funnels through actStaleOwnerForceClaim with the EXTENDED nonce grammar
 * (§2.7.5). Also locks the §2.4 pin-suspension read (a claim suspends the pin
 * via the annotation — derived at read time; an operator re-pin with a fresher
 * HLC clears it: `operator-repin-clears-suspension`) and the named code fix
 * (LOCAL pins gain the online-gate: `deferred-target-offline`).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OwnershipReconciler } from '../../src/core/OwnershipReconciler.js';
import { SessionOwnershipRegistry, InMemorySessionOwnershipStore } from '../../src/core/SessionOwnershipRegistry.js';
import { TopicPlacementPinStore } from '../../src/core/TopicPlacementPinStore.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import type { StaleOwnerReleaseEngine } from '../../src/core/StaleOwnerReleaseEngine.js';
import type { HlcTimestamp } from '../../src/core/HybridLogicalClock.js';

const SELF = 'm_self';
const DEAD = 'm_dead';

function makeWorld(opts: {
  engineActive?: boolean;
  suspensions?: Map<number, { suspended: boolean; hlc: HlcTimestamp }>;
  pinTargetOnline?: boolean;
  pinTo?: string;
  owner?: string;
  pinHlc?: HlcTimestamp;
}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'own-recon-u42-'));
  const nonces = new Set<string>();
  const reg = new SessionOwnershipRegistry({
    store: new InMemorySessionOwnershipStore(),
    seenNonce: (k) => nonces.has(k),
    recordNonce: (k) => nonces.add(k),
  });
  const owner = opts.owner ?? DEAD;
  reg.cas({ type: 'place', machineId: owner }, { sessionKey: '700', sender: owner, nonce: 'p' });
  reg.cas({ type: 'claim', machineId: owner }, { sessionKey: '700', sender: owner, nonce: 'c' });
  const pinStore = new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') });
  // The optional HLC is the re-pin freshness knob (Fix #2 skew-proof stamp).
  pinStore.set('700', opts.pinTo ?? SELF, true, opts.pinHlc);
  const placements: string[] = [];
  const engineTicks: number[] = [];
  const fakeEngine = opts.engineActive === undefined ? null : ({
    isActive: () => opts.engineActive === true,
    tick: () => { engineTicks.push(1); },
  } as unknown as StaleOwnerReleaseEngine);
  const reconciler = new OwnershipReconciler({
    enabled: () => true,
    dryRun: () => false,
    selfMachineId: () => SELF,
    pinStore: () => new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') }),
    ownership: reg,
    machines: () => [
      { machineId: SELF, online: true, lastSeenMs: Date.now() },
      { machineId: DEAD, online: false, lastSeenMs: 1 },
      ...(opts.pinTargetOnline === false ? [] : []),
    ],
    isTopicBusy: () => false,
    emitPlacement: (_k, _r, reason) => placements.push(reason),
    debounceMs: 0,
    staleOwnerEngine: fakeEngine ? () => fakeEngine : undefined,
    claimSuspensions: opts.suspensions ? () => opts.suspensions! : undefined,
  });
  const cleanup = () => SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/OwnershipReconciler-staleOwnerRelease.test.ts' });
  return { reconciler, reg, placements, engineTicks, cleanup, pinStore };
}

describe('OwnershipReconciler × StaleOwnerReleaseEngine (one actor, §2.7.6)', () => {
  it('the engine SUPERSEDES the legacy pin-based Case C force-claim when active', () => {
    const w = makeWorld({ engineActive: true });
    try {
      const report = w.reconciler.tick();
      // Legacy Case C would have force-claimed (pin names ME, owner dead) — the
      // engine owns it now: deferred, and the engine pass ran on the same tick.
      expect(report.forceClaims).toBe(0);
      expect(report.deferredNoEvidence).toBeGreaterThan(0);
      expect(w.engineTicks.length).toBe(1);
      const explain = w.reconciler.explainTopic('700');
      expect(explain.decision).toBe('deferred-no-evidence');
      expect(explain.reason).toContain('stale-owner-release engine');
    } finally {
      w.cleanup();
    }
  });

  it('an INACTIVE engine leaves the legacy Case C behavior byte-for-byte (force-claim on evidence)', () => {
    const w = makeWorld({ engineActive: false });
    try {
      const report = w.reconciler.tick();
      expect(report.forceClaims).toBe(1);
      expect(w.reg.read('700')?.ownerMachineId).toBe(SELF);
    } finally {
      w.cleanup();
    }
  });

  it('the engine pass runs even when the pin-reconcile layer is DISABLED (independent gating)', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'own-recon-u42b-'));
    const engineTicks: number[] = [];
    const fakeEngine = { isActive: () => true, tick: () => engineTicks.push(1) } as unknown as StaleOwnerReleaseEngine;
    const nonces = new Set<string>();
    const reg = new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => nonces.has(k), recordNonce: (k) => nonces.add(k) });
    const r = new OwnershipReconciler({
      enabled: () => false, // ws13Reconcile dark
      dryRun: () => false,
      selfMachineId: () => SELF,
      pinStore: () => new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') }),
      ownership: reg,
      machines: () => [],
      isTopicBusy: () => false,
      emitPlacement: () => {},
      staleOwnerEngine: () => fakeEngine,
    });
    try {
      const report = r.tick();
      expect(report.skipped).toBe('disabled');
      expect(engineTicks.length).toBe(1); // the engine still got its pass
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/OwnershipReconciler-staleOwnerRelease.test.ts' });
    }
  });

  it('actStaleOwnerForceClaim lands the CAS with the EXTENDED nonce grammar (§2.7.5) + placement pairing', () => {
    const w = makeWorld({ engineActive: true });
    try {
      const ok = w.reconciler.actStaleOwnerForceClaim('700', 'm_dead-12345');
      expect(ok).toBe(true);
      const rec = w.reg.read('700');
      expect(rec?.ownerMachineId).toBe(SELF);
      // `${self}:stale-owner-release:${sessionKey}:${episodeId}:${now}`
      expect(rec?.nonce).toMatch(/^m_self:stale-owner-release:700:m_dead-12345:\d+$/);
      expect(w.placements).toEqual(['stale-owner-release']);
      // A repeat against the already-claimed record is refused (FSM: force-claim-self).
      expect(w.reconciler.actStaleOwnerForceClaim('700', 'm_dead-12345')).toBe(false);
    } finally {
      w.cleanup();
    }
  });
});

describe('OwnershipReconciler — §2.4 claim suspension (derived at read time)', () => {
  const hlc = (physical: number, node = 'm_claimer'): HlcTimestamp => ({ physical, logical: 0, node });

  it('claim-suspends-pin: a live suspension EXCLUDES the topic pin (no claim/transfer-back oscillation)', () => {
    // Pin (older HLC) vs suspension (newer): the pin is suspended → the
    // reconciler makes NO move for the topic (no transfer, no force-claim).
    const w = makeWorld({
      engineActive: false,
      pinHlc: hlc(1_000, SELF),
      suspensions: new Map([[700, { suspended: true, hlc: hlc(2_000) }]]),
    });
    try {
      const report = w.reconciler.tick();
      expect(report.forceClaims).toBe(0);
      expect(report.transfers).toBe(0);
      expect(w.reg.read('700')?.ownerMachineId).toBe(DEAD); // untouched
    } finally {
      w.cleanup();
    }
  });

  it('operator-repin-clears-suspension: a FRESHER pin HLC wins (the operator\'s newer statement)', () => {
    const w = makeWorld({
      engineActive: false,
      pinHlc: hlc(3_000, SELF), // re-pin AFTER the suspension
      suspensions: new Map([[700, { suspended: true, hlc: hlc(2_000) }]]),
    });
    try {
      const report = w.reconciler.tick();
      // The pin is live again → legacy Case C force-claims the dead owner's topic.
      expect(report.forceClaims).toBe(1);
      expect(w.reg.read('700')?.ownerMachineId).toBe(SELF);
    } finally {
      w.cleanup();
    }
  });
});

describe('OwnershipReconciler — the U4.2 named code fix (local-pin online-gate)', () => {
  it('deferred-target-offline: I own the topic, the pin names an OFFLINE machine → cooperative transfer deferred', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'own-recon-u42c-'));
    const nonces = new Set<string>();
    const reg = new SessionOwnershipRegistry({ store: new InMemorySessionOwnershipStore(), seenNonce: (k) => nonces.has(k), recordNonce: (k) => nonces.add(k) });
    reg.cas({ type: 'place', machineId: SELF }, { sessionKey: '700', sender: SELF, nonce: 'p' });
    reg.cas({ type: 'claim', machineId: SELF }, { sessionKey: '700', sender: SELF, nonce: 'c' });
    const pinStore = new TopicPlacementPinStore({ filePath: path.join(tmp, 'pins.json') });
    pinStore.set('700', 'm_offline_target');
    const r = new OwnershipReconciler({
      enabled: () => true,
      dryRun: () => false,
      selfMachineId: () => SELF,
      pinStore: () => pinStore,
      ownership: reg,
      machines: () => [
        { machineId: SELF, online: true, lastSeenMs: Date.now() },
        { machineId: 'm_offline_target', online: false, lastSeenMs: 1 },
      ],
      isTopicBusy: () => false,
      emitPlacement: () => {},
      debounceMs: 0,
    });
    try {
      const report = r.tick();
      expect(report.deferredTargetOffline).toBe(1);
      expect(report.transfers).toBe(0);
      expect(reg.read('700')?.status).toBe('active'); // never started a doomed transfer
      expect(r.explainTopic('700').decision).toBe('deferred-target-offline');
    } finally {
      SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/OwnershipReconciler-staleOwnerRelease.test.ts' });
    }
  });
});

describe('case-c-staleness-input-is-observer-stamped (R-r2-5a wiring ratchet)', () => {
  it("server.ts feeds the reconciler + engine routerReceivedAt, NEVER selfReportedLastSeen", () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/commands/server.ts'), 'utf-8');
    // The named prerequisite fix: the old self-reported feed is GONE from the
    // reconciler wiring…
    expect(src).not.toMatch(/lastSeenMs:\s*c\.selfReportedLastSeen/);
    expect(src).not.toMatch(/observerLastSeenMs:\s*c\.selfReportedLastSeen/);
    // …and the observer-stamped inputs are present for BOTH consumers.
    expect(src).toMatch(/lastSeenMs:\s*c\.routerReceivedAt/);
    expect(src).toMatch(/observerLastSeenMs:\s*c\.routerReceivedAt/);
  });
});

describe('forged-advert-set-from-non-owner-rejected (R-r2-5b provenance ratchet)', () => {
  it('the stale-owner advert seam reads the identity registry (PeerEndpointRecorder-fed), NEVER lastKnownUrl', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/commands/server.ts'), 'utf-8');
    const start = src.indexOf('_staleOwnerAdvertSet = (machineId)');
    expect(start).toBeGreaterThan(-1);
    // The whole advert-set closure (bounded window — the closure is ~20 lines).
    const block = src.slice(start, start + 1_600);
    // Provenance: endpoints recorded out of the signed lease RPC, bound to the
    // cryptographically-verified sender, read back per-peer from the identity
    // registry (getMachineEndpoints — the PeerEndpointRecorder write target)…
    expect(block).toMatch(/getMachineEndpoints\(machineId\)/);
    // …and the git-backed registry's lastKnownUrl — writable by ANY machine
    // with repo push — is NEVER consulted as disproof input: a forger must not
    // be able to shrink the advert set to a rope it controls and manufacture
    // "unreachable on every transport".
    expect(block).not.toMatch(/lastKnownUrl/);
  });
});

describe('stale-owner-return-tears-down (§2.3 — returned-owner-does-not-respawn-claimed-run)', () => {
  it('the closeout pin-conflict veto YIELDS to a live claim suspension (same comparison authority as effectivePins)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/commands/server.ts'), 'utf-8');
    const start = src.indexOf('topicPinnedHere: (topicId)');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, start + 1_200);
    // A pin SUSPENDED by a stale-owner claim is NOT "the reconciler bringing
    // the topic back" (effectivePins excludes it), so it must not veto the
    // returned owner's post-claim teardown — otherwise a claimed PINNED
    // topic's session would linger on the returned owner forever, vetoed by a
    // pin the reconciler itself no longer honors. The wiring consults the SAME
    // suspension view + comparison authority the reconciler uses.
    expect(block).toMatch(/_sorClaimSuspensionsRead/);
    expect(block).toMatch(/claimSuspensionExcludesPin/);
  });

  it('claimSuspensionExcludesPin is the shared authority inside OwnershipReconciler.applyClaimSuspensions (no forked comparison)', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../src/core/OwnershipReconciler.ts'), 'utf-8');
    expect(src).toMatch(/claimSuspensionExcludesPin\(/);
  });
});
