/**
 * OutstandingPromptTracker — anti-ping-pong tests (spec MENTOR-LIVE-READINESS §Fix 2b
 * item 4 + Justin's original concern).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { OutstandingPromptTracker } from '../../../src/scheduler/OutstandingPromptTracker.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const NOW = 1_779_900_000_000;

describe('OutstandingPromptTracker', () => {
  let dir: string;
  let clock: number;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-out-')); clock = NOW; });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'mentor-out test' }); });

  function mk(over: { replyTimeoutMs?: number } = {}): OutstandingPromptTracker {
    return new OutstandingPromptTracker({
      filePath: path.join(dir, 'out.json'),
      now: () => clock,
      ...over,
    });
  }

  it('starts empty + canSendTo returns ok', () => {
    const t = mk();
    expect(t.canSendTo('instar-codey')).toEqual({ ok: true });
    expect(t.size()).toBe(0);
  });

  it('ANTI-PING-PONG: markSent makes the next canSendTo return prior-prompt-in-flight', () => {
    const t = mk();
    t.markSent('corr-1', 'instar-codey');
    const r = t.canSendTo('instar-codey');
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('prior-prompt-in-flight');
      expect(r.outstandingCorr).toBe('corr-1');
      expect(r.sentAt).toBe(NOW);
    }
  });

  it('clearByCorr lets the next send proceed (reply arrived)', () => {
    const t = mk();
    t.markSent('corr-1', 'instar-codey');
    expect(t.clearByCorr('corr-1')).toBe(true);
    expect(t.canSendTo('instar-codey')).toEqual({ ok: true });
  });

  it('clearByCorr on a non-existent corr returns false (spurious / late reply)', () => {
    const t = mk();
    expect(t.clearByCorr('never-sent')).toBe(false);
  });

  it('different mentee is NOT blocked by another mentee\'s outstanding', () => {
    const t = mk();
    t.markSent('corr-1', 'instar-codey');
    expect(t.canSendTo('instar-other-agent')).toEqual({ ok: true });
  });

  it('PERSISTENCE: survives a re-open (server restart doesn\'t lose in-flight state)', () => {
    const t1 = mk();
    t1.markSent('corr-1', 'instar-codey');
    const t2 = mk();
    expect(t2.canSendTo('instar-codey').ok).toBe(false);
  });

  it('REPLY TIMEOUT: an aged outstanding is swept + canSend becomes ok (next tick allowed)', () => {
    const t = mk({ replyTimeoutMs: 5000 });
    t.markSent('corr-1', 'instar-codey');
    clock += 6000;
    expect(t.canSendTo('instar-codey').ok).toBe(true);
    expect(t.size()).toBe(0);
  });

  it('sweepExpired surfaces orphans for the caller to notify on', () => {
    const t = mk({ replyTimeoutMs: 5000 });
    t.markSent('orphan-1', 'instar-codey');
    t.markSent('fresh-1', 'instar-codey-2');
    clock += 6000;
    t.markSent('really-fresh', 'instar-codey-3');
    const orphans = t.sweepExpired();
    expect(orphans.map((o) => o.corr).sort()).toEqual(['fresh-1', 'orphan-1']); // both aged past 5s
    expect(t.size()).toBe(1); // only really-fresh remains
  });

  it('recordOrphanNotified is idempotent (don\'t re-spam the same orphan-episode)', () => {
    const t = mk();
    expect(t.recordOrphanNotified('corr-X')).toBe(true);
    expect(t.recordOrphanNotified('corr-X')).toBe(false);
    expect(t.recordOrphanNotified('corr-Y')).toBe(true);
  });

  it('CORRUPT FILE: starts fresh rather than crash the mentor', () => {
    fs.writeFileSync(path.join(dir, 'out.json'), '{not valid');
    const t = mk();
    expect(t.size()).toBe(0);
    t.markSent('corr-A', 'instar-codey'); // can still operate
    expect(t.canSendTo('instar-codey').ok).toBe(false);
  });
});
