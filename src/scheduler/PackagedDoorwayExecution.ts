import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { scheduledDoorwayObservationDigest } from '../core/CommittedDoorwayObservation.js';
import {
  ScheduledDoorwayObservationStore,
  type ScheduledDoorwayObservation,
} from '../core/ScheduledDoorwayObservationStore.js';
import type { VerifiedPackagedDoorwayAssetsResult } from '../core/VerifiedPackagedCatalog.js';
import type { JobRun } from './JobRunHistory.js';

export function readDoorwayExecutionConfig(stateDir: string): { packagedExecution?: boolean; enabled?: boolean } | null {
  try {
    const config: unknown = JSON.parse(fs.readFileSync(path.join(stateDir, 'config.json'), 'utf8'));
    if (!isRecord(config)) return null;
    const maintenance = config.maintenance;
    if (maintenance === undefined) return {};
    if (!isRecord(maintenance)) return null;
    const scan = maintenance.doorwayScan;
    if (scan === undefined) return {};
    if (!isRecord(scan)
      || (scan.enabled !== undefined && typeof scan.enabled !== 'boolean')
      || (scan.packagedExecution !== undefined && typeof scan.packagedExecution !== 'boolean')) return null;
    return scan;
  } catch {
    // An unavailable config cannot authorize packaged probes.
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

// The child imports the verified bytes it received from the scheduler. Neither
// a reopened filesystem path nor an argv or environment override selects code.
const PROBE_ENTRY = `
  import fs from 'node:fs';
  const { source, door } = JSON.parse(fs.readFileSync(0, 'utf8'));
  const { probeDoorFree } = await import('data:text/javascript;base64,' + source);
  const { probeStatus } = await probeDoorFree(door);
  process.stdout.write(JSON.stringify(probeStatus));
`;

function probe(source: string, door: object, env: NodeJS.ProcessEnv, cwd: string, timeout: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, ['--input-type=module', '-e', PROBE_ENTRY], {
      cwd, env, timeout, maxBuffer: 4096, windowsHide: true,
    }, (error, stdout) => {
      if (error) {
        reject(new Error(error.killed ? 'packaged-probe-timeout' : 'packaged-probe-failed'));
        return;
      }
      // RULE 3: EXEMPT — this decodes the scheduler-owned JSON child protocol, not provider output or terminal state.
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error('packaged-probe-output-invalid'));
      }
    });
    child.stdin?.on('error', () => reject(new Error('packaged-probe-input-failed')));
    child.stdin?.end(JSON.stringify({ source, door }));
  });
}

export async function executePackagedDoorwayScan(options: {
  stateDir: string;
  run: JobRun;
  machineId: string;
  assets: VerifiedPackagedDoorwayAssetsResult;
  timeoutMs: number;
}): Promise<string> {
  const { stateDir, run, machineId, assets, timeoutMs } = options;
  if (assets.status !== 'verified') throw new Error(assets.reason);
  if (run.machineId !== machineId || run.slug !== 'doorway-scan' || run.origin !== 'instar'
    || run.runner !== 'script' || run.lockTrust !== 'trusted' || run.result !== 'pending') {
    throw new Error('packaged-run-unverified');
  }

  const catalog: unknown = JSON.parse(assets.catalogBytes.toString('utf8'));
  if (!isRecord(catalog) || !isRecord(catalog.doors)) throw new Error('packaged-catalog-invalid');
  const store = new ScheduledDoorwayObservationStore(stateDir, machineId, Object.keys(catalog.doors));
  const source = assets.proberBytes.toString('base64');
  const observations: ScheduledDoorwayObservation[] = [];
  const deadline = performance.now() + timeoutMs;
  const env = { PATH: process.env.PATH, HOME: process.env.HOME };
  const cwd = path.dirname(stateDir);

  const config = readDoorwayExecutionConfig(stateDir);
  if (config?.packagedExecution !== true || config.enabled === false) throw new Error('packaged-execution-disabled');
  store.startRun(run.runId, run.startedAt);
  for (const [doorId, door] of Object.entries(catalog.doors)) {
    if (!isRecord(door) || !isRecord(door.probe)) continue;
    const { kind, metered, vaultKeyName, listUrl } = door.probe;
    if (metered === true || (kind !== 'cli-version' && kind !== 'cli-model-list'
      && (kind !== 'http-model-list' || vaultKeyName || typeof listUrl !== 'string' || !listUrl))) continue;

    const remaining = Math.floor(deadline - performance.now());
    if (remaining <= 0) throw new Error('packaged-probe-timeout');
    const live = readDoorwayExecutionConfig(stateDir);
    if (live?.packagedExecution !== true || live.enabled === false) throw new Error('packaged-execution-disabled');
    store.startDoor(run.runId, doorId, new Date().toISOString());
    const probeStatus = await probe(source, { ...door, id: doorId }, env, cwd, remaining);
    if (typeof probeStatus !== 'string') throw new Error('packaged-probe-output-invalid');
    // The store validates the closed outcome enum and exact set of started doors.
    observations.push({ doorId, probeStatus: probeStatus as ScheduledDoorwayObservation['probeStatus'], observedAt: new Date().toISOString() });
  }

  store.stage(run.runId, new Date().toISOString(), observations);
  const staged = store.readStaged(run.runId);
  if (!staged || staged.runId !== run.runId || staged.machineId !== machineId || staged.startedAt !== run.startedAt) {
    throw new Error('packaged-observation-mismatch');
  }
  return scheduledDoorwayObservationDigest(staged);
}
