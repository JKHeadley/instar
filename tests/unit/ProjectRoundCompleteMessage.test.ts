/**
 * Unit tests for ProjectRoundCompleteMessage.
 *
 * Covers:
 *   - formatRoundCompleteMessage: required-field gate (presence, NOT
 *     non-emptiness), halt-flavor requires whatHalted, output shape.
 *   - idempotencyKeyFor: stable across input permutations.
 *   - RoundCompleteDeliveryHelper: 1st-attempt success, transient retry
 *     then success, non-transient bail, exhaustion triggers fallback,
 *     dedup ring suppresses repeat sends, on-disk persistence across
 *     instances.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  formatRoundCompleteMessage,
  idempotencyKeyFor,
  RoundCompleteDeliveryHelper,
  type RoundCompleteMessageInput,
  type SendResult,
} from '../../src/core/ProjectRoundCompleteMessage.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

function makeStateDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'rcm-'));
}

function validInput(): RoundCompleteMessageInput {
  return {
    projectId: 'demo-project',
    projectTitle: 'Demo Project',
    roundIndex: 0,
    projectVersion: 3,
    eventKind: 'round-complete',
    whatLanded: '• item-1: Alpha\n• item-2: Beta',
    evidenceCited: ['abc1234', 'def5678'],
    rootCauseHypothesis: '(none)',
    concreteNextStep: "Reply 'pause demo-project' within 24 hours to hold",
    brakeHandlePhrase: "pause demo-project",
  };
}

describe('formatRoundCompleteMessage', () => {
  it('returns ok with a non-empty message for a valid input', () => {
    const r = formatRoundCompleteMessage(validInput());
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('Round complete');
      expect(r.message).toContain('Demo Project');
      expect(r.message).toContain('What landed');
      expect(r.message).toContain('Next step');
      expect(r.message).toContain('To hold');
      expect(typeof r.idempotencyKey).toBe('string');
    }
  });

  it('rejects when whatLanded is undefined', () => {
    const input = validInput();
    delete (input as Partial<RoundCompleteMessageInput>).whatLanded;
    const r = formatRoundCompleteMessage(input as RoundCompleteMessageInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingFields).toContain('whatLanded');
  });

  it('accepts empty string for whatLanded (presence, not non-emptiness)', () => {
    const input = validInput();
    input.whatLanded = '';
    const r = formatRoundCompleteMessage(input);
    expect(r.ok).toBe(true);
  });

  it('requires whatHalted on round-halted events', () => {
    const input = validInput();
    input.eventKind = 'round-halted';
    const r = formatRoundCompleteMessage(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingFields).toContain('whatHalted');
  });

  it('requires whatHalted on round-failed events too', () => {
    const input = validInput();
    input.eventKind = 'round-failed';
    const r = formatRoundCompleteMessage(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missingFields).toContain('whatHalted');
  });

  it('produces a different message for halt events with whatHalted present', () => {
    const input = validInput();
    input.eventKind = 'round-halted';
    input.whatHalted = 'pre-flight FIRST_LAUNCH_ACK_REQUIRED';
    const r = formatRoundCompleteMessage(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('Round halted');
      expect(r.message).toContain('What halted');
      expect(r.message).toContain('pre-flight FIRST_LAUNCH_ACK_REQUIRED');
    }
  });

  it('omits the rootCauseHypothesis line when default is "(none)"', () => {
    const input = validInput();
    const r = formatRoundCompleteMessage(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).not.toContain('Root cause hypothesis');
    }
  });

  it('includes overrideLink when provided', () => {
    const input = validInput();
    input.overrideLink = 'https://example.invalid/dashboard#projects/demo';
    const r = formatRoundCompleteMessage(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.message).toContain('Dashboard:');
      expect(r.message).toContain(input.overrideLink);
    }
  });

  it('caps the evidence list at 10 items', () => {
    const input = validInput();
    input.evidenceCited = Array.from({ length: 25 }, (_, i) => `cite-${i}`);
    const r = formatRoundCompleteMessage(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      const matches = r.message.match(/cite-\d+/g) ?? [];
      expect(matches.length).toBe(10);
    }
  });
});

describe('idempotencyKeyFor', () => {
  it('keys differ when projectVersion changes', () => {
    const a = validInput();
    const b = { ...a, projectVersion: a.projectVersion + 1 };
    expect(idempotencyKeyFor(a)).not.toBe(idempotencyKeyFor(b));
  });
  it('keys differ when eventKind changes', () => {
    const a = validInput();
    const b = { ...a, eventKind: 'round-halted' as const };
    expect(idempotencyKeyFor(a)).not.toBe(idempotencyKeyFor(b));
  });
  it('keys differ when roundIndex changes', () => {
    const a = validInput();
    const b = { ...a, roundIndex: a.roundIndex + 1 };
    expect(idempotencyKeyFor(a)).not.toBe(idempotencyKeyFor(b));
  });
});

describe('RoundCompleteDeliveryHelper.sendOnce', () => {
  let dir: string;
  beforeEach(() => { dir = makeStateDir(); });
  afterEach(() => {
    try { SafeFsExecutor.safeRmSync(dir, { recursive: true, force: true, operation: 'tests/unit/ProjectRoundCompleteMessage.test.ts:afterEach' }); } catch { /* ignore */ }
  });

  it('first-attempt success records the key and returns sent:true', async () => {
    const helper = new RoundCompleteDeliveryHelper({ stateDir: dir });
    const sender = (): Promise<SendResult> => Promise.resolve({ ok: true });
    const r = await helper.sendOnce(validInput(), sender);
    expect(r.sent).toBe(true);
    expect(r.attempts.length).toBe(1);
    expect(r.idempotencyKey).toBeTruthy();
    expect(helper.hasSent(r.idempotencyKey!)).toBe(true);
  });

  it('subsequent calls with the same key short-circuit (no extra send)', async () => {
    const helper = new RoundCompleteDeliveryHelper({ stateDir: dir });
    let calls = 0;
    const sender = (): Promise<SendResult> => {
      calls++;
      return Promise.resolve({ ok: true });
    };
    await helper.sendOnce(validInput(), sender);
    const second = await helper.sendOnce(validInput(), sender);
    expect(calls).toBe(1);
    expect(second.alreadySent).toBe(true);
  });

  it('transient failure then success records exactly one attempt-failed + one attempt-ok', async () => {
    const helper = new RoundCompleteDeliveryHelper({ stateDir: dir, backoffBaseMs: 5 });
    let n = 0;
    const sender = (): Promise<SendResult> => {
      n++;
      if (n === 1) return Promise.resolve({ ok: false, transient: true, error: new Error('blip') });
      return Promise.resolve({ ok: true });
    };
    const r = await helper.sendOnce(validInput(), sender);
    expect(r.sent).toBe(true);
    expect(r.attempts).toHaveLength(2);
    expect(r.attempts[0].ok).toBe(false);
    expect(r.attempts[1].ok).toBe(true);
  });

  it('non-transient failure bails after one attempt and triggers fallback', async () => {
    const helper = new RoundCompleteDeliveryHelper({ stateDir: dir });
    const sender = (): Promise<SendResult> => Promise.resolve({ ok: false, transient: false, error: new Error('bad request') });
    let fallbackCalled = 0;
    const r = await helper.sendOnce(validInput(), sender, async () => { fallbackCalled++; });
    expect(r.sent).toBe(false);
    expect(r.attempts).toHaveLength(1);
    expect(r.fallbackTriggered).toBe(true);
    expect(fallbackCalled).toBe(1);
  });

  it('all-transient failure exhausts attempts and triggers fallback', async () => {
    const helper = new RoundCompleteDeliveryHelper({ stateDir: dir, maxAttempts: 3, backoffBaseMs: 5 });
    const sender = (): Promise<SendResult> => Promise.resolve({ ok: false, transient: true, error: new Error('timeout') });
    let fallbackCalled = 0;
    const r = await helper.sendOnce(validInput(), sender, async () => { fallbackCalled++; });
    expect(r.sent).toBe(false);
    expect(r.attempts).toHaveLength(3);
    expect(r.fallbackTriggered).toBe(true);
    expect(fallbackCalled).toBe(1);
  });

  it('persists dedup state across instances', async () => {
    const a = new RoundCompleteDeliveryHelper({ stateDir: dir });
    const r1 = await a.sendOnce(validInput(), () => Promise.resolve({ ok: true }));
    expect(r1.sent).toBe(true);
    // Fresh instance reads the dedup file.
    const b = new RoundCompleteDeliveryHelper({ stateDir: dir });
    expect(b.hasSent(r1.idempotencyKey!)).toBe(true);
    let calls = 0;
    const r2 = await b.sendOnce(validInput(), () => { calls++; return Promise.resolve({ ok: true }); });
    expect(calls).toBe(0);
    expect(r2.alreadySent).toBe(true);
  });

  it('does NOT record the key when send fails on every attempt', async () => {
    const helper = new RoundCompleteDeliveryHelper({ stateDir: dir, maxAttempts: 2, backoffBaseMs: 5 });
    const sender = (): Promise<SendResult> => Promise.resolve({ ok: false, transient: true, error: new Error('e') });
    await helper.sendOnce(validInput(), sender);
    // A retry with the same input + same projectVersion should not be
    // suppressed — the previous attempt was never confirmed sent.
    let calls = 0;
    const successSender = (): Promise<SendResult> => { calls++; return Promise.resolve({ ok: true }); };
    const r2 = await helper.sendOnce(validInput(), successSender);
    expect(calls).toBe(1);
    expect(r2.sent).toBe(true);
  });

  it('refuses delivery when the template rejects the input', async () => {
    const helper = new RoundCompleteDeliveryHelper({ stateDir: dir });
    const input = validInput();
    delete (input as Partial<RoundCompleteMessageInput>).whatLanded;
    let calls = 0;
    const r = await helper.sendOnce(input as RoundCompleteMessageInput, () => { calls++; return Promise.resolve({ ok: true }); });
    expect(r.sent).toBe(false);
    expect(calls).toBe(0);
  });
});
