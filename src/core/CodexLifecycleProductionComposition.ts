import type crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { withSyncOp } from './InFlightSyncOpMarker.js';
import type { EncryptedDeliveryTransfer } from './InboundDeliveryStore.js';
import { SessionRecoveryChannel } from './SessionRecoveryChannel.js';
import { SessionRecoveryConsumer } from './SessionRecoveryConsumer.js';

export function createInboundDeliveryTransferStep(deps: {
  activationActive: () => boolean;
  targetEncryptionPublicKey: (machineId: string) => string | null | undefined;
  exportTransfer: (input: {
    conversationId: string; sourceMachineId: string; sourceEpoch: number; targetMachineId: string;
    transferEpoch: number; activeEpoch: number; targetEncryptionPublicKey: string;
  }) => EncryptedDeliveryTransfer | null;
  sendTransfer: (target: string, sessionKey: string, sourceEpoch: number, transferEpoch: number,
    transfer: EncryptedDeliveryTransfer) => Promise<{ ok: boolean; reason?: string }>;
  selfMachineId: string;
}) {
  return async (input: { sessionKey: string; target: string; sourceEpoch: number; transferEpoch: number; activeEpoch: number }) => {
    if (!deps.activationActive()) return { ok: true };
    const key = deps.targetEncryptionPublicKey(input.target);
    if (!key) return { ok: false, reason: 'target-encryption-key-unavailable' };
    const transfer = deps.exportTransfer({
      conversationId: input.sessionKey, sourceMachineId: deps.selfMachineId,
      sourceEpoch: input.sourceEpoch, targetMachineId: input.target,
      transferEpoch: input.transferEpoch, activeEpoch: input.activeEpoch,
      targetEncryptionPublicKey: key,
    });
    if (!transfer) return { ok: false, reason: 'delivery-ledger-unavailable' };
    return deps.sendTransfer(input.target, input.sessionKey, input.sourceEpoch, input.transferEpoch, transfer);
  };
}

export function createInboundDeliveryTransferHandler(deps: {
  selfMachineId: string;
  readOwnership: (session: string) => { ownerMachineId: string; status: string; ownershipEpoch: number; transferTo?: string } | null | undefined;
  ownEncryptionPrivateKey: () => crypto.KeyObject;
  importTransfer: (input: {
    transfer: EncryptedDeliveryTransfer; ownEncryptionPrivateKey: crypto.KeyObject;
    authenticatedSourceMachineId: string; expectedTargetMachineId: string;
    expectedConversationId: string; expectedTransferEpoch: number;
  }) => { imported: number; duplicate: number; activeEpoch: number } | null;
}) {
  return (input: { session: string; sourceEpoch: number; transferEpoch: number; transfer: EncryptedDeliveryTransfer }, sender: string) => {
    const rec = deps.readOwnership(input.session);
    const sourceStillAuthoritative = rec?.ownerMachineId === sender
      && ((rec.status === 'active' && rec.ownershipEpoch === input.sourceEpoch)
        || (rec.status === 'transferring' && rec.transferTo === deps.selfMachineId
          && rec.ownershipEpoch === input.transferEpoch));
    if (!sourceStillAuthoritative) return { accepted: false, reason: 'ownership-epoch-mismatch' };
    try {
      const imported = deps.importTransfer({
        transfer: input.transfer, ownEncryptionPrivateKey: deps.ownEncryptionPrivateKey(),
        authenticatedSourceMachineId: sender, expectedTargetMachineId: deps.selfMachineId,
        expectedConversationId: input.session, expectedTransferEpoch: input.transferEpoch,
      });
      return imported ? { accepted: true, ...imported } : { accepted: false, reason: 'delivery-ledger-unavailable' };
    } catch (err) {
      return { accepted: false, reason: err instanceof Error ? err.message : String(err) };
    }
  };
}

export function createProductionSessionRecoveryConsumer(input: {
  stateDir: string; restart: (reason: string) => Promise<boolean>; replay: () => void;
  actuationEnabled: () => boolean;
  dryRun?: boolean; restartCooldownMs?: number; log?: (message: string) => void;
}): SessionRecoveryConsumer {
  return new SessionRecoveryConsumer({
    channel: new SessionRecoveryChannel(input.stateDir),
    restart: (reason) => input.actuationEnabled() ? input.restart(reason) : Promise.resolve(false),
    replay: () => { if (input.actuationEnabled()) input.replay(); },
    dryRun: input.dryRun ?? true, cooldownMs: input.restartCooldownMs ?? 600_000, log: input.log,
  });
}

const STAGE_C_MARKER = path.join('state', 'codex-stage-c-activation.json');

/** Server-owned boot lease. A dead prior server can never authorize lifeline actuation. */
export function writeStageCActivationLease(
  stateDir: string, enabled: boolean, serverPid = process.pid,
  processStartToken: (pid: number) => string | null = readProcessStartToken,
): void {
  const target = path.join(stateDir, STAGE_C_MARKER);
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  const temp = `${target}.${serverPid}.tmp`;
  const startToken = processStartToken(serverPid);
  fs.writeFileSync(temp, JSON.stringify({
    schemaVersion: 1, enabled: enabled && startToken !== null, serverPid, processStartToken: startToken, updatedAt: Date.now(),
  }), { mode: 0o600 });
  fs.renameSync(temp, target);
}

export function stageCActivationLeaseIsLive(
  stateDir: string, processStartToken: (pid: number) => string | null = readProcessStartToken,
): boolean {
  try {
    const row = JSON.parse(fs.readFileSync(path.join(stateDir, STAGE_C_MARKER), 'utf8')) as Record<string, unknown>;
    if (row.schemaVersion !== 1 || row.enabled !== true || !Number.isSafeInteger(row.serverPid)
      || typeof row.processStartToken !== 'string' || !row.processStartToken) return false;
    return processStartToken(Number(row.serverPid)) === row.processStartToken;
  } catch { /* @silent-fallback-ok: a missing or malformed lease is dark */ return false; }
}

function readProcessStartToken(pid: number): string | null {
  try {
    const token = withSyncOp(() => execFileSync('/bin/ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024,
    })).trim();
    return token || null;
  } catch { /* @silent-fallback-ok: unverifiable process identity fails closed */ return null; }
}
