import { describe, it, expect } from 'vitest';
import { buildMultiMachineCapstoneMatrix } from '../../src/core/multiMachineCapstoneMatrix.js';

describe('buildMultiMachineCapstoneMatrix (§7.5 capstone scenario matrix)', () => {
  const base = { targetMachine: 'mini-001', telegramTopicId: '13481', message: 'probe' };

  it('telegram-only: builds the seven §7.5 scenarios with the right risk categories', () => {
    const m = buildMultiMachineCapstoneMatrix(base);
    expect(m.featureId).toBe('multi-machine-transfer');
    expect(m.surfaces).toEqual(['telegram']);
    expect(m.scenarios).toHaveLength(7);
    const ids = m.scenarios.map((s) => s.id);
    expect(ids).toEqual([
      'mm-idle-move-telegram-reply-from-target',
      'mm-active-drain-telegram-reply-from-target',
      'mm-reverse-move-telegram-reply-from-target',
      'mm-offline-target-safe-refusal',
      'mm-crash-mid-move-single-owner',
      'mm-false-positive-guard-regression',
      'mm-repeat-transfer-idempotency',
    ]);
    // The eight §7.5 categories collapse to five distinct telegram-only ones here
    // (happy-path, lifecycle, failure-rollback, regression, idempotency).
    expect(new Set(m.riskCategories)).toEqual(
      new Set(['happy-path', 'lifecycle', 'failure-rollback', 'regression', 'idempotency']),
    );
    const cats = new Set(m.scenarios.map((s) => s.riskCategory));
    expect(cats.has('happy-path')).toBe(true);
    expect(cats.has('lifecycle')).toBe(true);
    expect(cats.has('failure-rollback')).toBe(true);
    expect(cats.has('regression')).toBe(true);
    expect(cats.has('idempotency')).toBe(true);
  });

  it('every move-to-target scenario asserts the reply came FROM the target machine', () => {
    const m = buildMultiMachineCapstoneMatrix(base);
    for (const s of m.scenarios) {
      expect(s.expect.responderMachine).toBe('mini-001');
      expect(s.expect.replyNotEmpty).toBe(true);
      expect(s.input).toBe('probe');
    }
  });

  it('every scenario is SAFE-volatility (no destructive op; they assert transfer honesty)', () => {
    const m = buildMultiMachineCapstoneMatrix(base);
    for (const s of m.scenarios) expect(s.volatility).toBe('safe');
  });

  it('telegram scenarios all target the given telegram topic', () => {
    const m = buildMultiMachineCapstoneMatrix(base);
    for (const s of m.scenarios.filter((x) => x.surface === 'telegram')) {
      expect(s.channelId).toBe('13481');
    }
  });

  it('with slackChannelId: adds the channel-parity scenario + slack surface + category', () => {
    const m = buildMultiMachineCapstoneMatrix({ ...base, slackChannelId: 'C0DEMO' });
    expect(m.surfaces).toEqual(['telegram', 'slack']);
    expect(m.riskCategories).toContain('channel-parity');
    expect(m.scenarios).toHaveLength(8);
    const slack = m.scenarios.find((s) => s.surface === 'slack');
    expect(slack).toBeDefined();
    expect(slack!.id).toBe('mm-channel-parity-slack-reply-from-target');
    expect(slack!.riskCategory).toBe('channel-parity');
    expect(slack!.channelId).toBe('C0DEMO');
    expect(slack!.expect.responderMachine).toBe('mini-001');
  });

  it('honors timeoutMs on every scenario when provided, omits otherwise', () => {
    const withTmo = buildMultiMachineCapstoneMatrix({ ...base, slackChannelId: 'C0DEMO', timeoutMs: 5000 });
    for (const s of withTmo.scenarios) expect(s.timeoutMs).toBe(5000);
    const without = buildMultiMachineCapstoneMatrix(base);
    for (const s of without.scenarios) expect(s.timeoutMs).toBeUndefined();
  });

  it('respects a custom featureId', () => {
    const m = buildMultiMachineCapstoneMatrix({ ...base, featureId: 'my-feature' });
    expect(m.featureId).toBe('my-feature');
  });

  it('is deterministic (same inputs → identical matrix)', () => {
    const a = buildMultiMachineCapstoneMatrix({ ...base, slackChannelId: 'C0DEMO', timeoutMs: 1000 });
    const b = buildMultiMachineCapstoneMatrix({ ...base, slackChannelId: 'C0DEMO', timeoutMs: 1000 });
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
});
