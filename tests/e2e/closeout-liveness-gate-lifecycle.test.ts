/**
 * E2E — post-transfer closeout liveness gate on the PRODUCTION wiring shape
 * (spec: post-transfer-closeout-correctness §Tests Tier-3).
 *
 *   Phase 1 (feature-alive — the must-have): with closeoutLivenessGate resolved
 *     ON, the reaper is constructed WITH a non-null, non-no-op
 *     `remoteOwnerHasLiveSession` dep that DELEGATES to a REAL snapshot (a live
 *     refresher against a real peer), and the closeout consults it. Flag OFF ⇒
 *     the dep is absent and the closeout runs the legacy path.
 *
 *   Phase 2 (lifecycle regression — the live bug end-to-end): a stale ownership
 *     record points to a peer that has NO live session for the topic. Gate ON ⇒
 *     the local LIVE session is NOT terminated (the fix). Gate OFF ⇒ the legacy
 *     closeout DOES terminate it (the documented pre-fix regression the gate
 *     fixes).
 *
 * The reaper + snapshot are constructed exactly as server.ts wires them (real
 * CloseoutLivenessSnapshot, resolveDevAgentGate posture), so this is the
 * production-initialization mirror the standard requires.
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import {
  SessionReaper,
  type SessionReaperDeps,
  type SessionReaperConfig,
} from '../../src/monitoring/SessionReaper.js';
import {
  CloseoutLivenessSnapshot,
  type PeerSessionLike,
} from '../../src/monitoring/closeoutLivenessSnapshot.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import type { Session } from '../../src/core/types.js';
import type { TranscriptProbe } from '../../src/monitoring/transcriptProber.js';

const WORKING_FRAME = 'esc to interrupt\nWorking...';
const STATIC: TranscriptProbe = { resolved: true, path: '/t.jsonl', size: 100, mtime: 1000 };
const AUTH = 'e2e-token';
const OWNER_ID = 'mac-mini-stable-id';
const TOPIC = 26624;

function mkSession(over: Partial<Session> = {}): Session {
  return { id: 's1', name: 'sess', status: 'running', tmuxSession: 't1', startedAt: new Date(0).toISOString(), framework: 'claude-code', claudeSessionId: 'c1', ...over };
}

/** A fake peer whose /sessions list is mutable. */
function fakePeer() {
  let sessions: PeerSessionLike[] = [];
  const app = express();
  app.get('/sessions', (_req, res) => res.json(sessions));
  let server: Server;
  const ready = new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  return {
    ready,
    url: () => `http://127.0.0.1:${(server!.address() as { port: number }).port}`,
    setSessions: (s: PeerSessionLike[]) => { sessions = s; },
    close: () => new Promise<void>((r) => server!.close(() => r())),
  };
}

/**
 * Construct the reaper the way server.ts does, with the gate resolved through
 * resolveDevAgentGate (developmentAgent:true ⇒ ON). Returns the reaper, the live
 * snapshot (so the test can drive a refresh), and the terminate spy.
 */
function buildProductionReaper(opts: { developmentAgent: boolean; peerUrl: () => string; sessions: Session[]; ownerInfo: () => { machineId: string; displayName: string } | null; clock?: { v: number } }) {
  const terminate = vi.fn(async () => ({ terminated: true }));
  const config = { developmentAgent: opts.developmentAgent };
  const gate = resolveDevAgentGate(undefined /* omitted in ConfigDefaults */, config);
  // A monotonic clock so two refreshes in the same wall-ms still produce distinct
  // `reachableAt` (the production refresher runs on a >=120s cadence, so this only
  // compresses the test's timeline; the dwell-advancement logic is unchanged).
  const clock = opts.clock ?? { v: Date.now() };

  let snapshot: CloseoutLivenessSnapshot | undefined;
  if (gate) {
    snapshot = new CloseoutLivenessSnapshot(
      {
        resolvePeerUrls: () => [{ machineId: OWNER_ID, url: opts.peerUrl() }],
        fetchPeerSessions: async (peer) => {
          const r = await fetch(`${peer.url}/sessions`, { headers: { Authorization: `Bearer ${AUTH}` }, signal: AbortSignal.timeout(2000) });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return (await r.json()) as PeerSessionLike[];
        },
        ownerSet: () => {
          const owners = new Set<string>();
          for (const s of opts.sessions.filter(x => x.status === 'running')) { const i = opts.ownerInfo(); if (i) owners.add(i.machineId); void s; }
          return [...owners];
        },
        now: () => clock.v,
      },
      { tickIntervalSec: 1 },
    );
  }

  const deps: SessionReaperDeps = {
    listRunningSessions: () => opts.sessions.filter(s => s.status === 'running'),
    captureOutput: () => WORKING_FRAME,
    hasActiveProcesses: () => true,
    frameworkForSession: () => 'claude-code',
    probeTranscript: () => STATIC,
    isRecoveryActive: () => false,
    isRelayLeaseActive: () => false,
    hasPendingInjection: () => false,
    topicBinding: () => TOPIC,
    recentUserMessage: () => false,
    activeCommitmentForTopic: () => false,
    activeSubagentCount: () => 0,
    buildOrAutonomousActive: () => false,
    protectedSessions: () => [],
    pressure: () => ({ tier: 'normal' }),
    terminate,
    markReaping: () => {},
    clearReaping: () => {},
    now: () => clock.v,
    // Legacy display-only dep (used only on the OFF path).
    topicOwnerElsewhere: () => opts.ownerInfo()?.displayName ?? null,
    // Gated atomic owner read.
    topicOwnerElsewhereInfo: opts.ownerInfo,
    // Injected ONLY when the gate resolved on (snapshot exists) — the
    // wiring-integrity contract: a non-null dep delegating to a REAL snapshot.
    remoteOwnerHasLiveSession: snapshot?.remoteOwnerHasLiveSession,
    recentUserMessageAt: () => null,
  };

  const cfg: Partial<SessionReaperConfig> = {
    enabled: true, dryRun: false, minAgeMinutes: 0,
    topicMovedCloseout: true, topicMovedConfirmTicks: 2,
    closeoutLivenessGate: gate,
    maxReapsPerTick: 3, maxReapsPerHour: 12,
  };

  return { reaper: new SessionReaper(deps, cfg), snapshot, terminate, deps, gate, clock };
}

describe('closeout liveness gate — E2E lifecycle (production wiring)', () => {
  let peer: ReturnType<typeof fakePeer>;
  beforeAll(async () => { peer = fakePeer(); await peer.ready; });
  afterAll(async () => { await peer.close(); });

  it('Phase 1 — feature-alive: gate ON constructs a non-null, non-no-op dep delegating to a real snapshot', async () => {
    const sessions = [mkSession()];
    const built = buildProductionReaper({
      developmentAgent: true, peerUrl: peer.url, sessions,
      ownerInfo: () => ({ machineId: OWNER_ID, displayName: 'Mac Mini' }),
    });
    expect(built.gate).toBe(true);
    expect(built.snapshot).toBeDefined();
    // The dep is present AND delegates to the REAL snapshot (not a stub): drive a
    // refresh against the live peer and assert the dep reflects it.
    expect(built.deps.remoteOwnerHasLiveSession).toBeTypeOf('function');
    peer.setSessions([{ platform: 'telegram', platformId: TOPIC, status: 'running' }]);
    await built.snapshot!.refresh();
    expect(built.deps.remoteOwnerHasLiveSession!(TOPIC, OWNER_ID).state).toBe(true);
  });

  it('Phase 1 — feature-inert: gate OFF leaves the dep absent + no snapshot (legacy path)', () => {
    const sessions = [mkSession()];
    const built = buildProductionReaper({
      developmentAgent: false, peerUrl: peer.url, sessions,
      ownerInfo: () => ({ machineId: OWNER_ID, displayName: 'Mac Mini' }),
    });
    expect(built.gate).toBe(false);
    expect(built.snapshot).toBeUndefined();
    expect(built.deps.remoteOwnerHasLiveSession).toBeUndefined();
  });

  it('Phase 2 — the live bug: STALE owner (no remote session) → gate ON does NOT terminate the live local session', async () => {
    const sessions = [mkSession()];
    const built = buildProductionReaper({
      developmentAgent: true, peerUrl: peer.url, sessions,
      ownerInfo: () => ({ machineId: OWNER_ID, displayName: 'Mac Mini' }),
    });
    // The remote owner has NO live session for the topic (the stale-ownership case).
    peer.setSessions([]); // owner reachable, zero sessions → false (stale-owner signal)
    await built.snapshot!.refresh();
    for (let i = 0; i < 4; i++) { await built.reaper.tick(); }
    expect(built.terminate).not.toHaveBeenCalled(); // the sole live worker survives
  });

  it('Phase 2 — pre-fix regression-lock: gate OFF DOES terminate the live local session on the stale record', async () => {
    const sessions = [mkSession()];
    const built = buildProductionReaper({
      developmentAgent: false, peerUrl: peer.url, sessions,
      ownerInfo: () => ({ machineId: OWNER_ID, displayName: 'Mac Mini' }),
    });
    // Legacy: no liveness check — the stale record alone drives the kill.
    await built.reaper.tick();        // dwell 1
    await built.reaper.tick();        // dwell 2 → terminate (the documented bug)
    expect(built.terminate).toHaveBeenCalledTimes(1);
  });

  it('Phase 2 — genuine move: gate ON DOES shed the leftover when the remote genuinely has a live session', async () => {
    const sessions = [mkSession()];
    const built = buildProductionReaper({
      developmentAgent: true, peerUrl: peer.url, sessions,
      ownerInfo: () => ({ machineId: OWNER_ID, displayName: 'Mac Mini' }),
    });
    peer.setSessions([{ platform: 'telegram', platformId: TOPIC, status: 'running' }]); // genuine duplicate
    await built.snapshot!.refresh();
    await built.reaper.tick();        // dwell 1 (true, gen A)
    built.clock.v += 1000;            // advance the clock so the next refresh is a NEW generation
    await built.snapshot!.refresh();  // advance the snapshot generation (new reachableAt)
    await built.reaper.tick();        // dwell 2 (true, gen B advanced) → shed
    expect(built.terminate).toHaveBeenCalledTimes(1);
  });
});
