import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

// Force the JSONL-detector path to find nothing so checkAndRecover reaches the
// ownership gate (the gate runs at the TOP, before any detector) and, on 'proceed',
// runs its existing logic harmlessly (no JSONL → 'No JSONL found').
vi.mock('../../src/monitoring/stall-detector.js', () => ({ detectToolCallStall: vi.fn(() => null), DEFAULT_TOOL_THRESHOLDS: {} }));
vi.mock('../../src/monitoring/crash-detector.js', () => ({ detectCrashedSession: vi.fn(() => null), detectErrorLoop: vi.fn(() => null) }));
vi.mock('../../src/monitoring/jsonl-truncator.js', () => ({ truncateJsonlToSafePoint: vi.fn() }));

import { SessionRecovery, type SessionRecoveryDeps } from '../../src/monitoring/SessionRecovery.js';

/**
 * Part D — double-dispatch recovery gate (docs/specs/ownership-follows-live-work.md).
 * Both sides of EVERY ownership state, driven through the SessionRecovery.checkAndRecover
 * funnel. The gate runs at the top of checkAndRecover; a `forward`/`withhold` decision
 * returns BEFORE any local respawn/re-inject (the spy deps assert no local recovery ran).
 */

const SELF = 'machine-self';
const PEER = 'machine-peer';

let tmpDir: string;

function makeTmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ofw-recovery-gate-'));
  fs.mkdirSync(path.join(dir, '.instar'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  return dir;
}

interface GateOverrides {
  enabled?: boolean;
  owner?: string | null;
  ownerThrows?: boolean;
  reachable?: boolean;
  reachableThrows?: boolean;
  pending?: { forwarded: number; nonePending: boolean };
}

function makeDeps(over: GateOverrides = {}): { deps: SessionRecoveryDeps; spies: Record<string, ReturnType<typeof vi.fn>>; telemetry: Array<Record<string, unknown>> } {
  const telemetry: Array<Record<string, unknown>> = [];
  const respawnSession = vi.fn(async () => {});
  const respawnSessionFresh = vi.fn(async () => {});
  const killSession = vi.fn(async () => {});
  const captureSessionOutput = vi.fn(() => null); // no context-exhaustion text
  const forward = vi.fn(async () => over.pending ?? { forwarded: 0, nonePending: true });
  const deps: SessionRecoveryDeps = {
    isSessionAlive: vi.fn(() => true),
    getPanePid: vi.fn(() => null), // ⇒ findJsonlForSession returns null on 'proceed'
    killSession,
    respawnSession,
    respawnSessionFresh,
    captureSessionOutput,
    // Part D deps
    ownershipFollowsLiveWork: () => over.enabled ?? true,
    ownerOfTopic: (_t) => {
      if (over.ownerThrows) throw new Error('registry unreadable');
      return over.owner ?? null;
    },
    selfMachineId: () => SELF,
    isOwnerReachable: (_o) => {
      if (over.reachableThrows) throw new Error('reachability indeterminate');
      return over.reachable ?? false;
    },
    forwardPendingInboundViaRoute: forward,
    emitRecoveryGateTelemetry: (row) => { telemetry.push(row as unknown as Record<string, unknown>); },
  };
  return { deps, spies: { respawnSession, respawnSessionFresh, killSession, captureSessionOutput, forward }, telemetry };
}

describe('Part D — recovery gate (both sides of every ownership state)', () => {
  let recovery: SessionRecovery;

  beforeEach(() => { tmpDir = makeTmpDir(); });
  afterEach(() => { try { SafeFsExecutor.safeRmSync(tmpDir, { recursive: true, force: true, operation: 'tests/unit/ownershipFollowsLiveWork-recovery-gate.test.ts' }); } catch { /* ignore */ } });

  it('owner === self → PROCEED (recovery re-runs locally; no forward)', async () => {
    const { deps, spies } = makeDeps({ owner: SELF });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);
    const r = await recovery.checkAndRecover(100, 'topic-100');
    // proceeds → reaches the JSONL path which finds nothing (getPanePid null)
    expect(r.message).toMatch(/No JSONL found/);
    expect(spies.forward).not.toHaveBeenCalled();
  });

  it('owner === reachable peer → FORWARD, do NOT recover locally (the single most important case)', async () => {
    const { deps, spies } = makeDeps({ owner: PEER, reachable: true, pending: { forwarded: 2, nonePending: false } });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);
    const r = await recovery.checkAndRecover(100, 'topic-100');
    expect(spies.forward).toHaveBeenCalledTimes(1);
    expect(spies.respawnSession).not.toHaveBeenCalled();
    expect(spies.respawnSessionFresh).not.toHaveBeenCalled();
    expect(r.message).toMatch(/forwarded/);
  });

  it('owner === unreachable peer → WITHHOLD local re-run (message rides the queue)', async () => {
    const { deps, spies } = makeDeps({ owner: PEER, reachable: false });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);
    const r = await recovery.checkAndRecover(100, 'topic-100');
    expect(spies.respawnSession).not.toHaveBeenCalled();
    expect(spies.respawnSessionFresh).not.toHaveBeenCalled();
    expect(spies.forward).not.toHaveBeenCalled(); // withhold ≠ forward
    expect(r.message).toMatch(/withheld/);
  });

  it('isOwnerReachable THROWS for a peer-owned record → treated as unreachable-peer (WITHHOLD + telemetry)', async () => {
    const { deps, spies, telemetry } = makeDeps({ owner: PEER, reachableThrows: true });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);
    const r = await recovery.checkAndRecover(100, 'topic-100');
    expect(r.message).toMatch(/withheld/);
    expect(spies.respawnSession).not.toHaveBeenCalled();
    expect(telemetry).toContainEqual(expect.objectContaining({
      kind: 'recovery-gate-reachability-unknown', topicId: 100, decision: 'withhold',
    }));
  });

  it('owner === null (released / never-seen) → PROCEED (conversation not stranded)', async () => {
    const { deps, spies } = makeDeps({ owner: null });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);
    const r = await recovery.checkAndRecover(100, 'topic-100');
    expect(r.message).toMatch(/No JSONL found/); // proceeded
    expect(spies.forward).not.toHaveBeenCalled();
  });

  it('ownerOf THROWS (registry unreadable) → PROCEED — fail-OPEN + recovery-gate-registry-unknown telemetry', async () => {
    const { deps, spies, telemetry } = makeDeps({ ownerThrows: true });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);
    const r = await recovery.checkAndRecover(100, 'topic-100');
    expect(r.message).toMatch(/No JSONL found/); // proceeded (re-run locally)
    expect(telemetry).toContainEqual(expect.objectContaining({
      kind: 'recovery-gate-registry-unknown', topicId: 100, decision: 're-run-local',
    }));
  });

  it('reachable peer but NO pending inbound → WITHHOLD local respawn, NO forward emitted (nothing to serve)', async () => {
    const { deps, spies } = makeDeps({ owner: PEER, reachable: true, pending: { forwarded: 0, nonePending: true } });
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);
    const r = await recovery.checkAndRecover(100, 'topic-100');
    expect(spies.respawnSession).not.toHaveBeenCalled();
    expect(spies.respawnSessionFresh).not.toHaveBeenCalled();
    expect(r.message).toMatch(/no pending inbound/);
  });

  it('flag OFF → recovery runs its existing logic unchanged (regression-lock, NO ownership consult)', async () => {
    const ownerOf = vi.fn(() => PEER);
    const { deps, spies } = makeDeps({ enabled: false, owner: PEER, reachable: true });
    deps.ownerOfTopic = ownerOf;
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);
    const r = await recovery.checkAndRecover(100, 'topic-100');
    // OFF ⇒ gate is a no-op: proceeds to the legacy path, ownerOf never consulted, no forward.
    expect(ownerOf).not.toHaveBeenCalled();
    expect(spies.forward).not.toHaveBeenCalled();
    expect(r.message).toMatch(/No JSONL found/);
  });

  it('deps absent (no ownerOfTopic) → PROCEED (legacy behavior; strict no-op)', async () => {
    const { deps, spies } = makeDeps({ owner: PEER, reachable: true });
    delete (deps as Partial<SessionRecoveryDeps>).ownerOfTopic;
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);
    const r = await recovery.checkAndRecover(100, 'topic-100');
    expect(r.message).toMatch(/No JSONL found/);
    expect(spies.forward).not.toHaveBeenCalled();
  });

  it('selfMachineId null (single-machine) → PROCEED even when a "peer" owner is named', async () => {
    const { deps, spies } = makeDeps({ owner: PEER, reachable: true });
    deps.selfMachineId = () => null;
    recovery = new SessionRecovery({ enabled: true, projectDir: tmpDir }, deps);
    const r = await recovery.checkAndRecover(100, 'topic-100');
    expect(r.message).toMatch(/No JSONL found/);
    expect(spies.forward).not.toHaveBeenCalled();
  });
});
