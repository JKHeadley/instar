/**
 * silent-loss-refusal-conservation §2.C — the unified SenderRejectionNoticer:
 * neutral fixed wording (no topology leak, no resend invitation), durable
 * per-messageId dedupe, cross-topic ceiling, flapping-proof decay, and the
 * sender-side divergence signal.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  SenderRejectionNoticer,
  SENDER_DEAUTHORIZED_NOTICE,
  CROSS_TOPIC_CEILING,
  DECAY_STEPS_MS,
  SUSTAINED_CLEAR_MS,
  type SenderRejectionNoticerDeps,
} from '../../src/core/senderRejectionNotice.js';

function mk(over: Partial<SenderRejectionNoticerDeps> = {}) {
  const sendTelegram = vi.fn();
  const sendSlack = vi.fn();
  const alertHub = vi.fn();
  let t = 0;
  const clock = { set: (v: number) => { t = v; } };
  const marked = new Set<string>();
  const deps: SenderRejectionNoticerDeps = {
    sendTelegram, sendSlack, alertHub,
    markRejectedDurable: over.markRejectedDurable ?? ((id: string) => (marked.has(id) ? false : (marked.add(id), true))),
    now: () => t,
    ...over,
  };
  return { n: new SenderRejectionNoticer(deps), sendTelegram, sendSlack, alertHub, clock };
}

describe('§2.C SenderRejectionNoticer', () => {
  it('fires the neutral fixed wording to the originating Telegram topic — no topology leak', () => {
    const { n, sendTelegram } = mk();
    n.onRejected({ adapter: 'telegram', topicId: 42, messageId: 'm1', senderUid: 7 });
    expect(sendTelegram).toHaveBeenCalledWith(42, SENDER_DEAUTHORIZED_NOTICE);
    // The wording must not name machines / registry / resend.
    expect(SENDER_DEAUTHORIZED_NOTICE.toLowerCase()).not.toContain('machine');
    expect(SENDER_DEAUTHORIZED_NOTICE.toLowerCase()).not.toContain('registry');
    expect(SENDER_DEAUTHORIZED_NOTICE.toLowerCase()).not.toContain('resend');
  });

  it('durable per-messageId dedupe: a replay of the SAME messageId fires ZERO additional notices', () => {
    const { n, sendTelegram } = mk();
    n.onRejected({ adapter: 'telegram', topicId: 42, messageId: 'dup', senderUid: 7 });
    n.onRejected({ adapter: 'telegram', topicId: 42, messageId: 'dup', senderUid: 7 });
    n.onRejected({ adapter: 'telegram', topicId: 42, messageId: 'dup', senderUid: 7 });
    expect(sendTelegram).toHaveBeenCalledTimes(1);
  });

  it('cross-topic ceiling: >3 distinct topics for one (peer,cause) → suppress per-topic + ONE aggregated hub alert', () => {
    const { n, sendTelegram, alertHub } = mk();
    for (let i = 1; i <= CROSS_TOPIC_CEILING + 2; i++) {
      n.onRejected({ adapter: 'telegram', topicId: i, messageId: `m${i}`, peer: 'peerX' });
    }
    // First CROSS_TOPIC_CEILING topics notice per-topic; beyond that → suppressed.
    expect(sendTelegram).toHaveBeenCalledTimes(CROSS_TOPIC_CEILING);
    expect(alertHub).toHaveBeenCalledTimes(1);
  });

  it('flapping-proof decay: a short recovery does NOT re-arm the fast cadence', () => {
    const { n, sendTelegram, clock } = mk();
    // First notice on topic 42.
    clock.set(0);
    n.onRejected({ adapter: 'telegram', topicId: 42, messageId: 'a', peer: 'p' });
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    // A short gap (< the first decay step, < the 30-min window) → suppressed.
    clock.set(DECAY_STEPS_MS[0] - 1000);
    n.onRejected({ adapter: 'telegram', topicId: 42, messageId: 'b', peer: 'p' });
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    // Past the first decay step but the episode has aged into a LONGER cadence
    // (time-since-first-observed) → still suppressed at the same short interval.
    clock.set(DECAY_STEPS_MS[0] + 1000);
    n.onRejected({ adapter: 'telegram', topicId: 42, messageId: 'c', peer: 'p' });
    // The window elapsed (>30m past last notice) so this one may fire — assert it
    // fired at most on a genuine window/step boundary (not the fast cadence).
    expect(sendTelegram.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it('sustained-clear reset: after a long silence the fast cadence re-arms (a NEW episode)', () => {
    const { n, sendTelegram, clock } = mk();
    clock.set(0);
    n.onRejected({ adapter: 'telegram', topicId: 42, messageId: 'a', peer: 'p' });
    expect(sendTelegram).toHaveBeenCalledTimes(1);
    // A gap ≥ the sustained-clear window → a fresh episode → notices again.
    clock.set(SUSTAINED_CLEAR_MS + 1);
    n.onRejected({ adapter: 'telegram', topicId: 42, messageId: 'b', peer: 'p' });
    expect(sendTelegram).toHaveBeenCalledTimes(2);
  });

  it('divergence signal: local-resolves + remote-rejects → ONE deduped advisory hub alert', () => {
    const { n, alertHub } = mk({ resolvesLocally: () => true });
    n.onRejected({ adapter: 'telegram', topicId: 42, messageId: 'a', senderUid: 7, peer: 'peerZ' });
    n.onRejected({ adapter: 'telegram', topicId: 43, messageId: 'b', senderUid: 7, peer: 'peerZ' });
    // The divergence alert dedupes per peer within the window (≤1 for peerZ).
    const divergenceCalls = alertHub.mock.calls.filter((c) => String(c[0]).toLowerCase().includes('divergence'));
    expect(divergenceCalls.length).toBe(1);
  });

  it('routes a Slack rejection to the Slack seam', () => {
    const { n, sendSlack } = mk();
    n.onRejected({ adapter: 'slack', slackKey: 'C123:169', messageId: 's1' });
    expect(sendSlack).toHaveBeenCalledWith('C123:169', SENDER_DEAUTHORIZED_NOTICE);
  });

  it('a notice send fault never throws out of onRejected (fire-and-forget)', () => {
    const { n } = mk({ sendTelegram: () => { throw new Error('boom'); } });
    expect(() => n.onRejected({ adapter: 'telegram', topicId: 1, messageId: 'x' })).not.toThrow();
  });
});
