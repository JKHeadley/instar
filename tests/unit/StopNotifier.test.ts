/**
 * Unit tests for StopNotifier — Layer B of notify-on-stop
 * (docs/specs/NOTIFY-ON-STOP-SPEC.md, Task 2 of the silent-stalls postmortem).
 *
 * Covers both sides of every decision boundary (Testing Integrity Standard):
 * the notify-worthy classifications, every NOT-worthy classification, the
 * attended-gate, per-session dedup/cooldown, and the master enable flag.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  StopNotifier,
  isNotifyWorthyStop,
  type StopGateMode,
  type StopGateDecision,
} from '../../src/monitoring/StopNotifier.js';

function makeNotifier(cfg = {}, now = () => 1_000_000) {
  const sent: Array<{ name: string; text: string }> = [];
  const notifier = new StopNotifier({ escalate: (name, text) => sent.push({ name, text }), now }, cfg);
  return { notifier, sent };
}

describe('isNotifyWorthyStop — the decision matrix (both sides)', () => {
  const worthy: Array<[StopGateMode, StopGateDecision]> = [
    ['shadow', 'continue'], // gate wanted to continue but can't block in shadow → silent stall
    ['shadow', 'escalate'],
    ['enforce', 'escalate'],
  ];
  const notWorthy: Array<[StopGateMode, StopGateDecision]> = [
    ['enforce', 'continue'], // blocked & continues — not a stop
    ['shadow', 'allow'],
    ['enforce', 'allow'],
    ['shadow', 'force_allow'],
    ['shadow', null], // fail-open / transient
    ['off', 'continue'],
    ['off', 'escalate'], // off shouldn't even call us, but be safe — escalate is worthy regardless of mode
  ];

  for (const [mode, decision] of worthy) {
    it(`WORTHY: mode=${mode} decision=${decision}`, () => {
      expect(isNotifyWorthyStop(mode, decision)).toBe(true);
    });
  }
  // 'escalate' is worthy in any mode by design; the off+escalate case is worthy.
  it("escalate is worthy regardless of mode (including 'off')", () => {
    expect(isNotifyWorthyStop('off', 'escalate')).toBe(true);
  });
  for (const [mode, decision] of notWorthy.filter(([, d]) => d !== 'escalate')) {
    it(`NOT worthy: mode=${mode} decision=${decision}`, () => {
      expect(isNotifyWorthyStop(mode, decision)).toBe(false);
    });
  }
});

describe('StopNotifier.maybeNotify', () => {
  it('sends for a shadow+continue unattended stop', () => {
    const { notifier, sent } = makeNotifier();
    const outcome = notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'continue', autonomousActive: true });
    expect(outcome).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].name).toBe('s1');
    expect(sent[0].text).toMatch(/background run/i);
  });

  it('sends for an escalate unattended stop', () => {
    const { notifier, sent } = makeNotifier();
    expect(notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'escalate', autonomousActive: true })).toBe('sent');
    expect(sent[0].text).toMatch(/couldn't confirm/i);
  });

  it('does NOT send for a routine allow', () => {
    const { notifier, sent } = makeNotifier();
    expect(notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'allow', autonomousActive: true })).toBe('not-worthy');
    expect(sent).toHaveLength(0);
  });

  it('does NOT send for continue in enforce (session is blocked & continues)', () => {
    const { notifier, sent } = makeNotifier();
    expect(notifier.maybeNotify({ sessionId: 's1', mode: 'enforce', decision: 'continue', autonomousActive: true })).toBe('not-worthy');
    expect(sent).toHaveLength(0);
  });

  it('attended-gate: skips an attended (non-autonomous) session by default', () => {
    const { notifier, sent } = makeNotifier();
    expect(notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'continue', autonomousActive: false })).toBe('skipped-attended');
    expect(sent).toHaveLength(0);
  });

  it('attended-gate off: notifies an attended session when unattendedOnly=false', () => {
    const { notifier, sent } = makeNotifier({ unattendedOnly: false });
    expect(notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'continue', autonomousActive: false })).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('per-session dedup: a second worthy stop within the cooldown is suppressed', () => {
    let t = 1_000_000;
    const { notifier, sent } = makeNotifier({ cooldownMs: 1000 }, () => t);
    expect(notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'continue', autonomousActive: true })).toBe('sent');
    t += 500;
    expect(notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'escalate', autonomousActive: true })).toBe('skipped-dedup');
    expect(sent).toHaveLength(1);
  });

  it('dedup expires after the cooldown window', () => {
    let t = 1_000_000;
    const { notifier, sent } = makeNotifier({ cooldownMs: 1000 }, () => t);
    notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'continue', autonomousActive: true });
    t += 1500;
    expect(notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'continue', autonomousActive: true })).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('dedup is per-session — a different session still notifies', () => {
    const { notifier, sent } = makeNotifier({ cooldownMs: 999999 });
    notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'continue', autonomousActive: true });
    expect(notifier.maybeNotify({ sessionId: 's2', mode: 'shadow', decision: 'continue', autonomousActive: true })).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('master disable: never sends when enabled=false', () => {
    const { notifier, sent } = makeNotifier({ enabled: false });
    expect(notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'continue', autonomousActive: true })).toBe('disabled');
    expect(sent).toHaveLength(0);
  });

  it('a throwing escalate sink never propagates (best-effort)', () => {
    const notifier = new StopNotifier({ escalate: () => { throw new Error('sink down'); }, now: () => 1 }, {});
    expect(() => notifier.maybeNotify({ sessionId: 's1', mode: 'shadow', decision: 'escalate', autonomousActive: true })).not.toThrow();
  });
});
