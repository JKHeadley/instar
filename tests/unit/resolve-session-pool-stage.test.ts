/**
 * Unit tests for resolveSessionPoolStage — the single source of truth for the
 * Multi-Machine Session Pool rollout stage, shared by BOTH the boot-time
 * inbound-queue construction gate AND the live `_sessionPoolStage` getter in
 * server.ts (boot-order-fix: the two used to be hand-duplicated, and the
 * construction gate read a not-yet-wired stub that always returned 'dark',
 * keeping the inbound queue engine null forever even when correctly configured).
 *
 * Decision boundary: a stage is returned ONLY when the pool is BOTH enabled AND
 * carries a stage; every other shape → 'dark' (inert default).
 */
import { describe, it, expect } from 'vitest';
import { resolveSessionPoolStage } from '../../src/core/inboundQueueConfig.js';

describe('resolveSessionPoolStage', () => {
  it('enabled + stage → returns the configured stage', () => {
    expect(resolveSessionPoolStage({ enabled: true, stage: 'live-transfer' })).toBe('live-transfer');
    expect(resolveSessionPoolStage({ enabled: true, stage: 'shadow' })).toBe('shadow');
  });

  it('enabled but MISSING stage → dark (a half-configured pool is inert, never a crash)', () => {
    expect(resolveSessionPoolStage({ enabled: true })).toBe('dark');
    expect(resolveSessionPoolStage({ enabled: true, stage: undefined })).toBe('dark');
    expect(resolveSessionPoolStage({ enabled: true, stage: '' })).toBe('dark');
  });

  it('disabled (regardless of stage) → dark', () => {
    expect(resolveSessionPoolStage({ enabled: false, stage: 'live-transfer' })).toBe('dark');
    expect(resolveSessionPoolStage({ stage: 'live-transfer' })).toBe('dark'); // enabled absent
    expect(resolveSessionPoolStage({ enabled: false })).toBe('dark');
  });

  it('empty / null / undefined config → dark (the production default state)', () => {
    expect(resolveSessionPoolStage({})).toBe('dark');
    expect(resolveSessionPoolStage(null)).toBe('dark');
    expect(resolveSessionPoolStage(undefined)).toBe('dark');
  });

  it('coerces a non-string stage to a string (defensive — config is untrusted)', () => {
    // A numeric/odd stage value never crashes the gate; it stringifies.
    expect(resolveSessionPoolStage({ enabled: true, stage: 42 as unknown as string })).toBe('42');
  });
});

describe('inboundQueuePoolGateOpen — the queue follows the pool switch, not its rollout stage (CMT-1117)', () => {
  it('open whenever the pool is enabled, at EVERY stage including dark', async () => {
    const { inboundQueuePoolGateOpen } = await import('../../src/core/inboundQueueConfig.js');
    for (const stage of ['dark', 'shadow', 'live-transfer', 'rebalance', undefined]) {
      expect(inboundQueuePoolGateOpen({ enabled: true, stage })).toBe(true);
    }
  });
  it('closed when the pool is disabled or the block is absent', async () => {
    const { inboundQueuePoolGateOpen } = await import('../../src/core/inboundQueueConfig.js');
    expect(inboundQueuePoolGateOpen({ enabled: false, stage: 'live-transfer' })).toBe(false);
    expect(inboundQueuePoolGateOpen({ stage: 'shadow' })).toBe(false);
    expect(inboundQueuePoolGateOpen(undefined)).toBe(false);
    expect(inboundQueuePoolGateOpen(null)).toBe(false);
  });
});
