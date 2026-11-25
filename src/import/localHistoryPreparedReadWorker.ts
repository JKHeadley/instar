/** Fixed preview child with an isolated first-claim pilot mode. No client path discovery. Private
 * owner and artifact metadata arrive on framed stdin, never command arguments.
 */
import { ImportWriterBusy } from './ImportedHistoryStore.js';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import type { LocalHistoryFirstPermit } from './LocalHistoryFirstPermit.js';
import { assertLocalHistoryDisposablePilotState } from './LocalHistoryDisposablePilot.js';
import { openLocalHistoryStoreTemporaryRun, type LocalHistoryStoreTemporaryToken } from './LocalHistoryStoreTemporaryRun.js';
import { holdLocalHistoryChild } from './LocalHistoryChildCustody.js';
import { localHistoryWorkerInput } from './LocalHistoryWorkerInput.js';
import { readLocalHistoryPreparedPreview, type LocalHistoryPreparedPreview, type LocalHistoryPreparedPreviewInput } from './LocalHistoryPreparedPreview.js';

async function send(value: object): Promise<void> {
  if (!process.connected) throw new Error('local-history-no-parent');
  await new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve()));
}
async function respondToFirstClaim(preview: LocalHistoryPreparedPreview,
  execute?: (permit: LocalHistoryFirstPermit) => void): Promise<void> {
  const planDigest = preview.firstClaimPlan?.planDigest;
  if (!planDigest || !process.connected) throw new Error('local-history-claim-plan-disconnected');
  await new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      process.off('message', message);
      process.off('disconnect', disconnected);
      if (error) reject(error); else resolve();
    };
    const disconnected = () => finish(new Error('local-history-claim-plan-disconnected'));
    const message = (value: unknown) => {
      const response = value as { kind?: unknown; planDigest?: unknown; permit?: LocalHistoryFirstPermit } | null;
      if (response && typeof response === 'object' && Object.keys(response).length === 2) {
        if (!execute && response.kind === 'discard-claim-plan' && response.planDigest === planDigest) {
          finish(); return;
        }
        if (execute && response.kind === 'commit-first-claim' && response.permit?.planDigest === planDigest) {
          try { execute(response.permit); finish(); }
          catch { finish(new Error('local-history-claim-plan-permit')); }
          return;
        }
      }
      finish(new Error('local-history-claim-plan-protocol'));
    };
    process.once('message', message);
    process.once('disconnect', disconnected);
    void send({ kind: 'claim-plan-ready', preview }).catch(disconnected);
  });
}
async function run(): Promise<void> {
  const raw = process.env.INSTAR_LOCAL_HISTORY_CUSTODY;
  delete process.env.INSTAR_LOCAL_HISTORY_CUSTODY;
  if (!raw || raw.length > CHUNK_BYTES || !process.connected) throw new Error('local-history-no-custody');
  const token = JSON.parse(raw);
  const custody = holdLocalHistoryChild(token);
  process.once('exit', () => custody.close());
  await send({ kind: 'ready' });
  const { header, body } = await localHistoryWorkerInput(process.stdin);
  const options = header as (LocalHistoryPreparedPreviewInput & { holdFirstClaimPlan?: true; pilotRun?: LocalHistoryStoreTemporaryToken }) | null;
  if (!options || !header || typeof header !== 'object' || Array.isArray(header)
    || !['stateDir', 'ownerUserId', 'descriptors', 'maxArtifactBytes'].every(key => Object.hasOwn(header, key))
    || Object.keys(header).some(key => !['stateDir', 'ownerUserId', 'descriptors', 'maxArtifactBytes', 'includeFirstClaimPlan', 'holdFirstClaimPlan', 'pilotRun'].includes(key))
    || (Object.hasOwn(header, 'includeFirstClaimPlan') && (header as LocalHistoryPreparedPreviewInput).includeFirstClaimPlan !== true)
    || (Object.hasOwn(header, 'holdFirstClaimPlan') && (options?.holdFirstClaimPlan !== true || options.includeFirstClaimPlan !== true))
    || (Object.hasOwn(header, 'pilotRun') && (!options?.pilotRun || options.holdFirstClaimPlan !== undefined
      || options.includeFirstClaimPlan !== true || options.pilotRun.stateDir !== token.stateDir
      || options.pilotRun.generation !== token.generation))
    || options?.stateDir !== token.stateDir) throw new Error('local-history-preview-header');
  if (options.pilotRun) assertLocalHistoryDisposablePilotState(options.stateDir);
  const allocator = options.pilotRun ? openLocalHistoryStoreTemporaryRun(options.pilotRun) : undefined;
  try {
    const result = await readLocalHistoryPreparedPreview(options, body,
      index => { if (!process.connected) throw new Error('local-history-no-parent'); process.send!({ kind: 'file', index }); },
      options.holdFirstClaimPlan ? preview => respondToFirstClaim(preview) : undefined,
      allocator ? { allocator, receivePermit: respondToFirstClaim } : undefined);
    await send({ kind: 'complete', preview: result });
  } finally { allocator?.close(); }
  process.disconnect();
}
void run().catch(async error => {
  // Never forward private input, exception text or native diagnostics.
  const code = error instanceof ImportWriterBusy ? 'writer-busy' : 'preview-refused';
  if (process.connected) await send({ kind: 'refused', code }).catch(() => {});
  process.exitCode = 65; process.stdin.destroy();
  if (process.connected) process.disconnect();
});
