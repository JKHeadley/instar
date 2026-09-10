import { parentPort, workerData } from 'node:worker_threads';
import { OriginStoreBackend } from './OriginStoreBackend.js';
import { writeSpoolEvidence } from './OriginEvidenceSpool.js';
import type { OriginStoreOptions } from './StoreTypes.js';

const data = workerData as { options: OriginStoreOptions; mode?: 'spool' };
let backend: OriginStoreBackend | null = null;
const methods = new Set([
  'putEvidence', 'putVerifiedEvidence', 'admit', 'getOrigin', 'getChild', 'getOperation', 'listOrigins', 'getMetrics',
  'claim', 'markDispatched', 'releaseUndispatchedClaim', 'renewClaim', 'recordOutcome', 'reapAbandoned', 'addMaterialization',
  'recordOperationState', 'reserveNotice', 'recordNoticeOutcome', 'archive', 'cleanupPayloads', 'diagnostics', 'getPayload', 'consumeAuditAssertion',
  'retireNoticeOwner', 'reconcileReceipt',
  'reserveRecoveryAttempt',
  'healthTransaction', 'recoverableAdmissions', 'takeRecoverableAdmissions', 'registerOwner', 'legacyCandidates', 'importLegacy', 'reserveDiagnostic', 'completeDiagnostic', 'browserRecovery', 'getFederatedMetrics', 'getBrowserRecoveryStates', 'undiagnosedOrigins',
]);
try { if (data.mode !== 'spool') backend = new OriginStoreBackend(data.options); parentPort!.postMessage({ ready: true }); }
catch (error) { parentPort!.postMessage({ ready: false, error: error instanceof Error ? error.message : String(error) }); parentPort!.close(); }

parentPort!.on('message', (message: { id: number; method: string; input?: unknown }) => {
  try {
    if (message.method === 'close') { backend?.close(); parentPort!.postMessage({ id: message.id, result: null }); parentPort!.close(); return; }
    let result: unknown;
    if (data.mode === 'spool' && message.method === 'putEvidence') result = writeSpoolEvidence(data.options, message.input as Parameters<typeof writeSpoolEvidence>[1]);
    else {
      if (!backend || !methods.has(message.method)) throw new Error('origin-store:unknown-method');
      const fn = (backend as unknown as Record<string, (input?: unknown) => unknown>)[message.method];
      result = fn.call(backend, message.input);
    }
    parentPort!.postMessage({ id: message.id, result });
  } catch (error) { parentPort!.postMessage({ id: message.id, error: error instanceof Error ? error.message : String(error) }); }
});
