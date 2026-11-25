import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { attributeManagedCodexStopCycle } from './ManagedCodexStopCycle.js';
import type { ManagedStopEnrollment } from './ManagedCodexStopDecision.js';
import { matchManagedCodexStopReceipt } from './ManagedCodexStopReceipt.js';
import type { ManagedStopRequest } from './ManagedCodexStopRuntime.js';
import type { ManagedStopCallback } from './ManagedCodexStopStore.js';

export interface ManagedStopWorker {
  topicId: string;
  machineId: string;
  ownerEpoch: number;
  nativeSessionId: string;
  codexHome: string;
  rolloutPath: string;
}

/**
 * Verify native evidence from a server-resolved live worker. The request
 * cannot choose a file, ownership epoch, or machine. The caller establishes
 * the worker's current custody and that its home is separate from project
 * writes. A bounded full read is required to prove intraturn uniqueness.
 */
export function verifyManagedCodexStop(
  request: ManagedStopRequest,
  worker: ManagedStopWorker,
  enrollment: ManagedStopEnrollment,
  maxRolloutBytes: number,
): Omit<ManagedStopCallback, 'sessionId' | 'enabled'> | undefined {
  if (request.topicId !== worker.topicId || request.sessionId !== worker.nativeSessionId
    || enrollment.sessionId !== worker.nativeSessionId || enrollment.machineId !== worker.machineId
    || enrollment.ownerEpoch !== worker.ownerEpoch || enrollment.state !== 'active'
    || !request.turnId || !request.lastAssistantMessage
    || !Number.isSafeInteger(maxRolloutBytes) || maxRolloutBytes <= 0) return;

  let fd: number | undefined;
  try {
    const home = fs.realpathSync(worker.codexHome);
    const rollout = fs.realpathSync(worker.rolloutPath);
    const relative = path.relative(home, rollout);
    if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep)
      || path.isAbsolute(relative) || rollout !== path.resolve(worker.rolloutPath)) return;

    fd = fs.openSync(rollout, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd, { bigint: true });
    if (!stat.isFile() || stat.size > BigInt(maxRolloutBytes)) return;
    const bytes = Buffer.alloc(Number(stat.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count === 0) return;
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (stat.size !== after.size || stat.mtimeNs !== after.mtimeNs || stat.ctimeNs !== after.ctimeNs) return;

    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
    const cycle = attributeManagedCodexStopCycle(
      decoder.decode(bytes), request.turnId, request.lastAssistantMessage,
    );
    if (!cycle) return;

    const fileKey = [stat.dev.toString(), stat.ino.toString(), stat.birthtimeNs.toString()].join(':');
    const outstanding = enrollment.outstanding;
    const prior = outstanding?.boundary;
    const receipt = outstanding && prior && prior.fileKey === fileKey
      && prior.endOffset >= 0 && prior.endOffset <= cycle.byteOffset
      && matchManagedCodexStopReceipt(
        decoder.decode(bytes.subarray(prior.endOffset, cycle.byteOffset)), prior.turnId, outstanding.marker,
      )
      ? { cycle: outstanding.cycle, marker: outstanding.marker }
      : undefined;
    return {
      machineId: worker.machineId,
      ownerEpoch: worker.ownerEpoch,
      cycle: JSON.stringify([fileKey, cycle.turnId, cycle.byteOffset, cycle.assistantItemId]),
      marker: 'instar-managed-' + randomUUID(),
      boundary: { fileKey, turnId: cycle.turnId, endOffset: bytes.length },
      receipt,
    };
  } catch {
    // Unreadable, changed or invalid native evidence cannot authorize output.
    return;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
