import { describe, it, expect } from 'vitest';
import {
  MissingLoginSessionDetector,
  buildAttention,
  computeStranded,
  resolveMissingLoginSessionConfig,
  guardStatusFor,
  MISSING_LOGIN_SESSION_DEDUP_KEY,
  type MissingLoginSessionDetectorDeps,
  type MissingLoginAccount,
  type LiveSessionBinding,
  type MissingLoginAttention,
} from '../../src/monitoring/MissingLoginSessionDetector.js';

function makeDetector(opts: {
  enabled?: boolean;
  dryRun?: boolean;
  missing: MissingLoginAccount[];
  sessions: LiveSessionBinding[];
}) {
  const raised: MissingLoginAttention[] = [];
  const audits: Array<{ event: string; detail: Record<string, unknown> }> = [];
  const deps: MissingLoginSessionDetectorDeps = {
    enabled: () => opts.enabled ?? true,
    dryRun: () => opts.dryRun ?? false,
    getMissingLoginAccounts: () => opts.missing,
    getLiveSessions: () => opts.sessions,
    raiseAttention: (item) => raised.push(item),
    audit: (event, detail) => audits.push({ event, detail }),
  };
  return { detector: new MissingLoginSessionDetector(deps), raised, audits };
}

describe('MissingLoginSessionDetector', () => {
  it('is a strict no-op when disabled — never reads accounts/sessions, never raises', () => {
    let read = false;
    const detector = new MissingLoginSessionDetector({
      enabled: () => false,
      dryRun: () => false,
      getMissingLoginAccounts: () => { read = true; return [{ accountId: 'a', configHome: '/h' }]; },
      getLiveSessions: () => { read = true; return [{ sessionName: 's', configHome: '/h' }]; },
      raiseAttention: () => { throw new Error('must not raise when disabled'); },
    });
    const res = detector.tick();
    expect(res).toEqual({ ran: false, gapDetected: false, stranded: [], raised: false });
    expect(read).toBe(false);
  });

  it('raises a high-priority deduped item when a live session runs on a missing-login account', () => {
    const { detector, raised, audits } = makeDetector({
      missing: [{ accountId: 'justin-gmail', configHome: '/home/.claude-x' }],
      sessions: [{ sessionName: 'echo-run', configHome: '/home/.claude-x', topicId: 29723 }],
    });
    const res = detector.tick();
    expect(res.ran).toBe(true);
    expect(res.gapDetected).toBe(true);
    expect(res.raised).toBe(true);
    expect(res.stranded).toEqual([{ accountId: 'justin-gmail', sessionNames: ['echo-run'] }]);
    expect(raised).toHaveLength(1);
    expect(raised[0].priority).toBe('high');
    expect(raised[0].dedupKey).toBe(MISSING_LOGIN_SESSION_DEDUP_KEY);
    expect(raised[0].source).toBe('missing-login-session');
    expect(raised[0].body).toMatch(/justin-gmail/);
    expect(raised[0].body).toMatch(/re-login/i);
    expect(audits.some((a) => a.event === 'raised')).toBe(true);
  });

  it('does NOT raise when a missing-login account has no live session on it (drift alone is not a gap)', () => {
    const { detector, raised, audits } = makeDetector({
      missing: [{ accountId: 'idle-acct', configHome: '/home/.claude-idle' }],
      sessions: [{ sessionName: 'echo-run', configHome: '/home/.claude-healthy' }],
    });
    const res = detector.tick();
    expect(res.gapDetected).toBe(false);
    expect(res.raised).toBe(false);
    expect(res.stranded).toEqual([]);
    expect(raised).toHaveLength(0);
    expect(audits.some((a) => a.event === 'no-gap')).toBe(true);
  });

  it('does NOT raise when there are no missing-login accounts at all', () => {
    const { detector, raised } = makeDetector({
      missing: [],
      sessions: [{ sessionName: 'echo-run', configHome: '/home/.claude-x' }],
    });
    const res = detector.tick();
    expect(res.gapDetected).toBe(false);
    expect(raised).toHaveLength(0);
  });

  it('dry-run computes the gap + counts a would-raise but does NOT raise', () => {
    const { detector, raised, audits } = makeDetector({
      dryRun: true,
      missing: [{ accountId: 'justin-gmail', configHome: '/home/.claude-x' }],
      sessions: [{ sessionName: 'echo-run', configHome: '/home/.claude-x' }],
    });
    const res = detector.tick();
    expect(res.gapDetected).toBe(true);
    expect(res.raised).toBe(false);
    expect(raised).toHaveLength(0);
    expect(audits.some((a) => a.event === 'would-raise')).toBe(true);
    expect(detector.status().counters.wouldRaise).toBe(1);
    expect(detector.status().counters.raises).toBe(0);
  });

  it('aggregates multiple affected accounts into ONE deduped item', () => {
    const { detector, raised } = makeDetector({
      missing: [
        { accountId: 'acct-a', configHome: '/h/a' },
        { accountId: 'acct-b', configHome: '/h/b' },
      ],
      sessions: [
        { sessionName: 's1', configHome: '/h/a' },
        { sessionName: 's2', configHome: '/h/b' },
        { sessionName: 's3', configHome: '/h/b' },
      ],
    });
    const res = detector.tick();
    expect(res.gapDetected).toBe(true);
    expect(raised).toHaveLength(1);
    expect(res.stranded).toEqual([
      { accountId: 'acct-a', sessionNames: ['s1'] },
      { accountId: 'acct-b', sessionNames: ['s2', 's3'] },
    ]);
    expect(raised[0].body).toMatch(/acct-a/);
    expect(raised[0].body).toMatch(/acct-b/);
  });

  it('fails toward silence: a throwing reader increments errors and raises nothing', () => {
    const raised: MissingLoginAttention[] = [];
    const detector = new MissingLoginSessionDetector({
      enabled: () => true,
      dryRun: () => false,
      getMissingLoginAccounts: () => { throw new Error('boom'); },
      getLiveSessions: () => [],
      raiseAttention: (item) => raised.push(item),
    });
    const res = detector.tick();
    expect(res.ran).toBe(true);
    expect(res.gapDetected).toBe(false);
    expect(raised).toHaveLength(0);
    expect(detector.status().counters.errors).toBe(1);
  });

  it('status() reflects ticks, last stranded set, and timestamp', () => {
    const { detector } = makeDetector({
      missing: [{ accountId: 'justin-gmail', configHome: '/h/x' }],
      sessions: [{ sessionName: 'echo-run', configHome: '/h/x' }],
    });
    detector.tick();
    const st = detector.status();
    expect(st.enabled).toBe(true);
    expect(st.dryRun).toBe(false);
    expect(st.counters.ticks).toBe(1);
    expect(st.counters.raises).toBe(1);
    expect(st.lastTickAt).not.toBeNull();
    expect(st.stranded).toEqual([{ accountId: 'justin-gmail', sessionNames: ['echo-run'] }]);
  });
});

describe('computeStranded (pure correlation)', () => {
  it('matches sessions to accounts by config home only', () => {
    const stranded = computeStranded(
      [{ accountId: 'a', configHome: '/h/a' }],
      [
        { sessionName: 's1', configHome: '/h/a' },
        { sessionName: 's2', configHome: '/h/other' },
      ],
    );
    expect(stranded).toEqual([{ accountId: 'a', sessionNames: ['s1'] }]);
  });

  it('ignores a session with an empty config home (never false-matches an empty account slot)', () => {
    const stranded = computeStranded(
      [{ accountId: 'a', configHome: '' }],
      [{ sessionName: 's1', configHome: '' }],
    );
    expect(stranded).toEqual([]);
  });
});

describe('resolveMissingLoginSessionConfig / guardStatusFor', () => {
  it('defaults dryRun to true (graduated-rollout first rung) and honors the dev gate', () => {
    const cfg = resolveMissingLoginSessionConfig(undefined, (explicit) => explicit ?? true);
    expect(cfg).toEqual({ enabled: true, dryRun: true });
    expect(guardStatusFor(cfg)).toBe('dry-run');
  });

  it('explicit enabled:false → dark; enabled + dryRun:false → live', () => {
    expect(guardStatusFor(resolveMissingLoginSessionConfig({ enabled: false }, (e) => e ?? true))).toBe('dark');
    expect(
      guardStatusFor(resolveMissingLoginSessionConfig({ enabled: true, dryRun: false }, (e) => e ?? false)),
    ).toBe('live');
  });
});

describe('buildAttention', () => {
  it('names the account and uses singular/plural correctly', () => {
    const one = buildAttention([{ accountId: 'justin-gmail', sessionNames: ['s1'] }]);
    expect(one.body).toMatch(/1 live session is running/);
    expect(one.body).toMatch(/account/);
    const many = buildAttention([
      { accountId: 'a', sessionNames: ['s1', 's2'] },
      { accountId: 'b', sessionNames: ['s3'] },
    ]);
    expect(many.body).toMatch(/3 live sessions are running/);
    expect(many.body).toMatch(/accounts/);
  });
});
