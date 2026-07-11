/**
 * Unit tests for SpawnAdmission — the binding-verdict seam at every
 * session-creating callsite (ownership-gated-spawn-and-judgment-within-floors
 * spec §3.1, Layer A).
 *
 * Covers:
 *  - resolveOwnershipSafe tri-state wrapper (self / other-alive / other-dark /
 *    unowned / error — NEVER a throw out of the wrapper)
 *  - effectiveMode(): the §3.1 item-6 admission-table invariant — `enforce`
 *    REQUIRES durable custody; with the queue dark the seam observes only
 *  - admit() exhaustive table rows (a)–(e), short-circuits, and the
 *    router-verdict TOCTOU consumption (queued/placement-blocked suppress
 *    independent of acked; the seam consumes, never re-resolves)
 *  - error-arm breaker: consecutive trip, windowed-rate trip, once-per-topic
 *    journal row, breaker-open enforce refusal vs dry-run allow, hysteresis
 *    close, episodes-in-24h HIGH escalation, dedupe id shape
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SpawnAdmission,
  resolveOwnershipSafe,
  ERROR_ARM_CONSTANTS,
} from '../../src/core/SpawnAdmission.js';
import type { AdmitInput, SpawnAdmissionDeps, SpawnAdmissionFlag } from '../../src/core/SpawnAdmission.js';

const T0 = Date.parse('2026-07-10T12:00:00.000Z');
let fakeNow = T0;

type OwnershipRec = { owner: string | null; epoch: number; status: string | null } | null;

function makeDeps(over: Partial<SpawnAdmissionDeps> = {}): SpawnAdmissionDeps {
  return {
    selfMachineId: vi.fn(() => 'machine-a'),
    poolStage: vi.fn(() => 'live'),
    readOwnership: vi.fn((): OwnershipRec => ({ owner: 'machine-a', epoch: 1, status: 'owned' })),
    isMachineAlive: vi.fn(() => true),
    durableCustodyLive: vi.fn(() => true),
    journal: vi.fn(),
    raiseAttention: vi.fn(),
    provenance: vi.fn(),
    log: vi.fn(),
    now: () => fakeNow,
    ...over,
  };
}

function admitInput(over: Partial<AdmitInput> = {}): AdmitInput {
  return { sessionKey: '12345', callsite: 'telegram-cold-spawn', ...over };
}

const ENFORCE: SpawnAdmissionFlag = { enabled: true, dryRun: false };
const DRY: SpawnAdmissionFlag = { enabled: true, dryRun: true };
const OFF: SpawnAdmissionFlag = { enabled: false, dryRun: true };

beforeEach(() => {
  fakeNow = T0;
});

// ── resolveOwnershipSafe ──────────────────────────────────────────────

describe('resolveOwnershipSafe', () => {
  it('kind self when the record names this machine', () => {
    const deps = makeDeps();
    const r = resolveOwnershipSafe('k', deps);
    expect(r).toMatchObject({ kind: 'self', owner: 'machine-a', epoch: 1 });
  });

  it('kind other-alive when another machine owns and is alive', () => {
    const deps = makeDeps({
      readOwnership: vi.fn(() => ({ owner: 'machine-b', epoch: 3, status: 'owned' })),
      isMachineAlive: vi.fn(() => true),
    });
    expect(resolveOwnershipSafe('k', deps)).toMatchObject({ kind: 'other-alive', owner: 'machine-b', epoch: 3 });
  });

  it('kind other-dark when another machine owns and is NOT alive', () => {
    const deps = makeDeps({
      readOwnership: vi.fn(() => ({ owner: 'machine-b', epoch: 3, status: 'owned' })),
      isMachineAlive: vi.fn(() => false),
    });
    expect(resolveOwnershipSafe('k', deps)).toMatchObject({ kind: 'other-dark', owner: 'machine-b' });
  });

  it('kind unowned when there is no record (null) or a null owner', () => {
    expect(resolveOwnershipSafe('k', makeDeps({ readOwnership: vi.fn(() => null) }))).toMatchObject({
      kind: 'unowned',
      owner: null,
      epoch: 0,
    });
    expect(
      resolveOwnershipSafe('k', makeDeps({ readOwnership: vi.fn(() => ({ owner: null, epoch: 7, status: null })) })),
    ).toMatchObject({ kind: 'unowned', owner: null, epoch: 7 });
  });

  it('a THROWN readOwnership becomes kind error — never a throw out', () => {
    const deps = makeDeps({
      readOwnership: vi.fn(() => {
        throw new Error('sqlite gone');
      }),
    });
    const r = resolveOwnershipSafe('k', deps);
    expect(r.kind).toBe('error');
    expect(r.error).toContain('registry-read-failed');
    expect(r.error).toContain('sqlite gone');
  });

  it('a thrown isMachineAlive becomes kind error (liveness-read-failed)', () => {
    const deps = makeDeps({
      readOwnership: vi.fn(() => ({ owner: 'machine-b', epoch: 2, status: 'owned' })),
      isMachineAlive: vi.fn(() => {
        throw new Error('heartbeat store torn');
      }),
    });
    const r = resolveOwnershipSafe('k', deps);
    expect(r.kind).toBe('error');
    expect(r.owner).toBe('machine-b');
    expect(r.error).toContain('liveness-read-failed');
  });
});

// ── effectiveMode ─────────────────────────────────────────────────────

describe('effectiveMode (§3.1 item 6 — enforce requires durable custody)', () => {
  it('off when the flag is disabled', () => {
    const sa = new SpawnAdmission(OFF, makeDeps());
    expect(sa.effectiveMode()).toBe('off');
    expect(sa.status().enforceBlockedBy).toBe('flag-disabled');
  });

  it('dry-run when dryRun is set', () => {
    const sa = new SpawnAdmission(DRY, makeDeps());
    expect(sa.effectiveMode()).toBe('dry-run');
    expect(sa.status().enforceBlockedBy).toBe('dry-run');
  });

  it('THE invariant: dryRun:false but durableCustodyLive()===false still yields dry-run — enforce is impossible with the queue dark', () => {
    const sa = new SpawnAdmission(ENFORCE, makeDeps({ durableCustodyLive: vi.fn(() => false) }));
    expect(sa.effectiveMode()).toBe('dry-run');
    expect(sa.status().enforceBlockedBy).toBe('durable-custody-dark');
    // and admit() on a blocking row therefore ALLOWS (observes only)
    const deps = makeDeps({
      durableCustodyLive: vi.fn(() => false),
      readOwnership: vi.fn(() => ({ owner: 'machine-b', epoch: 1, status: 'owned' })),
      isMachineAlive: vi.fn(() => true),
    });
    const sa2 = new SpawnAdmission(ENFORCE, deps);
    const d = sa2.admit(admitInput());
    expect(d.allow).toBe(true);
    expect(d.wouldBlock).toBe(true);
    expect(d.mode).toBe('dry-run');
  });

  it('enforce only when enabled + !dryRun + custody live', () => {
    const sa = new SpawnAdmission(ENFORCE, makeDeps());
    expect(sa.effectiveMode()).toBe('enforce');
    expect(sa.status().enforceBlockedBy).toBeNull();
  });
});

// ── admit() table ─────────────────────────────────────────────────────

describe('admit — short-circuit rows (§3.1 item 5: zero writes)', () => {
  it('flag off → allow, row short-circuit, zero journal + provenance writes', () => {
    const deps = makeDeps();
    const sa = new SpawnAdmission(OFF, deps);
    const d = sa.admit(admitInput());
    expect(d).toMatchObject({ allow: true, row: 'short-circuit', wouldBlock: false, reason: 'flag-disabled' });
    expect(deps.journal).not.toHaveBeenCalled();
    expect(deps.provenance).not.toHaveBeenCalled();
    expect(sa.status().counters.shortCircuits).toBe(1);
  });

  it("poolStage 'dark' → allow short-circuit, zero writes", () => {
    const deps = makeDeps({ poolStage: vi.fn(() => 'dark') });
    const sa = new SpawnAdmission(ENFORCE, deps);
    const d = sa.admit(admitInput());
    expect(d).toMatchObject({ allow: true, row: 'short-circuit', reason: 'single-machine-or-pool-dark' });
    expect(deps.journal).not.toHaveBeenCalled();
    expect(deps.provenance).not.toHaveBeenCalled();
    expect(deps.readOwnership).not.toHaveBeenCalled();
  });

  it('no selfMachineId (pool not wired) → allow short-circuit, zero writes', () => {
    const deps = makeDeps({ selfMachineId: vi.fn(() => null) });
    const sa = new SpawnAdmission(ENFORCE, deps);
    const d = sa.admit(admitInput());
    expect(d).toMatchObject({ allow: true, row: 'short-circuit', reason: 'single-machine-or-pool-dark' });
    expect(deps.journal).not.toHaveBeenCalled();
    expect(deps.provenance).not.toHaveBeenCalled();
  });
});

describe('admit — ownership rows', () => {
  it('row (a) self → allow', () => {
    const sa = new SpawnAdmission(ENFORCE, makeDeps());
    const d = sa.admit(admitInput());
    expect(d).toMatchObject({ allow: true, row: 'self', wouldBlock: false });
    expect(d.ownership?.kind).toBe('self');
  });

  it('row (d) unowned → allow (claim rides the router placeAndClaim path)', () => {
    const sa = new SpawnAdmission(ENFORCE, makeDeps({ readOwnership: vi.fn(() => null) }));
    const d = sa.admit(admitInput());
    expect(d).toMatchObject({ allow: true, row: 'unowned', wouldBlock: false });
  });

  it('row (b) other-alive in dry-run → allow + wouldBlock', () => {
    const deps = makeDeps({
      readOwnership: vi.fn(() => ({ owner: 'machine-b', epoch: 1, status: 'owned' })),
      isMachineAlive: vi.fn(() => true),
    });
    const sa = new SpawnAdmission(DRY, deps);
    const d = sa.admit(admitInput());
    expect(d).toMatchObject({ allow: true, row: 'other-alive', wouldBlock: true, mode: 'dry-run' });
    expect(d.refusalAction).toBeUndefined();
    expect(d.reason).toContain('[dry-run would-block]');
    expect(sa.status().counters.wouldBlock).toBe(1);
  });

  it("row (b) other-alive in enforce → refuse with refusalAction 'forward'", () => {
    const deps = makeDeps({
      readOwnership: vi.fn(() => ({ owner: 'machine-b', epoch: 1, status: 'owned' })),
      isMachineAlive: vi.fn(() => true),
    });
    const sa = new SpawnAdmission(ENFORCE, deps);
    const d = sa.admit(admitInput());
    expect(d).toMatchObject({ allow: false, row: 'other-alive', wouldBlock: true, refusalAction: 'forward' });
    expect(sa.status().counters.refused).toBe(1);
    // decision journaled + provenance row written
    expect(deps.journal).toHaveBeenCalledWith(expect.objectContaining({ kind: 'spawn-admission-decision', row: 'other-alive', allow: false }));
    expect(deps.provenance).toHaveBeenCalledWith(expect.objectContaining({ component: 'SpawnAdmission', decision: 'forward' }));
  });

  it("row (c) other-dark in enforce → refuse with refusalAction 'owner-dark-ladder'", () => {
    const deps = makeDeps({
      readOwnership: vi.fn(() => ({ owner: 'machine-b', epoch: 1, status: 'owned' })),
      isMachineAlive: vi.fn(() => false),
    });
    const sa = new SpawnAdmission(ENFORCE, deps);
    const d = sa.admit(admitInput());
    expect(d).toMatchObject({ allow: false, row: 'other-dark', refusalAction: 'owner-dark-ladder' });
  });
});

describe('admit — router-verdict TOCTOU consumption (§3.1 items 2 + 4)', () => {
  it.each([
    ['queued', true],
    ['queued', false],
    ['placement-blocked', true],
    ['placement-blocked', false],
  ] as Array<[string, boolean]>)(
    'enforce: %s verdict (acked=%s) suppresses local spawn INDEPENDENT of acked, without re-resolving',
    (action, acked) => {
      const deps = makeDeps();
      const sa = new SpawnAdmission(ENFORCE, deps);
      const d = sa.admit(admitInput({ routerVerdict: { messageId: 'm1', action, acked } }));
      expect(d).toMatchObject({
        allow: false,
        row: 'router-queued-suppress',
        wouldBlock: true,
        refusalAction: 'rung3-notice',
        consumedRouterVerdict: action,
      });
      // The seam CONSUMES the verdict — the registry is never re-resolved.
      expect(deps.readOwnership).not.toHaveBeenCalled();
      expect(deps.isMachineAlive).not.toHaveBeenCalled();
    },
  );

  it.each([true, false])('dry-run: queued verdict (acked=%s) → allow + wouldBlock, readOwnership never called', (acked) => {
    const deps = makeDeps();
    const sa = new SpawnAdmission(DRY, deps);
    const d = sa.admit(admitInput({ routerVerdict: { messageId: 'm1', action: 'queued', acked } }));
    expect(d).toMatchObject({ allow: true, row: 'router-queued-suppress', wouldBlock: true });
    expect(deps.readOwnership).not.toHaveBeenCalled();
  });

  it("other consumed actions ('handled-locally') → allow, row router-consumed", () => {
    const deps = makeDeps();
    const sa = new SpawnAdmission(ENFORCE, deps);
    const d = sa.admit(admitInput({ routerVerdict: { messageId: 'm2', action: 'handled-locally', acked: true } }));
    expect(d).toMatchObject({
      allow: true,
      row: 'router-consumed',
      wouldBlock: false,
      consumedRouterVerdict: 'handled-locally',
    });
    expect(deps.readOwnership).not.toHaveBeenCalled();
    expect(sa.status().counters.routerVerdictsConsumed).toBe(1);
  });
});

// ── Error arm + breaker ───────────────────────────────────────────────

describe('admit — error arm (§3.1 row e) + breaker', () => {
  /** Deps whose readOwnership behavior can be flipped between error and clean. */
  function switchableDeps() {
    let behavior: 'throw' | 'self' = 'throw';
    const deps = makeDeps({
      readOwnership: vi.fn((): OwnershipRec => {
        if (behavior === 'throw') throw new Error('registry down');
        return { owner: 'machine-a', epoch: 1, status: 'owned' };
      }),
    });
    return { deps, setBehavior: (b: 'throw' | 'self') => (behavior = b) };
  }

  it('pre-trip errors fail toward the spawn (reachability wins) in enforce mode', () => {
    const { deps } = switchableDeps();
    const sa = new SpawnAdmission(ENFORCE, deps);
    for (let i = 0; i < ERROR_ARM_CONSTANTS.CONSECUTIVE_TRIP - 1; i++) {
      const d = sa.admit(admitInput({ sessionKey: `topic-${i}` }));
      expect(d).toMatchObject({ allow: true, row: 'error' });
    }
    expect(sa.isErrorEpisodeOpen()).toBe(true);
    expect(sa.status().errorEpisode.breakerOpen).toBe(false);
    expect(sa.status().counters.errorArmSpawns).toBe(ERROR_ARM_CONSTANTS.CONSECUTIVE_TRIP - 1);
  });

  it(`breaker trips at ${ERROR_ARM_CONSTANTS.CONSECUTIVE_TRIP} consecutive errors → enforce refuses with rung3-notice`, () => {
    const { deps } = switchableDeps();
    const sa = new SpawnAdmission(ENFORCE, deps);
    let last;
    for (let i = 0; i < ERROR_ARM_CONSTANTS.CONSECUTIVE_TRIP; i++) {
      last = sa.admit(admitInput({ sessionKey: `topic-${i}` }));
    }
    expect(last).toMatchObject({ allow: false, row: 'error', refusalAction: 'rung3-notice' });
    expect(sa.status().errorEpisode.breakerOpen).toBe(true);
  });

  it('windowed-rate trip: ≥8 errors in 10min WITH interleaved successes (clean resets the consecutive counter, windowed errors still accumulate)', () => {
    const { deps, setBehavior } = switchableDeps();
    const sa = new SpawnAdmission(ENFORCE, deps);
    let last;
    for (let i = 0; i < ERROR_ARM_CONSTANTS.WINDOWED_TRIP_COUNT; i++) {
      setBehavior('throw');
      last = sa.admit(admitInput({ sessionKey: `err-${i}` }));
      // consecutive counter never reaches CONSECUTIVE_TRIP thanks to the clean
      // resolution between errors — the WINDOWED rate is what trips.
      if (i < ERROR_ARM_CONSTANTS.WINDOWED_TRIP_COUNT - 1) {
        expect(last.allow).toBe(true);
        setBehavior('self');
        const clean = sa.admit(admitInput({ sessionKey: `clean-${i}` }));
        expect(clean.row).toBe('self');
        fakeNow += 30_000; // all errors stay inside the 10-min window
      }
    }
    expect(sa.status().errorEpisode.consecutiveErrors).toBeLessThan(ERROR_ARM_CONSTANTS.CONSECUTIVE_TRIP);
    expect(sa.status().errorEpisode.breakerOpen).toBe(true);
    expect(last).toMatchObject({ allow: false, refusalAction: 'rung3-notice' });
  });

  it('once-per-topic-per-episode journal row: same sessionKey twice → ONE spawn-admission-error row', () => {
    const { deps } = switchableDeps();
    const sa = new SpawnAdmission(ENFORCE, deps);
    sa.admit(admitInput({ sessionKey: 'topic-x' }));
    sa.admit(admitInput({ sessionKey: 'topic-x' }));
    const errRows = (deps.journal as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((r) => r.kind === 'spawn-admission-error');
    expect(errRows).toHaveLength(1);
    expect(errRows[0]).toMatchObject({ sessionKey: 'topic-x', callsite: 'telegram-cold-spawn' });
    // a DIFFERENT topic in the same episode gets its own row
    sa.admit(admitInput({ sessionKey: 'topic-y' }));
    const errRows2 = (deps.journal as ReturnType<typeof vi.fn>).mock.calls
      .map((c) => c[0] as Record<string, unknown>)
      .filter((r) => r.kind === 'spawn-admission-error');
    expect(errRows2).toHaveLength(2);
  });

  it('breaker-open + dry-run → still allow:true (dry-run never blocks)', () => {
    const { deps } = switchableDeps();
    const sa = new SpawnAdmission(DRY, deps);
    let last;
    for (let i = 0; i <= ERROR_ARM_CONSTANTS.CONSECUTIVE_TRIP; i++) {
      last = sa.admit(admitInput({ sessionKey: `topic-${i}` }));
      expect(last.allow).toBe(true);
    }
    expect(sa.status().errorEpisode.breakerOpen).toBe(true);
    expect(last).toMatchObject({ allow: true, row: 'error', wouldBlock: true });
  });

  it(`hysteresis: episode closes (breaker resets) only after ${ERROR_ARM_CONSTANTS.HYSTERESIS_CLEAN_CLOSES} consecutive clean resolutions`, () => {
    const { deps, setBehavior } = switchableDeps();
    const sa = new SpawnAdmission(ENFORCE, deps);
    for (let i = 0; i < ERROR_ARM_CONSTANTS.CONSECUTIVE_TRIP; i++) sa.admit(admitInput({ sessionKey: `t-${i}` }));
    expect(sa.isErrorEpisodeOpen()).toBe(true);
    expect(sa.status().errorEpisode.breakerOpen).toBe(true);

    setBehavior('self');
    for (let i = 0; i < ERROR_ARM_CONSTANTS.HYSTERESIS_CLEAN_CLOSES - 1; i++) {
      sa.admit(admitInput({ sessionKey: `c-${i}` }));
      expect(sa.isErrorEpisodeOpen()).toBe(true); // not yet
    }
    sa.admit(admitInput({ sessionKey: 'c-final' }));
    expect(sa.isErrorEpisodeOpen()).toBe(false);
    expect(sa.status().errorEpisode.breakerOpen).toBe(false);
    expect(sa.status().errorEpisode.episodeId).toBeNull();
  });

  it('episodes-in-24h HIGH escalation: the 3rd episode raises attention with priority high (earlier ones medium)', () => {
    const { deps, setBehavior } = switchableDeps();
    const sa = new SpawnAdmission(ENFORCE, deps);
    const raise = deps.raiseAttention as ReturnType<typeof vi.fn>;

    for (let episode = 1; episode <= ERROR_ARM_CONSTANTS.EPISODES_HIGH_THRESHOLD; episode++) {
      setBehavior('throw');
      sa.admit(admitInput({ sessionKey: `ep${episode}-topic` }));
      setBehavior('self');
      for (let i = 0; i < ERROR_ARM_CONSTANTS.HYSTERESIS_CLEAN_CLOSES; i++) {
        sa.admit(admitInput({ sessionKey: `ep${episode}-clean-${i}` }));
      }
      expect(sa.isErrorEpisodeOpen()).toBe(false);
      fakeNow += 60_000; // well inside the 24h window
    }

    expect(raise).toHaveBeenCalledTimes(3);
    expect(raise.mock.calls[0][0].priority).toBe('medium');
    expect(raise.mock.calls[1][0].priority).toBe('medium');
    expect(raise.mock.calls[2][0].priority).toBe('high');
  });

  it('attention dedupe id shape: spawn-admission-error:<machine>:<episode>', () => {
    const { deps } = switchableDeps();
    const sa = new SpawnAdmission(ENFORCE, deps);
    sa.admit(admitInput({ sessionKey: 'topic-x' }));
    const raise = deps.raiseAttention as ReturnType<typeof vi.fn>;
    expect(raise).toHaveBeenCalledTimes(1);
    const id = raise.mock.calls[0][0].id as string;
    const episodeId = sa.status().errorEpisode.episodeId;
    expect(episodeId).toMatch(/^err-/);
    expect(id).toBe(`spawn-admission-error:machine-a:${episodeId}`);
  });

  it('isErrorEpisodeOpen(): true during the episode, false after hysteresis close', () => {
    const { deps, setBehavior } = switchableDeps();
    const sa = new SpawnAdmission(ENFORCE, deps);
    expect(sa.isErrorEpisodeOpen()).toBe(false);
    sa.admit(admitInput({ sessionKey: 't' }));
    expect(sa.isErrorEpisodeOpen()).toBe(true);
    setBehavior('self');
    for (let i = 0; i < ERROR_ARM_CONSTANTS.HYSTERESIS_CLEAN_CLOSES; i++) {
      sa.admit(admitInput({ sessionKey: `c-${i}` }));
    }
    expect(sa.isErrorEpisodeOpen()).toBe(false);
  });
});

// ── status() ──────────────────────────────────────────────────────────

describe('status counters', () => {
  it('tracks admitted / wouldBlock / refused / errorArmSpawns / shortCircuits / routerVerdictsConsumed', () => {
    let owner: string | null = 'machine-a';
    let alive = true;
    let throwing = false;
    const deps = makeDeps({
      readOwnership: vi.fn((): OwnershipRec => {
        if (throwing) throw new Error('boom');
        return { owner, epoch: 1, status: 'owned' };
      }),
      isMachineAlive: vi.fn(() => alive),
    });
    const sa = new SpawnAdmission(ENFORCE, deps);

    sa.admit(admitInput()); // self → admitted
    owner = null;
    sa.admit(admitInput()); // unowned → admitted
    owner = 'machine-b';
    alive = true;
    sa.admit(admitInput()); // other-alive enforce → refused
    throwing = true;
    sa.admit(admitInput({ sessionKey: 'err-topic' })); // error arm → errorArmSpawn
    throwing = false;
    sa.admit(admitInput({ routerVerdict: { messageId: 'm', action: 'handled-locally', acked: true } })); // consumed → admitted
    sa.setFlag(OFF);
    sa.admit(admitInput()); // short-circuit

    const c = sa.status().counters;
    expect(c.admitted).toBe(3);
    expect(c.refused).toBe(1);
    expect(c.errorArmSpawns).toBe(1);
    expect(c.shortCircuits).toBe(1);
    expect(c.routerVerdictsConsumed).toBe(1);
    expect(c.wouldBlock).toBe(0);
  });
});
