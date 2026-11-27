/**
 * Unit tests for StopNotifier — Layer B of notify-on-stop
 * (docs/specs/NOTIFY-ON-STOP-SPEC.md, Task 2 of the silent-stalls postmortem;
 * narrowed 2026-11-01 — named run, own topic, `escalate` log-only).
 *
 * Covers both sides of every decision boundary (Testing Integrity Standard):
 * the notify-worthy classification, every NOT-worthy classification, the
 * `escalate` log-only path, the attended-gate, the named-run gate, per-session
 * dedup/cooldown, and the master enable flag.
 */

import { describe, it, expect } from 'vitest';
import {
  StopNotifier,
  isNotifyWorthyStop,
  type MaybeNotifyInput,
  type StopGateMode,
  type StopGateDecision,
} from '../../src/monitoring/StopNotifier.js';

function makeNotifier(cfg = {}, now = () => 1_000_000) {
  const sent: Array<{ topicId: string; sessionId: string; text: string }> = [];
  const logged: Array<{ sessionId: string; detail: string }> = [];
  const notifier = new StopNotifier(
    {
      notifyTopic: (topicId, sessionId, text) => sent.push({ topicId, sessionId, text }),
      log: (_kind, sessionId, detail) => logged.push({ sessionId, detail }),
      now,
    },
    cfg,
  );
  return { notifier, sent, logged };
}

/** A shadow+continue stop of a named live autonomous run — the notify case. */
function stall(over: Partial<MaybeNotifyInput> = {}): MaybeNotifyInput {
  return {
    sessionId: 's1',
    mode: 'shadow',
    decision: 'continue',
    autonomousActive: true,
    topicId: '4242',
    runGoal: 'Fix the Lifeline noise bug',
    lastActivity: 'Running the unit suite now.',
    ...over,
  };
}

describe('isNotifyWorthyStop — the decision matrix (both sides)', () => {
  it('WORTHY: shadow + continue (gate saw a stall it cannot block)', () => {
    expect(isNotifyWorthyStop('shadow', 'continue')).toBe(true);
  });
  const notWorthy: Array<[StopGateMode, StopGateDecision]> = [
    ['shadow', 'escalate'], // the gate's "not sure" — log-only
    ['enforce', 'escalate'],
    ['off', 'escalate'],
    ['enforce', 'continue'], // blocked & continues — not a stop
    ['shadow', 'allow'],
    ['enforce', 'allow'],
    ['shadow', 'force_allow'],
    ['shadow', null], // fail-open / transient
    ['off', 'continue'],
  ];
  for (const [mode, decision] of notWorthy) {
    it(`NOT worthy: mode=${mode} decision=${decision}`, () => {
      expect(isNotifyWorthyStop(mode, decision)).toBe(false);
    });
  }
});

describe('StopNotifier.maybeNotify', () => {
  it("sends a stall of a named unattended run to THAT run's topic, naming it with its last message", () => {
    const { notifier, sent } = makeNotifier();
    expect(notifier.maybeNotify(stall())).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0].topicId).toBe('4242');
    expect(sent[0].sessionId).toBe('s1');
    expect(sent[0].text).toContain('Fix the Lifeline noise bug');
    expect(sent[0].text).toContain('Running the unit suite now.');
    expect(sent[0].text).toMatch(/Reply here/);
  });

  it('escalate (gate unsure) is LOG-ONLY, even for a named unattended run', () => {
    const { notifier, sent, logged } = makeNotifier();
    expect(notifier.maybeNotify(stall({ decision: 'escalate' }))).toBe('logged-unsure');
    expect(sent).toHaveLength(0);
    expect(logged).toHaveLength(1);
    expect(logged[0].sessionId).toBe('s1');
  });

  it('a stall with no resolved topic is LOG-ONLY (nowhere a reply could reach it)', () => {
    const { notifier, sent, logged } = makeNotifier();
    expect(notifier.maybeNotify(stall({ topicId: null }))).toBe('logged-unnamed');
    expect(sent).toHaveLength(0);
    expect(logged).toHaveLength(1);
  });

  it('a stall with no live run goal is LOG-ONLY (no named run)', () => {
    const { notifier, sent } = makeNotifier();
    expect(notifier.maybeNotify(stall({ runGoal: null }))).toBe('logged-unnamed');
    expect(notifier.maybeNotify(stall({ runGoal: '   ' }))).toBe('logged-unnamed');
    expect(sent).toHaveLength(0);
  });

  it('sends without the last-message line when there is no last activity', () => {
    const { notifier, sent } = makeNotifier();
    expect(notifier.maybeNotify(stall({ lastActivity: null }))).toBe('sent');
    expect(sent[0].text).not.toMatch(/last message/i);
  });

  it('sanitizes untrusted run text: one line, bounded, no backtick breakout', () => {
    const { notifier, sent } = makeNotifier();
    notifier.maybeNotify(stall({ runGoal: 'a`b\n\nc', lastActivity: 'x'.repeat(500) + '`' }));
    const text = sent[0].text;
    expect(text).toContain("`a'b c`");
    expect(text).not.toContain('x'.repeat(201));
    expect(text.split('\n')).toHaveLength(3);
  });

  it('does NOT send for a routine allow', () => {
    const { notifier, sent } = makeNotifier();
    expect(notifier.maybeNotify(stall({ decision: 'allow' }))).toBe('not-worthy');
    expect(sent).toHaveLength(0);
  });

  it('does NOT send for continue in enforce (session is blocked & continues)', () => {
    const { notifier, sent } = makeNotifier();
    expect(notifier.maybeNotify(stall({ mode: 'enforce' }))).toBe('not-worthy');
    expect(sent).toHaveLength(0);
  });

  it('attended-gate: skips an attended (non-autonomous) session by default', () => {
    const { notifier, sent } = makeNotifier();
    expect(notifier.maybeNotify(stall({ autonomousActive: false }))).toBe('skipped-attended');
    expect(sent).toHaveLength(0);
  });

  it('attended-gate off: notifies an attended session when unattendedOnly=false', () => {
    const { notifier, sent } = makeNotifier({ unattendedOnly: false });
    expect(notifier.maybeNotify(stall({ autonomousActive: false }))).toBe('sent');
    expect(sent).toHaveLength(1);
  });

  it('per-session dedup: a second worthy stop within the cooldown is suppressed', () => {
    let t = 1_000_000;
    const { notifier, sent } = makeNotifier({ cooldownMs: 1000 }, () => t);
    expect(notifier.maybeNotify(stall())).toBe('sent');
    t += 500;
    expect(notifier.maybeNotify(stall())).toBe('skipped-dedup');
    expect(sent).toHaveLength(1);
  });

  it('dedup expires after the cooldown window', () => {
    let t = 1_000_000;
    const { notifier, sent } = makeNotifier({ cooldownMs: 1000 }, () => t);
    notifier.maybeNotify(stall());
    t += 1500;
    expect(notifier.maybeNotify(stall())).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('dedup is per-session — a different session still notifies', () => {
    const { notifier, sent } = makeNotifier({ cooldownMs: 999999 });
    notifier.maybeNotify(stall());
    expect(notifier.maybeNotify(stall({ sessionId: 's2' }))).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('master disable: never sends or logs when enabled=false', () => {
    const { notifier, sent, logged } = makeNotifier({ enabled: false });
    expect(notifier.maybeNotify(stall())).toBe('disabled');
    expect(notifier.maybeNotify(stall({ decision: 'escalate' }))).toBe('disabled');
    expect(sent).toHaveLength(0);
    expect(logged).toHaveLength(0);
  });

  it('throwing sinks never propagate (best-effort)', () => {
    const notifier = new StopNotifier(
      {
        notifyTopic: () => { throw new Error('sink down'); },
        log: () => { throw new Error('disk full'); },
        now: () => 1,
      },
      {},
    );
    expect(() => notifier.maybeNotify(stall())).not.toThrow();
    expect(() => notifier.maybeNotify(stall({ decision: 'escalate' }))).not.toThrow();
  });
});
