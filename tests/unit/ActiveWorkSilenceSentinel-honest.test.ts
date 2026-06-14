/**
 * HONEST-PROGRESS-MESSAGING — ActiveWorkSilenceSentinel corroboration (A1/A2/A5).
 *
 * Reproduces the reported false positive (Bug-Fix Evidence Bar): a session
 * running a long task shows a static frame WITH an active-work indicator, and
 * the old sentinel escalated "it went quiet" with false confidence. The
 * corroboration gate must SUPPRESS that, escalate only a genuine wedge, and back
 * a frozen-indicator hang at the A5 timeout.
 */
import { describe, it, expect } from 'vitest';
import {
  ActiveWorkSilenceSentinel,
  type ActiveWorkSilenceSentinelDeps,
  type SessionRegistryEntry,
  type SilenceFunnelEvent,
} from '../../src/monitoring/ActiveWorkSilenceSentinel.js';

const T0 = 1_000_000_000_000;
const THIRTY_ONE_MIN = 31 * 60_000;

/** Flush the async escalate chain (report→runNudge awaits nudgeFn). */
const flush = () => new Promise<void>(r => setTimeout(r, 0));

function makeSentinel(over: Partial<ActiveWorkSilenceSentinelDeps>, cfg = {}) {
  let now = T0;
  const messages: string[] = [];
  const events: Array<{ event: SilenceFunnelEvent; name: string }> = [];
  // Single session, last output 31m ago → past the 30m threshold.
  const session: SessionRegistryEntry = {
    sessionName: 'ai.instar.echo-build',
    lastOutputAt: T0 - THIRTY_ONE_MIN,
    paused: false,
  };
  const deps: ActiveWorkSilenceSentinelDeps = {
    listSessions: () => [session],
    nudgeFn: async () => true, // nudge accepted, but no output change → verify→escalate
    notifyFn: async (_n, text) => { messages.push(text); },
    recordEvent: (event, name) => events.push({ event, name }),
    now: () => now,
    // Run verify timers synchronously so the test is deterministic.
    setTimer: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    clearTimer: () => {},
    ...over,
  };
  const sentinel = new ActiveWorkSilenceSentinel(deps, cfg);
  return {
    sentinel, messages, events, session,
    advance: (ms: number) => { now += ms; },
  };
}

describe('ActiveWorkSilenceSentinel — honest corroboration', () => {
  it('A1: a static frame STILL showing an active-work indicator is suppressed, not escalated', async () => {
    const { sentinel, messages, events } = makeSentinel({
      captureFrame: () => 'Building... 67%\n(esc to interrupt)',
      looksActivelyWorking: () => true, // generating now → long task, NOT a freeze
    });
    sentinel.tick();
    await flush();
    expect(messages).toEqual([]); // no "it went quiet" alert
    expect(events.some(e => e.event === 'suppressed_active_indicator')).toBe(true);
  });

  it('A2: an indeterminate frame (not working, no sub-agent, nudge no-op) escalates with honest wording', async () => {
    const { sentinel, messages, events } = makeSentinel({
      captureFrame: () => 'half-printed output with no prompt and no spinner',
      looksActivelyWorking: () => false,
      hasActiveSubagents: () => false,
    });
    sentinel.tick();
    await flush();
    expect(messages.length).toBe(1);
    expect(messages[0]).toMatch(/may be stuck, or on a long task I can't see into\. Want me to check\?/);
    expect(messages[0]).not.toMatch(/went quiet|nothing came back/); // no false-confidence wording
    expect(events.some(e => e.event === 'escalated_indeterminate')).toBe(true);
  });

  it('A2(c): a live sub-agent suppresses the escalation (the session is mid-work)', async () => {
    const { sentinel, messages, events } = makeSentinel({
      captureFrame: () => 'quiet frame, no spinner',
      looksActivelyWorking: () => false,
      hasActiveSubagents: () => true,
    });
    sentinel.tick();
    await flush();
    expect(messages).toEqual([]);
    expect(events.some(e => e.event === 'suppressed_subagent_live')).toBe(true);
  });

  it('FD-6: a capture error fails CLOSED (suppresses, never a false "stuck" claim)', async () => {
    const { sentinel, messages, events } = makeSentinel({
      captureFrame: () => { throw new Error('tmux capture failed'); },
      looksActivelyWorking: () => false,
    });
    sentinel.tick();
    await flush();
    expect(messages).toEqual([]);
    expect(events.some(e => e.event === 'suppressed_corroborate_error')).toBe(true);
  });

  it('A5: a frozen active-work frame, byte-identical past the timeout, escalates (hedged)', async () => {
    const frozenFrame = 'Building... 67%\n(esc to interrupt)';
    const h = makeSentinel({
      captureFrame: () => frozenFrame, // identical every tick
      looksActivelyWorking: () => true,
    }, { activeWorkMaxFrozenIndicatorMs: 90 * 60_000, tickIntervalMs: 60_000 });
    // First tick → suppressed-active, arms the frozen-frame timer.
    h.sentinel.tick();
    await flush();
    expect(h.messages).toEqual([]);
    // Advance past the 90m frozen-indicator timeout, tick again.
    h.advance(91 * 60_000);
    h.sentinel.tick();
    await flush();
    expect(h.messages.length).toBe(1);
    expect(h.messages[0]).toMatch(/same "working" frame for \d+ min with zero change/);
    expect(h.events.some(e => e.event === 'escalated_frozen_indicator')).toBe(true);
  });

  it('legacy: with no captureFrame wired, escalates with honest wording (no corroboration)', async () => {
    const { sentinel, messages, events } = makeSentinel({
      captureFrame: undefined,
    });
    sentinel.tick();
    await flush();
    expect(messages.length).toBe(1);
    expect(messages[0]).toMatch(/Want me to check\?/);
    expect(events.some(e => e.event === 'escalated_legacy')).toBe(true);
  });

  it('default silence threshold is 30m (A4): a 20m-idle session is not even a candidate', async () => {
    const session: SessionRegistryEntry = {
      sessionName: 'ai.instar.echo-build',
      lastOutputAt: T0 - 20 * 60_000, // only 20m idle
      paused: false,
    };
    const messages: string[] = [];
    const sentinel = new ActiveWorkSilenceSentinel({
      listSessions: () => [session],
      nudgeFn: async () => true,
      notifyFn: async (_n, t) => { messages.push(t); },
      captureFrame: () => 'frame',
      looksActivelyWorking: () => false,
      hasActiveSubagents: () => false,
      now: () => T0,
      setTimer: (fn) => { fn(); return 0 as unknown as ReturnType<typeof setTimeout>; },
    });
    sentinel.tick();
    await flush();
    expect(messages).toEqual([]); // 20m < 30m default → no detection
  });
});
