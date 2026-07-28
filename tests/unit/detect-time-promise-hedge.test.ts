/**
 * Unit (Tier 1) — CommitmentTracker.detectTimePromise hedge fix
 * (slack-followthrough-generalization §4.2, R3 hedge fix). Both sides of the
 * boundary: hedged numeric phrases ("in about 5 minutes") now register a cadence;
 * un-hedged phrases are unchanged; non-time text is null.
 */
import { describe, it, expect } from 'vitest';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';

const detect = (t: string) => CommitmentTracker.detectTimePromise(t);

describe('detectTimePromise — hedge tolerance (the S7 fix)', () => {
  it('the EXACT S7 string now registers', () => {
    // "in about 5 minutes" — the hedge "about" previously broke in\\s+(an?|\\d+)
    const r = detect("I'll post the check-in note here in about 5 minutes.");
    expect(r).not.toBeNull();
    expect(r!.cadenceMs).toBeGreaterThan(0);
  });

  it.each([
    ['in about 5 minutes', "back in about 5 minutes"],
    ['in around an hour', "I'll be back in around an hour"],
    ['in roughly 2 hours', "done in roughly 2 hours"],
    ['in ~10 min', "posting in ~10 min"],
    ['in ~ 10 min (space)', "posting in ~ 10 min"],
  ])('hedged numeric phrase registers: %s', (_label, text) => {
    expect(detect(text)).not.toBeNull();
  });

  it('un-hedged numeric phrase is UNCHANGED', () => {
    const hedged = detect('back in about 5 minutes');
    const plain = detect('back in 5 minutes');
    expect(plain).not.toBeNull();
    // same promised duration → same cadence (the hedge word must not change math)
    expect(hedged!.cadenceMs).toBe(plain!.cadenceMs);
    expect(hedged!.hardDeadlineOffsetMs).toBe(plain!.hardDeadlineOffsetMs);
  });

  it('the hedge does not fabricate a time from non-time text', () => {
    expect(detect('I think about this a lot')).toBeNull(); // "about" without in+N
    expect(detect('thanks, that works')).toBeNull();
    expect(detect('')).toBeNull();
  });

  it('softer markers still work (by EOD / tomorrow / check in)', () => {
    expect(detect('I will get this to you by EOD')).not.toBeNull();
    expect(detect("I'll circle back tomorrow")).not.toBeNull();
    expect(detect("I'll check in shortly")).not.toBeNull();
  });
});
