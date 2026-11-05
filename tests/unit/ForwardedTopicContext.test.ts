/**
 * Tier-1 tests for formatForwardedTopicContext (bug #2): a session moved to a standby
 * has no local history, so the router relays the prior conversation; this formats it.
 */
import { describe, it, expect } from 'vitest';
import { formatForwardedTopicContext } from '../../src/core/ForwardedTopicContext.js';
import { formatLocalTimestamp } from '../../src/utils/localTime.js';

describe('formatForwardedTopicContext (moved-session context relay — bug #2)', () => {
  it('returns empty string for null / empty history (nothing to inject)', () => {
    expect(formatForwardedTopicContext(undefined)).toBe('');
    expect(formatForwardedTopicContext(null)).toBe('');
    expect(formatForwardedTopicContext([])).toBe('');
  });

  it('formats a multi-message thread with sender attribution + the continue-not-restart guard', () => {
    const out = formatForwardedTopicContext([
      { fromUser: true, text: 'what is the deploy status?', senderName: 'Justin', timestamp: '2026-05-31T12:00:05Z' },
      { fromUser: false, text: 'Shipped v1.3.165.', timestamp: '2026-05-31T12:00:30Z' },
    ], 'deploys');
    expect(out).toContain('Thread History (last 2 messages, relayed from the previous machine)');
    expect(out).toContain('continue THIS conversation, not start something new');
    expect(out).toContain('history excerpt');
    expect(out).toContain('Topic: deploys');
    // Local-tz rendering (2026-06-05 time-incoherency fix): timestamps are
    // rendered in the HOST's local timezone with an explicit tz label.
    expect(out).toContain(`[${formatLocalTimestamp('2026-05-31T12:00:05Z')}] Justin: what is the deploy status?`);
    expect(out).toContain(`[${formatLocalTimestamp('2026-05-31T12:00:30Z')}] Agent: Shipped v1.3.165.`);
    expect(out.trimEnd().endsWith('--- End Thread History ---')).toBe(true);
  });

  it('falls back sender names + timestamps gracefully', () => {
    const out = formatForwardedTopicContext([
      { fromUser: true, text: 'hi' }, // no senderName, no timestamp
      { fromUser: false, text: 'hello' },
    ]);
    expect(out).toContain('[??:??] User: hi');
    expect(out).toContain('[??:??] Agent: hello');
  });

  it('caps a very long message at 2000 chars (no unbounded prompt bloat)', () => {
    const long = 'x'.repeat(5000);
    const out = formatForwardedTopicContext([{ fromUser: true, text: long, timestamp: 0 }]);
    const line = out.split('\n').find((l) => l.includes('User:'))!;
    expect(line.length).toBeLessThan(2100); // capped well under the raw 5000
  });
});

describe('cross-machine reply evidence', () => {
  it('finds the previous owner reply after a specific inbound', async () => {
    const { replyEvidenceForInbound } = await import('../../src/core/ForwardedTopicContext.js');
    const messages = [
      { messageId: 136473, fromUser: true, timestamp: '2026-11-03T05:19:55Z', text: 'Please look into this' },
      { messageId: 136475, fromUser: false, timestamp: '2026-11-03T05:20:18Z', text: 'Got it' },
    ];
    expect(replyEvidenceForInbound(messages, 136473, true)).toBe('answered');
    expect(replyEvidenceForInbound(messages, 999, false)).toBe('unknown');
    expect(replyEvidenceForInbound(messages.slice(0, 1), 136473, true)).toBe('unknown');
    expect(replyEvidenceForInbound(messages.slice(0, 1), 136473, false)).toBe('unanswered');
  });
});

it('permits a genuinely unanswered local topic after a complete self-only placement read', async () => {
  const { crossMachineReplyEvidence } = await import('../../src/core/ForwardedTopicContext.js');
  const messages = [{ messageId: 100, fromUser: true, timestamp: '2026-11-04T18:00:00Z' }];
  expect(crossMachineReplyEvidence(messages, 100, [], [], [], true)).toBe('unanswered');
  expect(crossMachineReplyEvidence(messages, 100, [], [], [], false)).toBe('unknown');
});
