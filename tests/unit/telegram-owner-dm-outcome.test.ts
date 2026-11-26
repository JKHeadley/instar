// Pairing waits for an owner DM only when the send can still land (fb-e6b7ee2b-a8c, second-pass review 2026-11-14).
import { describe, expect, it } from 'vitest';
import { TelegramAdapter } from '../../src/messaging/TelegramAdapter.js';
import { TelegramOriginService } from '../../src/messaging/telegram-origin/TelegramOriginService.js';
import { TelegramOriginHoldError } from '../../src/messaging/telegram-origin/types.js';
import { ORIGIN_LOCAL_REFUSAL_REASONS, ORIGIN_LEASE_REFUSAL_REASONS } from '../../src/messaging/telegram-origin/OriginEgressCapacity.js';

const HELD = TelegramAdapter.OWNER_DM_HELD;

describe('TelegramAdapter.ownerDMOutcome', () => {
  it('a retried hold with an operation id may still land', () => {
    expect(TelegramAdapter.ownerDMOutcome(new TelegramOriginHoldError('credential-capacity-unavailable', 'op-1'))).toBe(HELD);
    expect(TelegramAdapter.ownerDMOutcome(new TelegramOriginHoldError('execution-admission-unavailable', 'op-2'))).toBe(HELD);
  });
  it('a refusal that only carries the default "held" outcome is not waited for', () => {
    expect(TelegramAdapter.ownerDMOutcome(new TelegramOriginHoldError('unregistered-credential-owner'))).toBeNull(); // no operation id
    expect(TelegramAdapter.ownerDMOutcome(new TelegramOriginHoldError('origin-authority-revoked', 'op-3'))).toBeNull();
    expect(TelegramAdapter.ownerDMOutcome(new TelegramOriginHoldError('held-payload-capacity-unavailable', 'op-4'))).toBeNull();
  });
  it('an unknown outcome may already be with the owner; an unrecorded acceptance was delivered', () => {
    expect(TelegramAdapter.ownerDMOutcome(new TelegramOriginHoldError('timeout', 'op-5', 'outcome-unknown'))).toBe(HELD);
    expect(TelegramAdapter.ownerDMOutcome(new TelegramOriginHoldError('unrecorded', 'op-6', 'accepted-unrecorded', { messageId: '777', topicId: null, fallbackRecorded: true }))).toBe(777);
  });
  it('a known failure (bot blocked, no private chat) stays a failure; other errors are null', () => {
    expect(TelegramAdapter.ownerDMOutcome(new TelegramOriginHoldError('telegram-403', 'op-7', 'known-failed'))).toBeNull();
    expect(TelegramAdapter.ownerDMOutcome(new Error('boom'))).toBeNull();
  });
  it('covers every reason the origin service retries', () => {
    for (const r of TelegramOriginService.RECOVERABLE_HOLD_REASONS) expect(TelegramAdapter.OWNER_DM_RETRIED_HOLDS).toContain(r);
    // lease-freshness-lapse-retry — every request-bound local refusal is retried from its durable row too.
    for (const r of ORIGIN_LOCAL_REFUSAL_REASONS) expect(TelegramAdapter.OWNER_DM_RETRIED_HOLDS).toContain(r);
    for (const r of ORIGIN_LEASE_REFUSAL_REASONS) expect(ORIGIN_LOCAL_REFUSAL_REASONS).toContain(r);
    expect(ORIGIN_LOCAL_REFUSAL_REASONS).toContain('credential-capacity-unavailable');
  });
  it('a reply held for the lease at the send boundary may still land', () => {
    expect(TelegramAdapter.ownerDMOutcome(new TelegramOriginHoldError('lease-freshness-lapsed', 'op-8'))).toBe(HELD);
    expect(TelegramAdapter.ownerDMOutcome(new TelegramOriginHoldError('lease-not-held-at-send', 'op-9'))).toBe(HELD);
  });
});
