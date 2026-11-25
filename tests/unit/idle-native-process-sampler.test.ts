import { describe, expect, it, vi } from 'vitest';
import { IdleNativeProcessCache } from '../../src/core/IdleNativeProcessCache.js';
import {
  findPaneNativeProcess, sampleIdleNativeProcess, type IdleNativePaneSnapshot,
  type IdleNativeProcessRow,
} from '../../src/core/IdleNativeProcessSampler.js';

const binding = {
  sessionId: 'session', topicKey: 'topic', ownerMachineId: 'owner', ownerEpoch: '1', paneId: '%7', launchId: 'launch',
};
const pane: IdleNativePaneSnapshot = { binding, panePid: 10, nativeExecutable: '/tool/codex', paneStartToken: 'pane-start', wrapperExecutables: ['/bin/sh', '/tool/launcher'], launchedNative: { pid: 11, kernelStartToken: 'native-start' } };
const root: IdleNativeProcessRow = { pid: 10, parentPid: 1, executable: '/bin/sh', kernelStartToken: 'pane-start' };
const native: IdleNativeProcessRow = { pid: 11, parentPid: 10, executable: '/tool/codex', kernelStartToken: 'native-start' };
const rows = [root, native];

describe('idle native process sampler', () => {
  it('selects only a native executable in the exact pane tree', () => {
    expect(findPaneNativeProcess(pane, [
      ...rows, { ...native, pid: 23, parentPid: 2 }, { ...native, pid: 24, executable: '/tool/codex-other' },
    ])).toMatchObject([{ pid: 11, kernelStartToken: 'native-start' }]);
    expect(findPaneNativeProcess(pane, [{ ...root, kernelStartToken: 'replacement' }, native])).toEqual([]);
    expect(findPaneNativeProcess(pane, [...rows, { ...native }])).toEqual([]);
  });

  it('requires a trusted native handshake for wrapped launches and accepts a bound direct exec', () => {
    expect(findPaneNativeProcess({ ...pane, launchedNative: undefined }, rows)).toEqual([]);
    expect(findPaneNativeProcess(pane, [root, { ...native, kernelStartToken: 'replacement-child' }])).toEqual([]);
    expect(findPaneNativeProcess({ ...pane, launchedNative: undefined }, [{
      ...root, executable: pane.nativeExecutable,
    }])).toMatchObject([{ pid: 10, kernelStartToken: 'pane-start' }]);
  });

  it('publishes proof only after matching process and custody samples', async () => {
    const cache = new IdleNativeProcessCache(30);
    const readPane = vi.fn(async () => pane);
    expect(await sampleIdleNativeProcess(cache, binding, {
      readPane, readProcesses: async () => rows, now: () => 1,
    })).toBe(true);
    expect(readPane).toHaveBeenCalledTimes(3);
    expect(cache.read(binding, 2)).toContain('native-start');
  });

  it('rejects a PID reused between process samples', async () => {
    const cache = new IdleNativeProcessCache(30);
    const readProcesses = vi.fn()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([root, { ...native, kernelStartToken: 'new-process' }]);
    expect(await sampleIdleNativeProcess(cache, binding, {
      readPane: async () => pane, readProcesses, now: () => 1,
    })).toBe(false);
    expect(cache.read(binding, 2)).toBeNull();
  });

  it('rejects an unknown wrapper and detects a trusted intermediate wrapper PID reuse', async () => {
    const wrapper = { pid: 13, parentPid: 10, executable: '/tool/launcher', kernelStartToken: 'wrapper' };
    const descendant = { ...native, parentPid: 13 };
    expect(findPaneNativeProcess(pane, [root, { ...wrapper, executable: '/other/helper' }, descendant])).toEqual([]);

    const readProcesses = vi.fn()
      .mockResolvedValueOnce([root, wrapper, descendant])
      .mockResolvedValueOnce([root, { ...wrapper, kernelStartToken: 'wrapper-replaced' }, descendant]);
    const cache = new IdleNativeProcessCache(30);
    expect(await sampleIdleNativeProcess(cache, binding, {
      readPane: async () => pane, readProcesses, now: () => 1,
    })).toBe(false);
  });

  it('rejects a moved owner after the final process read', async () => {
    const cache = new IdleNativeProcessCache(30);
    const readPane = vi.fn().mockResolvedValueOnce(pane).mockResolvedValueOnce(pane)
      .mockResolvedValueOnce({ ...pane, binding: { ...binding, ownerMachineId: 'new-owner' } });
    expect(await sampleIdleNativeProcess(cache, binding, {
      readPane, readProcesses: async () => rows, now: () => 1,
    })).toBe(false);
  });

  it('keeps the first pane snapshot stable across changes to the producer cache', async () => {
    const shared = { ...pane };
    let reads = 0;
    const cache = new IdleNativeProcessCache(30);
    expect(await sampleIdleNativeProcess(cache, binding, {
      readPane: async () => {
        if (++reads === 2) shared.binding = { ...binding, ownerEpoch: '2' };
        if (reads === 3) shared.binding = binding;
        return shared;
      },
      readProcesses: async () => rows,
      now: () => 1,
    })).toBe(false);
  });

  it('refuses ambiguous process rows and failed monitor probes', async () => {
    const cache = new IdleNativeProcessCache(30);
    const readPane = async () => pane;
    expect(await sampleIdleNativeProcess(cache, binding, {
      readPane, readProcesses: async () => [...rows, { ...native, pid: 11 }], now: () => 1,
    })).toBe(false);
    expect(await sampleIdleNativeProcess(cache, binding, {
      readPane, readProcesses: async () => { throw new Error('fixture unavailable'); }, now: () => 2,
    })).toBe(false);
    expect(cache.read(binding, 3)).toBeNull();
  });
});
