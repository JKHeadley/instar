import { randomUUID } from 'node:crypto';
import type { ManagedCodexStopStore } from './ManagedCodexStopStore.js';

export interface ManagedProjectAdmission {
  workKey: string;
  revision: string;
  topicId: string;
  machineId: string;
  ownerEpoch: number;
  remaining: number;
}

export interface ManagedProjectLaunch {
  launchId: string;
  nativeSessionId: string;
}

interface Dependencies {
  enabled(): boolean;
  readAdmission(workKey: string): ManagedProjectAdmission | undefined;
  store: ManagedCodexStopStore;
  launch(admission: ManagedProjectAdmission, launchId: string): Promise<ManagedProjectLaunch>;
  verifyLaunch(admission: ManagedProjectAdmission, launch: ManagedProjectLaunch): boolean;
  releaseLaunch(launch: ManagedProjectLaunch): void;
  cancelLaunch(launchId: string): void;
}

function sameAdmission(a: ManagedProjectAdmission, b: ManagedProjectAdmission | undefined): boolean {
  return b !== undefined && a.workKey === b.workKey && a.revision === b.revision
    && a.topicId === b.topicId && a.machineId === b.machineId
    && a.ownerEpoch === b.ownerEpoch && a.remaining === b.remaining;
}

/**
 * Dispatch one server-admitted managed action. Admission is supplied by the
 * project authority for verified single-member custody. The launcher must
 * tag the exact incarnation and withhold its first turn until binding.
 */
export async function dispatchManagedCodexProject(
  workKey: string,
  deps: Dependencies,
): Promise<ManagedProjectLaunch | undefined> {
  if (!deps.enabled()) return;
  const admission = deps.readAdmission(workKey);
  if (!admission || admission.workKey !== workKey || !admission.revision || !admission.topicId) return;

  const launchId = randomUUID();
  if (!deps.store.reserve(workKey, {
    sessionId: launchId, machineId: admission.machineId,
    ownerEpoch: admission.ownerEpoch, remaining: admission.remaining,
  })) return;

  let bound = false;
  let released = false;
  let launched = false;
  try {
    if (!deps.enabled() || !sameAdmission(admission, deps.readAdmission(workKey))) return;
    launched = true;
    const worker = await deps.launch(admission, launchId);
    if (!deps.enabled() || worker.launchId !== launchId
      || !sameAdmission(admission, deps.readAdmission(workKey))
      || !deps.verifyLaunch(admission, worker)) return;

    bound = deps.store.bindNative(launchId, worker.nativeSessionId);
    if (!bound) return;
    deps.releaseLaunch(worker);
    released = true;
    return worker;
  } finally {
    if (!released) {
      try {
        if (bound) deps.store.pause(launchId);
        else deps.store.abortPending(launchId);
      } finally {
        if (launched) deps.cancelLaunch(launchId);
      }
    }
  }
}
