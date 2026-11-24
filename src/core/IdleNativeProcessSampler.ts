import { IdleNativeProcessCache, type IdleNativeBinding, type NativeProcessSample } from './IdleNativeProcessCache.js';

/** A pane read performed by the monitor, with the exact owner and launch binding. */
export interface IdleNativePaneSnapshot {
  readonly binding: IdleNativeBinding;
  readonly panePid: number;
  /** Exact executable obtained from the trusted launch, rather than a command-line substring. */
  readonly nativeExecutable: string;
  /** Kernel start identity for the root process from the pane's trusted launch binding. */
  readonly paneStartToken: string;
  /** Wrapper executables that the trusted launch actually used. */
  readonly wrapperExecutables: readonly string[];
  /** Required for a wrapped launch. Only the trusted launch handshake can supply it. */
  readonly launchedNative?: NativeProcessSample;
}

export interface IdleNativeProcessRow extends NativeProcessSample {
  readonly parentPid: number;
  readonly executable: string;
}

interface IdleNativeProcessSamplerPorts {
  readPane: (sessionId: string) => Promise<IdleNativePaneSnapshot | null>;
  readProcesses: () => Promise<readonly IdleNativeProcessRow[]>;
  now: () => number;
}

interface PaneNativeProcess extends NativeProcessSample {
  lineage: string;
}

/** Accept native executables only within the exact pane's trusted wrapper chain. */
export function findPaneNativeProcess(
  pane: IdleNativePaneSnapshot,
  rows: readonly IdleNativeProcessRow[],
): PaneNativeProcess[] {
  const byPid = new Map<number, IdleNativeProcessRow>();
  for (const row of rows) {
    if (byPid.has(row.pid)) return [];
    byPid.set(row.pid, row);
  }
  if (!pane.nativeExecutable || !pane.paneStartToken
    || byPid.get(pane.panePid)?.kernelStartToken !== pane.paneStartToken) return [];

  const candidates: PaneNativeProcess[] = [];
  for (const row of rows) {
    if (row.executable !== pane.nativeExecutable || !row.kernelStartToken) continue;
    if (pane.launchedNative) {
      if (row.pid !== pane.launchedNative.pid || row.kernelStartToken !== pane.launchedNative.kernelStartToken) continue;
    } else if (row.pid !== pane.panePid) {
      // A replacement child can have the same executable and wrapper ancestry.
      continue;
    }
    const visited = new Set<number>();
    const chain: Array<[number, string, string]> = [];
    let current: IdleNativeProcessRow | undefined = row;
    while (current && current.kernelStartToken && !visited.has(current.pid)) {
      if (current !== row && !pane.wrapperExecutables.includes(current.executable)) break;
      chain.push([current.pid, current.kernelStartToken, current.executable]);
      if (current.pid === pane.panePid) {
        candidates.push({ pid: row.pid, kernelStartToken: row.kernelStartToken, lineage: JSON.stringify(chain) });
        break;
      }
      visited.add(current.pid);
      current = byPid.get(current.parentPid);
    }
  }
  return candidates;
}

function samePane(a: IdleNativePaneSnapshot, b: IdleNativePaneSnapshot): boolean {
  return a.panePid === b.panePid && a.paneStartToken === b.paneStartToken
    && a.nativeExecutable === b.nativeExecutable && a.launchedNative?.pid === b.launchedNative?.pid
    && a.launchedNative?.kernelStartToken === b.launchedNative?.kernelStartToken
    && a.wrapperExecutables.length === b.wrapperExecutables.length
    && a.wrapperExecutables.every((executable, index) => executable === b.wrapperExecutables[index]);
}

function copyPane(pane: IdleNativePaneSnapshot | null): IdleNativePaneSnapshot | null {
  return pane ? {
    ...pane,
    binding: { ...pane.binding },
    wrapperExecutables: [...pane.wrapperExecutables],
    launchedNative: pane.launchedNative ? { ...pane.launchedNative } : undefined,
  } : null;
}

/** Background monitor seam. Evidence is sampled and grants no live mutation fence. */
export async function sampleIdleNativeProcess(
  cache: IdleNativeProcessCache,
  expected: IdleNativeBinding,
  ports: IdleNativeProcessSamplerPorts,
): Promise<boolean> {
  const ticket = cache.begin(expected, ports.now());
  if (!ticket) return false;
  const binding = ticket.binding;
  try {
    const before = copyPane(await ports.readPane(binding.sessionId));
    if (!before) return cache.observe(ticket, null, [], ports.now());
    const first = findPaneNativeProcess(before, await ports.readProcesses());
    const after = copyPane(await ports.readPane(binding.sessionId));
    if (!after || !samePane(before, after) || first.length !== 1) {
      return cache.observe(ticket, null, [], ports.now());
    }
    const second = findPaneNativeProcess(after, await ports.readProcesses());
    if (second.length !== 1 || first[0].lineage !== second[0].lineage) {
      return cache.observe(ticket, null, [], ports.now());
    }
    // Recheck custody after the final process read, not just before it.
    const final = copyPane(await ports.readPane(binding.sessionId));
    if (!final || !samePane(after, final)) return cache.observe(ticket, null, [], ports.now());
    const bindingFields = ['sessionId', 'topicKey', 'ownerMachineId', 'ownerEpoch', 'paneId', 'launchId'] as const;
    if (bindingFields.some(field => [before, after, final].some(pane => pane.binding[field] !== binding[field]))) {
      return cache.observe(ticket, null, [], ports.now());
    }
    const { pid, kernelStartToken } = second[0];
    return cache.observe(ticket, final.binding, [{ pid, kernelStartToken }], ports.now());
  } catch {
    // A failed monitor read carries no evidence. It must not restore an older proof.
    return cache.observe(ticket, null, [], ports.now());
  }
}
