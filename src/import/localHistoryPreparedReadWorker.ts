/** Fixed read-only child. No client path discovery or copy permission. Private
 * owner and artifact metadata arrive on framed stdin, never command arguments.
 */
import { ImportWriterBusy } from './ImportedHistoryStore.js';
import { CHUNK_BYTES } from '../core/appMediaTypes.js';
import { holdLocalHistoryChild } from './LocalHistoryChildCustody.js';
import { localHistoryWorkerInput } from './LocalHistoryWorkerInput.js';
import { readLocalHistoryPreparedPreview, type LocalHistoryPreparedPreviewInput } from './LocalHistoryPreparedPreview.js';

async function send(value: object): Promise<void> {
  if (!process.connected) throw new Error('local-history-no-parent');
  await new Promise<void>((resolve, reject) => process.send!(value, error => error ? reject(error) : resolve()));
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
  if (!header || typeof header !== 'object' || Array.isArray(header)
    || Object.keys(header).length !== 4
    || Object.keys(header).some(key => !['stateDir', 'ownerUserId', 'descriptors', 'maxArtifactBytes'].includes(key))
    || (header as LocalHistoryPreparedPreviewInput).stateDir !== token.stateDir) throw new Error('local-history-preview-header');
  const result = await readLocalHistoryPreparedPreview(header as LocalHistoryPreparedPreviewInput, body,
    index => { if (!process.connected) throw new Error('local-history-no-parent'); process.send!({ kind: 'file', index }); });
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
