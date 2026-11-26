import { expect, it, vi } from 'vitest';
import { runFirstPhoneWitnessObservation } from '../../src/core/FirstPhoneWitnessObservation.js';

it('does no work when disabled or stopped before startup', async () => {
  const controller = new AbortController();
  const observe = vi.fn(() => 'pending' as const);
  const report = vi.fn();
  const deps = { observe, report, intervalMs: 1000, signal: controller.signal };
  await runFirstPhoneWitnessObservation(deps);
  controller.abort();
  await runFirstPhoneWitnessObservation({ ...deps, enabled: true });
  expect(observe).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
});

it('reports a failed observation, retries, and shuts down during the wait', async () => {
  const controller = new AbortController();
  const observe = vi.fn<() => 'staged'>()
    .mockImplementationOnce(() => { throw new Error('fixture observation unavailable'); })
    .mockReturnValue('staged');
  const statuses: string[] = [];
  let sawStaged!: () => void;
  const staged = new Promise<void>(resolve => { sawStaged = resolve; });
  const loop = runFirstPhoneWitnessObservation({
    enabled: true, observe, intervalMs: 1000, signal: controller.signal,
    report(result) {
      statuses.push(result);
      if (result === 'staged') sawStaged();
    },
  });
  try {
    await staged;
    expect(statuses).toEqual(['error', 'staged']);
  } finally {
    controller.abort();
    await loop;
  }
  expect(observe).toHaveBeenCalledTimes(2);
});
