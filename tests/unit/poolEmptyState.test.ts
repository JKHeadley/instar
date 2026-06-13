/**
 * WS4.2 (MULTI-MACHINE-SEAMLESSNESS-SPEC §WS4.2, F7) — per-machine empty-state
 * classifier. Both sides of EVERY decision boundary with realistic inputs:
 * online-idle vs offline (known) vs unreachable (surprise silence), and the
 * relative-time formatter.
 */
import { describe, it, expect } from 'vitest';
import {
  classifyMachineEmptyState,
  formatLastSeen,
  type MachineStateInput,
} from '../../src/server/poolEmptyState.js';

const NOW = Date.parse('2026-06-12T12:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('classifyMachineEmptyState — WS4.2 empty-state', () => {
  describe('online — no active sessions (idle but healthy)', () => {
    it('heartbeat-fresh AND the live fetch succeeded → online', () => {
      const input: MachineStateInput = {
        online: true,
        failedReason: null,
        routerReceivedAt: ago(5_000),
      };
      const state = classifyMachineEmptyState(input, NOW);
      expect(state.kind).toBe('online');
      expect(state.text).toBe('online — no active sessions');
    });

    it('online with no timestamps at all still classifies online (self machine)', () => {
      const state = classifyMachineEmptyState({ online: true, failedReason: null }, NOW);
      expect(state.kind).toBe('online');
      expect(state.text).toBe('online — no active sessions');
    });
  });

  describe('offline since <t> (known absence)', () => {
    it('registry says offline → offline, last-seen rendered', () => {
      const input: MachineStateInput = {
        online: false,
        failedReason: 'offline',
        routerReceivedAt: ago(2 * 60 * 60 * 1000), // 2h ago
      };
      const state = classifyMachineEmptyState(input, NOW);
      expect(state.kind).toBe('offline');
      expect(state.text).toBe('offline since 2h ago');
      expect(state.lastSeen).toBe(ago(2 * 60 * 60 * 1000));
    });

    it('registry offline with NO live fetch attempted (failedReason null) → still offline', () => {
      // The registry already knew the machine was offline, so the fan-out
      // skipped the doomed fetch entirely — !online is the decider, not a fetch
      // failure. This is the boundary that must NOT misread as online.
      const input: MachineStateInput = {
        online: false,
        failedReason: null,
        routerReceivedAt: ago(30 * 60 * 1000), // 30m ago
      };
      const state = classifyMachineEmptyState(input, NOW);
      expect(state.kind).toBe('offline');
      expect(state.text).toBe('offline since 30m ago');
    });

    it('no-known-url fan-out reason → offline (a machine with no URL is a known absence)', () => {
      const input: MachineStateInput = {
        online: false,
        failedReason: 'no-known-url',
        selfReportedLastSeen: ago(45 * 1000),
      };
      const state = classifyMachineEmptyState(input, NOW);
      expect(state.kind).toBe('offline');
      expect(state.text).toBe('offline since 45s ago');
    });

    it('offline machine with no last-seen renders "unknown", never a fabricated time', () => {
      const state = classifyMachineEmptyState({ online: false, failedReason: 'offline' }, NOW);
      expect(state.kind).toBe('offline');
      expect(state.text).toBe('offline since unknown');
      expect(state.lastSeen).toBeNull();
    });
  });

  describe('unreachable (last seen <t>) — was online, now not answering', () => {
    it('registry thought online but the live fetch TIMED OUT → unreachable', () => {
      const input: MachineStateInput = {
        online: true,
        failedReason: 'timeout',
        routerReceivedAt: ago(20 * 1000),
      };
      const state = classifyMachineEmptyState(input, NOW);
      expect(state.kind).toBe('unreachable');
      expect(state.text).toBe('unreachable (last seen 20s ago)');
    });

    it('registry online but the connection was refused → unreachable', () => {
      const input: MachineStateInput = {
        online: true,
        failedReason: 'unreachable',
        routerReceivedAt: ago(3 * 60 * 1000), // 3m ago
      };
      const state = classifyMachineEmptyState(input, NOW);
      expect(state.kind).toBe('unreachable');
      expect(state.text).toBe('unreachable (last seen 3m ago)');
    });

    it('registry online but the peer returned a 5xx error → unreachable (surprise silence)', () => {
      const input: MachineStateInput = {
        online: true,
        failedReason: 'error',
        routerReceivedAt: ago(10 * 1000),
      };
      const state = classifyMachineEmptyState(input, NOW);
      expect(state.kind).toBe('unreachable');
      expect(state.text).toContain('unreachable (last seen');
    });

    it('registry online but the peer rejected the token → unreachable (not silently fine)', () => {
      const input: MachineStateInput = {
        online: true,
        failedReason: 'unauthorized',
        routerReceivedAt: ago(15 * 1000),
      };
      const state = classifyMachineEmptyState(input, NOW);
      expect(state.kind).toBe('unreachable');
    });
  });

  describe('formatLastSeen', () => {
    it('null → "unknown" (never fabricated)', () => {
      expect(formatLastSeen(null, NOW)).toBe('unknown');
    });
    it('unparseable → "unknown"', () => {
      expect(formatLastSeen('not-a-date', NOW)).toBe('unknown');
    });
    it('seconds, minutes, hours, days buckets', () => {
      expect(formatLastSeen(ago(5_000), NOW)).toBe('5s ago');
      expect(formatLastSeen(ago(90 * 1000), NOW)).toBe('1m ago');
      expect(formatLastSeen(ago(3 * 60 * 60 * 1000), NOW)).toBe('3h ago');
      expect(formatLastSeen(ago(2 * 24 * 60 * 60 * 1000), NOW)).toBe('2d ago');
    });
    it('a future timestamp clamps to 0s (clock skew is never negative time)', () => {
      expect(formatLastSeen(new Date(NOW + 10_000).toISOString(), NOW)).toBe('0s ago');
    });
  });
});
