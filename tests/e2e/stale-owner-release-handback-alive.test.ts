/**
 * Tier-3 "feature is alive" E2E — U4.2 stale-owner release + U4.4 lease
 * hand-back through the REAL AgentServer stack (auth middleware, error
 * handling, route ctx threading).
 *
 * Proves: (1) GET /pool/stale-owner-release answers 200 — NOT 503 because the
 * engine wasn't wired — and its counters advance as the engine runs a real
 * dry-run episode (owner darkened → would-claim); (2) GET /pool/lease-handback
 * is alive with the reconciler ticking a synthetic preferred-unhealthy→healthy
 * transition (dry-run counters advance — the spec §6 E2E lifecycle case);
 * (3) the operator latch write/clear levers work end-to-end (PIN-gated clear);
 * (4) dark → the stale-owner route answers 503, zero presence.
 *
 * Like its siblings (pool-reconciler-alive-lifecycle), it wires AgentServer
 * directly; server.ts's construction ordering is asserted by the
 * `case-c-staleness-input-is-observer-stamped` wiring ratchet.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AgentServer } from '../../src/server/AgentServer.js';
import { StateManager } from '../../src/core/StateManager.js';
import { SessionManager } from '../../src/core/SessionManager.js';
import { StaleOwnerReleaseEngine, DEFAULT_STALE_OWNER_RELEASE_CONFIG } from '../../src/core/StaleOwnerReleaseEngine.js';
import { LeaseHandbackReconciler, DEFAULT_LEASE_HANDBACK_CONFIG } from '../../src/core/LeaseHandbackReconciler.js';
import { setRopeHealthProvider } from '../../src/core/ropeHealth.js';
import { writeHandbackLatch, readHandbackLatchRecord, clearHandbackLatch, readHandbackLatchUntilMs } from '../../src/core/handbackLatch.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { SessionOwnershipRecord } from '../../src/core/SessionOwnership.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('E2E: U4.2 stale-owner release + U4.4 lease hand-back are ALIVE through the real AgentServer', () => {
  const PORT = 47317;
  const TOKEN = 'e2e-u4-token';
  const PIN = '135790';
  const SELF = 'm_self';
  const OWNER = 'm_owner';
  const PREFERRED = 'm_captain';
  const base = `http://127.0.0.1:${PORT}`;
  const auth = { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' };

  let dir: string;
  let server: AgentServer;
  let engine: StaleOwnerReleaseEngine;
  let handback: LeaseHandbackReconciler;
  let engineActive = true;
  // Synthetic clocks + world state the two components observe.
  let wall = 1_000_000;
  let mono = 100_000;
  let preferredHealthy = false;

  beforeAll(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'u4-alive-e2e-'));
    const record: SessionOwnershipRecord = {
      sessionKey: '700', ownerMachineId: OWNER, ownershipEpoch: 2, status: 'active',
      nonce: 'n', timestamp: 1_000, updatedAt: new Date(1_000).toISOString(),
    };
    engine = new StaleOwnerReleaseEngine({
      enabled: () => engineActive,
      dryRun: () => true, // graduated-rollout posture: the E2E drives the dry-run canary
      config: () => ({ enabled: engineActive, ...DEFAULT_STALE_OWNER_RELEASE_CONFIG }),
      selfMachineId: () => SELF,
      machines: () => [
        { machineId: SELF, online: true, observerLastSeenMs: wall },
        { machineId: 'm_third', online: true, observerLastSeenMs: wall },
        { machineId: OWNER, online: false, observerLastSeenMs: 1 },
      ],
      holdsLease: () => true,
      listOwnershipRecords: () => [record],
      durableLastKnownHeartbeatMs: () => 1,
      advertSet: () => ({ endpoints: [{ kind: 'lan', url: 'http://x' }, { kind: 'ts', url: 'http://y' }], fresh: true }),
      probeEndpoint: async () => false,
      selfConnectivityProof: async () => true,
      hasDurableLeaseAuthority: () => true,
      evidenceMirror: () => ({ lastSyncOkMs: wall - 500, lastOwnerSideEffectMs: () => wall - 10 * 60_000 }),
      claimAnnotations: () => new Map(),
      actForceClaim: () => true,
      emitClaimAnnotation: () => {},
      pullWorkingSet: () => {},
      trace: () => {},
      raiseAttention: () => {},
      now: () => wall,
      monotonicNow: () => mono,
    });

    // U4.4: register a synthetic rope-health provider through the REAL seam
    // (the spec §6 E2E case: reconciler ticking a preferred-unhealthy→healthy
    // transition; enabled + dryRun — would-hand-back counters advance).
    setRopeHealthProvider({ reachableOnAnyRope: (m) => (m === PREFERRED ? (preferredHealthy ? true : undefined) : undefined) });
    const { ropeReachableOnAnyRope } = await import('../../src/core/ropeHealth.js');
    handback = new LeaseHandbackReconciler({
      config: () => ({ ...DEFAULT_LEASE_HANDBACK_CONFIG, enabled: true, dryRun: true }),
      selfMachineId: () => SELF,
      preferredAwakeMachineId: () => PREFERRED,
      holdsLease: () => true,
      currentEpoch: () => 5,
      preferredHealth: (m) => ({
        heartbeatFresh: preferredHealthy,
        ropeReachable: ropeReachableOnAnyRope(m),
        leaseEligible: true,
        quotaOk: true,
      }),
      cleanBoundary: () => ({ inFlightForwards: false, queuedInbound: 0, msSinceLastIngress: null }),
      kickInboundDrain: () => {},
      splitBrainActive: () => false,
      churnLatched: () => false,
      recordChurnFlip: () => {},
      operatorLatchUntilMs: () => readHandbackLatchUntilMs(dir),
      mintConsentToken: () => null,
      sendOffer: async () => 'timeout',
      metric: () => {},
      notify: () => {},
      now: () => wall,
      monotonicNow: () => mono,
    });

    const config = {
      projectName: 'u4-alive-e2e',
      projectDir: dir,
      stateDir: dir,
      port: PORT,
      authToken: TOKEN,
      dashboardPin: PIN,
    } as unknown as InstarConfig;

    server = new AgentServer({
      config,
      sessionManager: new SessionManager({ projectDir: dir, port: PORT }),
      state: new StateManager(dir),
      meshSelfId: SELF,
      staleOwnerEngine: engine,
      leaseHandback: {
        status: () => handback.status(),
        latchWrite: (reason?: string) => writeHandbackLatch(dir, 86_400_000, reason),
        latchClear: () => clearHandbackLatch(dir),
        latchRecord: () => readHandbackLatchRecord(dir),
      },
    });
    await server.start();
  }, 20000);

  afterAll(async () => {
    setRopeHealthProvider(null);
    await server?.stop();
    SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/e2e/stale-owner-release-handback-alive.test.ts' });
  });

  it('GET /pool/stale-owner-release is ALIVE (200, not 503) and the dry-run episode advances the §2.9 counters', async () => {
    const first = await fetch(`${base}/pool/stale-owner-release`, { headers: auth });
    expect(first.status).toBe(200); // 503 here is the "engine never wired" bug
    // Drive a real episode: fold liveness, darken past the bound, settle probes.
    engine.tick();
    wall += DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000;
    mono += DEFAULT_STALE_OWNER_RELEASE_CONFIG.deathEvidenceMs + 5_000;
    for (let i = 0; i < 4; i++) {
      engine.tick();
      await new Promise((r) => setTimeout(r, 5));
    }
    const res = await fetch(`${base}/pool/stale-owner-release`, { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { enabled: boolean; dryRun: boolean; counters: { wouldClaims: number }; openEpisodes: unknown[]; lastEpisode: { verdict: string } };
    expect(body.enabled).toBe(true);
    expect(body.dryRun).toBe(true);
    expect(body.openEpisodes.length).toBe(1);
    expect(body.counters.wouldClaims).toBeGreaterThan(0);
    expect(body.lastEpisode.verdict).toBe('would-claim');
  });

  it('GET /pool/lease-handback is ALIVE and the synthetic unhealthy→healthy transition advances the dry-run counters', async () => {
    // Unhealthy: observing, no window.
    handback.observe();
    let res = await fetch(`${base}/pool/lease-handback`, { headers: auth });
    expect(res.status).toBe(200);
    let body = (await res.json()) as { enabled: boolean; state: string; counters: Record<string, number> };
    expect(body.enabled).toBe(true);
    expect(body.state).toBe('observing');
    // Healthy → window opens → past the hysteresis window → dry-run would-hand-back.
    preferredHealthy = true;
    handback.observe();
    wall += DEFAULT_LEASE_HANDBACK_CONFIG.healthWindowMs + 1_000;
    mono += DEFAULT_LEASE_HANDBACK_CONFIG.healthWindowMs + 1_000;
    handback.observe();
    res = await fetch(`${base}/pool/lease-handback`, { headers: auth });
    body = (await res.json()) as typeof body;
    expect(body.counters['window-start']).toBeGreaterThan(0);
    expect(body.counters['armed']).toBeGreaterThan(0);
    expect(body.counters['would-hand-back']).toBeGreaterThan(0);
    expect(body.state).toBe('armed');
  });

  it('the operator latch levers work end-to-end (Bearer write; PIN-gated clear)', async () => {
    const post = await fetch(`${base}/pool/lease-handback/latch`, { method: 'POST', headers: auth, body: JSON.stringify({ reason: 'e2e flip' }) });
    expect(post.status).toBe(200);
    // The reconciler goes fully inert while latched — visible on status.
    handback.observe();
    const status = (await (await fetch(`${base}/pool/lease-handback`, { headers: auth })).json()) as { state: string; latch: { reason: string } };
    expect(status.state).toBe('latched');
    expect(status.latch.reason).toBe('e2e flip');
    // Bearer alone cannot clear (403); the PIN can.
    const noPin = await fetch(`${base}/pool/lease-handback/latch`, { method: 'DELETE', headers: auth, body: JSON.stringify({}) });
    expect(noPin.status).toBe(403);
    const ok = await fetch(`${base}/pool/lease-handback/latch`, { method: 'DELETE', headers: auth, body: JSON.stringify({ pin: PIN }) });
    expect(ok.status).toBe(200);
    expect(readHandbackLatchUntilMs(dir)).toBeNull();
  });

  it('dark → GET /pool/stale-owner-release answers 503 (zero presence)', async () => {
    engineActive = false;
    const res = await fetch(`${base}/pool/stale-owner-release`, { headers: auth });
    expect(res.status).toBe(503);
    engineActive = true;
  });

  it('401 without a Bearer token (the real auth middleware is in the path)', async () => {
    expect((await fetch(`${base}/pool/stale-owner-release`)).status).toBe(401);
    expect((await fetch(`${base}/pool/lease-handback`)).status).toBe(401);
  });
});
