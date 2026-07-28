import { describe, it, expect } from 'vitest';
import { ApprenticeshipCycleSlaMonitor } from '../../src/monitoring/ApprenticeshipCycleSlaMonitor.js';
import type { ApprenticeshipCycleRecord } from '../../src/monitoring/ApprenticeshipCycleStore.js';

const NOW = new Date('2026-06-03T12:00:00.000Z');

function cycle(overrides: Partial<ApprenticeshipCycleRecord>): ApprenticeshipCycleRecord {
  return {
    id: 'cycle-1',
    instanceId: 'echo-to-codey',
    cycleNumber: 1,
    createdAt: '2026-06-03T09:00:00.000Z',
    task: 'task',
    menteeOutput: 'output',
    mentorFlagged: [],
    overseerDifferential: [],
    coaching: '',
    infraItems: [],
    kind: 'differential-cycle',
    status: 'open',
    ...overrides,
  };
}

describe('ApprenticeshipCycleSlaMonitor', () => {
  it('flags only open cycles older than the configured SLA', () => {
    const records = [
      cycle({ id: 'old-open', createdAt: '2026-06-03T09:30:00.000Z', status: 'open' }),
      cycle({ id: 'young-open', createdAt: '2026-06-03T11:00:00.000Z', status: 'open' }),
      cycle({ id: 'old-closed', createdAt: '2026-06-03T08:00:00.000Z', status: 'closed' }),
    ];
    const monitor = new ApprenticeshipCycleSlaMonitor({
      store: { list: () => records },
      config: { enabled: true, overdueAfterMinutes: 120 },
      now: () => NOW,
    });

    expect(monitor.listOverdue()).toEqual([
      {
        id: 'old-open',
        instanceId: 'echo-to-codey',
        cycleNumber: 1,
        ageMinutes: 150,
        createdAt: '2026-06-03T09:30:00.000Z',
      },
    ]);
  });

  it('passes instanceId through to the store list query', () => {
    let seenInstanceId: string | undefined;
    const monitor = new ApprenticeshipCycleSlaMonitor({
      store: {
        list: (opts) => {
          seenInstanceId = opts.instanceId;
          return [cycle({ id: 'old-open' })];
        },
      },
      config: { enabled: true, overdueAfterMinutes: 120 },
      now: () => NOW,
    });

    expect(monitor.listOverdue('specific-instance')).toHaveLength(1);
    expect(seenInstanceId).toBe('specific-instance');
  });

  it('raises one attention item per overdue cycle and dedupes across ticks', async () => {
    const raised: string[] = [];
    const monitor = new ApprenticeshipCycleSlaMonitor({
      store: { list: () => [cycle({ id: 'old-open' })] },
      config: { enabled: true, overdueAfterMinutes: 120 },
      now: () => NOW,
      raiseAttention: (item) => { raised.push(item.id); },
    });

    const first = await monitor.tick();
    const second = await monitor.tick();

    expect(first.raised).toEqual(['old-open']);
    expect(second.raised).toEqual([]);
    expect(raised).toEqual(['apprenticeship-cycle-overdue-old-open']);
  });

  it('is a no-op when disabled', async () => {
    const monitor = new ApprenticeshipCycleSlaMonitor({
      store: { list: () => [cycle({ id: 'old-open' })] },
      config: { enabled: false, overdueAfterMinutes: 120 },
      now: () => NOW,
      raiseAttention: () => { throw new Error('should not raise'); },
    });

    expect(monitor.listOverdue()).toEqual([]);
    await expect(monitor.tick()).resolves.toEqual({ enabled: false, overdue: [], raised: [] });
  });
});

