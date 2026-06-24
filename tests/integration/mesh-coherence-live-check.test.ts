/**
 * mesh-coherence-live-state-honesty — Fix (b) WIRING behaviour (integration tier).
 *
 * The periodic live-coherence check is wired INLINE into the peerPresenceTimer
 * callback in src/commands/server.ts (no extractable timer function), so this test
 * exercises the surfacing-path STATE MACHINE the wiring implements — transition-only
 * emit + level-triggered reset, the emitCap ceiling, the dev-flag gate no-op, and the
 * capped consecutive-failure backoff with auto-recovery — over the REAL pure function
 * (checkMeshLiveStateCoherence) and the REAL dev-gate funnel (resolveDevAgentGate),
 * with a recorder satisfying the REAL FeatureMetricsRecorder interface.
 *
 * The harness below is byte-for-byte the wiring logic in server.ts (transition Set +
 * emitCap counts + backoff counters + failing latch); the source-grep companion
 * (tests/unit/mesh-coherence-wiring.test.ts) pins that the same logic actually lives
 * in server.ts so this harness can't drift from the real wiring.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  checkMeshLiveStateCoherence,
  MESH_WARMUP_GRACE_MS,
  type MeshLiveState,
} from '../../src/core/configCoherence.js';
import { resolveDevAgentGate } from '../../src/core/devAgentGate.js';
import type { FeatureMetricsRecorder } from '../../src/core/CircuitBreakingIntelligenceProvider.js';

type Outcome = 'fired' | 'noop' | 'error' | 'shed';

/** A faithful re-implementation of the server.ts peerPresenceTick coherence branch. */
function makeTickHarness(opts: {
  config: { developmentAgent?: boolean; monitoring?: { meshCoherenceLiveCheck?: { enabled?: boolean; warmupGraceMs?: number; emitCap?: number } }; multiMachine?: unknown };
  liveProvider: () => MeshLiveState; // may throw to simulate a corrupt registry read
  recorder: FeatureMetricsRecorder;
  log: (line: string) => void;
}) {
  const MAX_BACKOFF_TICKS = 20;
  let lastCodes = new Set<string>();
  const emitCounts = new Map<string, number>();
  let consecFailures = 0;
  let ticksSinceAttempt = 0;
  let failing = false;
  const { config, liveProvider, recorder, log } = opts;

  return function tick(): void {
    if (!resolveDevAgentGate(config.monitoring?.meshCoherenceLiveCheck?.enabled, config)) return;
    const backoffTicks = Math.min(consecFailures, MAX_BACKOFF_TICKS);
    if (consecFailures > 0 && ticksSinceAttempt < backoffTicks) {
      ticksSinceAttempt += 1;
      return;
    }
    ticksSinceAttempt = 0;
    const warmupGraceMs = config.monitoring?.meshCoherenceLiveCheck?.warmupGraceMs ?? MESH_WARMUP_GRACE_MS;
    const emitCap = config.monitoring?.meshCoherenceLiveCheck?.emitCap;
    try {
      const live = liveProvider();
      const warnings = checkMeshLiveStateCoherence(config.multiMachine as never, true, live, warmupGraceMs);
      const nowCodes = new Set(warnings.map((w) => w.code));
      let firedThisTick = false;
      for (const w of warnings) {
        if (!lastCodes.has(w.code)) {
          const count = emitCounts.get(w.code) ?? 0;
          if (emitCap === undefined || count < emitCap) {
            log(`  ⚠ mesh-live-coherence [${w.code}]: ${w.message}`);
            emitCounts.set(w.code, count + 1);
            firedThisTick = true;
          }
        }
      }
      recorder.record({ feature: 'mesh-coherence-live', kind: 'event', outcome: firedThisTick ? 'fired' : 'noop' });
      lastCodes = nowCodes;
      consecFailures = 0;
      failing = false;
    } catch {
      if (!failing) {
        recorder.record({ feature: 'mesh-coherence-live', kind: 'event', outcome: 'error' });
        failing = true;
      }
      consecFailures += 1;
    }
  };
}

function makeRecorder() {
  const outcomes: Outcome[] = [];
  const recorder: FeatureMetricsRecorder = {
    record: (e) => { if (e.feature === 'mesh-coherence-live') outcomes.push(e.outcome); },
  };
  return { recorder, outcomes };
}

const devCfg = (extra?: object) => ({ developmentAgent: true, ...extra });

describe('mesh-coherence live-check wiring (transition-only emit)', () => {
  it('a steady divergence over THREE ticks logs exactly ONCE; resolve+recur logs again', () => {
    const logs: string[] = [];
    const { recorder, outcomes } = makeRecorder();
    let live: MeshLiveState = { boundHost: '0.0.0.0' }; // config off + wide bind = divergence
    const tick = makeTickHarness({
      config: devCfg({ multiMachine: { meshTransport: { enabled: false } }, monitoring: { meshCoherenceLiveCheck: {} } }),
      liveProvider: () => live,
      recorder,
      log: (l) => logs.push(l),
    });

    tick(); tick(); tick();
    expect(logs.filter((l) => l.includes('mesh-config-off-but-live-on'))).toHaveLength(1);
    expect(outcomes).toEqual(['fired', 'noop', 'noop']);

    // resolve the divergence (clean tick) then re-introduce it → logs AGAIN (level-triggered reset)
    live = { boundHost: '127.0.0.1' };
    tick(); // resolved → noop
    live = { boundHost: '0.0.0.0' };
    tick(); // recurs → fires again
    expect(logs.filter((l) => l.includes('mesh-config-off-but-live-on'))).toHaveLength(2);
    expect(outcomes).toEqual(['fired', 'noop', 'noop', 'noop', 'fired']);
  });

  it('flag DARK (fleet) → the check is a strict no-op (no logs, no metric)', () => {
    const logs: string[] = [];
    const { recorder, outcomes } = makeRecorder();
    const tick = makeTickHarness({
      config: { developmentAgent: false, multiMachine: { meshTransport: { enabled: false } }, monitoring: { meshCoherenceLiveCheck: {} } },
      liveProvider: () => ({ boundHost: '0.0.0.0' }),
      recorder,
      log: (l) => logs.push(l),
    });
    tick(); tick();
    expect(logs).toHaveLength(0);
    expect(outcomes).toHaveLength(0);
  });

  it('emitCap:2 — a divergence that resolves-and-recurs >2 times logs at most TWICE for the code', () => {
    const logs: string[] = [];
    const { recorder } = makeRecorder();
    let live: MeshLiveState = { boundHost: '0.0.0.0' };
    const tick = makeTickHarness({
      config: devCfg({ multiMachine: { meshTransport: { enabled: false } }, monitoring: { meshCoherenceLiveCheck: { emitCap: 2 } } }),
      liveProvider: () => live,
      recorder,
      log: (l) => logs.push(l),
    });
    // 4 fresh transitions (resolve+recur each time)
    for (let i = 0; i < 4; i++) {
      live = { boundHost: '0.0.0.0' }; tick(); // recur (fresh transition)
      live = { boundHost: '127.0.0.1' }; tick(); // resolve
    }
    expect(logs.filter((l) => l.includes('mesh-config-off-but-live-on')).length).toBe(2);
  });
});

describe('mesh-coherence live-check wiring (sustained-failure backoff + auto-recover)', () => {
  it('a throwing registry read: ONE error row, never crashes, backoff bounds re-probes, then auto-recovers', () => {
    const logs: string[] = [];
    const { recorder, outcomes } = makeRecorder();
    let throwIt = true;
    let live: MeshLiveState = { boundHost: '0.0.0.0' };
    const liveProvider = vi.fn<[], MeshLiveState>(() => {
      if (throwIt) throw new Error('corrupt registry');
      return live;
    });
    const tick = makeTickHarness({
      config: devCfg({ multiMachine: { meshTransport: { enabled: false } }, monitoring: { meshCoherenceLiveCheck: {} } }),
      liveProvider,
      recorder,
      log: (l) => logs.push(l),
    });

    // Drive 100 failing ticks. (i) ONE error row (transition-gated). (ii) never throws.
    expect(() => { for (let i = 0; i < 100; i++) tick(); }).not.toThrow();
    expect(outcomes.filter((o) => o === 'error')).toHaveLength(1);
    expect(logs).toHaveLength(0); // a read error logs no coherence warning

    // (iii) backoff bounded the ACTUAL read attempts (NOT one per tick). With MAX_BACKOFF_TICKS=20,
    // 100 ticks yields far fewer than 100 attempts.
    expect(liveProvider.mock.calls.length).toBeLessThan(20);

    // (iv) make the next read succeed on a divergence → backoff resets, the very next eligible
    // tick emits the divergence line + a 'fired' metric (auto-recovery proven).
    throwIt = false;
    live = { boundHost: '0.0.0.0' };
    // advance enough ticks for the backoff window to elapse
    for (let i = 0; i < 25; i++) tick();
    expect(logs.filter((l) => l.includes('mesh-config-off-but-live-on')).length).toBe(1);
    expect(outcomes.filter((o) => o === 'fired')).toHaveLength(1);
  });
});
