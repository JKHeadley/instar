/**
 * Tier-1 tests for formatForwardedTopicContext (bug #2): a session moved to a standby
 * has no local history, so the router relays the prior conversation; this formats it.
 */
import { describe, it, expect } from 'vitest';
import { formatForwardedTopicContext } from '../../src/core/ForwardedTopicContext.js';

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
    expect(out).toContain('Topic: deploys');
    expect(out).toContain('[12:00:05] Justin: what is the deploy status?');
    expect(out).toContain('[12:00:30] Agent: Shipped v1.3.165.');
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
