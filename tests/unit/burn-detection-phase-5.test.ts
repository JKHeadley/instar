/**
 * Unit tests — Burn-detection Phase 5 (principal-bound buttons + wiring).
 *
 * Covers the Phase 5 deliverables from docs/specs/token-burn-detection-and-self-heal.md:
 *   - HMAC-signed callback_data (forge rejection)
 *   - Principal verification (user_id ∈ authorizedUserIds)
 *   - Signal-id freshness check (replay rejection)
 *   - Release / Snooze / Extend / Investigate actions
 *   - Runbook honours snooze state (alert-only-snoozed outcome)
 *   - Subscriber wiring: registers as a feature='token-burn-detection' healer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';

import { LlmRateGate } from '../../src/monitoring/LlmRateGate.js';
import { BurnAlertButtons } from '../../src/monitoring/BurnAlertButtons.js';
import { BurnThrottleRunbook, RUNBOOK_ISSUER } from '../../src/monitoring/BurnThrottleRunbook.js';
import { registerBurnDetectionSubscriber, BURN_DETECTION_FEATURE } from '../../src/monitoring/BurnDetectionSubscriber.js';
import type { DegradationEvent } from '../../src/monitoring/DegradationReporter.js';

const JUSTIN_USER_ID = 7812716706;
const STRANGER_USER_ID = 9999999999;

function makeBurnEvent(opts: { attributionKey: string }): DegradationEvent {
  return {
    feature: 'token-burn-detection',
    primary: `attribution_key ${opts.attributionKey} sustained spend within thresholds`,
    fallback: 'signal-only',
    reason: `${opts.attributionKey} consumed 73.0% of 24h spend (threshold 25%)`,
    impact: 'Projected 3,000,000,000 tokens in next 24h at current rate.',
    timestamp: '2026-05-15T23:00:00Z',
    reported: false,
    alerted: false,
  };
}

// ── BurnAlertButtons — principal binding + HMAC + freshness ──────────

describe('BurnAlertButtons — principal-bound callbacks', () => {
  let gate: LlmRateGate;
  let buttons: BurnAlertButtons;
  let now: number;
  let key: Buffer;

  beforeEach(() => {
    now = 1_000_000_000_000;
    key = crypto.randomBytes(32);
    gate = new LlmRateGate({ now: () => now });
    buttons = new BurnAlertButtons({
      capabilityKey: key,
      authorizedUserIds: [JUSTIN_USER_ID],
      gate,
      now: () => now,
    });
  });

  it('release action revokes an active throttle when caller is authorized', () => {
    gate.installThrottle({
      attributionKey: 'InputDetector::aa',
      durationMs: 60_000,
      reason: '',
      issuer: RUNBOOK_ISSUER,
      signalId: 'sig-1',
    });
    const cb = buttons.encodeCallbackData({ action: 'release', attributionKey: 'InputDetector::aa', signalId: 'sig-1' });
    const result = buttons.handle({ callbackData: cb, fromUserId: JUSTIN_USER_ID });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('accepted');
    expect(gate.shouldFire('InputDetector::aa')).toBe(true); // throttle released
  });

  it('rejects unauthorized principal (stranger Telegram user_id)', () => {
    const cb = buttons.encodeCallbackData({ action: 'release', attributionKey: 'X::y', signalId: 'sig-2' });
    const result = buttons.handle({ callbackData: cb, fromUserId: STRANGER_USER_ID });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('principal-not-authorized');
  });

  it('rejects tampered callback_data (HMAC mismatch)', () => {
    const valid = buttons.encodeCallbackData({ action: 'release', attributionKey: 'X::y', signalId: 'sig-3' });
    // Tamper: swap action label, keep the same signature.
    const parts = valid.split('|');
    const tampered = `snooze-24h|${parts[1]}|${parts[2]}|${parts[3]}`;
    const result = buttons.handle({ callbackData: tampered, fromUserId: JUSTIN_USER_ID });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('invalid-signature');
  });

  it('rejects replayed signal-id-action pair (freshness check)', () => {
    const cb = buttons.encodeCallbackData({ action: 'release', attributionKey: 'X::y', signalId: 'sig-replay' });
    const first = buttons.handle({ callbackData: cb, fromUserId: JUSTIN_USER_ID });
    expect(first.ok).toBe(true);
    const second = buttons.handle({ callbackData: cb, fromUserId: JUSTIN_USER_ID });
    expect(second.ok).toBe(false);
    expect(second.reason).toBe('signal-id-replayed');
  });

  it('snooze-24h records the snooze and revokes any active throttle', () => {
    gate.installThrottle({
      attributionKey: 'Surge::aa',
      durationMs: 60_000,
      reason: '',
      issuer: RUNBOOK_ISSUER,
      signalId: 'sig-pre',
    });
    const cb = buttons.encodeCallbackData({ action: 'snooze-24h', attributionKey: 'Surge::aa', signalId: 'sig-snooze' });
    const result = buttons.handle({ callbackData: cb, fromUserId: JUSTIN_USER_ID });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('snooze-recorded');
    expect(buttons.isSnoozed('Surge::aa')).toBe(true);
    expect(gate.shouldFire('Surge::aa')).toBe(true); // throttle released as part of snooze
  });

  it('snooze auto-expires after 24h', () => {
    const cb = buttons.encodeCallbackData({ action: 'snooze-24h', attributionKey: 'Z::y', signalId: 'sig-z' });
    buttons.handle({ callbackData: cb, fromUserId: JUSTIN_USER_ID });
    expect(buttons.isSnoozed('Z::y')).toBe(true);
    now += 24 * 60 * 60 * 1000 + 1;
    expect(buttons.isSnoozed('Z::y')).toBe(false);
  });

  it('extend re-installs a throttle for another hour', () => {
    gate.installThrottle({
      attributionKey: 'EX::tend',
      durationMs: 60_000,
      reason: '',
      issuer: RUNBOOK_ISSUER,
      signalId: 'sig-orig',
    });
    const cb = buttons.encodeCallbackData({ action: 'extend', attributionKey: 'EX::tend', signalId: 'sig-orig' });
    const result = buttons.handle({ callbackData: cb, fromUserId: JUSTIN_USER_ID });
    expect(result.ok).toBe(true);
    expect(gate.shouldFire('EX::tend')).toBe(false);
    const active = gate.listActiveThrottles().find((t) => t.attributionKey === 'EX::tend')!;
    expect(active.reason).toMatch(/User-initiated extension/);
  });

  it('extend fails gracefully if no throttle is active', () => {
    const cb = buttons.encodeCallbackData({ action: 'extend', attributionKey: 'NoThrottle::x', signalId: 'sig-ne' });
    const result = buttons.handle({ callbackData: cb, fromUserId: JUSTIN_USER_ID });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('extend-failed-not-throttled');
  });

  it('investigate is informational — no state change', () => {
    const cb = buttons.encodeCallbackData({ action: 'investigate', attributionKey: 'Foo::bar', signalId: 'sig-i' });
    const result = buttons.handle({ callbackData: cb, fromUserId: JUSTIN_USER_ID });
    expect(result.ok).toBe(true);
    expect(result.reason).toBe('accepted');
  });

  it('malformed callback_data is rejected', () => {
    const result = buttons.handle({ callbackData: 'not-a-valid-payload', fromUserId: JUSTIN_USER_ID });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('malformed-payload');
  });

  it('buildKeyboard produces four buttons with valid signatures', () => {
    const kb = buttons.buildKeyboard('Foo::bar', 'sig-kb');
    expect(kb).toHaveLength(4);
    expect(kb.map((b) => b.text).sort()).toEqual(['Extend +1h', 'Investigate', 'Release', 'Snooze 24h']);
    // Every button's callback_data is verifiable.
    for (const btn of kb) {
      const result = buttons.handle({ callbackData: btn.callback_data, fromUserId: JUSTIN_USER_ID });
      // 'release' and 'extend' will fail because no throttle is active — that's
      // fine; we only care the signature passes and the action is recognized.
      expect(['accepted', 'snooze-recorded', 'extend-failed-not-throttled']).toContain(result.reason);
    }
  });
});

// ── Runbook honours snoozed state ──────────────────────────────────

describe('BurnThrottleRunbook — Phase 5 snooze honoring', () => {
  it('returns alert-only-snoozed when the key is currently snoozed', () => {
    const gate = new LlmRateGate({ now: () => 1 });
    const messages: string[] = [];
    const snoozed = new Set(['InputDetector::aa']);
    const runbook = new BurnThrottleRunbook({
      gate,
      sendTelegram: (_, m) => messages.push(m),
      isSnoozed: (k) => snoozed.has(k),
      now: () => 1,
    });
    const out = runbook.handle(makeBurnEvent({ attributionKey: 'InputDetector::aa' }));
    expect(out.kind).toBe('alert-only-snoozed');
    expect(gate.shouldFire('InputDetector::aa')).toBe(true); // not throttled
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(/snoozed/i);
  });

  it('still throttles when key is NOT snoozed (default behavior unchanged)', () => {
    const gate = new LlmRateGate({ now: () => 1 });
    const runbook = new BurnThrottleRunbook({
      gate,
      sendTelegram: () => {},
      isSnoozed: () => false,
      now: () => 1,
    });
    const out = runbook.handle(makeBurnEvent({ attributionKey: 'InputDetector::aa' }));
    expect(out.kind).toBe('throttle-installed');
  });
});

// ── Subscriber wiring ───────────────────────────────────────────────

describe('registerBurnDetectionSubscriber', () => {
  it('registers the runbook as a healer for token-burn-detection feature', async () => {
    const gate = new LlmRateGate({ now: () => 1 });
    const runbook = new BurnThrottleRunbook({ gate, sendTelegram: () => {}, now: () => 1 });

    const registered = new Map<string, Function>();
    const fakeReporter = {
      registerHealer: (feature: string, healer: Function) => { registered.set(feature, healer); },
    };

    let lastOutcome: any = null;
    registerBurnDetectionSubscriber(fakeReporter as any, runbook, (o) => { lastOutcome = o; });
    expect(registered.has(BURN_DETECTION_FEATURE)).toBe(true);

    const healer = registered.get(BURN_DETECTION_FEATURE)!;
    const result = await healer(makeBurnEvent({ attributionKey: 'InputDetector::xx' }));
    expect(result).toBe(true); // throttle-installed → healer "succeeded"
    expect(lastOutcome.kind).toBe('throttle-installed');
    expect(gate.shouldFire('InputDetector::xx')).toBe(false);
  });

  it('healer returns false for alert-only outcomes (the action was an alert, not a heal)', async () => {
    const gate = new LlmRateGate({ now: () => 1 });
    const runbook = new BurnThrottleRunbook({ gate, sendTelegram: () => {}, config: { autoThrottle: false }, now: () => 1 });

    const registered = new Map<string, Function>();
    const fakeReporter = {
      registerHealer: (feature: string, h: Function) => { registered.set(feature, h); },
    };
    registerBurnDetectionSubscriber(fakeReporter as any, runbook);
    const healer = registered.get(BURN_DETECTION_FEATURE)!;
    const result = await healer(makeBurnEvent({ attributionKey: 'X::y' }));
    expect(result).toBe(false);
  });
});
