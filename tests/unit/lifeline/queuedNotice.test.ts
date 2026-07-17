import { describe, it, expect } from 'vitest';
import { buildQueuedNotice } from '../../../src/lifeline/queuedNotice.js';

describe('buildQueuedNotice', () => {
  describe('healthy server + failed forward (the bug: must NOT say "restarting")', () => {
    for (const kind of ['message', 'photo', 'file'] as const) {
      it(`does not claim a restart when the server is healthy (${kind})`, () => {
        const notice = buildQueuedNotice(kind, 3, /* serverHealthy */ true);
        // The core regression guard: a confirmed-healthy server must never be
        // reported to the user as "restarting" or "down".
        expect(notice.toLowerCase()).not.toContain('restart');
        expect(notice.toLowerCase()).not.toContain('temporarily down');
        // It reflects the real state: reconnecting after a transient failure.
        expect(notice.toLowerCase()).toContain('reconnect');
        expect(notice).toContain(kind);
        expect(notice).toContain('(3 in queue)');
      });
    }
  });

  describe('genuinely-down server (unchanged, accurate wording preserved)', () => {
    for (const kind of ['message', 'photo', 'file'] as const) {
      it(`still says "temporarily down" when the server is unhealthy (${kind})`, () => {
        const notice = buildQueuedNotice(kind, 1, /* serverHealthy */ false);
        expect(notice).toContain('Server is temporarily down.');
        expect(notice).not.toContain('restarting');
        expect(notice).toContain(kind);
        expect(notice).toContain('(1 in queue)');
        expect(notice).toContain('delivered when the server recovers');
      });
    }
  });

  it('produces byte-identical down-branch text to the pre-fix wording (no churn)', () => {
    // Guards against accidental wording drift in the down branch, which existing
    // dedup / snapshot behavior may depend on.
    expect(buildQueuedNotice('message', 2, false)).toBe(
      'Server is temporarily down. Your message has been queued (2 in queue). It will be delivered when the server recovers.',
    );
    expect(buildQueuedNotice('photo', 2, false)).toBe(
      'Server is temporarily down. Your photo has been queued (2 in queue). It will be delivered when the server recovers.',
    );
    expect(buildQueuedNotice('file', 2, false)).toBe(
      'Server is temporarily down. Your file has been queued (2 in queue). It will be delivered when the server recovers.',
    );
  });

  it('the healthy and down notices are always distinct for the same inputs', () => {
    for (const kind of ['message', 'photo', 'file'] as const) {
      expect(buildQueuedNotice(kind, 5, true)).not.toBe(buildQueuedNotice(kind, 5, false));
    }
  });
});
