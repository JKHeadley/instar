import { execFile } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export const SMALL_PEER_COLLECTOR = 'darwin-vm-stat-native-pressure-v1' as const;
export const SAMPLE_INTERVAL_MS = 1000;
export const SAMPLE_DEADLINE_MS = 2000;

export interface SmallPeerMemorySample {
  collector: typeof SMALL_PEER_COLLECTOR;
  sampledAt: number;
  availableBytes: number;
  pressureLevel: number;
}

/** Calibration and trial admission both require complete native counters. */
export function parseSmallPeerMemory(vmStat: string, pressure: string, sampledAt: number): SmallPeerMemorySample | null {
  const native = pressure.trim();
  if (!['1', '2', '4'].includes(native) || !Number.isFinite(sampledAt)) return null;
  const size = /^Mach Virtual Memory Statistics: \(page size of (\d+) bytes\)/m.exec(vmStat);
  if (!size) return null;
  const pageBytes = Number(size[1]);
  if (!Number.isSafeInteger(pageBytes) || pageBytes <= 0) return null;
  let pages = 0;
  for (const label of ['Pages free', 'Pages inactive', 'Pages purgeable']) {
    const field = new RegExp('^' + label + ':\\s*(\\d+)\\.\\s*$', 'm').exec(vmStat);
    if (!field) return null;
    pages += Number(field[1]);
  }
  const availableBytes = pages * pageBytes;
  if (!Number.isSafeInteger(availableBytes)) return null;
  return { collector: SMALL_PEER_COLLECTOR, availableBytes, pressureLevel: Number(native), sampledAt };
}

export async function readSmallPeerMemory(): Promise<SmallPeerMemorySample | null> {
  if (process.platform !== 'darwin') return null;
  // Start time bounds the age of the oldest of the two measurements.
  const sampledAt = performance.now();
  try {
    const options = { timeout: SAMPLE_INTERVAL_MS, maxBuffer: 16384 };
    const [vm, pressure] = await Promise.all([
      exec('/usr/bin/vm_stat', [], options),
      exec('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'], options),
    ]);
    return parseSmallPeerMemory(vm.stdout, pressure.stdout, sampledAt);
  } catch { return null; } // @silent-fallback-ok: missing measurements refuse admission and stop a running trial.
}

export function smallPeerMemoryStopReason(sample: SmallPeerMemorySample | null, floorBytes: number, now: number): 'measurement-failed' | 'memory' | null {
  if (!sample || sample.collector !== SMALL_PEER_COLLECTOR || !Number.isFinite(now)
    || !Number.isFinite(sample.sampledAt) || now < sample.sampledAt || now - sample.sampledAt >= SAMPLE_DEADLINE_MS
    || !Number.isSafeInteger(sample.availableBytes) || sample.availableBytes < 0
    || ![1, 2, 4].includes(sample.pressureLevel) || !Number.isSafeInteger(floorBytes) || floorBytes <= 0) return 'measurement-failed';
  return sample.pressureLevel !== 1 || sample.availableBytes <= floorBytes ? 'memory' : null;
}

export function smallPeerMemoryAllows(sample: SmallPeerMemorySample | null, floorBytes: number, now: number): boolean {
  return smallPeerMemoryStopReason(sample, floorBytes, now) === null;
}

/** The full policy travels in the request so the signed digest binds the measured floor. */
export interface SmallPeerTrialPolicy {
  version: 1;
  machineId: string;
  collector: typeof SMALL_PEER_COLLECTOR;
  floorBytes: number;
  reserveBytes: number;
  recoveryMs: number;
  unitWorkers: 1 | 2;
  integration: 1;
  e2e: 1;
}

export function parseSmallPeerTrialPolicy(raw: unknown): SmallPeerTrialPolicy | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const p = raw as Partial<SmallPeerTrialPolicy>;
  if (Object.keys(p).length !== 9 || p.version !== 1 || typeof p.machineId !== 'string'
    || !/^m_[a-f0-9]{32}$/.test(p.machineId) || p.collector !== SMALL_PEER_COLLECTOR
    || typeof p.floorBytes !== 'number' || !Number.isSafeInteger(p.floorBytes)
    || typeof p.reserveBytes !== 'number' || !Number.isSafeInteger(p.reserveBytes)
    || p.reserveBytes <= 0 || p.floorBytes <= p.reserveBytes
    || typeof p.recoveryMs !== 'number' || !Number.isSafeInteger(p.recoveryMs) || p.recoveryMs < 2 * SAMPLE_INTERVAL_MS
    || (p.unitWorkers !== 1 && p.unitWorkers !== 2) || p.integration !== 1 || p.e2e !== 1) return null;
  return {
    version: 1, machineId: p.machineId, collector: SMALL_PEER_COLLECTOR,
    floorBytes: p.floorBytes, reserveBytes: p.reserveBytes, recoveryMs: p.recoveryMs,
    unitWorkers: p.unitWorkers, integration: 1, e2e: 1,
  };
}

export interface SmallPeerHeartbeat {
  attemptId: string;
  sequence: number;
  /** Receiver's monotonic time when this sample was requested. Never compare clocks across processes. */
  requestedAt: number;
}

export function validSmallPeerHeartbeat(
  expectedAttempt: string, previous: SmallPeerHeartbeat | null, next: SmallPeerHeartbeat, now: number,
): boolean {
  return next.attemptId === expectedAttempt && Number.isSafeInteger(next.sequence) && next.sequence > 0
    && Number.isFinite(now) && Number.isFinite(next.requestedAt)
    && next.requestedAt <= now && now - next.requestedAt < SAMPLE_DEADLINE_MS
    && (!previous || (next.sequence > previous.sequence && next.requestedAt >= previous.requestedAt));
}
