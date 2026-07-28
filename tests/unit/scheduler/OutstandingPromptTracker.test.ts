/**
 * OutstandingPromptTracker — anti-ping-pong tests (spec MENTOR-LIVE-READINESS §Fix 2b
 * item 4 + Justin's original concern).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  OutstandingPromptTracker,
  type OutstandingPromptTrackerOptions,
} from '../../../src/scheduler/OutstandingPromptTracker.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';

const NOW = 1_779_900_000_000;

describe('OutstandingPromptTracker', () => {
  let dir: string;
  let clock: number;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mentor-out-')); clock = NOW; });
  afterEach(() => { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'mentor-out test' }); });

  function mk(over: Partial<OutstandingPromptTrackerOptions> = {}): OutstandingPromptTracker {
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

  it('DELIVERY BRAKE: allows the first attempt for new mentor content', () => {
    const t = mk({ replyTimeoutMs: 5000 });
    const r = t.reserveSend('corr-1', 'instar-codey', 'May I use the default permission rule?');
    expect(r).toMatchObject({ ok: true, attempt: 1 });
    expect(t.size()).toBe(1);
  });

  it('DELIVERY BRAKE: suppresses identical unanswered content after the bounded attempt cap', () => {
    const t = mk({ replyTimeoutMs: 5000 });
    const content = 'May I use the default permission rule?';

    for (let attempt = 1; attempt <= 3; attempt++) {
      const r = t.reserveSend(`corr-${attempt}`, 'instar-codey', content);
      expect(r).toMatchObject({ ok: true, attempt });
      clock += 6000;
      t.sweepExpired();
    }

    expect(t.reserveSend('corr-4', 'instar-codey', content)).toMatchObject({
      ok: false,
      reason: 'identical-content-retry-exhausted',
      attempts: 3,
    });
  });

  it('DELIVERY BRAKE: allows a genuinely new agenda item while old content is suppressed', () => {
    const t = mk({ replyTimeoutMs: 5000 });
    const oldContent = 'May I use the default permission rule?';
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(t.reserveSend(`old-${attempt}`, 'instar-codey', oldContent).ok).toBe(true);
      clock += 6000;
      t.sweepExpired();
    }

    expect(t.reserveSend('old-4', 'instar-codey', oldContent).ok).toBe(false);
    expect(t.reserveSend('new-1', 'instar-codey', 'Please review the next bounded task.')).toMatchObject({
      ok: true,
      attempt: 1,
    });
  });

  it('DELIVERY BRAKE: survives a restart and escalates an exhausted content key once', () => {
    const content = 'May I use the default permission rule?';
    const t1 = mk({ replyTimeoutMs: 5000 });
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(t1.reserveSend(`corr-${attempt}`, 'instar-codey', content).ok).toBe(true);
      clock += 6000;
      t1.sweepExpired();
    }

    const denied = t1.reserveSend('corr-4', 'instar-codey', content);
    expect(denied).toMatchObject({
      ok: false,
      reason: 'identical-content-retry-exhausted',
      attempts: 3,
    });
    if (denied.ok) throw new Error('expected exhausted delivery brake');
    expect(t1.recordRetryExhaustionEscalated(denied.contentKey)).toBe(true);

    const t2 = mk({ replyTimeoutMs: 5000 });
    expect(t2.reserveSend('corr-after-restart', 'instar-codey', content)).toMatchObject({
      ok: false,
      reason: 'identical-content-retry-exhausted',
      attempts: 3,
    });
    expect(t2.recordRetryExhaustionEscalated(denied.contentKey)).toBe(false);
  });

  it('DELIVERY BRAKE: normalizes whitespace, persists only hashes, and bounds distinct keys', () => {
    const t = mk({ maxTrackedContentKeys: 2 });
    const sensitive = 'May I use the default permission rule?';
    const first = t.reserveSend('corr-a', 'instar-codey', sensitive);
    expect(first).toMatchObject({ ok: true, attempt: 1 });
    t.markDeliveryFailed('corr-a');

    const normalizedRepeat = t.reserveSend(
      'corr-b',
      'instar-codey',
      '  May I use the default   permission rule?  ',
    );
    expect(normalizedRepeat).toMatchObject({ ok: true, attempt: 2 });
    t.markDeliveryFailed('corr-b');

    expect(fs.readFileSync(path.join(dir, 'out.json'), 'utf-8')).not.toContain(sensitive);

    expect(t.reserveSend('corr-c', 'instar-codey', 'A second agenda item.').ok).toBe(true);
    t.markDeliveryFailed('corr-c');
    expect(t.reserveSend('corr-d', 'instar-codey', 'A third agenda item.')).toEqual({
      ok: false,
      reason: 'delivery-retry-ledger-full',
    });
  });

  it('CORRUPT FILE: starts fresh rather than crash the mentor', () => {
    fs.writeFileSync(path.join(dir, 'out.json'), '{not valid');
    const t = mk();
    expect(t.size()).toBe(0);
    t.markSent('corr-A', 'instar-codey'); // can still operate
    expect(t.canSendTo('instar-codey').ok).toBe(false);
  });
});
