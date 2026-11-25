import { createHash } from 'node:crypto';
import type { LocalHistoryPreparedArtifactDescriptor } from './LocalHistoryPreparedArtifacts.js';

export interface LocalHistoryFirstClaimSizing {
  fileId: string;
  contentBytes: number;
  databaseCeilingBytes: number;
  journalBytes: number;
}

/** A stable binding for verified size evidence. The digest is not a writer
 * token. A future worker must recompute it inside the current writer. */
export function localHistoryFirstClaimPlanDigest(ownerUserId: string, artifact: LocalHistoryPreparedArtifactDescriptor,
  destinationFingerprint: string, sizing: LocalHistoryFirstClaimSizing): string {
  return createHash('sha256').update(JSON.stringify([
    'local-history-first-claim-plan-v1',
    ownerUserId, artifact.fileId, artifact.source, artifact.expectedSessionId, artifact.projectPath, artifact.representation,
    artifact.bytes, artifact.sha256, destinationFingerprint,
    sizing.fileId, sizing.contentBytes, sizing.databaseCeilingBytes, sizing.journalBytes,
  ])).digest('hex');
}
