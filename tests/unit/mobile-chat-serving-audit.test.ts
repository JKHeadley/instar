import { describe, expect, it } from 'vitest';
import { recordMobileChatServingRefusal } from '../../src/server/mobileChatServingAudit.js';

describe('app chat serving refusal audit', () => {
  it.each(['holding', 'suspended', 'not-current-holder', 'renewal-lapsed', 'superseded'])(
    'records only the fixed schema for observed verdict %s', (verdict) => {
      const lines: string[] = [];
      recordMobileChatServingRefusal({
        now: () => 1_000,
        readFreshness: () => ({ verdict, ttlMs: 60_000, msSinceConfirmedRenewal: 60_001, text: 'private-message', device: 'private-device' }),
        write: (line) => lines.push(line),
      });
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({
        kind: 'mobile-chat-not-serving', at: '1970-01-01T00:00:01.000Z', pid: process.pid,
        sample: 'after-refusal', observedLeaseVerdict: verdict,
        msSinceConfirmedRenewal: 60_001, ttlMs: 60_000,
      });
      expect(lines[0]).not.toContain('private');
    },
  );

  it('reports unavailable fields instead of echoing malformed diagnostics', () => {
    const lines: string[] = [];
    recordMobileChatServingRefusal({
      now: () => NaN,
      readFreshness: () => ({ verdict: 'private-arbitrary-error', ttlMs: Infinity, msSinceConfirmedRenewal: -1 }),
      write: (line) => lines.push(line),
    });
    expect(JSON.parse(lines[0])).toMatchObject({ at: null, observedLeaseVerdict: 'unavailable', ttlMs: null, msSinceConfirmedRenewal: null });
    expect(lines[0]).not.toContain('private');
  });

  it('records an unavailable read without including its exception', () => {
    const lines: string[] = [];
    recordMobileChatServingRefusal({ readFreshness: () => { throw new Error('private-error'); }, write: (line) => lines.push(line) });
    expect(JSON.parse(lines[0]).observedLeaseVerdict).toBe('unavailable');
    expect(Number.isFinite(Date.parse(JSON.parse(lines[0]).at))).toBe(true);
    expect(lines[0]).not.toContain('private');
  });

  it('reads the verdict accessor once before validating it', () => {
    const lines: string[] = [];
    let reads = 0;
    recordMobileChatServingRefusal({
      readFreshness: () => ({ get verdict() { return ++reads === 1 ? 'renewal-lapsed' : 'private-changing-value'; } }),
      write: (line) => lines.push(line),
    });
    expect(reads).toBe(1);
    expect(JSON.parse(lines[0]).observedLeaseVerdict).toBe('renewal-lapsed');
    expect(lines[0]).not.toContain('private');
  });

  it('never throws when the diagnostic writer fails', () => {
    expect(() => recordMobileChatServingRefusal({ write: () => { throw new Error('disk unavailable'); } })).not.toThrow();
  });
});
