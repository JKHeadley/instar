import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { dispatchManagedCodexProject } from '../../src/core/ManagedCodexProjectDispatch.js';
import { ManagedCodexStopStore } from '../../src/core/ManagedCodexStopStore.js';

const admission = { workKey: 'project-action', revision: 'approved-1', topicId: 'topic',
  machineId: 'sole-machine', ownerEpoch: 3, remaining: 2 };

function setup() {
  const db = new Database(':memory:');
  const store = new ManagedCodexStopStore(db);
  const readAdmission = vi.fn(() => ({ ...admission }));
  const launch = vi.fn(async (_: typeof admission, launchId: string) => {
    expect(store.hasEnrollment(launchId)).toBe(true);
    return { launchId, nativeSessionId: 'native-worker' };
  });
  const releaseLaunch = vi.fn((worker: { nativeSessionId: string }) => {
    expect(store.hasEnrollment(worker.nativeSessionId)).toBe(true);
  });
  const cancelLaunch = vi.fn();
  return { db, store, readAdmission, launch, releaseLaunch, cancelLaunch, enabled: () => true, verifyLaunch: () => true };
}

describe('managed Codex project dispatch', () => {
  it('reserves before the one authorized launch and binds its verified native worker', async () => {
    const deps = setup();
    try {
      const outcomes = await Promise.all([
        dispatchManagedCodexProject(admission.workKey, deps),
        dispatchManagedCodexProject(admission.workKey, deps),
      ]);
      expect(deps.launch).toHaveBeenCalledOnce();
      expect(deps.releaseLaunch).toHaveBeenCalledOnce();
      expect(deps.cancelLaunch).not.toHaveBeenCalled();
      expect(outcomes.filter(Boolean)).toHaveLength(1);
      expect(deps.store.hasEnrollment('native-worker')).toBe(true);
    } finally {
      deps.db.close();
    }
  });

  it('declines changed admission during launch and retains the refusal record', async () => {
    const deps = setup();
    try {
      deps.readAdmission.mockReturnValueOnce(admission).mockReturnValueOnce(admission)
        .mockReturnValue({ ...admission, ownerEpoch: 4 });
      expect(await dispatchManagedCodexProject(admission.workKey, deps)).toBeUndefined();
      const launchId = deps.launch.mock.calls[0][1];
      expect(deps.store.hasEnrollment(launchId)).toBe(true);
      expect(deps.store.hasEnrollment('native-worker')).toBe(false);
      expect(deps.store.activate(launchId)).toBe(false);
      expect(deps.releaseLaunch).not.toHaveBeenCalled();
      expect(deps.cancelLaunch).toHaveBeenCalledWith(launchId);
    } finally {
      deps.db.close();
    }
  });

  it('leaves the authority and launcher untouched while disabled', async () => {
    const deps = setup();
    try {
      expect(await dispatchManagedCodexProject(admission.workKey, { ...deps, enabled: () => false })).toBeUndefined();
      expect(deps.readAdmission).not.toHaveBeenCalled();
      expect(deps.launch).not.toHaveBeenCalled();
    } finally {
      deps.db.close();
    }
  });
});
