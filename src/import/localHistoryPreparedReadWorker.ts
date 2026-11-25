/** Fixed read-only child. No client path discovery or copy permission. Private
 * owner and artifact metadata arrive on framed stdin, never command arguments.
 */
import { ImportWriterBusy } from './ImportedHistoryStore.js';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { holdLocalHistoryChild } from './LocalHistoryChildCustody.js';
import { localHistoryWorkerInput } from './LocalHistoryWorkerInput.js';
import { readLocalHistoryPreparedPreview, type LocalHistoryPreparedPreview, type LocalHistoryPreparedPreviewInput } from './LocalHistoryPreparedPreview.js';

async function send(value: object): Promise<void> {
  if (!process.connected) throw new Error('local-history-no-parent');
  await new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve()));
}
async function observeAndDiscardFirstClaim(preview: LocalHistoryPreparedPreview): Promise<void> {
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
      const response = value as { kind?: unknown; planDigest?: unknown } | null;
      if (!response || typeof response !== 'object' || Object.keys(response).length !== 2
        || response.kind !== 'discard-claim-plan' || response.planDigest !== planDigest) {
        finish(new Error('local-history-claim-plan-protocol')); return;
      }
      finish();
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
  const options = header as (LocalHistoryPreparedPreviewInput & { holdFirstClaimPlan?: true }) | null;
  if (!header || typeof header !== 'object' || Array.isArray(header)
    || !['stateDir', 'ownerUserId', 'descriptors', 'maxArtifactBytes'].every(key => Object.hasOwn(header, key))
    || Object.keys(header).some(key => !['stateDir', 'ownerUserId', 'descriptors', 'maxArtifactBytes', 'includeFirstClaimPlan', 'holdFirstClaimPlan'].includes(key))
    || (Object.hasOwn(header, 'includeFirstClaimPlan') && (header as LocalHistoryPreparedPreviewInput).includeFirstClaimPlan !== true)
    || (Object.hasOwn(header, 'holdFirstClaimPlan') && (options?.holdFirstClaimPlan !== true || options.includeFirstClaimPlan !== true))
    || options?.stateDir !== token.stateDir) throw new Error('local-history-preview-header');
  const result = await readLocalHistoryPreparedPreview(header as LocalHistoryPreparedPreviewInput, body,
    index => { if (!process.connected) throw new Error('local-history-no-parent'); process.send!({ kind: 'file', index }); },
    options?.holdFirstClaimPlan ? observeAndDiscardFirstClaim : undefined);
  await send({ kind: 'complete', preview: result });
  process.disconnect();
}
void run().catch(async error => {
  // Never forward private input, exception text or native diagnostics.
  const code = error instanceof ImportWriterBusy ? 'writer-busy' : 'preview-refused';
  if (process.connected) await send({ kind: 'refused', code }).catch(() => {});
  process.exitCode = 65; process.stdin.destroy();
  if (process.connected) process.disconnect();
});
