/**
 * Unit tests for resolveSentinelScanIntervalMs — Phase 0b of the
 * topic-intent-layer thread (Telegram 9976).
 *
 * The periodic SessionActivitySentinel scan is gated by this resolver:
 * it computes the interval from config, applies the 5-minute floor, the
 * 30-minute default, and the disabled signal. Server bootstrap can't be
 * unit-tested directly, so the policy lives in this pure function.
 */
import { describe, expect, it } from 'vitest';
import { resolveSentinelScanIntervalMs } from '../../src/monitoring/SessionActivitySentinel.js';

describe('resolveSentinelScanIntervalMs', () => {
  it('defaults to 30 minutes when no config is provided', () => {
    expect(resolveSentinelScanIntervalMs()).toBe(30 * 60_000);
    expect(resolveSentinelScanIntervalMs({})).toBe(30 * 60_000);
  });

  it('returns null when explicitly disabled', () => {
    expect(resolveSentinelScanIntervalMs({ enabled: false })).toBeNull();
    // enabled: false overrides any interval.
    expect(resolveSentinelScanIntervalMs({ enabled: false, scanIntervalMinutes: 10 })).toBeNull();
  });

  it('treats enabled:true and enabled:undefined as on', () => {
    expect(resolveSentinelScanIntervalMs({ enabled: true })).toBe(30 * 60_000);
    expect(resolveSentinelScanIntervalMs({ scanIntervalMinutes: 45 })).toBe(45 * 60_000);
  });

  it('honors a custom interval', () => {
    expect(resolveSentinelScanIntervalMs({ scanIntervalMinutes: 60 })).toBe(60 * 60_000);
    expect(resolveSentinelScanIntervalMs({ scanIntervalMinutes: 15 })).toBe(15 * 60_000);
  });

  it('clamps below the 5-minute floor', () => {
    // A too-frequent cadence wastes LLM budget; floor protects against it.
    expect(resolveSentinelScanIntervalMs({ scanIntervalMinutes: 1 })).toBe(5 * 60_000);
    expect(resolveSentinelScanIntervalMs({ scanIntervalMinutes: 0 })).toBe(5 * 60_000);
    expect(resolveSentinelScanIntervalMs({ scanIntervalMinutes: -10 })).toBe(5 * 60_000);
  });

  it('allows exactly the floor', () => {
    expect(resolveSentinelScanIntervalMs({ scanIntervalMinutes: 5 })).toBe(5 * 60_000);
  });
});
