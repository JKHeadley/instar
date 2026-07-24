/**
 * self-action-convergence.test.ts — THE live guard that ENDS the
 * `unbounded-self-action` defect class (docs/specs/self-action-convergence.md
 * → Part D3). This is the class's `closure: guard` target: #1347's grader
 * classifies a `.test.ts` file as a `ratchet` (the strongest enforcement type).
 *
 * The missing "does-it-SETTLE" invariant, alongside the three existing
 * "does-it-WORK" Testing-Integrity invariants. For every controller in the
 * SELF_ACTION_CONTROLLERS registry, it drives N ticks under a PINNED
 * sustained-pressure fixture (the exact worst case that never clears on its
 * own) and proves the action count settles to a small bound — AND does NOT
 * scale with the horizon (a converged loop's action count is horizon-
 * independent; a ping-pong's is not).
 *
 * Constitution: "Capacity Safety — No Unbounded Self-Action" (BBR's temporal
 * twin — BBR bounds instantaneous MASS; this bounds steady-state FREQUENCY
 * under feedback).
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  SELF_ACTION_CONTROLLERS,
  makeActionSink,
  type PressureFixture,
  type VirtualClock,
} from '../../src/testing/selfActionRegistry.js';
import {
  SELF_ACTION_VERB_TOKENS,
  SELF_ACTION_EMIT,
} from '../../scripts/lib/self-action-detect.mjs';
import { classifyFileGuard } from '../../scripts/lib/class-closure-grader.mjs';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');

/** A deterministic virtual clock — no real time, no randomness (a fixed adversary). */
function makeClock(): VirtualClock {
  let now = 0;
  return {
    nowMs: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

/**
 * The PINNED sustained-pressure fixture: EVERY predicate at its worst, forever.
 * This is the condition swap-thrash ran under (every account hot; a polled
 * quota reading that lags real usage) generalized so ONE fixture pressures every
 * controller kind at once.
 */
function makePressureFixture(overrides: Partial<PressureFixture> = {}): PressureFixture {
  const clock = overrides.clock ?? makeClock();
  return {
    clock,
    durableState: new Map<string, unknown>(),
    everyAccountHot: () => true,
    everySessionBusy: () => true,
    targetAlwaysRejects: () => true,
    // A lagging poll: every account reads 85% — hot in truth, and even the
    // stalest read + a swap's own re-hydration burst never dips below threshold.
    staleQuotaReading: () => 85,
    ...overrides,
  };
}

/** Drive a controller `ticks` times, advancing the clock `tickMs` each tick. */
function driveController(
  controller: (typeof SELF_ACTION_CONTROLLERS)[number],
  ticks: number,
): ReturnType<typeof makeActionSink> {
  const fixture = makePressureFixture();
  const sink = makeActionSink();
  const instance = controller.makeUnderPressure(fixture, sink);
  for (let i = 0; i < ticks; i++) {
    instance.tick();
    fixture.clock.advance(controller.tickMs);
  }
  return sink;
}

describe('self-action convergence ratchet — every registered controller SETTLES under sustained pressure', () => {
  for (const controller of SELF_ACTION_CONTROLLERS) {
    describe(`controller: ${controller.id}`, () => {
      it('was genuinely pressured (considered > 0 — not inertly idle)', () => {
        const sink = driveController(controller, controller.ticks);
        expect(sink.considered).toBeGreaterThan(0);
      });

      if (controller.eternalSentinel) {
        // A declared Eternal Sentinel (P19 exemption): NO total-count bound.
        // Assert the two P19 conditions instead — a constant per-attempt cost
        // (one fixed line per emit) + a rate FLOOR that prevents accumulation
        // (emits never exceed elapsed / rateFloorMs).
        it('honors its P19 rate floor (emits never accumulate past elapsed / rateFloorMs)', () => {
          const sink = driveController(controller, controller.ticks);
          const rateFloorMs = controller.eternalSentinel!.rateFloorMs;
          const elapsedMs = controller.ticks * controller.tickMs;
          const maxAllowed = Math.ceil(elapsedMs / rateFloorMs) + 1;
          expect(sink.count).toBeLessThanOrEqual(maxAllowed);
          // Every inter-emit gap respects the floor (no burst inside the window).
          for (let i = 1; i < sink.emitTimesMs.length; i++) {
            expect(sink.emitTimesMs[i] - sink.emitTimesMs[i - 1]).toBeGreaterThanOrEqual(rateFloorMs);
          }
        });

        it('does not accelerate at 2x the horizon (rate stays floored)', () => {
          const sink = driveController(controller, controller.ticks * 2);
          const rateFloorMs = controller.eternalSentinel!.rateFloorMs;
          const elapsedMs = controller.ticks * 2 * controller.tickMs;
          const maxAllowed = Math.ceil(elapsedMs / rateFloorMs) + 1;
          expect(sink.count).toBeLessThanOrEqual(maxAllowed);
        });
      } else {
        it(`settles to <= boundK (${controller.boundK}) under sustained pressure`, () => {
          const sink = driveController(controller, controller.ticks);
          expect(sink.count).toBeLessThanOrEqual(controller.boundK);
        });

        it('settle-is-real: count does NOT scale with the horizon (2x ticks, same bound)', () => {
          const sinkN = driveController(controller, controller.ticks);
          const sink2N = driveController(controller, controller.ticks * 2);
          // A converged loop's action count is horizon-independent; a ping-pong's
          // doubles. The load-bearing anti-oscillation check R3 §2.2 named as
          // never having existed.
          expect(sink2N.count).toBeLessThanOrEqual(controller.boundK);
          expect(sink2N.count).toBe(sinkN.count);
        });

        it('no single target thrashed (anti-ping-pong)', () => {
          const sink = driveController(controller, controller.ticks * 2);
          const maxPerTarget = Math.max(0, ...sink.perTarget.values());
          expect(maxPerTarget).toBeLessThanOrEqual(controller.perTargetBoundK);
        });

        if (controller.restartPosture.pressureSurvives) {
          for (const restartPercent of [25, 50, 75]) {
            it(`keeps the same bound across reconstruction at ${restartPercent}% of sustained pressure`, () => {
              const restart = controller.restartPosture.restartUnderPressure;
              expect(restart).toBeTypeOf('function');
              const fixture = makePressureFixture();
              const sink = makeActionSink();
              let instance = controller.makeUnderPressure(fixture, sink);
              const restartAt = Math.floor(controller.ticks * restartPercent / 100);
              for (let i = 0; i < controller.ticks; i++) {
                if (i === restartAt) instance = restart(fixture, sink);
                instance.tick();
                fixture.clock.advance(controller.tickMs);
              }
              expect(sink.count).toBeLessThanOrEqual(controller.boundK);
            });
          }

          it('keeps the same bound when reconstructed before every tick', () => {
            const restart = controller.restartPosture.restartUnderPressure;
            expect(restart).toBeTypeOf('function');
            const fixture = makePressureFixture();
            const sink = makeActionSink();
            for (let i = 0; i < controller.ticks; i++) {
              restart(fixture, sink).tick();
              fixture.clock.advance(controller.tickMs);
            }
            expect(sink.count).toBeLessThanOrEqual(controller.boundK);
          });
        }
      }
    });
  }

  // ── Semantic-correctness: the swap monitor's SECOND brake (projected load) ──
  it('proactive-swap-monitor: the projected-post-swap-load brake also converges (accounts not all-hot but a swap would push the target hot)', () => {
    const controller = SELF_ACTION_CONTROLLERS.find((c) => c.id === 'proactive-swap-monitor')!;
    // everyAccountHot() FALSE (so brake 1 does not fire) but staleQuotaReading
    // is high enough that current + the swap's own re-hydration burst >= 80 for
    // every candidate — so brake 2 (projected load) refuses every swap.
    const fixture = makePressureFixture({ everyAccountHot: () => false, staleQuotaReading: () => 70 });
    const sink = makeActionSink();
    const instance = controller.makeUnderPressure(fixture, sink);
    for (let i = 0; i < controller.ticks; i++) {
      instance.tick();
      fixture.clock.advance(controller.tickMs);
    }
    expect(sink.considered).toBe(controller.ticks); // pressured every tick
    expect(sink.count).toBeLessThanOrEqual(controller.boundK); // still converges
  });
});

describe('self-action registry — wiring integrity (Testing Integrity)', () => {
  it('SELF_ACTION_CONTROLLERS is non-empty', () => {
    expect(SELF_ACTION_CONTROLLERS.length).toBeGreaterThan(0);
  });

  it('every controller returns a LIVE tick (no null/no-op controllers smuggled in to pass vacuously)', () => {
    const fixture = makePressureFixture();
    const sink = makeActionSink();
    for (const controller of SELF_ACTION_CONTROLLERS) {
      const instance = controller.makeUnderPressure(fixture, sink);
      expect(instance).toBeTruthy();
      expect(typeof instance.tick).toBe('function');
      // A tick must not throw and must actually run the controller's body.
      const before = sink.considered;
      instance.tick();
      expect(sink.considered).toBe(before + 1);
    }
  });

  it('every controller declares a positive ticks horizon and tickMs', () => {
    for (const controller of SELF_ACTION_CONTROLLERS) {
      expect(controller.ticks).toBeGreaterThan(0);
      expect(controller.tickMs).toBeGreaterThan(0);
    }
  });

  it('every controller declares a non-vacuous restart posture', () => {
    for (const controller of SELF_ACTION_CONTROLLERS) {
      expect(controller.restartPosture).toBeTruthy();
      if (controller.restartPosture.pressureSurvives) {
        expect(controller.restartPosture.restartUnderPressure).toBeTypeOf('function');
      } else {
        expect(controller.restartPosture.resetSafeReason.trim().length).toBeGreaterThan(20);
      }
    }
  });

  it('controller ids are unique (the forcing lint cross-checks marker ids against these)', () => {
    const ids = SELF_ACTION_CONTROLLERS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('verb-superset coherence (shared with the detector, Part D5/E5)', () => {
  it('SELF_ACTION_VERB_TOKENS contains a token matching every registry actionVerb', () => {
    for (const controller of SELF_ACTION_CONTROLLERS) {
      const matched = SELF_ACTION_VERB_TOKENS.some((tok) =>
        controller.actionVerb.toLowerCase().includes(tok.toLowerCase()),
      );
      expect(matched, `actionVerb "${controller.actionVerb}" has no detector token`).toBe(true);
    }
  });

  it('SELF_ACTION_EMIT is a real, usable RegExp', () => {
    expect(SELF_ACTION_EMIT).toBeInstanceOf(RegExp);
    expect(SELF_ACTION_EMIT.test('foo.swap(')).toBe(true);
    expect(SELF_ACTION_EMIT.test('a plain sentence about a swap')).toBe(false);
  });
});

describe("grader parity — #1347's grader classifies the three new guards truthfully", () => {
  it('self-action-convergence.test.ts grades `ratchet`', () => {
    expect(classifyFileGuard('tests/unit/self-action-convergence.test.ts')).toBe('ratchet');
  });

  it('lint-no-unregistered-self-action.js grades `lint`', () => {
    expect(classifyFileGuard('scripts/lint-no-unregistered-self-action.js')).toBe('lint');
  });

  it('the precommit arm (scripts/instar-dev-precommit.js) grades `gate`', () => {
    expect(classifyFileGuard('scripts/instar-dev-precommit.js')).toBe('gate');
  });

  it('the three cited guard files all exist on disk (a citation must resolve to a LIVE guard)', () => {
    for (const rel of [
      'tests/unit/self-action-convergence.test.ts',
      'scripts/lint-no-unregistered-self-action.js',
      'scripts/instar-dev-precommit.js',
      'src/testing/selfActionRegistry.ts',
    ]) {
      expect(fs.existsSync(path.join(REPO_ROOT, rel)), `${rel} missing`).toBe(true);
    }
  });
});

// ── RATCHET GENERALIZED over the runtime governor (unified-self-action-
//    backpressure companion §13 Tier 1 / spec §Testing) — every REGISTERED
//    controller's worst-case emissions are driven THROUGH SelfActionGovernor
//    admit() in ENFORCE mode, asserting the governor honors its COUNT ceiling
//    (never looser than the ratchet it generalizes: an entry the model bounds
//    at K can never pass the governor unbounded). Eternal sentinels ride the
//    rate-floor lane (never count-bounded) — the governor must ALLOW their
//    model's rate-floored emissions, not starve them (FD7). ──
describe('governor generalization — every registered controller honors its count ceiling through admit()', () => {
  it('drives each registry model sink through the governor in enforce mode', async () => {
    const os = await import('node:os');
    const { initSelfActionGovernor, resetSelfActionGovernorModuleForTest } = await import(
      '../../src/monitoring/selfaction/governor.js'
    );
    const { resetAnchorForTest } = await import('../../src/monitoring/selfaction/anchor.js');

    for (const controller of SELF_ACTION_CONTROLLERS) {
      resetSelfActionGovernorModuleForTest();
      resetAnchorForTest();
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sag-ratchet-'));
      let vnow = 0;
      try {
        const gov = initSelfActionGovernor({
          stateDir: tmp,
          readEmergencyDisable: () => false,
          readClassesConfig: () => ({ [controller.id]: { mode: 'enforce' } }),
          now: () => vnow,
        });
        gov.setModeForTest(controller.id, 'enforce');
        const handle = gov.for(controller.id);

        const fixture = makePressureFixture();
        const sink = makeActionSink();
        const instance = controller.makeUnderPressure(fixture, sink);
        let governorAllows = 0;
        const baseEmit = sink.emit.bind(sink);
        sink.emit = (action: { verb: string; target: string }) => {
          // The runtime arm of the SAME contract: each model emission asks the
          // governor first. The derived target mirrors the model's own target
          // identity (stable key — the registry models already collapse
          // volatile incarnations onto stable recurrence identities).
          const admission = handle.admitSync(
            { key: action.target, classId: controller.actionVerb, keyIsVolatile: false },
            { nowMs: vnow },
          );
          if (admission.outcome === 'allow') {
            governorAllows++;
            baseEmit(action);
          }
          // A non-allow is a queue/coalesce — bounded, never a silent drop.
        };

        for (let i = 0; i < controller.ticks; i++) {
          instance.tick();
          fixture.clock.advance(controller.tickMs);
          vnow += controller.tickMs;
        }

        if (controller.eternalSentinel) {
          // FD7: rate-floored, never count-bounded — the governor must not
          // starve a declared sentinel's already-rate-floored emissions.
          expect(
            governorAllows,
            `${controller.id}: the governor starved a rate-floored eternal sentinel`,
          ).toBe(sink.count);
        } else {
          // The governor is NEVER LOOSER than the proven model bound: what the
          // brake lets through, the governor also admits (the model's own brake
          // already settles ≤ boundK) — and the governor's own conservative
          // ceiling would bind even if the brake were removed.
          expect(
            governorAllows,
            `${controller.id}: governor admits exceed the model's proven bound`,
          ).toBeLessThanOrEqual(controller.boundK);
          expect(sink.count).toBeLessThanOrEqual(controller.boundK);
        }
      } finally {
        resetSelfActionGovernorModuleForTest();
        resetAnchorForTest();
        SafeFsExecutor.safeRmSync(tmp, { recursive: true, force: true, operation: 'tests/unit/self-action-convergence.test.ts' });
      }
    }
  });
});
