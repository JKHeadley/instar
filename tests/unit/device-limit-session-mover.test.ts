/**
 * DeviceLimitSessionMover (spec codex-device-limit-tripwire §4): moves live interactive sessions
 * off a benched account, serialised at most one per 30 s, re-checking the bench before each move,
 * with the login-expired swap brakes (one try per session per 10 min, at most 3).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DeviceLimitSessionMover,
  DEVICE_LIMIT_MOVE_SPACING_MS,
  type DeviceLimitMoverSession,
} from '../../src/core/DeviceLimitSessionMover.js';

const T0 = Date.parse('2026-10-31T12:00:00Z');
const MIN = 60_000;

function makeEnv(sessions: DeviceLimitMoverSession[]) {
  let clock = T0;
  const benched = new Set<string>(['acct-a']);
  const swaps: Array<{ sessionName: string; exhaustedAccountId: string; at: number }> = [];
  const sleeps: number[] = [];
  let swapResult: (name: string) => { swapped: boolean; toAccountId?: string; reason?: string } = () => ({ swapped: true, toAccountId: 'acct-b' });
  let enabled = true;
  const live = [...sessions];
  const mover = new DeviceLimitSessionMover({
    listSessions: () => live,
    isBenched: (id) => benched.has(id),
    swap: async ({ sessionName, exhaustedAccountId }) => {
      swaps.push({ sessionName, exhaustedAccountId, at: clock });
      return swapResult(sessionName);
    },
    enabled: () => enabled,
    now: () => clock,
    sleep: async (ms) => { sleeps.push(ms); clock += ms; },
  });
  return {
    mover, benched, swaps, sleeps, live,
    setSwap: (fn: typeof swapResult) => { swapResult = fn; },
    setEnabled: (v: boolean) => { enabled = v; },
    advance: (ms: number) => { clock += ms; },
  };
}

const s = (tmux: string, extra: Partial<DeviceLimitMoverSession> = {}): DeviceLimitMoverSession =>
  ({ tmuxSession: tmux, name: tmux, subscriptionAccountId: 'acct-a', jobSlug: null, protected: false, ...extra });

describe('DeviceLimitSessionMover', () => {
  let env: ReturnType<typeof makeEnv>;
  beforeEach(() => {
    env = makeEnv([
      s('s1'),
      s('s2'),
      s('job', { jobSlug: 'nightly' }),
      s('prot', { protected: true }),
      s('other', { subscriptionAccountId: 'acct-b' }),
    ]);
  });

  it('moves only interactive, non-protected sessions on the benched account', async () => {
    await env.mover.moveOff('acct-a');
    expect(env.swaps.map((x) => x.sessionName)).toEqual(['s1', 's2']);
    expect(env.swaps.every((x) => x.exhaustedAccountId === 'acct-a')).toBe(true);
    expect(env.mover.counters).toMatchObject({ queued: 2, moved: 2, refused: 0 });
  });

  it('serialises moves at least 30 s apart', async () => {
    env.live.push(s('s3'));
    await env.mover.moveOff('acct-a');
    const at = env.swaps.map((x) => x.at);
    expect(at).toHaveLength(3);
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(DEVICE_LIMIT_MOVE_SPACING_MS);
    expect(at[2] - at[1]).toBeGreaterThanOrEqual(DEVICE_LIMIT_MOVE_SPACING_MS);
    expect(env.sleeps).toEqual([DEVICE_LIMIT_MOVE_SPACING_MS, DEVICE_LIMIT_MOVE_SPACING_MS]);
  });

  it('spacing carries across moveOff calls', async () => {
    await env.mover.moveOff('acct-a');
    env.live.push(s('s9'));
    env.sleeps.length = 0;
    env.advance(10_000);
    await env.mover.moveOff('acct-a');
    expect(env.sleeps[0]).toBe(DEVICE_LIMIT_MOVE_SPACING_MS - 10_000);
  });

  it('re-checks isBenched before each move: a release mid-queue skips the rest', async () => {
    env.setSwap(() => { env.benched.delete('acct-a'); return { swapped: true }; });
    await env.mover.moveOff('acct-a');
    expect(env.swaps.map((x) => x.sessionName)).toEqual(['s1']);
    expect(env.mover.counters.skipped).toBe(1);
  });

  it('skips a session that moved off the account by itself before its turn', async () => {
    env.setSwap((name) => { if (name === 's1') env.live[1] = s('s2', { subscriptionAccountId: 'acct-c' }); return { swapped: true }; });
    await env.mover.moveOff('acct-a');
    expect(env.swaps.map((x) => x.sessionName)).toEqual(['s1']);
  });

  it('a refused swap is counted; brakes: 10-min cooldown and at most 3 attempts per session', async () => {
    const solo = makeEnv([s('s1')]);
    solo.setSwap(() => ({ swapped: false, reason: 'no-target' }));
    await solo.mover.moveOff('acct-a');
    expect(solo.mover.counters.refused).toBe(1);
    solo.advance(MIN);
    await solo.mover.moveOff('acct-a'); // inside the 10-min cooldown
    expect(solo.swaps).toHaveLength(1);
    expect(solo.mover.counters.skipped).toBe(1);
    solo.advance(10 * MIN);
    await solo.mover.moveOff('acct-a');
    solo.advance(10 * MIN);
    await solo.mover.moveOff('acct-a');
    expect(solo.swaps).toHaveLength(3);
    solo.advance(10 * MIN);
    await solo.mover.moveOff('acct-a'); // gave up after 3
    expect(solo.swaps).toHaveLength(3);
    expect(solo.mover.counters.refused).toBe(3);
  });

  it('a throwing swap counts as refused and does not break the queue', async () => {
    env.setSwap((name) => { if (name === 's1') throw new Error('boom'); return { swapped: true }; });
    await env.mover.moveOff('acct-a');
    expect(env.swaps.map((x) => x.sessionName)).toEqual(['s1', 's2']);
    expect(env.mover.counters).toMatchObject({ refused: 1, moved: 1 });
  });

  it('disabled ⇒ no moves', async () => {
    env.setEnabled(false);
    await env.mover.moveOff('acct-a');
    expect(env.swaps).toHaveLength(0);
    expect(env.mover.counters.queued).toBe(0);
  });
});
