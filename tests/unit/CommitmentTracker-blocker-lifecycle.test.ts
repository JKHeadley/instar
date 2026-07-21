import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CommitmentTracker } from '../../src/monitoring/CommitmentTracker.js';
import { LiveConfig } from '../../src/config/LiveConfig.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

describe('CommitmentTracker blocker lifecycle', () => {
  const dirs: string[] = [];
  afterEach(() => { vi.restoreAllMocks(); dirs.splice(0).forEach(dir => SafeFsExecutor.safeRmSync(dir, {
    recursive: true, force: true, operation: 'tests/unit/CommitmentTracker-blocker-lifecycle.test.ts',
  })); });

  function tracker(): CommitmentTracker {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blocker-tracker-')); dirs.push(dir);
    fs.writeFileSync(path.join(dir, 'config.json'), '{}');
    return new CommitmentTracker({ stateDir: dir, liveConfig: new LiveConfig(dir), blockerLifecycleEnabled: true });
  }

  it('opens and closes a durable episode and emits only after persistence', () => {
    const t = tracker();
    const request = vi.fn(); const close = vi.fn();
    t.on('blocker-request-persisted', request); t.on('blocker-episode-closed', close);
    const c = t.record({ userRequest: 'x', agentResponse: 'y', type: 'behavioral', behavioralRule: 'z' });
    t.transitionState(c.id, { blockedOn: 'external' });
    expect(request).toHaveBeenCalledTimes(1);
    const open = t.get(c.id)!.blockerEpisodes![0];
    expect(open.closedAtMs).toBeUndefined();
    t.transitionState(c.id, { blockedOn: 'none' });
    expect(close).toHaveBeenCalledTimes(1);
    expect(t.get(c.id)!.blockerEpisodes![0].closedAtMs).toEqual(expect.any(Number));
  });

  it('rolls back an authoritative mutation when rename fails', () => {
    const t = tracker();
    const c = t.record({ userRequest: 'x', agentResponse: 'y', type: 'behavioral', behavioralRule: 'z' });
    vi.spyOn(fs, 'renameSync').mockImplementation(() => { throw new Error('disk-failure'); });
    expect(() => t.transitionState(c.id, { blockedOn: 'external' })).toThrow();
    expect(t.get(c.id)!.blockedOn).toBe('none');
    expect(t.get(c.id)!.blockerEpisodes ?? []).toHaveLength(0);
  });
});
