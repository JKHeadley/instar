/**
 * Unit tests for TunnelNotifier — two-channel routing + class-based
 * throttling.
 *
 * Spec: specs/dev-infrastructure/tunnel-failure-resilience.md Part 3.
 *
 * Strategy:
 *   - Drive the notifier with synthetic transition events (no real
 *     TunnelLifecycle wiring needed for these tests).
 *   - Mock the sink with vi.fn() — assert which channel got which
 *     class of message, and that credentials never appear in group
 *     messages (the GPT review's CRITICAL finding).
 *   - Use an injectable clock to drive throttling.
 */

import { describe, it, expect, vi } from 'vitest';
import { TunnelNotifier } from '../../src/tunnel/TunnelNotifier.js';
import type { NotifierSink, NotifierClock } from '../../src/tunnel/TunnelNotifier.js';
import type { TransitionEvent, Episode } from '../../src/tunnel/TunnelLifecycle.js';

function mockSink(): NotifierSink & { groupCalls: string[]; dmCalls: string[] } {
  const groupCalls: string[] = [];
  const dmCalls: string[] = [];
  return {
    groupCalls,
    dmCalls,
    sendGroup: vi.fn(async (text: string) => { groupCalls.push(text); }),
    sendOwnerDM: vi.fn(async (text: string) => { dmCalls.push(text); }),
  };
}

let now = 0;
const fakeClock: NotifierClock = { now: () => now };

function ep(id = 'ep_aaaa'): Episode {
  return {
    episodeId: id,
    startedAt: '2026-05-22T00:00:00Z',
    tier1Attempts: 0,
    lastFailureReason: null,
    attemptedProviders: [],
  };
}

function tx(opts: Partial<TransitionEvent> & { from: TransitionEvent['from']; to: TransitionEvent['to']; epoch: number }): TransitionEvent {
  return {
    epoch: opts.epoch,
    from: opts.from,
    to: opts.to,
    episode: opts.episode ?? ep(),
    lastFailureReason: opts.lastFailureReason ?? null,
    at: opts.at ?? Date.now(),
  };
}

describe('TunnelNotifier — channel separation (GPT critical finding)', () => {
  it('group channel NEVER receives the credential placeholder', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock });
    await n.onTransition(tx({ from: 'starting', to: 'active', epoch: 1 })); // initial startup — no DM
    await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 2, lastFailureReason: 'rate-limited' }));
    await n.onTransition(tx({ from: 'retrying', to: 'active', epoch: 3 }));
    await n.onTransition(tx({ from: 'retrying', to: 'awaiting-consent', epoch: 4 }));
    await n.onTransition(tx({ from: 'awaiting-consent', to: 'relay-active', epoch: 5 }));
    await n.onTransition(tx({ from: 'self-healing', to: 'active', epoch: 6 }));

    for (const groupText of sink.groupCalls) {
      expect(groupText).not.toContain('PLACEHOLDER');
      expect(groupText).not.toContain('PIN');
      expect(groupText).not.toContain('https://');
    }
  });

  it('owner DM is the only channel that carries the credential snapshot', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({
      sink,
      clock: fakeClock,
      credentialProvider: () => ({ url: 'https://tunnel.example', pin: '123456' }),
    });
    await n.onTransition(tx({ from: 'retrying', to: 'active', epoch: 1 }));
    await n.onTransition(tx({ from: 'awaiting-consent', to: 'relay-active', epoch: 2, episode: ep('ep_aaab') }));
    await n.onTransition(tx({ from: 'self-healing', to: 'active', epoch: 3, episode: ep('ep_aaac') }));

    // Every credential-bearing message goes to DM (count = 3 — recovered, relay, restored).
    expect(sink.dmCalls.length).toBe(3);
    for (const dm of sink.dmCalls) {
      expect(dm).toContain('https://tunnel.example');
      expect(dm).toContain('123456');
    }
    // The credentials must NEVER appear in any group message.
    for (const grp of sink.groupCalls) {
      expect(grp).not.toContain('https://tunnel.example');
      expect(grp).not.toContain('123456');
    }
  });

  it('renders a graceful "link not available" placeholder when no credentialProvider is wired', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock });
    await n.onTransition(tx({ from: 'retrying', to: 'active', epoch: 1 }));
    expect(sink.dmCalls.length).toBe(1);
    expect(sink.dmCalls[0]).not.toContain('https://');
    expect(sink.dmCalls[0]).toContain('link not available');
  });
});

describe('TunnelNotifier — epoch dedup', () => {
  it('repeated calls with the same epoch are no-ops', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock });
    const e = tx({ from: 'active', to: 'retrying', epoch: 1, lastFailureReason: 'rate-limited' });
    await n.onTransition(e);
    await n.onTransition(e);
    await n.onTransition(e);
    expect(sink.groupCalls.length).toBe(1);
  });

  it('out-of-order epochs (a re-fire of an older event) are dropped', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock });
    await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 5, lastFailureReason: 'rate-limited' }));
    await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 3, lastFailureReason: 'rate-limited' }));
    expect(sink.groupCalls.length).toBe(1);
  });
});

describe('TunnelNotifier — class-based throttling (V2 + GPT #5)', () => {
  it('action-required (consent prompt) is NEVER throttled', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock, stateChangeMinIntervalMs: 60_000 });

    // First consent prompt
    now = 0;
    await n.onTransition(tx({ from: 'retrying', to: 'awaiting-consent', epoch: 1 }));
    expect(sink.dmCalls.length).toBe(1);

    // Cycle through and arrive at awaiting-consent again, well within the 1-minute throttle
    // window: action-required must still emit.
    now = 100;
    await n.onTransition(tx({ from: 'awaiting-consent', to: 'exhausted', epoch: 2 }));
    now = 200;
    await n.onTransition(tx({ from: 'exhausted', to: 'self-healing', epoch: 3 }));
    now = 300;
    await n.onTransition(tx({ from: 'self-healing', to: 'exhausted', epoch: 4 }));
    now = 400;
    await n.onTransition(tx({ from: 'exhausted', to: 'starting', epoch: 5 }));
    now = 500;
    await n.onTransition(tx({ from: 'starting', to: 'retrying', epoch: 6, lastFailureReason: 'rate-limited' }));
    now = 600;
    await n.onTransition(tx({ from: 'retrying', to: 'awaiting-consent', epoch: 7 }));

    // Two consent prompts (action-required) regardless of throttle window —
    // matched by the consent message's distinctive phrasing.
    const consentDms = sink.dmCalls.filter((d) => d.includes('Reply "yes, use a backup"'));
    expect(consentDms.length).toBe(2);
  });

  it('state-change is throttled to once per (episode, state) within the window', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock, stateChangeMinIntervalMs: 60_000 });

    const e = ep('ep_throttle');
    now = 0;
    await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 1, lastFailureReason: 'rate-limited', episode: e }));
    now = 30_000;
    // Cycle back to active and into retrying again — same episode, same state, within window.
    await n.onTransition(tx({ from: 'retrying', to: 'active', epoch: 2, episode: e }));
    await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 3, lastFailureReason: 'rate-limited', episode: e }));
    // Should still be only the original "couldn't reach" message; no duplicate.
    const cantReach = sink.groupCalls.filter((g) => g.includes("Couldn't reach"));
    expect(cantReach.length).toBe(1);
  });

  it('state-change throttle resets across episodes', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock, stateChangeMinIntervalMs: 60_000 });

    now = 0;
    await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 1, lastFailureReason: 'rate-limited', episode: ep('ep_one') }));
    await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 2, lastFailureReason: 'rate-limited', episode: ep('ep_two') }));

    const cantReach = sink.groupCalls.filter((g) => g.includes("Couldn't reach"));
    expect(cantReach.length).toBe(2);
  });

  it('noise (flap collapse) emits exactly once per episode regardless of cycle count', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock, flapThreshold: 3 });

    const e = ep('ep_flap');
    // 5 connect/drop cycles in the same episode.
    for (let i = 1; i <= 5; i++) {
      now = i * 1000;
      await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: i * 2, lastFailureReason: 'rate-limited', episode: e }));
      await n.onTransition(tx({ from: 'retrying', to: 'active', epoch: i * 2 + 1, episode: e }));
    }

    const unstable = sink.groupCalls.filter((g) => g.includes('unstable'));
    expect(unstable.length).toBe(1);
  });
});

describe('TunnelNotifier — failure-reason in first message', () => {
  it('includes the reason hint for rate-limited', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock });
    await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 1, lastFailureReason: 'rate-limited' }));
    expect(sink.groupCalls[0]).toContain('rate-limiting');
  });

  it('includes the reason hint for network', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock });
    await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 1, lastFailureReason: 'network' }));
    expect(sink.groupCalls[0]).toContain('unreachable');
  });

  it('emits a clean message when the reason is unknown', async () => {
    const sink = mockSink();
    const n = new TunnelNotifier({ sink, clock: fakeClock });
    await n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 1, lastFailureReason: null }));
    expect(sink.groupCalls[0]).toContain("Couldn't reach the usual Cloudflare tunnel");
    expect(sink.groupCalls[0]).not.toContain('(undefined)');
  });
});

describe('TunnelNotifier — error swallowing', () => {
  it('does not throw when the sink throws (preserves catch-all semantics)', async () => {
    const sink: NotifierSink = {
      sendGroup: vi.fn(async () => { throw new Error('telegram down'); }),
      sendOwnerDM: vi.fn(async () => { throw new Error('dm down'); }),
    };
    const n = new TunnelNotifier({ sink, clock: fakeClock });
    await expect(n.onTransition(tx({ from: 'active', to: 'retrying', epoch: 1, lastFailureReason: 'rate-limited' }))).resolves.not.toThrow();
  });
});
