import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSyncOp } from './InFlightSyncOpMarker.js';
import { InboundDeliveryStore } from './InboundDeliveryStore.js';
import { createPhysicalEffectLock, type PhysicalEffectLock } from './PhysicalEffectLock.js';
import type { StageBActivationStatus } from './StageBActivationGate.js';

export type StageBStartupFailure = 'startup-schema-failed' | 'startup-full-failed'
  | 'startup-lock-failed' | 'startup-old-callback-live' | 'startup-attempt-owner-failed';

export function applyStageBStartupReadiness(
  status: StageBActivationStatus,
  stateDir: string,
  deps: { pid?: number; processStartToken?: (pid: number) => string | null } = {},
): StageBActivationStatus {
  if (!status.active) return status;
  const pid = deps.pid ?? process.pid;
  const processStartToken = deps.processStartToken ?? readProcessStartToken;
  const failed = verifyStageBStartupReadiness(stateDir, pid, processStartToken);
  return failed ? { ...status, active: false, reason: failed } : status;
}

export function verifyStageBStartupReadiness(
  stateDir: string,
  pid = process.pid,
  processStartToken: (pid: number) => string | null = readProcessStartToken,
  deps: {
    openStore?: (stateDir: string) => Pick<InboundDeliveryStore, 'startupReadiness' | 'close'>;
    createLock?: (stateDir: string) => PhysicalEffectLock;
  } = {},
): StageBStartupFailure | null {
  const leasePath = path.join(stateDir, 'state', 'codex-stage-b-runtime-lease.json');
  try {
    const previous = JSON.parse(fs.readFileSync(leasePath, 'utf8')) as Record<string, unknown>;
    if (Number.isSafeInteger(previous.pid) && typeof previous.processStartToken === 'string'
      && processStartToken(Number(previous.pid)) === previous.processStartToken) return 'startup-old-callback-live';
  } catch { /* @silent-fallback-ok: absent/malformed prior lease has no live authority */ }

  let store: Pick<InboundDeliveryStore, 'startupReadiness' | 'close'> | null = null;
  try {
    store = (deps.openStore ?? InboundDeliveryStore.open)(stateDir);
    const durability = store.startupReadiness();
    if (!durability.schema || durability.journalMode.toLowerCase() !== 'wal') return 'startup-schema-failed';
    // SQLite FULL is numeric 2. Verify on this exact newly-opened connection.
    if (durability.synchronous !== 2) return 'startup-full-failed';
  } catch { return 'startup-schema-failed'; }
  finally { store?.close(); }

  const lock = (deps.createLock ?? createPhysicalEffectLock)(stateDir);
  if (!lock.status().available) return 'startup-lock-failed';
  try {
    const first = lock.acquireSync('__codex-stage-b-startup-conformance__', Date.now() + 2_000);
    first.assertHeld();
    const firstEpoch = first.epoch;
    first.release();
    const owner = lock.acquireSync('__codex-stage-b-startup-conformance__', Date.now() + 2_000);
    owner.assertHeld();
    if (owner.epoch <= firstEpoch) { owner.release(); return 'startup-attempt-owner-failed'; }
    owner.release();
  } catch { return 'startup-lock-failed'; }

  const token = processStartToken(pid);
  if (!token) return 'startup-old-callback-live';
  fs.mkdirSync(path.dirname(leasePath), { recursive: true, mode: 0o700 });
  const temp = `${leasePath}.${pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify({ schemaVersion: 1, pid, processStartToken: token, writtenAt: Date.now() }), { mode: 0o600 });
  fs.renameSync(temp, leasePath);
  return null;
}

function readProcessStartToken(pid: number): string | null {
  try {
    const token = withSyncOp(() => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024,
    })).trim();
    return token || null;
  } catch { /* @silent-fallback-ok: unverifiable process identity has no startup authority */ return null; }
}
